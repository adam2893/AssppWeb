import type { Account, Software, DownloadOutput, Sinf } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import type { StoreDownloadEndpoint } from "./config";
import {
  RETRYABLE_FAILURE_TYPE,
  volumeStoreEndpoint,
  redownloadEndpoint,
  updateProductEndpoint,
} from "./config";
import i18n from "../i18n";

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

  // Explicit ordered chain — provably bounded at 3 endpoints × 4 redirects max.
  const endpoints: StoreDownloadEndpoint[] = [
    volumeStoreEndpoint(account.pod, deviceId),
    redownloadEndpoint(deviceId),
    updateProductEndpoint(deviceId),
  ];
  let endpointIndex = 0;
  let cookies = [...account.cookies];

  while (endpointIndex < endpoints.length) {
    const endpoint = endpoints[endpointIndex];
    let requestHost = endpoint.host;
    let requestPath = endpoint.path;
    let redirectAttempt = 0;

    while (redirectAttempt <= 3) {
      const payload: Record<string, any> = {
        creditDisplay: "",
        guid: deviceId,
        salableAdamId: app.id,
      };

      if (externalVersionId) {
        payload[endpoint.externalVersionIdKey] = externalVersionId;
      }

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
          throw new DownloadError(i18n.t("errors.download.redirectLocation"));
        }
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        redirectAttempt++;
        continue;
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      if (dict.failureType) {
        const failureType = String(dict.failureType);

        // Retryable failure — advance to next endpoint in the chain.
        if (
          failureType === RETRYABLE_FAILURE_TYPE &&
          endpointIndex < endpoints.length - 1
        ) {
          endpointIndex++;
          break;
        }

        const customerMessage = dict.customerMessage as string | undefined;
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
              "9610",
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
      if (!songList || songList.length === 0) {
        // Empty songList on an intermediate endpoint — advance the chain.
        if (endpointIndex < endpoints.length - 1) {
          endpointIndex++;
          break;
        }
        // All endpoints exhausted with no downloadable item.
        throw new DownloadError(i18n.t("errors.download.noItems"));
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

      // Build iTunesMetadata plist
      const metadataDict: Record<string, any> = { ...metadata };
      metadataDict["apple-id"] = account.email;
      metadataDict["userName"] = account.email;
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
        // No sinf data means the IPA was stored without FairPlay injection;
        // the download may not be installable on a real device.
        unlicensed: sinfs.length === 0,
      };
    }

    // Exited inner loop due to redirect limit.
    if (redirectAttempt > 3) {
      throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
    }
    // Otherwise we broke to advance endpointIndex — outer loop retries.
  }

  // All endpoints exhausted without a downloadable item.
  throw new DownloadError(i18n.t("errors.download.noItems"));
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}


