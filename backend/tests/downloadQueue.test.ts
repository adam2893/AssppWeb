import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Software } from "../src/types/index.js";
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTask,
  pauseTask,
  resumeTask,
} from "../src/services/downloadManager.js";

/**
 * Queue behaviour for downloadManager (the MAX_CONCURRENT_DOWNLOADS ceiling).
 *
 * The real ChunkedDownloader is replaced by a gate this file opens and closes
 * by hand, so the tests can observe *when* each download starts and finishes.
 * Everything else under test — the queue, the status transitions, the slot
 * bookkeeping and the partial-file cleanup — is the real code.
 *
 * vi.mock factories are hoisted above the imports, so the shared state they
 * need is created with vi.hoisted and everything is referenced through it.
 */
const h = vi.hoisted(() => ({
  /** Per-test scratch DATA_DIR so this file cannot collide with other tests. */
  dataDir: `${process.env.TMPDIR ?? "/tmp"}/asspp-queue-${process.pid}-${Date.now()}`,
  /** Read through a getter so a single test can force the timeout path. */
  downloadTimeoutMs: 60_000,
  maxConcurrent: 2,
  /** Resolvers for in-flight mock downloads, keyed by task id. */
  pending: new Map<string, { resolve: () => void; reject: (e: unknown) => void }>(),
  /** Task ids in the order their download actually started. */
  started: [] as string[],
  /** Live and peak download counts. */
  active: 0,
  maxActive: 0,
  /** Lets the test make a file exist at the start of each download. */
  onStart: (_destPath: string) => {},
}));

vi.mock("../src/config.js", () => ({
  config: {
    port: 8080,
    dataDir: h.dataDir,
    publicBaseUrl: "",
    disableHttpsRedirect: false,
    autoCleanupDays: 0,
    autoCleanupMaxMB: 0,
    maxDownloadMB: 0,
    buildCommit: "test",
    buildDate: "test",
    accessPassword: "",
  },
  get DOWNLOAD_TIMEOUT_MS() {
    return h.downloadTimeoutMs;
  },
  get MAX_CONCURRENT_DOWNLOADS() {
    return h.maxConcurrent;
  },
}));

// The download must be able to reach "completed" without opening a real IPA.
vi.mock("../src/services/platformValidator.js", () => ({
  validatePlatform: vi.fn(async () => undefined),
}));

vi.mock("../src/services/chunkedDownloader.js", () => ({
  ChunkedDownloader: class {
    private readonly destPath: string;

    constructor(_url: string, destPath: string) {
      this.destPath = destPath;
    }

    download(signal: AbortSignal): Promise<void> {
      // Dest paths are "<...>/<taskId>.ipa" (see startDownload).
      const id = this.destPath
        .slice(this.destPath.lastIndexOf("/") + 1)
        .replace(/\.ipa$/, "");

      h.started.push(id);
      h.active += 1;
      h.maxActive = Math.max(h.maxActive, h.active);
      h.onStart(this.destPath);

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          h.pending.delete(id);
          h.active -= 1;
          finish();
        };
        const onAbort = () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          settle(() => reject(err));
        };

        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        h.pending.set(id, {
          resolve: () => settle(resolve),
          reject: (err) => settle(() => reject(err)),
        });
      });
    }

    abort(): void {
      // downloadManager aborts its own AbortController, which is the signal
      // wired above — the real class would also abort its in-flight fetches.
    }
  },
}));

const ACCOUNT_HASH = "abcdef1234567890";

function software(name: string): Software {
  return {
    id: 123,
    bundleID: `com.test.${name}`,
    name,
    version: "1.0",
    artistName: "Test",
    sellerName: "Test Seller",
    description: "",
    averageUserRating: 4.5,
    userRatingCount: 10,
    artworkUrl: "",
    screenshotUrls: [],
    minimumOsVersion: "15.0",
    releaseDate: "2024-01-01",
    primaryGenreName: "Utilities",
  };
}

