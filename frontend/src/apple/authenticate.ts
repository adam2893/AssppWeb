import type { Account, Cookie } from "../types";
import { appleRequest, type WispConnectionState } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL, normalizeAuthURL } from "./bag";
import { createSapSigner } from "./sap/client";
import { loadSapAssets } from "./sap/assets";
import type { SapSigner } from "./sap/signer";
import i18n from "../i18n";

function hardwareIdBytes(deviceId: string): Uint8Array {
  if (!/^[0-9a-fA-F]{12}$/.test(deviceId)) {
    throw new Error("Device identifier must be 12 hexadecimal characters");
  }
  const bytes = new Uint8Array(6);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(deviceId.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const MAX_AUTH_ATTEMPTS = 3;
const MAX_REDIRECTS = 3;
const AUTH_RETRY_DELAY_MS = 10_000;
const MAX_AUTH_RETRY_DELAY_MS = 30_000;

export interface AuthenticationDiagnostics {
  bagFetchStatus: "loading" | "ready" | "fallback";
  resolvedAuthEndpoint?: string;
  pod?: string;
  storefront?: string;
  sapAssetReadiness: "not-required" | "loading" | "ready" | "failed";
  wispConnection: WispConnectionState | "not-started";
  lastAppleStatusCode?: number;
  retryCount: number;
  retryDelayMs?: number;
  failureReason?: string;
}

export function createInitialAuthenticationDiagnostics(): AuthenticationDiagnostics {
  return {
    bagFetchStatus: "loading",
    sapAssetReadiness: "not-required",
    wispConnection: "not-started",
    retryCount: 0,
  };
}

function safeAuthEndpoint(host: string, path: string): string {
  try {
    const url = new URL(`https://${host}${path}`);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

function isTransientAuthStatus(status: number): boolean {
  return (
    status === 204 ||
    status === 404 ||
    status === 429 ||
    (status >= 500 && status < 600)
  );
}

function retryAfterDelay(
  responseHeaders: Record<string, string>,
  retryNumber: number,
): number {
  const retryAfter =
    responseHeaders["retry-after"] ?? responseHeaders["Retry-After"];
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_AUTH_RETRY_DELAY_MS);
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(
        Math.max(0, retryAt - Date.now()),
        MAX_AUTH_RETRY_DELAY_MS,
      );
    }
  }

  return Math.min(
    AUTH_RETRY_DELAY_MS * 2 ** retryNumber,
    MAX_AUTH_RETRY_DELAY_MS,
  );
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
  onDiagnostics?: (diagnostics: AuthenticationDiagnostics) => void,
): Promise<Account> {
  const guid = deviceId.toUpperCase();
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;
  const diagnostics = createInitialAuthenticationDiagnostics();
  const report = () => onDiagnostics?.({ ...diagnostics });
  const setFailure = (reason: string) => {
    diagnostics.failureReason = reason;
    report();
  };

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", guid);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(guid, (status) => {
    diagnostics.bagFetchStatus = status;
    report();
  });
  // fetchBag normalizes advertised URLs. Keep the fallback native endpoint's
  // established trailing slash while also handling callers that provide a
  // legacy bag URL directly.
  const authURL =
    bag.authURL === defaultAuthURL
      ? bag.authURL
      : normalizeAuthURL(bag.authURL);
  const authEndpoint = new URL(authURL);
  authEndpoint.searchParams.set("guid", guid);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;
  diagnostics.resolvedAuthEndpoint = safeAuthEndpoint(requestHost, requestPath);
  report();

  // When the bag advertises the SAP signing protocol, every request to the
  // auth endpoint must carry X-Apple-ActionSignature over its body bytes.
  // The signer sees only the hardware ID and public Apple assets — never the
  // password — because signing happens here in the browser.
  let sapSigner: SapSigner | null = null;
  if (bag.sapEndpoints) {
    diagnostics.sapAssetReadiness = "loading";
    report();
    let assets;
    try {
      assets = await loadSapAssets();
      diagnostics.sapAssetReadiness = "ready";
      report();
    } catch (error) {
      diagnostics.sapAssetReadiness = "failed";
      setFailure("sap-assets-unavailable");
      throw error;
    }
    diagnostics.wispConnection = "initializing";
    report();
    try {
      sapSigner = await createSapSigner({
        ...bag.sapEndpoints,
        hardwareID: hardwareIdBytes(guid),
        assets,
      });
      diagnostics.wispConnection = "ready";
      report();
    } catch (error) {
      diagnostics.wispConnection = "failed";
      setFailure("sap-signing-unavailable");
      throw error;
    }
  }

  let currentAttempt = 0;
  let redirectAttempt = 0;

  while (currentAttempt < MAX_AUTH_ATTEMPTS && redirectAttempt <= MAX_REDIRECTS) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId: email,
        attempt: code ? "2" : "1",
        guid,
        password: code ? `${password}${code}` : password,
        rmp: "0",
        why: "signIn",
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      };

      if (sapSigner) {
        // The signature must cover the exact bytes on the wire; libcurl sends
        // the body string as UTF-8, so sign its encoded form.
        headers["X-Apple-ActionSignature"] = await sapSigner.sign(
          new TextEncoder().encode(plistBody),
        );
      }

      const response = await appleRequest({
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies,
        onWispStateChange: (state) => {
          diagnostics.wispConnection = state;
          if (state === "failed") {
            diagnostics.failureReason = "wisp-unavailable";
          }
          report();
        },
      });

      diagnostics.lastAppleStatusCode = response.status;
      diagnostics.retryDelayMs = undefined;
      report();

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;
      diagnostics.pod = pod;
      diagnostics.storefront = storeFront || undefined;
      report();

      if (
        isTransientAuthStatus(response.status) &&
        currentAttempt < MAX_AUTH_ATTEMPTS
      ) {
        const delayMs = retryAfterDelay(response.headers, currentAttempt - 1);
        diagnostics.retryCount = currentAttempt;
        diagnostics.retryDelayMs = delayMs;
        report();
        await waitForRetry(delayMs);
        continue;
      }

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          setFailure("redirect-location-missing");
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const currentURL = new URL(`https://${requestHost}${requestPath}`);
        const url = new URL(location, currentURL);
        const normalizedURL = new URL(normalizeAuthURL(url.toString()));
        requestHost = normalizedURL.hostname;
        requestPath = normalizedURL.pathname + normalizedURL.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        setFailure(`HTTP ${response.status}`);
        throw new Error(`Apple authentication returned HTTP ${response.status}`);
      }

      // Handle non-plist responses (e.g. 204 with an empty body)
      if (!response.body.trim()) {
        setFailure(`HTTP ${response.status} empty response`);
        throw new Error(
          `${i18n.t("errors.auth.emptyBody", { status: response.status })} ` +
            `(host=${requestHost}, sap=${sapSigner ? "enabled" : "disabled"})`,
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        setFailure("two-factor-required");
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        setFailure("account-info-missing");
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        setFailure("account-address-missing");
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      await sapSigner?.close().catch(() => undefined);
      sapSigner = null;
      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        await sapSigner?.close().catch(() => undefined);
        throw e;
      }
      if (!diagnostics.failureReason) {
        setFailure("authentication-failed");
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  await sapSigner?.close().catch(() => undefined);
  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}
