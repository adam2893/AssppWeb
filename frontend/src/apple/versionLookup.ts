import type { Account, Software, VersionMetadata } from "../types";
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
 * Resolve version metadata via the MZStorePlatform lookup endpoint.
 * Returns displayVersion and releaseDate from the response.
 *
 * For mobile platforms (iphone/ipad), retries with iphone then ipad catalogs
 * when the primary catalog (enterprisestore) yields nothing.
 */
async function lookupPlatformMetadata(
  appId: number,
  country: string,
  platform: PlatformId,
  _versionId: string,
): Promise<VersionMetadata> {
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
  const result = await tryCatalogForMetadata(url, appId);
  if (result) return result;

  // For mobile platforms, retry with iphone then ipad catalogs.
  if (platform === "iphone" || platform === "ipad") {
    for (const fallback of ["iphone", "ipad"] as PlatformId[]) {
      url.searchParams.set("platform", fallback);
      const fbResult = await tryCatalogForMetadata(url, appId);
      if (fbResult) return fbResult;
    }
  }

  throw new Error(
    `No version metadata found for app ${appId} on ${platform}`,
  );
}

/** Attempt a single catalog lookup; returns metadata or null. */
async function tryCatalogForMetadata(
  url: URL,
  appId: number,
): Promise<VersionMetadata | null> {
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  const data = await resp.json() as any;
  const result = data?.results?.[String(appId)];
  if (!result) return null;
  return extractMetadata(result);
}

function extractMetadata(result: any): VersionMetadata {
  const offer = result.offers?.[0];
  const version = offer?.version;
  return {
    displayVersion: version?.displayVersion ?? version?.externalId ?? "0",
    releaseDate: version?.releaseDate ?? new Date(0).toISOString(),
  };
}

export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
  platform?: PlatformId,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: typeof account.cookies;
}> {
  // When a platform is specified, resolve metadata via the MZStorePlatform
  // endpoint instead of the volumeStore chain.
  if (platform) {
    const metadata = await lookupPlatformMetadata(
      app.id,
      account.store,
      platform,
      versionId,
    );
    return { metadata, updatedCookies: account.cookies };
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
      [endpoint.externalVersionIdKey]: versionId,
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

    // volumeStore intermittently returns 5002; retry once via the redownload
    // dispatch endpoint, which serves the same payload.
    if (
      String(dict.failureType ?? "") === RETRYABLE_FAILURE_TYPE &&
      !triedRedownload
    ) {
      triedRedownload = true;
      endpoint = redownloadEndpoint(deviceId);
      requestHost = endpoint.host;
      requestPath = endpoint.path;
      redirectAttempt = 0;
      continue;
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      throw new Error("No items in response");
    }

    const item = songList[0];
    const itemMetadata = item.metadata as Record<string, any>;
    if (!itemMetadata) {
      throw new Error("Missing metadata");
    }

    const bundleShortVersionString =
      itemMetadata.bundleShortVersionString as string;
    if (!bundleShortVersionString) {
      throw new Error("Missing bundleShortVersionString");
    }

    const rawReleaseDate = itemMetadata.releaseDate;
    if (!rawReleaseDate) {
      throw new Error("Missing releaseDate");
    }
    const releaseDate =
      rawReleaseDate instanceof Date
        ? rawReleaseDate.toISOString()
        : String(rawReleaseDate);

    return {
      metadata: {
        displayVersion: bundleShortVersionString,
        releaseDate,
      },
      updatedCookies: cookies,
    };
  }

  throw new Error("Too many redirects");
}
