import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { config } from "../config.js";
import { getWhitePng } from "./manifestBuilder.js";
import type { DownloadTask } from "../types/index.js";

const ICON_CACHE_DIR = "icon-cache";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024; // 5 MB
const ICON_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB — hardcoded cap, no new env var

// Test override: allows tests to inject a short timeout without fake timers.
let timeoutOverrideMs: number | undefined = undefined;

// Allow only Apple's artwork CDN. Matches the pattern used in wsProxy.ts.
const ALLOWED_ARTWORK_HOST_RE = /^[\w-]+\.mzstatic\.com$/;

// Loopback, link-local, private, and reserved IP prefixes (defence in depth).
// This catches literal IP hosts that pass the hostname allowlist (which they
// cannot, but a future edit might inadvertently broaden the regex).
const PRIVATE_IP_RE = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|fe80::)/;

// --- Lazy sharp loader (F4) ---
// sharp is a native binary. Loading it at the top level would crash the
// entire server on boot if the prebuild is missing or incompatible. Load
// lazily on first icon request so a sharp failure only degrades icons.
let sharpInstance: typeof import("sharp").default | null | undefined = undefined;
let sharpLoadPromise: Promise<typeof import("sharp").default | null> | null = null;

async function getSharp(): Promise<typeof import("sharp").default | null> {
  if (sharpInstance !== undefined) return sharpInstance;
  if (sharpLoadPromise) return sharpLoadPromise;
  sharpLoadPromise = (async () => {
    try {
      const mod = await import("sharp");
      sharpInstance = mod.default;
      return sharpInstance;
    } catch {
      sharpInstance = null;
      return null;
    }
  })();
  return sharpLoadPromise;
}

// --- LRU cache accounting (F2) ---
// Tracks total bytes on disk and entry order so we can evict oldest when
// the cap is exceeded. A simple promise-chain mutex prevents concurrent
// writes from corrupting the accounting.
const cacheEntries = new Map<string, { size: number }>();
let cacheBytes = 0;
let cacheLock: Promise<void> = Promise.resolve();

// Serialises cache writes. The previous lock MUST be captured synchronously:
// if `cacheLock` were reassigned inside a .then callback, two callers in the
// same tick would both read the old (already-resolved) lock and run their
// critical sections concurrently — which let a parallel burst overshoot the
// cap by N x size.
function withCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = cacheLock;
  let release!: () => void;
  cacheLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(() => fn().finally(release));
}

/** Promote an entry to most-recently-used (re-set to move to Map end). */
function touchCacheEntry(key: string): void {
  if (cacheEntries.has(key)) {
    const entry = cacheEntries.get(key)!;
    cacheEntries.delete(key);
    cacheEntries.set(key, entry);
  }
}

/** Evict oldest entries until total fits within the cap. */
function evictLru(targetBytes: number): void {
  for (const [key, entry] of cacheEntries) {
    if (cacheBytes <= targetBytes) break;
    cacheEntries.delete(key);
    cacheBytes -= entry.size;
    const cachePath = path.resolve(
      path.join(config.dataDir, ICON_CACHE_DIR, `${key}.png`),
    );
    fs.unlink(cachePath, () => {
      /* ignore — file may already be gone */
    });
  }
}

// --- Cache hydration on first use (F2b) ---
// The byte accounting is in-process only, so a restart would otherwise forget
// the on-disk cache entirely and allow another full cap to accumulate on top
// of what is already there. Seed the LRU from disk once, oldest-mtime first so
// Map insertion order matches eviction order.
let cacheHydrated: Promise<void> | null = null;

