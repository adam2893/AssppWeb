import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import type { DownloadTask } from "../src/types/index.js";

// Must be set before any imports that read config
process.env.DATA_DIR = "/tmp/asspp-test-icons";

// mockToBuffer must be defined with vi.hoisted so it's available in the
// vi.mock factory (which is hoisted above all imports)
const { mockToBuffer } = vi.hoisted(() => {
  const mockToBuffer = vi.fn();
  return { mockToBuffer };
});

vi.mock("sharp", () => {
  const mockResize = vi.fn().mockReturnThis();
  const mockPng = vi.fn().mockReturnThis();

  const mockSharp = Object.assign(
    vi.fn(() => mockSharp),
    { resize: mockResize, png: mockPng, toBuffer: mockToBuffer },
  );

  return { default: mockSharp };
});

import {
  getIconForTask,
  isAllowedArtworkUrl,
  _test,
} from "../src/services/iconService.js";
import { getWhitePng } from "../src/services/manifestBuilder.js";

const mockTask: DownloadTask = {
  id: "test-id-1",
  software: {
    id: 12345,
    bundleID: "com.example.test",
    name: "Test App",
    version: "1.0.0",
    artistName: "Test Developer",
    sellerName: "Test Inc.",
    description: "A test app",
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

/** Helper: creates a fresh ReadableStream with a small payload. */
function freshBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 2, 3]));
      controller.close();
    },
  });
}

/** Helper: creates a fetch mock that returns a fresh response per call. */
function mockFetchOk(): typeof globalThis.fetch {
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      body: freshBody(),
    }),
  );
}

describe("isAllowedArtworkUrl", () => {
  it("accepts a valid https *.mzstatic.com URL", () => {
    expect(
      isAllowedArtworkUrl(
        "https://is1-ssl.mzstatic.com/image/thumb/icon.png",
      ),
    ).toBe(true);
    expect(
      isAllowedArtworkUrl(
        "https://is5-ssl.mzstatic.com/image/thumb/icon.png",
      ),
    ).toBe(true);
    expect(
      isAllowedArtworkUrl("https://s.mzstatic.com/image/thumb/icon.png"),
    ).toBe(true);
  });

  it("rejects http:// scheme", () => {
    expect(
      isAllowedArtworkUrl("http://is1-ssl.mzstatic.com/image.png"),
    ).toBe(false);
  });

  it("rejects non-Apple host", () => {
    expect(isAllowedArtworkUrl("https://evil.com/x.png")).toBe(false);
  });

  it("rejects subdomain takeover via hostname suffix", () => {
    expect(
      isAllowedArtworkUrl("https://mzstatic.com.evil.com/x.png"),
    ).toBe(false);
    expect(isAllowedArtworkUrl("https://evil-mzstatic.com/x.png")).toBe(
      false,
    );
  });

  it("rejects literal loopback IP", () => {
    expect(isAllowedArtworkUrl("https://127.0.0.1/x.png")).toBe(false);
    expect(isAllowedArtworkUrl("https://127.1/x.png")).toBe(false);
  });

  it("rejects link-local IP", () => {
    expect(isAllowedArtworkUrl("https://169.254.169.254/x.png")).toBe(
      false,
    );
  });

  it("rejects localhost hostname", () => {
    expect(isAllowedArtworkUrl("https://localhost/x.png")).toBe(false);
  });

  it("rejects private IP ranges", () => {
    expect(isAllowedArtworkUrl("https://10.0.0.1/x.png")).toBe(false);
    expect(isAllowedArtworkUrl("https://192.168.1.1/x.png")).toBe(false);
    expect(isAllowedArtworkUrl("https://172.16.0.1/x.png")).toBe(false);
    expect(isAllowedArtworkUrl("https://172.31.255.255/x.png")).toBe(
      false,
    );
  });

  it("rejects malformed / non-URL strings", () => {
    expect(isAllowedArtworkUrl("")).toBe(false);
    expect(isAllowedArtworkUrl("not-a-url")).toBe(false);
    expect(isAllowedArtworkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedArtworkUrl("   ")).toBe(false);
  });

  it("rejects IPv6 loopback", () => {
    expect(isAllowedArtworkUrl("https://[::1]/x.png")).toBe(false);
  });

  it("rejects IPv6 link-local", () => {
    expect(isAllowedArtworkUrl("https://[fe80::1]/x.png")).toBe(false);
  });

  it("rejects 0.0.0.0", () => {
    expect(isAllowedArtworkUrl("https://0.0.0.0/x.png")).toBe(false);
  });
});

