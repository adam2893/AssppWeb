import type { Account, DownloadOutput, Sinf, Software } from "../types";
import i18n from "../i18n";
import type { StoreDownloadEndpoint } from "./config";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";
import { extractAndMergeCookies } from "./cookies";
import {
  isRecoverableEmptyResponse,
  lookupLatestVersion,
} from "./latestVersion";
import { appleRequest } from "./request";
import {
  parseDownloadResponse,
  recoverUpdateEndpoint,
} from "./downloadRecovery";
import { buildPlist } from "./plist";

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{
  output: DownloadOutput;
  updatedCookies: typeof account.cookies;
  unlicensed?: boolean;
}> {
  const deviceId = account.deviceIdentifier;
  let endpoint: StoreDownloadEndpoint = volumeStoreEndpoint(
    account.pod,
    deviceId,
  );
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let triedUpdate = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  const recoverViaRedownload = async () => {
    // An unpinned redownload can select a tvOS product. Resolve an iOS
    // external version in the account storefront before retrying it.
    if (!externalVersionId) {
      try {
        externalVersionId = await lookupLatestVersion(account, app);
      } catch {
        throw new DownloadError(i18n.t("errors.download.versionLookupFailed"));
      }
    }
    triedRedownload = true;
    endpoint = redownloadEndpoint(deviceId);
    requestHost = endpoint.host;
    requestPath = endpoint.path;
    redirectAttempt = 0;
  };

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      serialNumber: "0",
    };
    if (externalVersionId) {
      payload[endpoint.externalVersionIdKey] = externalVersionId;
    }

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers: {
        "Content-Type": "application/x-apple-plist",
        "iCloud-DSID": account.directoryServicesIdentifier,
        "X-Dsid": account.directoryServicesIdentifier,
      },
      body: buildPlist(payload),
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers["location"];
      if (!location) {
        throw new DownloadError(i18n.t("errors.download.redirectLocation"));
      }
      const currentURL = new URL(`https://${requestHost}${requestPath}`);
      const url = new URL(location, currentURL);
      requestHost = url.hostname;
      requestPath = `${url.pathname}${url.search}`;
      redirectAttempt++;
      continue;
    }

    let dict: Record<string, any> | undefined;
    let parseError: unknown;
    try {
      dict = parseDownloadResponse(response, requestHost, requestPath);
    } catch (error) {
      parseError = error;
    }

    // updateProduct is a single, narrowly-gated recovery after redownload.
    if (triedRedownload && !triedUpdate) {
      const update = await recoverUpdateEndpoint(response, dict, deviceId);
      if (update) {
        triedUpdate = true;
        endpoint = update;
        requestHost = endpoint.host;
        requestPath = endpoint.path;
        redirectAttempt = 0;
        continue;
      }
    }
    if (!dict) throw parseError;

    if (dict.failureType) {
      const failureType = String(dict.failureType);
      if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
        await recoverViaRedownload();
        continue;
      }

      const customerMessage =
        typeof dict.customerMessage === "string"
          ? dict.customerMessage
          : undefined;
      switch (failureType) {
        case "2034":
        case "2042":
          throw new DownloadError(
            i18n.t("errors.download.passwordExpired"),
            failureType,
          );
        case "9610":
          throw new DownloadError(
            i18n.t("errors.download.licenseRequired"),
            failureType,
          );
        default: {
          if (customerMessage === "Your password has changed.") {
            throw new DownloadError(
              i18n.t("errors.download.passwordExpired"),
              failureType,
            );
          }
          throw new DownloadError(
            customerMessage ??
              i18n.t("errors.download.downloadFailed", { failureType }),
            failureType,
          );
        }
      }
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!Array.isArray(songList) || songList.length === 0) {
      if (!triedRedownload && isRecoverableEmptyResponse(response.status, dict)) {
        await recoverViaRedownload();
        continue;
      }
      const message =
        typeof dict.customerMessage === "string"
          ? dict.customerMessage.trim()
          : "";
      throw new DownloadError(message || i18n.t("errors.download.noItems"));
    }

    const item = songList[0];
    const url = item.URL as string;
    if (!url) {
      throw new DownloadError(i18n.t("errors.download.missingUrl"));
    }

    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new DownloadError(i18n.t("errors.download.missingMetadata"));
    }

    if (
      triedRedownload &&
      (songList.length !== 1 ||
        String(metadata.itemId) !== String(app.id) ||
        String(metadata.softwareVersionExternalIdentifier) !==
          externalVersionId ||
        !metadata.softwareVersionBundleId ||
        (app.bundleID && metadata.softwareVersionBundleId !== app.bundleID))
    ) {
      throw new DownloadError(i18n.t("errors.download.unexpectedItem"));
    }

    const version = metadata.bundleShortVersionString as string;
    const bundleVersion = metadata.bundleVersion as string;
    if (!version || !bundleVersion) {
      throw new DownloadError(i18n.t("errors.download.missingVersion"));
    }

    const sinfs: Sinf[] = [];
    const sinfData = item.sinfs as Record<string, any>[] | undefined;
    if (sinfData) {
      for (const sinfItem of sinfData) {
        const id = sinfItem.id as number;
        const sinf = sinfItem.sinf;
        if (id !== undefined && sinf) {
          let sinfBase64: string;
          if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
            const bytes =
              sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
            sinfBase64 = base64FromBytes(bytes);
          } else if (typeof sinf === "string") {
            sinfBase64 = sinf;
          } else {
            throw new DownloadError(i18n.t("errors.download.invalidSinf"));
          }
          sinfs.push({ id, sinf: sinfBase64 });
        }
      }
    }

    const metadataDict: Record<string, any> = { ...metadata };
    metadataDict["apple-id"] = account.email;
    metadataDict.userName = account.email;
    delete metadataDict.passwordToken;
    delete metadataDict["passwordToken"];
    const iTunesMetadata = base64FromString(buildPlist(metadataDict));

    return {
      output: {
        downloadURL: url,
        sinfs,
        bundleShortVersionString: version,
        bundleVersion,
        iTunesMetadata,
      },
      updatedCookies: cookies,
      unlicensed: sinfs.length === 0,
    };
  }

  throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
}

function base64FromString(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
