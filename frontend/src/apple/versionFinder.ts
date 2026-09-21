import type { Account, Software } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";
import type { PlatformId } from "./platform";
import { PLATFORMS } from "./platform";

/**
 * Resolve the latest version external ID via the MZStorePlatform lookup
 * endpoint. Returns the externalId from the offers array, falling back to
 * appExtVrsId from buyParams.
 *
 * For mobile platforms (iphone/ipad), retries with iphone then ipad catalogs
 * when the primary catalog (enterprisestore) yields nothing.
 */
async function lookupPlatformVersion(
  appId: number,
  country: string,
  platform: PlatformId,
): Promise<string> {
  const def = PLATFORMS[platform];
  const url = new URL(
    "https://uclient-api.itunes.apple.com/WebObjects/MZStorePlatform.woa/wa/lookup",
  );
  url.searchParams.set("version", "2");
  url.searchParams.set("id", String(appId));
  url.searchParams.set("p", "mdm-lockup");
  url.searchParams.set("caller", "MDM");
  url.searchParams.set("platform", def.versionCatalog);
  url.searchParams.set("cc", country);
  url.searchParams.set("l", "en");

  // Try the primary catalog first.
  const result = await tryCatalog(url, appId);
  if (result) return result;

  // For mobile platforms, retry with iphone then ipad catalogs.
  if (platform === "iphone" || platform === "ipad") {
    for (const fallback of ["iphone", "ipad"] as PlatformId[]) {
      url.searchParams.set("platform", fallback);
      const fbResult = await tryCatalog(url, appId);
      if (fbResult) return fbResult;
    }
  }

  throw new Error(
    `No version data found for app ${appId} on ${platform}`,
  );
}

/** Attempt a single catalog lookup; returns the version ID or null. */
async function tryCatalog(
  url: URL,
  appId: number,
): Promise<string | null> {
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  const data = await resp.json() as any;
  const result = data?.results?.[String(appId)];
  if (!result) return null;
  return extractVersionId(result, appId);
}

function extractVersionId(
  result: any,
  appId: number,
): string {
  const offer = result.offers?.[0];
  if (offer?.version?.externalId) {
    return String(offer.version.externalId);
  }
  // Fallback: parse appExtVrsId from buyParams
  const buyParams: string = offer?.buyParams ?? "";
  const match = buyParams.match(/appExtVrsId=(\d+)/);
  if (match) {
    return match[1];
  }
  throw new Error(
    `No version identifier found for app ${appId} in MZStorePlatform response`,
  );
}

export async function listVersions(
  account: Account,
  app: Software,
  platform?: PlatformId,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  // When a platform is specified, use the MZStorePlatform endpoint to resolve
  // the latest version external ID, then return it as a single-element list.
  if (platform) {
    const versionId = await lookupPlatformVersion(
      app.id,
      account.store,
      platform,
    );
    return { versions: [versionId], updatedCookies: account.cookies };
  }
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
    };

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers["location"];
      if (!location) {
        throw new Error("Failed to retrieve redirect location");
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    const dict = parsePlist(response.body) as Record<string, any>;

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      if (dict.failureType) {
        const failureType = String(dict.failureType);

        // volumeStore intermittently returns 5002; retry once via the
        // redownload dispatch endpoint, which serves the same payload.
        if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
          triedRedownload = true;
          endpoint = redownloadEndpoint(deviceId);
          requestHost = endpoint.host;
          requestPath = endpoint.path;
          redirectAttempt = 0;
          continue;
        }

        switch (failureType) {
          case "2034":
            throw new Error("Password token is expired");
          case "9610":
            throw new Error("License required - purchase the app first");
          default: {
            const msg = dict.customerMessage as string | undefined;
            throw new Error(msg ?? "No items in response");
          }
        }
      }
      throw new Error("No items in response");
    }

    const item = songList[0];
    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new Error("Missing version identifiers");
    }

    const identifiers = metadata.softwareVersionExternalIdentifiers as any[];
    if (!identifiers) {
      throw new Error("Missing version identifiers");
    }

    const versions = identifiers.map((id) => String(id)).reverse();
    if (versions.length === 0) {
      throw new Error("No versions found");
    }

    return { versions, updatedCookies: cookies };
  }

  throw new Error("Too many redirects");
}
