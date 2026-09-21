import { open as openZip } from "yauzl-promise";
import { parsePlistBuffer, streamToBuffer } from "./sinfInjector.js";

export type PlatformId = "iphone" | "ipad" | "appletv";

const PLATFORM_TO_EXPECTED: Record<PlatformId, string> = {
  iphone: "iPhoneOS",
  ipad: "iPhoneOS",
  appletv: "AppleTVOS",
};

/**
 * The MAIN app bundle's Info.plist, and nothing else.
 *
 * Anchored deliberately: a loose `endsWith("/Info.plist")` match also selects an
 * app extension's plist (`Payload/My.app/PlugIns/Ext.appex/Info.plist`) or a
 * nested Watch bundle, and adm-zip/yauzl return entries in central-directory
 * order — so a valid app whose extension entry comes first would be rejected.
 */
const APP_INFO_PLIST_RE = /^Payload\/[^/]+\.app\/Info\.plist$/;

/** The archive is readable and the platforms genuinely differ. */
export class PlatformValidationError extends Error {
  public readonly expected: string;
  public readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Platform mismatch: expected "${expected}", found "${actual}" in IPA`);
    this.name = "PlatformValidationError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The package could not be inspected at all — not a ZIP, no app Info.plist, or
 * an unparseable plist.
 *
 * Kept DISTINCT from PlatformValidationError so a corrupt download is not
 * reported to the user as "you picked the wrong platform".
 */
export class IpaInspectionError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(`Could not inspect the downloaded package: ${reason}`);
    this.name = "IpaInspectionError";
    this.reason = reason;
  }
}

/**
 * Validate that the IPA at `filePath` declares a platform matching `platform`.
 *
 * Reads only the single `Info.plist` entry through a STREAMING zip reader, so a
 * multi-GB IPA is never buffered whole (the download path streams to disk, and
 * `MAX_DOWNLOAD_MB` defaults to unlimited).
 *
 * Handles BOTH binary and XML plists via `parsePlistBuffer` — App Store IPAs
 * commonly ship a binary Info.plist, and an XML-only parse reports a bogus
 * mismatch for a perfectly valid package.
 */
export async function validatePlatform(
  filePath: string,
  platform: PlatformId,
): Promise<void> {
  const expected = PLATFORM_TO_EXPECTED[platform];

  let zip: Awaited<ReturnType<typeof openZip>>;
  try {
    zip = await openZip(filePath);
  } catch {
    throw new IpaInspectionError("not a readable ZIP archive");
  }

  try {
    let infoPlistBuffer: Buffer | null = null;

    for await (const entry of zip) {
      if (!APP_INFO_PLIST_RE.test(entry.filename)) continue;
      try {
        infoPlistBuffer = await streamToBuffer(await entry.openReadStream());
      } catch {
        throw new IpaInspectionError("Info.plist could not be read");
      }
      break;
    }

    if (!infoPlistBuffer) {
      throw new IpaInspectionError(
        "no Payload/<App>.app/Info.plist in the archive",
      );
    }

    const infoPlist = parsePlistBuffer(infoPlistBuffer);
    if (!infoPlist) {
      throw new IpaInspectionError("Info.plist could not be parsed");
    }

    const raw = infoPlist.CFBundleSupportedPlatforms;
    // Tolerate a bare string as well as the normal array form.
    const supported = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string"
        ? [raw]
        : [];

    if (supported.length === 0) {
      throw new IpaInspectionError(
        "CFBundleSupportedPlatforms is missing or empty",
      );
    }

    // A universal (tvOS + iOS) app lists SEVERAL platforms and any match is
    // valid. Comparing only index 0 rejected multi-platform apps outright.
    if (!supported.includes(expected)) {
      throw new PlatformValidationError(expected, supported.join(", "));
    }
  } finally {
    await zip.close();
  }
}
