import { createHash } from "crypto";
import { timingSafeEqual } from "crypto";

export const config = {
  port: parseInt(process.env.PORT || "8080"),
  dataDir: process.env.DATA_DIR || "./data",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  disableHttpsRedirect:
    process.env.UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT === "true",
  // Auto-cleanup: 0 disables
  autoCleanupDays: parseInt(process.env.AUTO_CLEANUP_DAYS || "0", 10) || 0,
  autoCleanupMaxMB: parseInt(process.env.AUTO_CLEANUP_MAX_MB || "0", 10) || 0,
  // Max download file size in MB (0 disables)
  maxDownloadMB: parseInt(process.env.MAX_DOWNLOAD_MB || "0", 10) || 0,
  // Build info (injected via Docker build args)
  buildCommit: process.env.BUILD_COMMIT || "unknown",
  buildDate: process.env.BUILD_DATE || "unknown",
  // Access password protection (empty = disabled)
  accessPassword: process.env.ACCESS_PASSWORD || "",
};

export const accessPasswordHash = config.accessPassword
  ? createHash("sha256").update(config.accessPassword).digest("hex")
  : "";

/** Timing-safe comparison of a client-supplied token against the precomputed hash. */
export function verifyAccessToken(token: string): boolean {
  const expected = Buffer.from(accessPasswordHash, "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const MAX_DOWNLOAD_SIZE = 8 * 1024 * 1024 * 1024; // 8 GB
export const DOWNLOAD_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours
export const BAG_TIMEOUT_MS = 15_000; // 15 seconds
export const BAG_MAX_BYTES = 1024 * 1024; // 1 MB
export const MIN_ACCOUNT_HASH_LENGTH = 8;

// Chunked download settings
export const DOWNLOAD_THREADS = Math.max(
  1,
  Math.min(32, parseInt(process.env.DOWNLOAD_THREADS || "8", 10) || 8),
);
// How many downloads may run at once. DOWNLOAD_THREADS is the chunk concurrency
// WITHIN a single download, so without this ceiling N queued downloads would
// each open DOWNLOAD_THREADS connections (N x 8 by default).
export const MAX_CONCURRENT_DOWNLOADS = Math.max(
  1,
  Math.min(
    10,
    parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "2", 10) || 2,
  ),
);
export const CHUNK_RETRY_COUNT = 3;
export const CHUNK_RETRY_DELAY_MS = 2000;
