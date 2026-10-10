import { fetchBag } from "./bag";
import type { StoreDownloadEndpoint } from "./config";
import type { AppleResponse } from "./request";
import { parsePlist } from "./plist";

/**
 * Parse an Apple download response without ever putting its body or query
 * string in an error.  Response bodies can contain cookies, tokens, and
 * account identifiers, so diagnostics deliberately contain only status and
 * the endpoint path.
 */
export function parseDownloadResponse(
  response: AppleResponse,
  host: string,
  path: string,
): Record<string, any> {
  try {
    const value = parsePlist(response.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Response is not a plist dictionary");
    }
    return value as Record<string, any>;
  } catch {
    const kind = response.body.trim() ? "invalid plist" : "empty response";
    throw new Error(
      `Apple download: HTTP ${response.status}; ${kind}; ${host}${path.split("?", 1)[0]}`,
    );
  }
}

/**
 * The updateProduct endpoint is advertised by Apple's bag.  It is only safe
 * to use the exact HTTPS endpoint Apple documents; accepting an arbitrary bag
 * URL would turn this recovery path into an SSRF primitive.
 */
export async function recoverUpdateEndpoint(
  response: AppleResponse,
  dict: Record<string, any> | undefined,
  deviceId: string,
): Promise<StoreDownloadEndpoint | undefined> {
  const empty500 = response.status === 500 && !response.body.trim();
  const message =
    typeof dict?.customerMessage === "string"
      ? dict.customerMessage.trim().toLowerCase()
      : "";
  const unavailable =
    response.status === 200 &&
    !!dict &&
    !dict.failureType &&
    (!Array.isArray(dict.songList) || dict.songList.length === 0) &&
    (message === "no longer available" || message.endsWith(" no longer available"));

  if (!empty500 && !unavailable) return undefined;

  const bag = await fetchBag(deviceId);
  if (!bag.updateURL) return undefined;

  let url: URL;
  try {
    url = new URL(bag.updateURL);
  } catch {
    return undefined;
  }

  const expected =
    "https://downloaddispatch.itunes.apple.com/up/updateProduct";
  if (
    bag.updateURL !== expected ||
    url.protocol !== "https:" ||
    url.host !== "downloaddispatch.itunes.apple.com" ||
    url.pathname !== "/up/updateProduct" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return undefined;
  }

  url.searchParams.set("guid", deviceId);
  return {
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    externalVersionIdKey: "appExtVrsId",
  };
}