/** Create a task whose download URL is unique per name. */
function start(name: string) {
  return createTask(
    software(name),
    ACCOUNT_HASH,
    `https://valid.apple.com/${name}.ipa`,
    [],
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  // Drain anything still in flight so no slot leaks into the next test.
  for (const gate of [...h.pending.values()]) gate.resolve();
  for (let i = 0; i < 5; i += 1) await tick();
  for (const task of getAllTasks()) deleteTask(task.id);
  for (let i = 0; i < 5; i += 1) await tick();

  h.started.length = 0;
  h.pending.clear();
  h.active = 0;
  h.maxActive = 0;
  h.maxConcurrent = 2;
  h.downloadTimeoutMs = 60_000;
  h.onStart = (destPath) => fs.writeFileSync(destPath, "partial download");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe("download queue concurrency ceiling", () => {
  it("runs at most MAX_CONCURRENT_DOWNLOADS downloads at once", () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    expect(h.started).toEqual([a.id, b.id]);
    expect(h.maxActive).toBe(2);
    // The third waits rather than opening its own connections.
    expect(getTask(c.id)?.status).toBe("pending");
  });

  it("starts the next queued download when a slot frees up", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    h.pending.get(a.id)?.resolve();

    await vi.waitFor(() => {
      expect(h.started).toEqual([a.id, b.id, c.id]);
    });
    expect(h.maxActive).toBe(2);
    expect(getTask(c.id)?.status).toBe("downloading");
  });

  it("keeps FIFO order across several slot releases", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");
    const d = start("d");

    expect(h.started).toEqual([a.id, b.id]);

    h.pending.get(a.id)?.resolve();
    await vi.waitFor(() => expect(h.started).toContain(c.id));

    h.pending.get(b.id)?.resolve();
    await vi.waitFor(() => expect(h.started).toContain(d.id));

    expect(h.started).toEqual([a.id, b.id, c.id, d.id]);
    expect(h.maxActive).toBe(2);
  });

  it("honours a ceiling of 1 from config", async () => {
    h.maxConcurrent = 1;

    const a = start("a");
    const b = start("b");

    expect(h.started).toEqual([a.id]);
    expect(h.maxActive).toBe(1);

    h.pending.get(a.id)?.resolve();
    await vi.waitFor(() => expect(h.started).toEqual([a.id, b.id]));
    expect(h.maxActive).toBe(1);
  });

  it("frees a slot when a download completes", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    h.pending.get(a.id)?.resolve();

    await vi.waitFor(() => {
      expect(getTask(a.id)?.status).toBe("completed");
    });
    // b still holds the second slot, c took a's.
    expect(h.started).toEqual([a.id, b.id, c.id]);
    expect(h.maxActive).toBe(2);
  });
});

