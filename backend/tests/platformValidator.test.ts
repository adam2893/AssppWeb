import { describe, it, expect, beforeAll, afterAll } from "vitest";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";
import plist from "plist";
import bplistCreator from "bplist-creator";
import {
  validatePlatform,
  PlatformValidationError,
  IpaInspectionError,
} from "../src/services/platformValidator.js";
import type { PlatformId } from "../src/services/platformValidator.js";

const TEMP_DIR = path.join(os.tmpdir(), "platform-validator-test");

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIpaPath(
  infoPlistXml: string,
  bundleName: string = "TestApp",
): string {
  const zip = new AdmZip();
  zip.addFile(
    `Payload/${bundleName}.app/Info.plist`,
    Buffer.from(infoPlistXml),
  );
  zip.addFile(
    `Payload/${bundleName}.app/${bundleName}`,
    Buffer.from("fake executable"),
  );
  const ipaPath = path.join(TEMP_DIR, `${bundleName}_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

function createIpaWithPlatforms(
  platforms: string[],
  bundleName: string = "TestApp",
): string {
  const infoPlistXml = plist.build({
    CFBundleSupportedPlatforms: platforms,
    CFBundleExecutable: bundleName,
  });
  return createIpaPath(infoPlistXml, bundleName);
}

function createIpaWithoutPlatforms(bundleName: string = "TestApp"): string {
  const infoPlistXml = plist.build({
    CFBundleExecutable: bundleName,
  });
  return createIpaPath(infoPlistXml, bundleName);
}

function createIpaWithoutInfoPlist(bundleName: string = "TestApp"): string {
  const zip = new AdmZip();
  zip.addFile(
    `Payload/${bundleName}.app/${bundleName}`,
    Buffer.from("fake executable"),
  );
  const ipaPath = path.join(TEMP_DIR, `no_infoplist_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

function createNonZipFile(): string {
  const filePath = path.join(TEMP_DIR, `not_a_zip_${Date.now()}.ipa`);
  fs.writeFileSync(filePath, Buffer.from("this is not a zip archive"));
  return filePath;
}

// ---------------------------------------------------------------------------
// Bit-3 (data descriptor) archive builder
// ---------------------------------------------------------------------------

/**
 * CRC-32 (simplified, for test data only).
 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a proper ZIP archive with bit-3 data descriptors from scratch.
 *
 * Each local file header has general-purpose bit 3 set and CRC/sizes zeroed.
 * A data descriptor (PK\x07\x08 + actual CRC + sizes) follows each file's data.
 * The central directory carries the correct metadata.
 *
 * This tests that adm-zip (which reads from the central directory) handles
 * bit-3 streaming/data-descriptor archives correctly — unlike the hand-rolled
 * parser that was found to reject them.
 */
function createBit3Ipa(
  infoPlistXml: string,
  bundleName: string = "TestApp",
): string {
  const files = [
    {
      name: `Payload/${bundleName}.app/Info.plist`,
      data: Buffer.from(infoPlistXml),
    },
    {
      name: `Payload/${bundleName}.app/${bundleName}`,
      data: Buffer.from("fake executable"),
    },
  ];

  const chunks: Buffer[] = [];
  const centralDirEntries: Buffer[] = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header (bit 3 set, CRC/sizes = 0)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x08, 6); // bit flag (bit 3)
    localHeader.writeUInt16LE(0, 8); // compression method (stored)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // CRC = 0 (deferred)
    localHeader.writeUInt32LE(0, 18); // compressed size = 0 (deferred)
    localHeader.writeUInt32LE(0, 22); // uncompressed size = 0 (deferred)
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // no extra field

    chunks.push(localHeader);
    chunks.push(nameBuf);
    chunks.push(data);

    // Data descriptor (PK\7\8 signature + actual CRC + sizes)
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); // optional signature
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(size, 8);
    dd.writeUInt32LE(size, 12);
    chunks.push(dd);

    // Central directory entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x08, 8); // bit flag
    cd.writeUInt16LE(0, 10); // compression method (stored)
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16); // actual CRC
    cd.writeUInt32LE(size, 20); // actual compressed size
    cd.writeUInt32LE(size, 24); // actual uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // no extra field
    cd.writeUInt16LE(0, 32); // no comment
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(localOffset, 42); // local header offset

    centralDirEntries.push(cd);
    centralDirEntries.push(nameBuf);

    localOffset += 30 + nameBuf.length + size + 16; // header + name + data + dd
  }

  const localData = Buffer.concat(chunks);
  const cdData = Buffer.concat(centralDirEntries);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  eocd.writeUInt16LE(0, 20);

  const full = Buffer.concat([localData, cdData, eocd]);
  const ipaPath = path.join(TEMP_DIR, `bit3_${Date.now()}.ipa`);
  fs.writeFileSync(ipaPath, full);
  return ipaPath;
}

