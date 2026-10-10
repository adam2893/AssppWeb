import type { Account, Software } from "../types";
import { storeIdToCountry } from "./config";
import { appleRequest } from "./request";

export function isRecoverableEmptyResponse(
  status: number,
  dict: Record<string, unknown>,
): boolean {
  if (
    status !== 200 ||
    dict.failureType ||
    (Array.isArray(dict.songList) && dict.songList.length > 0)
  ) {
    return false;
  }

  const message =
    typeof dict.customerMessage === "string"
      ? dict.customerMessage.trim().toLowerCase()
      : "";
  return (
    !message ||
    message === "no longer available" ||
    message.endsWith(" no longer available")
  );
}

/**
 * Resolve the latest iOS version from the account's storefront.  This request
 * deliberately carries no account cookies or authentication headers: the MDM
 * catalog is public metadata, while the selected version is subsequently sent
 * only through the Apple download tunnel.
 */
export async function lookupLatestVersion(
  account: Account,
  app: Software,
): Promise<string> {
  const storefront = account.store.split("-", 1)[0];
  const country = storeIdToCountry(storefront);
  if (!country) throw new Error("Unknown account storefront");

  for (const platform of ["enterprisestore", "iphone", "ipad"]) {
    const query = new URLSearchParams({
      version: "2",
      id: String(app.id),
      p: "mdm-lockup",
      caller: "MDM",
      platform,
      cc: country.toLowerCase(),
      l: "en",
    });

    const response = await appleRequest({
      method: "GET",
      host: "uclient-api.itunes.apple.com",
      path: `/WebObjects/MZStorePlatform.woa/wa/lookup?${query.toString()}`,
    });
    if (response.status !== 200) {
      throw new Error(`Catalog HTTP ${response.status}`);
    }

    let data: any;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error("Catalog returned invalid JSON");
    }

    const item = data?.results?.[String(app.id)];
    if (!item || !Array.isArray(item.offers) || item.offers.length === 0) {
      continue;
    }
    if (app.bundleID && item.bundleId !== app.bundleID) {
      throw new Error("Catalog returned a different bundle identifier");
    }

    const offer = item.offers[0];
    const externalId = offer?.version?.externalId;
    const buyParams = new URLSearchParams(offer?.buyParams ?? "");
    const version = String(externalId ?? buyParams.get("appExtVrsId") ?? "");
    if (/^[1-9]\d*$/.test(version)) return version;
    throw new Error("Catalog returned no valid iOS version identifier");
  }

  throw new Error("App not found in account storefront catalogs");
}
