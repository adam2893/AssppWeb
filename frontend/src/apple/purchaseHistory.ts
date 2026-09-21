// Purchase history / owned apps via the legacy DAAP purchase daap endpoint.
// Protocol: 3 calls × 2 storefronts (34=mobile, 13=desktop) = 6 HTTP requests.
// Base URL: https://pd.itunes.apple.com/WebObjects/MZPurchaseDaap.woa/purchase

import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { fetchBag } from "./bag";
import { loadSapAssets } from "./sap/assets";
import { createSapSigner } from "./sap/client";
import type { SapSigner } from "./sap/signer";
import {
  writeDmapContainer,
  writeDmapUInt32,
  writeDmapUInt8,
  writeDmapString,
  writeDmapEmpty,
  parseDmap,
  findTag,
  findTags,
  readNumericValue,
} from "./dmap";
import type { DmapNode } from "./dmap";

// ── Constants ──────────────────────────────────────────────────────────────

const PURCHASE_DAAP_HOST = "pd.itunes.apple.com";
const PURCHASE_DAAP_PATH = "/WebObjects/MZPurchaseDaap.woa/purchase";

/** Storefront suffixes: 34 = iOS/tvOS, 13 = macOS. */
const STOREFRONT_SUFFIXES = ["34", "13"] as const;

/** DAAP query for all app types (mobile, Arcade, Mac). */
const DAAP_QUERY =
  "('com.apple.itunes.extended\\-media\\-kind:131072','com.apple.itunes.extended\\-media\\-kind:262144','com.apple.itunes.extended\\-media\\-kind:67108864')";

// ── Types ──────────────────────────────────────────────────────────────────

export interface OwnedApp {
  /** Adam ID / item identifier. */
  adamId: number;
  /** Bundle identifier (e.g. "com.example.app"). */
  bundleId: string;
  /** Display name. */
  name: string;
  /** Version string. */
  version: string;
  /** Purchase date as Unix seconds. */
  purchaseDate: number;
  /** Media kind: 131072=mobile, 262144=Arcade, 67108864=Mac. */
  mediaKind: number;
  /** Platform bitmask: 1=iPhone, 2=iPad, 8=macOS, 16=visionOS. */
  platformBitmask: number;
}

export interface OwnedAppsResult {
  /** Merged, sorted (newest first), deduplicated apps. */
  apps: OwnedApp[];
  /** Updated cookies from the requests. */
  updatedCookies: Cookie[];
}

// ── DAAP session helpers ───────────────────────────────────────────────────

interface DaapSession {
  mlid: number;
  musr: number;
}

/**
 * POST /login — unsigned, no body, no Content-Type.
 * Returns DMAP; extracts mlog → mlid (session id).
 */
/**
 * Apple signals an expired password token EITHER as an HTTP 401/403 OR as a
 * DAAP `mstt` status. Both must be treated as auth failures.
 *
 * Checking only `mstt` is not enough: on an HTTP 401 the body is not valid
 * DMAP, so `parseDmap` returns `[]`, no `mstt` node exists, and the caller
 * would report a successful but silently EMPTY purchase list — indistinguishable
 * from "you own no apps".
 */
function assertNotExpired(status: number): void {
  if (status === 401 || status === 403) {
    throw new DaapAuthError("DAAP token expired");
  }
}

async function daapLogin(
  account: Account,
  storeFront: string,
  cookies: Cookie[],
): Promise<{ mlid: number; cookies: Cookie[] }> {
  const now = new Date();
  const headers = buildCommonHeaders(account, storeFront, now);
  // /login is unsigned — no X-Apple-ActionSignature.

  const response = await appleRequest({
    method: "POST",
    host: PURCHASE_DAAP_HOST,
    path: `${PURCHASE_DAAP_PATH}/login`,
    headers,
    cookies,
  });

  assertNotExpired(response.status);

  const mergedCookies = mergeResponseCookies(response.rawHeaders, cookies);

  const nodes = parseDmap(response.rawBody);
  const mlog = findTag(nodes, "mlog");
  if (!mlog) {
    throw new Error("DAAP login response missing mlog container");
  }
  const mlid = findTag(mlog.children, "mlid");
  if (!mlid || mlid.uint32Value === undefined) {
    throw new Error("DAAP login response missing mlid");
  }

  return { mlid: mlid.uint32Value, cookies: mergedCookies };
}