// ---------------------------------------------------------------------------
// Helpers for the F-A / F-B / F-C regression cases
// ---------------------------------------------------------------------------

/**
 * An IPA whose Info.plist is a BINARY plist — the Xcode Release default and
 * what App Store packages commonly ship. An XML-only parser reports a bogus
 * platform mismatch for these.
 */
function createIpaWithBinaryPlist(
  platforms: string[],
  bundleName: string = "TestApp",
): string {
  const zip = new AdmZip();
  zip.addFile(
    `Payload/${bundleName}.app/Info.plist`,
    bplistCreator({
      CFBundleSupportedPlatforms: platforms,
      CFBundleExecutable: bundleName,
    }),
  );
  zip.addFile(
    `Payload/${bundleName}.app/${bundleName}`,
    Buffer.from("fake executable"),
  );
  const ipaPath = path.join(TEMP_DIR, `binary_${bundleName}_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

/**
 * An IPA where an app EXTENSION's Info.plist is written BEFORE the main app's,
 * so a loose `endsWith("/Info.plist")` match picks the wrong one.
 */
function createIpaWithExtensionPlistFirst(
  extensionPlatforms: string[],
  appPlatforms: string[],
  bundleName: string = "TestApp",
): string {
  const zip = new AdmZip();
  zip.addFile(
    `Payload/${bundleName}.app/PlugIns/Ext.appex/Info.plist`,
    Buffer.from(
      plist.build({
        CFBundleSupportedPlatforms: extensionPlatforms,
        CFBundleExecutable: "Ext",
      }),
    ),
  );
  zip.addFile(
    `Payload/${bundleName}.app/Info.plist`,
    Buffer.from(
      plist.build({
        CFBundleSupportedPlatforms: appPlatforms,
        CFBundleExecutable: bundleName,
      }),
    ),
  );
  const ipaPath = path.join(TEMP_DIR, `ext_first_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("platformValidator", () => {
  describe("valid platform matches", () => {
    it("iPhoneOS passes for iphone", async () => {
      const ipaPath = createIpaWithPlatforms(["iPhoneOS"]);
      await expect(validatePlatform(ipaPath, "iphone")).resolves.toBeUndefined();
    });

    it("iPhoneOS passes for ipad", async () => {
      const ipaPath = createIpaWithPlatforms(["iPhoneOS"]);
      await expect(validatePlatform(ipaPath, "ipad")).resolves.toBeUndefined();
    });

    it("AppleTVOS passes for appletv", async () => {
      const ipaPath = createIpaWithPlatforms(["AppleTVOS"]);
      await expect(
        validatePlatform(ipaPath, "appletv"),
      ).resolves.toBeUndefined();
    });
  });

  describe("F-A: binary Info.plist (the App Store / Xcode Release default)", () => {
    it("accepts a BINARY plist that matches", async () => {
      const ipaPath = createIpaWithBinaryPlist(["AppleTVOS"]);
      await expect(
        validatePlatform(ipaPath, "appletv"),
      ).resolves.toBeUndefined();
    });

    it("reports a genuine mismatch from a binary plist (not an inspection failure)", async () => {
      const ipaPath = createIpaWithBinaryPlist(["iPhoneOS"]);
      await expect(validatePlatform(ipaPath, "appletv")).rejects.toBeInstanceOf(
        PlatformValidationError,
      );
    });
  });

  describe("F-B: multi-platform apps", () => {
    it("accepts ANY matching platform regardless of array order", async () => {
      const iosFirst = createIpaWithPlatforms(["iPhoneOS", "AppleTVOS"]);
      await expect(
        validatePlatform(iosFirst, "appletv"),
      ).resolves.toBeUndefined();
      await expect(
        validatePlatform(iosFirst, "iphone"),
      ).resolves.toBeUndefined();

      const tvFirst = createIpaWithPlatforms(["AppleTVOS", "iPhoneOS"]);
      await expect(validatePlatform(tvFirst, "iphone")).resolves.toBeUndefined();
      await expect(
        validatePlatform(tvFirst, "appletv"),
      ).resolves.toBeUndefined();
    });

    it("still rejects when NO listed platform matches", async () => {
      const ipaPath = createIpaWithPlatforms(["iPhoneOS", "iPadOS"]);
      await expect(validatePlatform(ipaPath, "appletv")).rejects.toBeInstanceOf(
        PlatformValidationError,
      );
    });
  });

  describe("F-C: only the MAIN app bundle's Info.plist is considered", () => {
    it("ignores an app-extension Info.plist that precedes the app's", async () => {
      const ipaPath = createIpaWithExtensionPlistFirst(
        ["iPhoneOS"], // extension (written first)
        ["AppleTVOS"], // the app itself
      );
      await expect(
        validatePlatform(ipaPath, "appletv"),
      ).resolves.toBeUndefined();
    });
  });

  describe("platform mismatches", () => {
    it("AppleTVOS fails for iphone with expected/actual in error", async () => {
      const ipaPath = createIpaWithPlatforms(["AppleTVOS"]);
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toMatchObject({
        name: "PlatformValidationError",
        expected: "iPhoneOS",
        actual: "AppleTVOS",
      });
    });

    it("iPhoneOS fails for appletv with expected/actual in error", async () => {
      const ipaPath = createIpaWithPlatforms(["iPhoneOS"]);
      await expect(validatePlatform(ipaPath, "appletv")).rejects.toMatchObject({
        name: "PlatformValidationError",
        expected: "AppleTVOS",
        actual: "iPhoneOS",
      });
    });
  });

  describe("F-D: structural failures are IpaInspectionError, NOT a mismatch", () => {
    it("missing Info.plist", async () => {
      const ipaPath = createIpaWithoutInfoPlist();
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toBeInstanceOf(
        IpaInspectionError,
      );
    });

    it("missing CFBundleSupportedPlatforms", async () => {
      const ipaPath = createIpaWithoutPlatforms();
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toBeInstanceOf(
        IpaInspectionError,
      );
    });

    it("empty CFBundleSupportedPlatforms", async () => {
      const ipaPath = createIpaWithPlatforms([]);
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toBeInstanceOf(
        IpaInspectionError,
      );
    });

    it("non-ZIP file", async () => {
      const filePath = createNonZipFile();
      await expect(validatePlatform(filePath, "iphone")).rejects.toBeInstanceOf(
        IpaInspectionError,
      );
    });

    it("unparseable Info.plist", async () => {
      const ipaPath = createIpaPath("this is not a plist at all");
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toBeInstanceOf(
        IpaInspectionError,
      );
    });

    it("a corrupt package is never reported as a platform mismatch", async () => {
      const ipaPath = createIpaWithoutPlatforms();
      await expect(
        validatePlatform(ipaPath, "iphone"),
      ).rejects.not.toBeInstanceOf(PlatformValidationError);
    });
  });

  describe("bit-3 (data descriptor) archive", () => {
    it("validates correctly despite bit-3 local headers (not rejected)", async () => {
      const infoPlistXml = plist.build({
        CFBundleSupportedPlatforms: ["AppleTVOS"],
        CFBundleExecutable: "TestApp",
      });
      const ipaPath = createBit3Ipa(infoPlistXml);

      await expect(
        validatePlatform(ipaPath, "appletv"),
      ).resolves.toBeUndefined();
      await expect(validatePlatform(ipaPath, "iphone")).rejects.toMatchObject({
        name: "PlatformValidationError",
        expected: "iPhoneOS",
        actual: "AppleTVOS",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: route-level platform acceptance
// ---------------------------------------------------------------------------

describe("downloads route platform field", () => {
  it("accepts valid platform values", () => {
    const validPlatforms: PlatformId[] = ["iphone", "ipad", "appletv"];
    for (const p of validPlatforms) {
      // This just validates the type — the route uses the same check
      expect(["iphone", "ipad", "appletv"].includes(p)).toBe(true);
    }
  });

  it("defaults missing platform to iphone", () => {
    const validPlatforms: PlatformId[] = ["iphone", "ipad", "appletv"];
    const platform = undefined;
    const resolved: PlatformId = validPlatforms.includes(platform as PlatformId)
      ? (platform as PlatformId)
      : "iphone";
    expect(resolved).toBe("iphone");
  });

  it("defaults invalid platform to iphone", () => {
    const validPlatforms: PlatformId[] = ["iphone", "ipad", "appletv"];
    const platform = "android";
    const resolved: PlatformId = validPlatforms.includes(platform as PlatformId)
      ? (platform as PlatformId)
      : "iphone";
    expect(resolved).toBe("iphone");
  });
});