function hydrateCache(): Promise<void> {
  if (!cacheHydrated) {
    cacheHydrated = (async () => {
      try {
        const dir = path.resolve(path.join(config.dataDir, ICON_CACHE_DIR));
        const names = await fs.promises.readdir(dir);
        const found: { key: string; size: number; mtimeMs: number }[] = [];
        for (const name of names) {
          if (!name.endsWith(".png")) continue;
          try {
            const st = await fs.promises.stat(path.join(dir, name));
            found.push({
              key: name.slice(0, -4),
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch {
            /* entry vanished mid-scan — ignore */
          }
        }
        found.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
        for (const f of found) {
          cacheEntries.set(f.key, { size: f.size });
          cacheBytes += f.size;
        }
        if (cacheBytes > ICON_CACHE_MAX_BYTES) {
          evictLru(ICON_CACHE_MAX_BYTES);
        }
      } catch {
        // Cache directory absent — nothing to hydrate.
      }
    })();
  }
  return cacheHydrated;
}

// --- URL normalisation for cache key (F2) ---
// Strips query string and fragment so ?x=rand and #section variants of the
// same artwork share one cache entry. NOTE: this is a dedup/convenience
// measure, NOT the disk bound — mzstatic also honours arbitrary path-transform
// segments (e.g. 1x1bb.jpg .. 3000x3000bb.jpg, .png, .webp), so an attacker can
// still mint distinct keys within an allowlisted host. The actual bound is
// ICON_CACHE_MAX_BYTES plus eviction, and one key requires one completed task.
function normalizeArtworkUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return rawUrl;
  }
}

// --- Streaming body reader with size cap + abort signal (F3) ---
// Reads the response body chunk-by-chunk and aborts (cancels the stream)
// as soon as cumulative bytes exceed the cap, so an oversized response is
// never fully buffered in RAM. If an AbortSignal is provided, each read is
// raced against the signal so a timeout or external abort cuts through a
// stalled body read immediately.

async function readWithSizeCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = signal
        ? await raceReaderRead(reader, signal)
        : await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  return Buffer.concat(chunks);
}

/** Race reader.read() against an AbortSignal so a stalled body read is
 *  interrupted when the signal fires (e.g. from a fetch timeout). */
function raceReaderRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Validate that a URL is safe to fetch as artwork.
 *
 * Rules (all must pass):
 *  1. Must be parseable as a URL.
 *  2. Protocol must be `https:`.
 *  3. Hostname must match Apple's `*.mzstatic.com` CDN.
 *  4. Hostname must not be a literal loopback/private/reserved IP
 *     (defence in depth — the hostname regex already prevents this).
 *
 * This is exported so it can be unit-tested directly.
 */
export function isAllowedArtworkUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (!ALLOWED_ARTWORK_HOST_RE.test(parsed.hostname)) {
    return false;
  }

  // Defence in depth: reject literal IPs in reserved ranges even if the
  // hostname regex above would allow them (it won't — but guard against
  // future edits that broaden the pattern).
  if (PRIVATE_IP_RE.test(parsed.hostname)) {
    return false;
  }

  return true;
}

/**
 * Get a PNG icon for a download task at the specified size.
 *
 * Fetches the artwork URL from the task's software metadata, resizes it
 * with sharp, and caches the result on disk under DATA_DIR/icon-cache/.
 * Falls back to a 1×1 white PNG on any failure (missing artwork, SSRF
 * validation failure, network error, decode error, sharp error) — never
 * throws.
 *
 * Size rationale (the manifest plist declares no pixel sizes):
 * - 120×120: conventional iOS `display-image` size (@2x home screen icon).
 * - 512×512: conventional iOS `full-size-image` size (App Store large icon).
 */
