import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Wiring guard (roadmap #13).
 *
 * Three features in this project shipped *implemented and unit-tested but never
 * called*: the SSE progress route (the client never sent the `accountHash` it
 * required, so the app silently polled instead), `validatePlatform` (dead code,
 * so the tvOS check never ran) and platform-aware version resolution (never
 * invoked). Every one of them had green tests. Green tests prove a unit works,
 * not that anything uses it.
 *
 * This asserts that a curated set of feature entry points is really called from
 * production code. It is deliberately curated rather than "every export":
 * helpers that are exported only so tests can reach them would make the guard
 * noisy, which is how a guard like this ends up deleted.
 *
 * Lives in the backend suite because it spans both source trees; the paths are
 * resolved from this file's location, so the working directory does not matter.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SOURCE_ROOTS = [
  path.join(REPO_ROOT, "backend", "src"),
  path.join(REPO_ROOT, "frontend", "src"),
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `vendor` holds prebuilt third-party bundles, not our code.
      if (entry.name === "node_modules" || entry.name === "vendor") continue;
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    // Tests calling a function is exactly what we are not counting.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    files.push(full);
  }
  return files;
}

/**
 * Heuristic comment stripper, so a symbol merely *named* in a comment or doc
 * block does not count as a call site. `//` preceded by `:` is left alone so a
 * `https://…` literal does not truncate the rest of its line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const sources = SOURCE_ROOTS.flatMap((root) => collectSourceFiles(root)).map(
  (file) => ({
    relative: path.relative(REPO_ROOT, file),
    lines: stripComments(fs.readFileSync(file, "utf8")).split("\n"),
  }),
);

/** Production call sites of `name`, excluding the line that defines it. */
function callSites(name: string): string[] {
  const called = new RegExp(`\\b${name}\\s*\\(`);
  const declared = new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`,
  );

  const hits: string[] = [];
  for (const source of sources) {
    source.lines.forEach((text, index) => {
      if (!called.test(text)) return;
      if (declared.test(text)) return;
      hits.push(`${source.relative}:${index + 1}`);
    });
  }
  return hits;
}

interface EntryPoint {
  name: string;
  /** Why this one is worth guarding. */
  why: string;
}

const ENTRY_POINTS: EntryPoint[] = [
  {
    name: "validatePlatform",
    why: "post-download platform check that once shipped as dead code",
  },
  {
    name: "listVersions",
    why: "platform-aware version history, whose platform argument was once dropped",
  },
  {
    name: "getVersionMetadata",
    why: "per-version metadata behind the version history screen",
  },
  {
    name: "sanitizeTaskForResponse",
    why: "keeps download URLs, sinfs and file paths out of API responses",
  },
  {
    name: "addProgressListener",
    why: "the SSE progress route only reports if a listener is registered",
  },
  {
    name: "ensureSapAssets",
    why: "SAP signing assets must exist before a signer can be built",
  },
  {
    name: "buildManifest",
    why: "the OTA manifest is what makes a compiled IPA installable",
  },
  {
    name: "extractAndMergeCookies",
    why: "Apple sessions break if the refreshed cookies are dropped",
  },
  {
    name: "firstAccountCountry",
    why: "search and add-download default to the account's storefront",
  },
  {
    name: "accountStoreCountry",
    why: "storefront resolution behind the purchase list and product pages",
  },
];

describe("feature wiring (roadmap #13)", () => {
  it("scans both source trees", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some((s) => s.relative.startsWith("backend/src"))).toBe(true);
    expect(sources.some((s) => s.relative.startsWith("frontend/src"))).toBe(true);
  });

  it.each(ENTRY_POINTS)("calls $name from production code — $why", ({ name }) => {
    expect(callSites(name)).not.toHaveLength(0);
  });

  it("attributes a call site to the file that makes it", () => {
    // Also proves the path bookkeeping works, not just that a string matched.
    expect(
      callSites("buildManifest").some((hit) =>
        hit.startsWith("backend/src/routes/install.ts:"),
      ),
    ).toBe(true);
  });

  it("reports nothing for a symbol that is not wired, so it is not vacuous", () => {
    expect(callSites("noSuchFeatureIsWiredAnywhere")).toHaveLength(0);
  });
});
