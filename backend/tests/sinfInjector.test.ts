import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inject } from "../src/services/sinfInjector.js";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import os from "os";
import plist from "plist";

const TEMP_DIR = path.join(os.tmpdir(), "sinf-injector-test");

beforeAll(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function createMockIPA(
  bundleName: string,
  opts?: {
    addManifest?: boolean;
    sinfPaths?: string[];
    executableName?: string;
  },
): string {
  const zip = new AdmZip();
  const execName = opts?.executableName ?? bundleName;

  const infoPlistXml = plist.build({
    CFBundleExecutable: execName,
    CFBundleIdentifier: `com.example.${bundleName.toLowerCase()}`,
  });
  zip.addFile(
    `Payload/${bundleName}.app/Info.plist`,
    Buffer.from(infoPlistXml),
  );
  zip.addFile(
    `Payload/${bundleName}.app/${execName}`,
    Buffer.from("fake executable"),
  );

  if (opts?.addManifest && opts?.sinfPaths) {
    const manifestPlistXml = plist.build({
      SinfPaths: opts.sinfPaths,
    });
    zip.addFile(
      `Payload/${bundleName}.app/SC_Info/Manifest.plist`,
      Buffer.from(manifestPlistXml),
    );
  }

  const ipaPath = path.join(TEMP_DIR, `${bundleName}_${Date.now()}.ipa`);
  zip.writeZip(ipaPath);
  return ipaPath;
}

// ---------------------------------------------------------------------------
// ZIP structure inspection helpers (raw binary parsing)
// ---------------------------------------------------------------------------

/** ZIP local file header signature */
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
/** Central directory file header signature */
const CENTRAL_DIR_SIG = 0x02014b50;
/** End of central directory record signature */
const END_CENTRAL_DIR_SIG = 0x06054b50;

/**
 * Read a 2-byte unsigned little-endian integer from a buffer at offset.
 */
function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

/**
 * Read a 4-byte unsigned little-endian integer from a buffer at offset.
 */
function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

/**
 * Parse all local file headers from a ZIP buffer and return their
 * general-purpose bit flags and metadata.
 */
function inspectLocalFileHeaders(
  data: Buffer,
): { fileName: string; bitFlag: number; offset: number }[] {
  const headers: { fileName: string; bitFlag: number; offset: number }[] = [];
  let offset = 0;

  while (offset + 30 <= data.length) {
    const sig = readUInt32LE(data, offset);
    if (sig !== LOCAL_FILE_HEADER_SIG) break;

    const bitFlag = readUInt16LE(data, offset + 6);
    const compressionMethod = readUInt16LE(data, offset + 8);
    const crc32 = readUInt32LE(data, offset + 14);
    const compressedSize = readUInt32LE(data, offset + 18);
    const uncompressedSize = readUInt32LE(data, offset + 22);
    const fileNameLen = readUInt16LE(data, offset + 26);
    const extraFieldLen = readUInt16LE(data, offset + 28);

    const fileName =
      fileNameLen > 0
        ? data.toString("utf-8", offset + 30, offset + 30 + fileNameLen)
        : "";

    headers.push({
      fileName,
      bitFlag,
      offset,
    });

    // Move past header + filename + extra field + compressed data
    const dataStart = offset + 30 + fileNameLen + extraFieldLen;
    if (compressionMethod === 0) {
      // Stored: compressedSize == uncompressedSize
      offset = dataStart + compressedSize;
    } else {
      // Deflated or other: skip by compressed size
      offset = dataStart + compressedSize;
    }
  }

  return headers;
}

/**
 * Find the end-of-central-directory record and return the central directory
 * offset and number of entries.
 */
function findCentralDirectory(
  data: Buffer,
): { centralDirOffset: number; totalEntries: number } | null {
  // Search backwards for EOCD signature (0x06054b50)
  // EOCD is at most 65557 bytes from the end (max comment length 65535 + 22)
  const searchStart = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= searchStart; i--) {
    const sig = readUInt32LE(data, i);
    if (sig === END_CENTRAL_DIR_SIG) {
      const totalEntries = readUInt16LE(data, i + 10);
      const centralDirSize = readUInt32LE(data, i + 12);
      const centralDirOffset = readUInt32LE(data, i + 16);
      return { centralDirOffset, totalEntries };
    }
  }
  return null;
}

/**
 * Count central directory entries by scanning for CD headers.
 */
function countCentralDirEntries(data: Buffer, startOffset: number): number {
  let count = 0;
  let offset = startOffset;
  while (offset + 46 <= data.length) {
    const sig = readUInt32LE(data, offset);
    if (sig !== CENTRAL_DIR_SIG) break;
    count++;
    const fileNameLen = readUInt16LE(data, offset + 28);
    const extraFieldLen = readUInt16LE(data, offset + 30);
    const commentLen = readUInt16LE(data, offset + 32);
    offset += 46 + fileNameLen + extraFieldLen + commentLen;
  }
  return count;
}