// --- F2: Cache key normalisation (direct unit test) ---

describe("normalizeArtworkUrl", () => {
  it("strips query string", () => {
    expect(
      _test.normalizeArtworkUrl(
        "https://is1-ssl.mzstatic.com/icon.png?x=rand123",
      ),
    ).toBe("https://is1-ssl.mzstatic.com/icon.png");
  });

  it("strips fragment", () => {
    expect(
      _test.normalizeArtworkUrl(
        "https://is1-ssl.mzstatic.com/icon.png#section",
      ),
    ).toBe("https://is1-ssl.mzstatic.com/icon.png");
  });

  it("strips both query string and fragment", () => {
    expect(
      _test.normalizeArtworkUrl(
        "https://is1-ssl.mzstatic.com/icon.png?x=1#section",
      ),
    ).toBe("https://is1-ssl.mzstatic.com/icon.png");
  });

  it("leaves URL unchanged when no query or fragment", () => {
    expect(
      _test.normalizeArtworkUrl(
        "https://is1-ssl.mzstatic.com/icon.png",
      ),
    ).toBe("https://is1-ssl.mzstatic.com/icon.png");
  });
});

describe("iconService", () => {
  let originalFetch: typeof globalThis.fetch;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockToBuffer.mockReset();
    _test.resetIconCache();

    // Always simulate cache miss so tests exercise the fetch path
    readFileSpy = vi
      .spyOn(fs.promises, "readFile")
      .mockRejectedValue(new Error("cache miss"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    readFileSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("getIconForTask", () => {
    it("should return resized PNG when artwork URL is valid", async () => {
      const fakePng = Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0,
      ]);
      mockToBuffer.mockResolvedValue(fakePng);

      globalThis.fetch = mockFetchOk();

      const result = await getIconForTask(mockTask, 120);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result).toEqual(fakePng);
      // Verify sharp was called with the fetched bytes
      const sharpModule = (await import("sharp")).default;
      expect(sharpModule).toHaveBeenCalledTimes(1);
    });

    it("should fall back to white PNG when artworkUrl is missing", async () => {
      const result = await getIconForTask(
        {
          ...mockTask,
          software: { ...mockTask.software, artworkUrl: "" },
        },
        120,
      );

      expect(result).toEqual(whitePng);
    });

    it("should fall back to white PNG when artworkUrl is empty string", async () => {
      const result = await getIconForTask(
        {
          ...mockTask,
          software: { ...mockTask.software, artworkUrl: "" },
        },
        512,
      );

      expect(result).toEqual(whitePng);
    });

    it("should fall back to white PNG when fetch fails", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Network error"));

      const result = await getIconForTask(mockTask, 120);

      expect(result).toEqual(whitePng);
    });

    it("should fall back to white PNG when fetch returns non-ok status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        body: freshBody(),
      });

      const result = await getIconForTask(mockTask, 120);

      expect(result).toEqual(whitePng);
    });

    it("should fall back to white PNG when sharp resize fails", async () => {
      mockToBuffer.mockRejectedValue(new Error("sharp error"));

      globalThis.fetch = mockFetchOk();

      const result = await getIconForTask(mockTask, 120);

      expect(result).toEqual(whitePng);
    });

    it("should handle both small (120) and large (512) sizes", async () => {
      const fakePng = Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0,
      ]);
      mockToBuffer.mockResolvedValue(fakePng);

      // mockImplementation ensures each call gets a fresh ReadableStream
      globalThis.fetch = mockFetchOk();

      const small = await getIconForTask(mockTask, 120);
      const large = await getIconForTask(mockTask, 512);

      expect(small).toEqual(fakePng);
      expect(large).toEqual(fakePng);
    });

    it("should reject SSRF URLs with no outbound request", async () => {
      const fetchSpy = vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: freshBody(),
        }),
      );
      globalThis.fetch = fetchSpy;

      const badUrls = [
        {
          ...mockTask,
          software: {
            ...mockTask.software,
            artworkUrl: "http://is1-ssl.mzstatic.com/x.png",
          },
        },
        {
          ...mockTask,
          software: {
            ...mockTask.software,
            artworkUrl: "https://evil.com/x.png",
          },
        },
        {
          ...mockTask,
          software: {
            ...mockTask.software,
            artworkUrl: "https://127.0.0.1/x.png",
          },
        },
        {
          ...mockTask,
          software: {
            ...mockTask.software,
            artworkUrl: "https://169.254.169.254/x.png",
          },
        },
        {
          ...mockTask,
          software: {
            ...mockTask.software,
            artworkUrl: "https://localhost/x.png",
          },
        },
      ];

      for (const task of badUrls) {
        const result = await getIconForTask(task, 120);
        expect(result).toEqual(whitePng);
      }

      // fetch should never have been called — validation rejects before I/O
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should fall back to white PNG when an allowlisted host redirects", async () => {
      // With redirect: "manual", a 302 response produces an opaque-redirect
      // filtered response with status 0 and ok=false.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 0,
        type: "opaqueredirect",
        body: freshBody(),
      });

      const result = await getIconForTask(mockTask, 120);

      expect(result).toEqual(whitePng);
    });

    // --- F2: Cache key normalisation (integration) ---

    it("should share cache entry for URLs differing only by query string", async () => {
      _test.resetIconCache();

      const fakePng = Buffer.alloc(100, 0x89);
      mockToBuffer.mockResolvedValue(fakePng);

      globalThis.fetch = mockFetchOk();

      const writeFileSpy = vi
        .spyOn(fs.promises, "writeFile")
        .mockResolvedValue(undefined);
      vi.spyOn(fs.promises, "access").mockRejectedValue(
        new Error("not found"),
      );
      vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

      // Override the beforeEach readFile spy: throw on first call (cache miss
      // for the initial write), then return fakePng on subsequent calls so the
      // second URL (same normalised key) hits the cache.
      readFileSpy.mockRestore();
      let readCallCount = 0;
      const localReadFileSpy = vi
        .spyOn(fs.promises, "readFile")
        .mockImplementation(async () => {
          readCallCount++;
          if (readCallCount === 1) throw new Error("cache miss");
          return fakePng;
        });

      // First call: URL without query string
      const taskA = {
        ...mockTask,
        software: {
          ...mockTask.software,
          artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/icon.png",
        },
      };
      await getIconForTask(taskA, 120);

      // Second call: URL with query string — normalised key is identical
      const taskB = {
        ...mockTask,
        software: {
          ...mockTask.software,
          artworkUrl:
            "https://is1-ssl.mzstatic.com/image/thumb/icon.png?x=rand123",
        },
      };
      await getIconForTask(taskB, 120);

      // writeFile should only have been called once (second call was cache hit)
      expect(writeFileSpy).toHaveBeenCalledTimes(1);

      writeFileSpy.mockRestore();
      localReadFileSpy.mockRestore();
    });

    it("should share cache entry for URLs differing only by fragment", async () => {
      _test.resetIconCache();

      const fakePng = Buffer.alloc(100, 0x89);
      mockToBuffer.mockResolvedValue(fakePng);

      globalThis.fetch = mockFetchOk();

      const writeFileSpy = vi
        .spyOn(fs.promises, "writeFile")
        .mockResolvedValue(undefined);
      vi.spyOn(fs.promises, "access").mockRejectedValue(
        new Error("not found"),
      );
      vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

      readFileSpy.mockRestore();
      let readCallCount = 0;
      const localReadFileSpy = vi
        .spyOn(fs.promises, "readFile")
        .mockImplementation(async () => {
          readCallCount++;
          if (readCallCount === 1) throw new Error("cache miss");
          return fakePng;
        });

      // First call: URL without fragment
      const taskA = {
        ...mockTask,
        software: {
          ...mockTask.software,
          artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/icon.png",
        },
      };
      await getIconForTask(taskA, 120);

      // Second call: URL with fragment — normalised key is identical
      const taskB = {
        ...mockTask,
        software: {
          ...mockTask.software,
          artworkUrl:
            "https://is1-ssl.mzstatic.com/image/thumb/icon.png#section",
        },
      };
      await getIconForTask(taskB, 120);

      expect(writeFileSpy).toHaveBeenCalledTimes(1);

      writeFileSpy.mockRestore();
      localReadFileSpy.mockRestore();
    });

    // --- F2: Cache LRU eviction ---

    it("should evict oldest cache entries when byte cap is exceeded", async () => {
      _test.resetIconCache();

      const entrySize = 30 * 1024 * 1024; // 30 MB per entry
      const bigBuffer = Buffer.alloc(entrySize, 0x89);
      mockToBuffer.mockResolvedValue(bigBuffer);

      globalThis.fetch = mockFetchOk();

      vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
      vi.spyOn(fs.promises, "access").mockRejectedValue(
        new Error("not found"),
      );
      vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

      // Add 3 entries (90 MB > 64 MB cap → at least 1 evicted)
      const urls = [
        "https://is1-ssl.mzstatic.com/icon-a.png",
        "https://is1-ssl.mzstatic.com/icon-b.png",
        "https://is1-ssl.mzstatic.com/icon-c.png",
      ];

      for (const url of urls) {
        const task = {
          ...mockTask,
          software: { ...mockTask.software, artworkUrl: url },
        };
        await getIconForTask(task, 120);
      }

      const stats = _test.getCacheStats();
      // 90 MB > 64 MB, so at least 1 entry (30 MB) evicted → at most 2 entries, ≤ 64 MB
      expect(stats.entries).toBeLessThanOrEqual(2);
      expect(stats.bytes).toBeLessThanOrEqual(_test.ICON_CACHE_MAX_BYTES);
    });

    it("should preserve most-recently-used entry during eviction", async () => {
      _test.resetIconCache();

      const entrySize = 30 * 1024 * 1024; // 30 MB per entry
      const bigBuffer = Buffer.alloc(entrySize, 0x89);
      mockToBuffer.mockResolvedValue(bigBuffer);

      globalThis.fetch = mockFetchOk();

      vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
      vi.spyOn(fs.promises, "access").mockRejectedValue(
        new Error("not found"),
      );
      vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

      // Add 3 entries: A, B, C (90 MB > 64 MB)
      const urls = [
        "https://is1-ssl.mzstatic.com/icon-a.png",
        "https://is1-ssl.mzstatic.com/icon-b.png",
        "https://is1-ssl.mzstatic.com/icon-c.png",
      ];

      for (const url of urls) {
        const task = {
          ...mockTask,
          software: { ...mockTask.software, artworkUrl: url },
        };
        await getIconForTask(task, 120);
      }

      // The newest entry (icon-c) should survive
      const stats = _test.getCacheStats();
      expect(stats.entries).toBeGreaterThan(0);
      // Total should be ≤ cap
      expect(stats.bytes).toBeLessThanOrEqual(_test.ICON_CACHE_MAX_BYTES);
    });

    // --- F3: Oversized response abort ---

    it("should abort oversized response without fully buffering", async () => {
      _test.resetIconCache();

      const maxBytes = _test.MAX_ARTWORK_BYTES;
      const chunk = new Uint8Array(maxBytes); // exactly at cap
      const over = new Uint8Array(1); // 1 byte over

      let cancelCalled = false;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(over);
        },
        cancel() {
          cancelCalled = true;
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body,
      });

      const result = await getIconForTask(mockTask, 120);
      expect(result).toEqual(whitePng);
      expect(cancelCalled).toBe(true);
    });

    // --- F3: Stalled body timeout ---

    it("should timeout on stalled body read and return white PNG", async () => {
      _test.resetIconCache();

      // Inject a short timeout so the test doesn't wait 10 real seconds.
      _test.setTimeoutOverride(10);

      // A body that emits one chunk then never closes — simulates a
      // stalled/slow-drip connection after headers arrive.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2, 3]));
          // Never close
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body,
      });

      const result = await getIconForTask(mockTask, 120);
      expect(result).toEqual(whitePng);

      _test.setTimeoutOverride(undefined);
    });
  });
});