/**
 * POST /update — form body, SAP-signed.
 * Returns DMAP; extracts mupd → musr (revision number).
 */
async function daapUpdate(
  account: Account,
  storeFront: string,
  mlid: number,
  signer: SapSigner,
  cookies: Cookie[],
): Promise<{ musr: number; cookies: Cookie[] }> {
  const now = new Date();
  const bodyStr = `session-id=${mlid}&revision-number=(null)&query=${DAAP_QUERY}`;
  const bodyBytes = new TextEncoder().encode(bodyStr);

  const headers: Record<string, string> = {
    ...buildCommonHeaders(account, storeFront, now),
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Apple-ActionSignature": await signer.sign(bodyBytes),
  };

  const response = await appleRequest({
    method: "POST",
    host: PURCHASE_DAAP_HOST,
    path: `${PURCHASE_DAAP_PATH}/update`,
    headers,
    body: bodyStr,
    cookies,
  });

  assertNotExpired(response.status);

  const mergedCookies = mergeResponseCookies(response.rawHeaders, cookies);

  const nodes = parseDmap(response.rawBody);
  const mupd = findTag(nodes, "mupd");
  if (!mupd) {
    throw new Error("DAAP update response missing mupd container");
  }
  const musr = findTag(mupd.children, "musr");
  if (!musr || musr.uint32Value === undefined) {
    throw new Error("DAAP update response missing musr");
  }

  return { musr: musr.uint32Value, cookies: mergedCookies };
}

/**
 * POST /databases/{musr}/items — binary DMAP body, SAP-signed.
 * Returns DMAP with adbs → mlcl → repeated mlit items.
 */
async function daapItems(
  account: Account,
  storeFront: string,
  session: DaapSession,
  signer: SapSigner,
  cookies: Cookie[],
): Promise<{ items: OwnedApp[]; cookies: Cookie[] }> {
  const now = new Date();
  const dmapBody = buildItemsRequest(session);

  const headers: Record<string, string> = {
    ...buildCommonHeaders(account, storeFront, now),
    "Content-Type": "application/x-dmap-tagged",
    "X-Apple-ActionSignature": await signer.sign(dmapBody),
  };

  // appleRequest.body is typed as string, but libcurl.fetch accepts Uint8Array.
  // The double assertion is safe: libcurl will receive the raw bytes.
  const response = await appleRequest({
    method: "POST",
    host: PURCHASE_DAAP_HOST,
    path: `${PURCHASE_DAAP_PATH}/databases/${session.musr}/items`,
    headers,
    body: dmapBody as unknown as string,
    cookies,
  });

  assertNotExpired(response.status);

  const mergedCookies = mergeResponseCookies(response.rawHeaders, cookies);

  // Check top-level status
  const nodes = parseDmap(response.rawBody);
  const mstt = findTag(nodes, "mstt");
  if (mstt?.uint32Value === 401 || mstt?.uint32Value === 403) {
    throw new DaapAuthError("DAAP token expired");
  }

  const items = parseItemsResponse(nodes);
  return { items, cookies: mergedCookies };
}

// ── Request body builders ──────────────────────────────────────────────────

function buildItemsRequest(session: DaapSession): Uint8Array {
  const now = Math.floor(Date.now() / 1000);

  return writeDmapContainer("adsr", [
    writeDmapUInt32("mstc", now),
    writeDmapUInt32("mlid", session.mlid),
    writeDmapUInt8("mikd", 2),
    writeDmapUInt32("musr", session.musr),
    writeDmapUInt32("mder", 0),
    writeDmapString("mque", DAAP_QUERY),
    writeDmapEmpty("aetl"),
  ]);
}

// ── Response parsing ───────────────────────────────────────────────────────