/**
 * Check whether a specific entry has general-purpose bit 3 set
 * (data descriptor present with deferred CRC/sizes).
 */
function hasBit3(bitFlag: number): boolean {
  return (bitFlag & 0x08) !== 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sinfInjector", () => {
  it("should inject sinf via Info.plist fallback (no manifest)", async () => {
    const ipaPath = createMockIPA("TestApp", { executableName: "TestApp" });
    const sinfData = Buffer.from("fake sinf data for testing").toString(
      "base64",
    );

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const sinfEntry = resultZip.getEntry(
      "Payload/TestApp.app/SC_Info/TestApp.sinf",
    );
    expect(sinfEntry).not.toBeNull();

    const sinfContent = resultZip.readFile(sinfEntry!);
    expect(sinfContent).not.toBeNull();
    expect(sinfContent!.toString()).toBe("fake sinf data for testing");
  });

  it("should read bundle name from .app directory", async () => {
    const ipaPath = createMockIPA("MyGreatApp");
    const sinfData = Buffer.from("sinf content").toString("base64");

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const sinfEntry = resultZip.getEntry(
      "Payload/MyGreatApp.app/SC_Info/MyGreatApp.sinf",
    );
    expect(sinfEntry).not.toBeNull();
  });

  it("should handle multiple sinfs with manifest", async () => {
    const ipaPath = createMockIPA("MultiSinf", {
      addManifest: true,
      sinfPaths: ["SC_Info/main.sinf", "SC_Info/extension.sinf"],
    });

    const sinf1 = Buffer.from("sinf data 1").toString("base64");
    const sinf2 = Buffer.from("sinf data 2").toString("base64");

    await inject(
      [
        { id: 1, sinf: sinf1 },
        { id: 2, sinf: sinf2 },
      ],
      ipaPath,
    );

    const resultZip = new AdmZip(ipaPath);

    const entry1 = resultZip.getEntry(
      "Payload/MultiSinf.app/SC_Info/main.sinf",
    );
    expect(entry1).not.toBeNull();
    expect(resultZip.readFile(entry1!)!.toString()).toBe("sinf data 1");

    const entry2 = resultZip.getEntry(
      "Payload/MultiSinf.app/SC_Info/extension.sinf",
    );
    expect(entry2).not.toBeNull();
    expect(resultZip.readFile(entry2!)!.toString()).toBe("sinf data 2");
  });

  it("should handle empty sinfs array with no-manifest fallback", async () => {
    const ipaPath = createMockIPA("EmptyTest");
    await inject([], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    const entries = resultZip
      .getEntries()
      .filter((e) => e.entryName.endsWith(".sinf"));
    expect(entries.length).toBe(0);
  });

  it("should throw if IPA has no .app directory", async () => {
    const zip = new AdmZip();
    zip.addFile("SomeFile.txt", Buffer.from("not an IPA"));
    const ipaPath = path.join(TEMP_DIR, "invalid.ipa");
    zip.writeZip(ipaPath);

    const sinfData = Buffer.from("sinf").toString("base64");
    await expect(
      inject([{ id: 1, sinf: sinfData }], ipaPath),
    ).rejects.toThrow();
  });

  it("should use different executable name from CFBundleExecutable", async () => {
    const ipaPath = createMockIPA("AppBundle", {
      executableName: "CustomExec",
    });
    const sinfData = Buffer.from("sinf").toString("base64");

    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    // Should use CFBundleExecutable (CustomExec), not bundle name (AppBundle)
    const sinfEntry = resultZip.getEntry(
      "Payload/AppBundle.app/SC_Info/CustomExec.sinf",
    );
    expect(sinfEntry).not.toBeNull();
  });

  it("should prefer manifest over Info.plist when both exist", async () => {
    const ipaPath = createMockIPA("WithManifest", {
      addManifest: true,
      sinfPaths: ["SC_Info/custom.sinf"],
      executableName: "WithManifest",
    });

    const sinfData = Buffer.from("manifest sinf").toString("base64");
    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const resultZip = new AdmZip(ipaPath);
    // Should inject at manifest-specified path, not Info.plist path
    const manifestEntry = resultZip.getEntry(
      "Payload/WithManifest.app/SC_Info/custom.sinf",
    );
    expect(manifestEntry).not.toBeNull();
    expect(resultZip.readFile(manifestEntry!)!.toString()).toBe(
      "manifest sinf",
    );
  });

  // -----------------------------------------------------------------------
  // Requirement 1: Empirical ZIP structure analysis
  // -----------------------------------------------------------------------
  it("should produce a structurally valid ZIP archive with no bit 3 set after injection", async () => {
    const ipaPath = createMockIPA("StructCheck", {
      addManifest: true,
      sinfPaths: ["SC_Info/main.sinf"],
      executableName: "StructCheck",
    });

    // Read the pre-injection bytes
    const preBytes = fs.readFileSync(ipaPath);

    const sinfData = Buffer.from("structural test sinf").toString("base64");
    await inject([{ id: 1, sinf: sinfData }], ipaPath);

    const postBytes = fs.readFileSync(ipaPath);

    // --- Check 1: Central directory is present and consistent ---
    const cd = findCentralDirectory(postBytes);
    expect(cd).not.toBeNull();
    expect(cd!.totalEntries).toBeGreaterThan(0);

    const countedEntries = countCentralDirEntries(
      postBytes,
      cd!.centralDirOffset,
    );
    expect(countedEntries).toBe(cd!.totalEntries);

    // --- Check 2: No local file header has general-purpose bit 3 set ---
    const localHeaders = inspectLocalFileHeaders(postBytes);
    expect(localHeaders.length).toBeGreaterThan(0);

    const entriesWithBit3 = localHeaders.filter((h) => hasBit3(h.bitFlag));
    expect(entriesWithBit3).toEqual([]);

    // --- Check 3: All entries are enumerable via adm-zip ---
    const resultZip = new AdmZip(ipaPath);
    const allEntries = resultZip.getEntries();
    expect(allEntries.length).toBe(cd!.totalEntries);

    // --- Check 4: The injected sinf entry is readable ---
    const sinfEntry = resultZip.getEntry(
      "Payload/StructCheck.app/SC_Info/main.sinf",
    );
    expect(sinfEntry).not.toBeNull();
    const sinfContent = resultZip.readFile(sinfEntry!);
    expect(sinfContent!.toString()).toBe("structural test sinf");

    // --- Check 5: CRC/sizes are filled in local headers (not deferred) ---
    // For stored entries (method 0), compressedSize == uncompressedSize
    // and CRC should be non-zero if data is present
    // We verify by reading the raw header fields
    let offset = 0;
    let foundSinf = false;
    while (offset + 30 <= postBytes.length) {
      const sig = readUInt32LE(postBytes, offset);
      if (sig !== LOCAL_FILE_HEADER_SIG) break;

      const crc32 = readUInt32LE(postBytes, offset + 14);
      const compressedSize = readUInt32LE(postBytes, offset + 18);
      const uncompressedSize = readUInt32LE(postBytes, offset + 22);
      const fileNameLen = readUInt16LE(postBytes, offset + 26);
      const fileName =
        fileNameLen > 0
          ? postBytes.toString("utf-8", offset + 30, offset + 30 + fileNameLen)
          : "";

      if (fileName.includes(".sinf")) {
        foundSinf = true;
        // Sinf files are tiny and stored (method 0 via Info-ZIP -0)
        // CRC should be non-zero (not deferred)
        expect(crc32).not.toBe(0);
        expect(compressedSize).toBeGreaterThan(0);
        expect(uncompressedSize).toBeGreaterThan(0);
      }

      const compressionMethod = readUInt16LE(postBytes, offset + 8);
      const extraFieldLen = readUInt16LE(postBytes, offset + 28);
      const dataStart = offset + 30 + fileNameLen + extraFieldLen;
      if (compressionMethod === 0) {
        offset = dataStart + compressedSize;
      } else {
        offset = dataStart + compressedSize;
      }
    }
    expect(foundSinf).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Requirement 2: Raw-copy regression test (empty sinfs)
  // -----------------------------------------------------------------------
  it("should leave file bytes unchanged when sinfs array is empty (raw-copy case)", async () => {
    const ipaPath = createMockIPA("RawCopyTest", {
      addManifest: true,
      sinfPaths: ["SC_Info/main.sinf"],
      executableName: "RawCopyTest",
    });

    // Read the original bytes before any injection
    const originalBytes = fs.readFileSync(ipaPath);

    // Inject with empty sinfs array
    await inject([], ipaPath);

    // Read bytes after injection
    const postBytes = fs.readFileSync(ipaPath);

    // Must be byte-identical
    expect(Buffer.compare(originalBytes, postBytes)).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Requirement 2: Non-ZIP input throws (extend existing test)
  // -----------------------------------------------------------------------
  it("should throw a clear error for non-ZIP input (not an archive)", async () => {
    const nonZipPath = path.join(TEMP_DIR, "not_a_zip.ipa");
    fs.writeFileSync(nonZipPath, Buffer.from("this is not a zip archive"));

    const sinfData = Buffer.from("sinf").toString("base64");
    await expect(
      inject([{ id: 1, sinf: sinfData }], nonZipPath),
    ).rejects.toThrow();
  });
});