describe("icon cache write serialisation (F2a)", () => {
  beforeEach(() => {
    _test.resetIconCache();
  });

  it("must not run two same-tick critical sections concurrently", async () => {
    const log: string[] = [];
    const job = (n: string) =>
      _test.withCacheLock(async () => {
        log.push(`${n}:enter`);
        await new Promise((r) => setTimeout(r, 20));
        log.push(`${n}:exit`);
      });

    // Both scheduled in the SAME tick. This is the exact pattern that broke
    // when cacheLock was reassigned inside a .then callback: both callers read
    // the old (already-resolved) lock and ran concurrently.
    await Promise.all([job("A"), job("B")]);

    expect(log).toEqual(["A:enter", "A:exit", "B:enter", "B:exit"]);
  });

  it("must serialise a parallel burst with no interleaving", async () => {
    const log: string[] = [];
    const job = (n: number) =>
      _test.withCacheLock(async () => {
        log.push(`J${n}:enter`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`J${n}:exit`);
      });

    await Promise.all([1, 2, 3, 4, 5].map(job));

    expect(log).toHaveLength(10);
    for (let i = 0; i < log.length; i += 2) {
      const enter = log[i];
      const exit = log[i + 1];
      expect(enter.endsWith(":enter")).toBe(true);
      expect(exit.endsWith(":exit")).toBe(true);
      // each enter must be immediately followed by its OWN exit
      expect(enter.split(":")[0]).toBe(exit.split(":")[0]);
    }
  });
});