function parseItemsResponse(nodes: DmapNode[]): OwnedApp[] {
  const adbs = findTag(nodes, "adbs");
  if (!adbs) return [];

  const mlcl = findTag(adbs.children, "mlcl");
  if (!mlcl) return [];

  const mlitNodes = findTags(mlcl.children, "mlit");
  const items: OwnedApp[] = [];

  for (const mlit of mlitNodes) {
    const aeSI = findTag(mlit.children, "aeSI");
    const aeBI = findTag(mlit.children, "aeBI");
    const aeLN = findTag(mlit.children, "aeLN");
    const minm = findTag(mlit.children, "minm");
    const aePd = findTag(mlit.children, "aePd");
    const asdp = findTag(mlit.children, "asdp");
    const aeMk = findTag(mlit.children, "aeMk");
    const aeSS = findTag(mlit.children, "aeSS");

    const adamId = aeSI ? readNumericValue(aeSI) : undefined;
    if (adamId === undefined) continue;

    items.push({
      adamId,
      bundleId: aeBI?.stringValue ?? "",
      name: aeLN?.stringValue ?? minm?.stringValue ?? "",
      version: aePd?.stringValue ?? "",
      purchaseDate: asdp?.uint32Value ?? 0,
      mediaKind: aeMk?.uint32Value ?? 0,
      platformBitmask: aeSS?.uint32Value ?? 0,
    });
  }

  return items;
}

// ── Headers ────────────────────────────────────────────────────────────────

function buildCommonHeaders(
  account: Account,
  storeFront: string,
  now: Date,
): Record<string, string> {
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOffset = -now.getTimezoneOffset();

  return {
    Accept: "*/*",
    "Accept-Language": "en-us",
    "Client-Cloud-DAAP-Request-Reason": "5",
    "Client-Cloud-Purchase-Daap-Version": "1.1/Configurator-2.0",
    "Client-DAAP-Version": "3.12",
    Date: now.toUTCString(),
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Apple-I-Client-Time": now.toISOString().replace(/\.\d{3}/, ""),
    "X-Apple-I-Locale": "en_US",
    "X-Apple-I-TimeZone": tzName,
    "X-Apple-Store-Front": storeFront,
    "X-Apple-TZ": String(tzOffset),
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Guid": account.deviceIdentifier.toUpperCase(),
    "X-Token": account.passwordToken,
  };
}

// ── Cookie helpers ─────────────────────────────────────────────────────────

function mergeResponseCookies(
  rawHeaders: [string, string][],
  existing: Cookie[],
): Cookie[] {
  const setCookies: string[] = [];
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === "set-cookie") {
      setCookies.push(value);
    }
  }
  if (setCookies.length === 0) return existing;

  const parsed = parseSetCookieHeaders(setCookies);
  return mergeCookies(existing, parsed);
}

function parseSetCookieHeaders(headers: string[]): Cookie[] {
  const cookies: Cookie[] = [];
  for (const header of headers) {
    const parts = header.split(";").map((s) => s.trim());
    if (parts.length === 0) continue;
    const eqIdx = parts[0].indexOf("=");
    if (eqIdx < 0) continue;
    const name = parts[0].substring(0, eqIdx).trim();
    const value = parts[0].substring(eqIdx + 1).trim();
    if (!name) continue;

    let path = "/";
    let domain: string | undefined;
    let expiresAt: number | undefined;
    let httpOnly = false;
    let secure = false;

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const attrEq = attr.indexOf("=");
      const attrName = (attrEq >= 0 ? attr.substring(0, attrEq) : attr)
        .trim()
        .toLowerCase();
      const attrVal = attrEq >= 0 ? attr.substring(attrEq + 1).trim() : "";
      switch (attrName) {
        case "path":
          path = attrVal || "/";
          break;
        case "domain":
          domain = attrVal.startsWith(".") ? attrVal.substring(1) : attrVal;
          break;
        case "max-age": {
          const maxAge = parseInt(attrVal, 10);
          if (!isNaN(maxAge)) {
            expiresAt = Date.now() / 1000 + maxAge;
          }
          break;
        }
        case "expires": {
          const d = new Date(attrVal);
          if (!isNaN(d.getTime())) {
            expiresAt = d.getTime() / 1000;
          }
          break;
        }
        case "httponly":
          httpOnly = true;
          break;
        case "secure":
          secure = true;
          break;
      }
    }
    cookies.push({ name, value, path, domain, expiresAt, httpOnly, secure });
  }
  return cookies;
}

