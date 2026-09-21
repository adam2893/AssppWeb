import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { DownloadTask } from "../src/types/index.js";

// Must be set before any imports that read config
process.env.DATA_DIR = "/tmp/asspp-test-icons-sharp-fail";

// Mock sharp to return null — simulating a native-binary load failure (F4).
// This must be at the top level so it's hoisted before the module import.
vi.mock("sharp", () => ({ default: null }));

import { getIconForTask, _test } from "../src/services/iconService.js";
import { getWhitePng } from "../src/services/manifestBuilder.js";

const mockTask: DownloadTask = {
  id: "test-id-sharp-fail",
  software: {
    id: 12345,
    bundleID: "com.example.fail",
    name: "Sharp Fail Test",
    version: "1.0.0",
    artistName: "Test",
    sellerName: "Test Inc.",
    description: "Test",
    averageUserRating: 4.5,
    userRatingCount: 100,
    artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/icon.png",
    screenshotUrls: [],
    minimumOsVersion: "15.0",
    releaseDate: "2024-01-01",
    primaryGenreName: "Utilities",
  },
  accountHash: "hash123",
  downloadURL: "https://example.com/app.ipa",
  sinfs: [],
  status: "completed",
  progress: 100,
  speed: "0 B/s",
  filePath: "/data/packages/test.ipa",
  createdAt: "2024-01-01T00:00:00Z",
};

const whitePng = getWhitePng();

describe("iconService - sharp import failure (F4)", () => {
  let originalFetch: typeof globalThis.fetch;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _test.resetIconCache();

    // Simulate cache miss
    readFileSpy = vi
      .spyOn(fs.promises, "readFile")
      .mockRejectedValue(new Error("cache miss"));

    // Mock fetch to succeed (so we test that sharp failure is the fallback trigger)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2, 3]));
          controller.close();
        },
      }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    readFileSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("should degrade to white PNG when sharp fails to load", async () => {
    const result = await getIconForTask(mockTask, 120);
    expect(result).toEqual(whitePng);
  });

  it("should not throw when sharp is unavailable", async () => {
    await expect(getIconForTask(mockTask, 120)).resolves.not.toThrow();
  });
});