export async function getIconForTask(
  task: DownloadTask,
  size: number,
): Promise<Buffer> {
  const artworkUrl = task.software?.artworkUrl;
  if (!artworkUrl) {
    return getWhitePng();
  }

  // SSRF guard: reject non-Apple-CDN URLs before any I/O
  if (!isAllowedArtworkUrl(artworkUrl)) {
    return getWhitePng();
  }

  // Normalise cache key: strip query string and fragment so ?x=rand variants
  // of the same artwork share one entry (F2).
  const normalisedUrl = normalizeArtworkUrl(artworkUrl);
  const cacheDir = path.resolve(path.join(config.dataDir, ICON_CACHE_DIR));
  const cacheKey = createHash("sha256")
    .update(`${normalisedUrl}:${size}`)
    .digest("hex");
  const cachePath = path.join(cacheDir, `${cacheKey}.png`);

  // Seed the in-process LRU from disk once, so a restart cannot forget the
  // existing cache and stack another full cap on top of it (F2b).
  await hydrateCache();

  // Check disk cache (promote on hit for LRU ordering)
  try {
    const data = await fs.promises.readFile(cachePath);
    touchCacheEntry(cacheKey);
    return data;
  } catch {
    // Cache miss — continue to fetch
  }

  // Lazy-load sharp (F4): a native-binary failure here only degrades icons,
  // not the whole server.
  const sharp = await getSharp();
  if (!sharp) {
    return getWhitePng();
  }

  try {
    // Fetch artwork with timeout. Use redirect: "manual" to prevent an
    // allowlisted host from redirecting to an internal target (SSRF via
    // redirect). If the response is a redirect (status 301/302/303/307/308),
    // the "opaque-redirect" filtered response will have status 0 / ok=false,
    // so the !response.ok check below will catch it and fall back to the
    // white PNG. This is simpler and safer than re-validating the Location
    // header, since a crafted redirect chain could point to a host whose DNS
    // resolves to a private IP at the time of the redirect fetch.
    //
    // The timeout covers the entire fetch + body read: if the body trickles
    // slowly, controller.abort() errors the body stream, reader.read()
    // rejects, and readWithSizeCap's catch returns null → white PNG (F3).
    const controller = new AbortController();
    const timeoutMs = timeoutOverrideMs ?? FETCH_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(artworkUrl, {
        signal: controller.signal,
        redirect: "manual",
      });

      if (!response.ok) {
        return getWhitePng();
      }

      // Stream body with size cap — abort as soon as cumulative bytes exceed
      // MAX_ARTWORK_BYTES, so an oversized response is never fully buffered.
      // If the timeout fires during the body read, controller.abort() errors
      // the stream and raceReaderRead rejects, which readWithSizeCap catches
      // and returns null (F3).
      const buffer = await readWithSizeCap(
        response.body,
        MAX_ARTWORK_BYTES,
        controller.signal,
      );
      if (!buffer) {
        return getWhitePng();
      }

      // Resize and convert to PNG
      const resized = await sharp(Buffer.from(buffer))
        .resize(size, size, { fit: "cover", withoutEnlargement: false })
        .png()
        .toBuffer();

      // Write to cache with LRU eviction (F2)
      try {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        await withCacheLock(async () => {
          // Re-check cache (another request may have written it)
          try {
            await fs.promises.access(cachePath);
            return; // already cached by concurrent request
          } catch {
            // proceed
          }

          const newBytes = resized.length;
          evictLru(ICON_CACHE_MAX_BYTES - newBytes);
          await fs.promises.writeFile(cachePath, resized);
          cacheEntries.set(cacheKey, { size: newBytes });
          cacheBytes += newBytes;
        });
      } catch {
        // Cache write failure is acceptable — serve the icon anyway
      }

      return resized;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return getWhitePng();
  }
}

// --- Test helpers ---
// Exported under a _test namespace so unit tests can verify internal
// behaviour without exposing implementation details to production callers.

export const _test = {
  resetIconCache: () => {
    cacheEntries.clear();
    cacheBytes = 0;
    cacheLock = Promise.resolve();
    sharpInstance = undefined;
    sharpLoadPromise = null;
  },
  getCacheStats: () => ({ entries: cacheEntries.size, bytes: cacheBytes }),
  normalizeArtworkUrl,
  getSharp,
  readWithSizeCap,
  // Exposed so the write-serialisation guarantee can be regression-tested:
  // two same-tick callers MUST NOT run their critical sections concurrently.
  withCacheLock,
  hydrateCache,
  MAX_ARTWORK_BYTES,
  ICON_CACHE_MAX_BYTES,
  setTimeoutOverride: (ms: number | undefined) => {
    timeoutOverrideMs = ms;
  },
};