function mergeCookies(existing: Cookie[], newCookies: Cookie[]): Cookie[] {
  const dict = new Map<string, Cookie>();
  for (const c of existing) dict.set(c.name, c);
  for (const c of newCookies) dict.set(c.name, c);
  return Array.from(dict.values());
}

// ── Error types ────────────────────────────────────────────────────────────

export class DaapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaapAuthError";
  }
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Fetch all owned apps for the given account across both storefronts
 * (iOS/tvOS and macOS). Returns merged, deduplicated, sorted results.
 *
 * On 401/403 (token expired), retries once after doing nothing (the caller
 * should re-login and call again — we just surface the error).
 */
export async function fetchOwnedApps(account: Account): Promise<OwnedAppsResult> {
  const storeFrontBase = account.store;
  let allCookies = [...account.cookies];
  const allItems: OwnedApp[] = [];

  // Create SAP signer from bag endpoints.
  const bag = await fetchBag(account.deviceIdentifier);
  let sapSigner: SapSigner | null = null;
  if (bag.sapEndpoints) {
    const assets = await loadSapAssets();
    sapSigner = await createSapSigner({
      ...bag.sapEndpoints,
      hardwareID: new TextEncoder().encode(account.deviceIdentifier),
      assets,
    });
  }

  try {
    for (const suffix of STOREFRONT_SUFFIXES) {
      const storeFront = `${storeFrontBase},-1,${suffix}`;

      // Step 1: Login (unsigned)
      const { mlid, cookies: loginCookies } = await daapLogin(
        account,
        storeFront,
        allCookies,
      );
      allCookies = loginCookies;

      // Step 2: Update (SAP-signed)
      if (!sapSigner) {
        throw new Error("SAP signer not available — cannot sign DAAP requests");
      }
      const { musr, cookies: updateCookies } = await daapUpdate(
        account,
        storeFront,
        mlid,
        sapSigner,
        allCookies,
      );
      allCookies = updateCookies;

      // Step 3: Items (SAP-signed)
      const { items, cookies: itemsCookies } = await daapItems(
        account,
        storeFront,
        { mlid, musr },
        sapSigner,
        allCookies,
      );
      allCookies = itemsCookies;

      allItems.push(...items);
    }
  } catch (error) {
    if (error instanceof DaapAuthError) {
      // Re-throw auth errors — caller should re-login.
      throw error;
    }
    throw error;
  } finally {
    await sapSigner?.close().catch(() => undefined);
  }

  const merged = mergeOwnedApps(allItems);
  return { apps: merged, updatedCookies: allCookies };
}

/**
 * Merge apps from multiple storefronts: union by adamId, keeping the max
 * purchase date and union of platform bitmasks. Sort by purchase date
 * descending.
 */
export function mergeOwnedApps(apps: OwnedApp[]): OwnedApp[] {
  const map = new Map<number, OwnedApp>();

  for (const app of apps) {
    const existing = map.get(app.adamId);
    if (!existing) {
      map.set(app.adamId, { ...app });
    } else {
      existing.purchaseDate = Math.max(existing.purchaseDate, app.purchaseDate);
      existing.platformBitmask |= app.platformBitmask;
      // Keep the first-seen name/bundleId/version/mediaKind (they should be
      // identical across storefronts).
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.purchaseDate - a.purchaseDate,
  );
}

/**
 * Page the given sorted app list in memory.
 * Returns the slice for the requested page.
 */
export function pageOwnedApps(
  apps: OwnedApp[],
  page: number,
  pageSize: number,
): OwnedApp[] {
  const start = page * pageSize;
  return apps.slice(start, start + pageSize);
}