describe("download queue slot handling", () => {
  it("releases the slot and keeps the file when a download is paused", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    const filePath = getTask(a.id)?.filePath;
    expect(filePath).toBeDefined();
    expect(fs.existsSync(filePath!)).toBe(true);

    expect(pauseTask(a.id)).toBe(true);

    expect(getTask(a.id)?.status).toBe("paused");
    // A paused download keeps its file so it can resume later.
    expect(fs.existsSync(filePath!)).toBe(true);
    // Its slot is handed to the queued task.
    await vi.waitFor(() => expect(h.started).toContain(c.id));
    expect(h.maxActive).toBe(2);
  });

  it("never starts a task deleted while it waited in the queue", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");
    const d = start("d");

    // c and d are both queued behind the two running downloads.
    expect(h.started).toEqual([a.id, b.id]);

    expect(deleteTask(c.id)).toBe(true);

    h.pending.get(a.id)?.resolve();
    await vi.waitFor(() => expect(h.started).toContain(d.id));

    expect(getTask(c.id)).toBeUndefined();
    expect(h.started).not.toContain(c.id);
    expect(h.maxActive).toBe(2);
  });

  it("frees the slot of a task deleted while it is downloading", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    expect(deleteTask(a.id)).toBe(true);

    await vi.waitFor(() => expect(h.started).toContain(c.id));
    expect(getTask(a.id)).toBeUndefined();
    expect(h.maxActive).toBe(2);
  });

  it("sends a resumed task to the back of the queue", async () => {
    h.maxConcurrent = 1;

    const a = start("a");
    const b = start("b");
    const c = start("c");

    expect(h.started).toEqual([a.id]);

    // Pausing frees the single slot, so the next queued task starts.
    pauseTask(a.id);
    await vi.waitFor(() => expect(h.started).toEqual([a.id, b.id]));
    expect(getTask(a.id)?.status).toBe("paused");

    // a resumes behind c, which was already waiting. Resuming must not let it
    // jump the queue, and must not exceed the ceiling.
    expect(resumeTask(a.id)).toBe(true);
    expect(getTask(a.id)?.status).toBe("pending");

    h.pending.get(b.id)?.resolve();
    await vi.waitFor(() => expect(h.started).toEqual([a.id, b.id, c.id]));

    h.pending.get(c.id)?.resolve();
    await vi.waitFor(() =>
      expect(h.started).toEqual([a.id, b.id, c.id, a.id]),
    );
    expect(h.maxActive).toBe(1);
  });

  it("refuses to resume a task that is not paused", () => {
    const a = start("a");

    expect(resumeTask(a.id)).toBe(false);
    expect(getTask(a.id)?.status).toBe("downloading");
  });

  it("refuses to pause a task that is still queued", () => {
    start("a");
    start("b");
    const c = start("c");

    // A queued task is "pending", not "downloading" — and only a downloading
    // task can be paused. This is why "paused while queued" cannot happen.
    expect(getTask(c.id)?.status).toBe("pending");
    expect(pauseTask(c.id)).toBe(false);
    expect(getTask(c.id)?.status).toBe("pending");
  });

  it("resumes a paused task when a slot is free", async () => {
    const a = start("a");
    const b = start("b");
    const c = start("c");

    pauseTask(a.id);
    await vi.waitFor(() => expect(h.started).toContain(c.id));

    h.pending.get(b.id)?.resolve();
    await vi.waitFor(() => expect(getTask(b.id)?.status).toBe("completed"));

    // Nothing else is queued, so the resumed task starts immediately.
    expect(resumeTask(a.id)).toBe(true);
    await vi.waitFor(() => {
      expect(getTask(a.id)?.status).toBe("downloading");
    });
    expect(h.started.filter((id) => id === a.id)).toHaveLength(2);
  });
});

describe("partial file cleanup", () => {
  it("deletes the partial file when a download times out", async () => {
    h.downloadTimeoutMs = 30;

    const a = start("a");
    const filePath = getTask(a.id)?.filePath;
    expect(filePath).toBeDefined();
    expect(fs.existsSync(filePath!)).toBe(true);

    await vi.waitFor(() => {
      expect(getTask(a.id)?.status).toBe("failed");
    });
    expect(getTask(a.id)?.error).toBe("Download timed out");

    await vi.waitFor(() => expect(fs.existsSync(filePath!)).toBe(false));
  });

  it("keeps the partial file when the download was paused instead", async () => {
    h.downloadTimeoutMs = 30;

    const a = start("a");
    const filePath = getTask(a.id)?.filePath;
    expect(filePath).toBeDefined();

    // Pausing aborts the download well before the timeout fires.
    pauseTask(a.id);
    expect(getTask(a.id)?.status).toBe("paused");

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(getTask(a.id)?.status).toBe("paused");
    expect(getTask(a.id)?.error).toBeUndefined();
    expect(fs.existsSync(filePath!)).toBe(true);
  });

  it("deletes the partial file when the downloader fails", async () => {
    const a = start("a");
    const filePath = getTask(a.id)?.filePath;
    expect(filePath).toBeDefined();

    h.pending.get(a.id)?.reject(new Error("connection reset"));

    await vi.waitFor(() => expect(getTask(a.id)?.status).toBe("failed"));
    expect(getTask(a.id)?.error).toBe("connection reset");
    await vi.waitFor(() => expect(fs.existsSync(filePath!)).toBe(false));
  });
});

describe("task persistence", () => {
  it("does not persist the download URL or sinfs of a completed task", async () => {
    const a = start("a");
    h.pending.get(a.id)?.resolve();

    await vi.waitFor(() => expect(getTask(a.id)?.status).toBe("completed"));
    // persistTasks() runs before the slot is released.
    const persisted = JSON.parse(
      fs.readFileSync(path.join(h.dataDir, "tasks.json"), "utf-8"),
    ) as Array<Record<string, unknown>>;

    const entry = persisted.find((task) => task.id === a.id);
    expect(entry).toBeDefined();
    expect(entry?.downloadURL).toBe("");
    expect(entry?.sinfs).toEqual([]);
  });
});
