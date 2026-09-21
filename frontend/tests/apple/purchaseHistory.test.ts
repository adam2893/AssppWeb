import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../../src/types";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { createSapSigner } from "../../src/apple/sap/client";
import { loadSapAssets } from "../../src/apple/sap/assets";
import {
  fetchOwnedApps,
  mergeOwnedApps,
  pageOwnedApps,
  DaapAuthError,
} from "../../src/apple/purchaseHistory";
import {
  writeDmapContainer,
  writeDmapUInt32,
  writeDmapString,
  writeDmapUInt8,
  writeDmapEmpty,
} from "../../src/apple/dmap";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
}));

vi.mock("../../src/apple/sap/client", () => ({
  createSapSigner: vi.fn(),
}));

vi.mock("../../src/apple/sap/assets", () => ({
  loadSapAssets: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert a Uint8Array DMAP buffer to the string format appleRequest returns. */
function dmapToString(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

/** Build a mock /login DMAP response buffer. */
function buildLoginBuffer(mlid: number): Uint8Array {
  return writeDmapContainer("adbs", [
    writeDmapContainer("mlog", [
      writeDmapUInt32("mlid", mlid),
    ]),
  ]);
}

/** Build a mock /update DMAP response buffer. */
function buildUpdateBuffer(musr: number): Uint8Array {
  return writeDmapContainer("adbs", [
    writeDmapContainer("mupd", [
      writeDmapUInt32("musr", musr),
    ]),
  ]);
}

/** Build a mock /items DMAP response buffer with the given mlit items. */
function buildItemsBuffer(
  status: number,
  items: { adamId: number; bundleId: string; name: string; version: string; purchaseDate: number; mediaKind: number; platformBitmask: number }[],
): Uint8Array {
  const mlits = items.map((item) =>
    writeDmapContainer("mlit", [
      writeDmapUInt32("aeSI", item.adamId),
      writeDmapString("aeBI", item.bundleId),
      writeDmapString("aeLN", item.name),
      writeDmapString("aePd", item.version),
      writeDmapUInt32("asdp", item.purchaseDate),
      writeDmapUInt32("aeMk", item.mediaKind),
      writeDmapUInt32("aeSS", item.platformBitmask),
    ]),
  );

  return writeDmapContainer("adbs", [
    writeDmapUInt32("mstt", status),
    writeDmapContainer("mlcl", mlits),
  ]);
}

function makeMockResponse(buf: Uint8Array, status = 200) {
  const rawBody = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return {
    status,
    statusText: status === 200 ? "OK" : "Unauthorized",
    headers: {},
    rawHeaders: [] as [string, string][],
    body: dmapToString(buf),
    rawBody,
  };
}

const mockSigner = {
  sign: vi.fn().mockResolvedValue("mock-signature"),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockAccount: Account = {
  email: "test@example.com",
  password: "password",
  appleId: "test@example.com",
  store: "143441", // US
  firstName: "Test",
  lastName: "User",
  passwordToken: "mock-token",
  directoryServicesIdentifier: "12345",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("apple/purchaseHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "https://auth.itunes.apple.com/auth/v1/native/fast/",
      sapEndpoints: {
        certificateURL: "https://setup-ck.cert.apple.com/cert",
        setupURL: "https://setup-ck.setup.apple.com/setup",
        version: 200,
      },
    });

    vi.mocked(loadSapAssets).mockResolvedValue({
      commerceKit: new Uint8Array(10),
      commerceCore: new Uint8Array(10),
      coreFP: new Uint8Array(10),
      coreFPICXS: new Uint8Array(10),
    });

    vi.mocked(createSapSigner).mockResolvedValue(mockSigner);
  });

  describe("fetchOwnedApps", () => {
    it("should make 6 requests (3 per storefront)", async () => {
      // Mock all 6 responses
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const itemsBuf = buildItemsBuffer(200, [
        { adamId: 1, bundleId: "com.a", name: "App A", version: "1.0", purchaseDate: 1600000000, mediaKind: 131072, platformBitmask: 1 },
      ]);

      const loginResponse = makeMockResponse(loginBuf);
      const updateResponse = makeMockResponse(updateBuf);
      const itemsResponse = makeMockResponse(itemsBuf);

      vi.mocked(appleRequest).mockResolvedValue(loginResponse);

      // First storefront (34): login, update, items
      // Second storefront (13): login, update, items
      // We need to return different responses for each call
      const callSequence = [
        // Storefront 34
        loginResponse,
        updateResponse,
        itemsResponse,
        // Storefront 13
        loginResponse,
        updateResponse,
        itemsResponse,
      ];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => {
        const result = callSequence[callIndex];
        callIndex++;
        return result;
      });

      const result = await fetchOwnedApps(mockAccount);

      // Should have made 6 requests
      expect(appleRequest).toHaveBeenCalledTimes(6);

      // Check storefront values
      const calls = vi.mocked(appleRequest).mock.calls;
      expect(calls[0][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,34");
      expect(calls[1][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,34");
      expect(calls[2][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,34");
      expect(calls[3][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,13");
      expect(calls[4][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,13");
      expect(calls[5][0].headers?.["X-Apple-Store-Front"]).toBe("143441,-1,13");

      // Check paths
      expect(calls[0][0].path).toContain("/login");
      expect(calls[1][0].path).toContain("/update");
      expect(calls[2][0].path).toContain("/items");
      expect(calls[3][0].path).toContain("/login");
      expect(calls[4][0].path).toContain("/update");
      expect(calls[5][0].path).toContain("/items");

      // Check that /login has no X-Apple-ActionSignature
      expect(calls[0][0].headers?.["X-Apple-ActionSignature"]).toBeUndefined();
      // Check that /update and /items have signatures
      expect(calls[1][0].headers?.["X-Apple-ActionSignature"]).toBe("mock-signature");
      expect(calls[2][0].headers?.["X-Apple-ActionSignature"]).toBe("mock-signature");
      expect(calls[4][0].headers?.["X-Apple-ActionSignature"]).toBe("mock-signature");
      expect(calls[5][0].headers?.["X-Apple-ActionSignature"]).toBe("mock-signature");

      // Check common headers present on all calls
      for (const call of calls) {
        expect(call[0].headers?.["Accept"]).toBe("*/*");
        expect(call[0].headers?.["iCloud-DSID"]).toBe("12345");
        expect(call[0].headers?.["X-Token"]).toBe("mock-token");
        expect(call[0].headers?.["X-Guid"]).toBe("AABBCCDDEEFF");
      }

      // Should have 1 app
      expect(result.apps).toHaveLength(1);
      expect(result.apps[0].adamId).toBe(1);
    });

    it("should send the exact DAAP query string on /update", async () => {
      const expectedQuery =
        "('com.apple.itunes.extended\\-media\\-kind:131072','com.apple.itunes.extended\\-media\\-kind:262144','com.apple.itunes.extended\\-media\\-kind:67108864')";

      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const itemsBuf = buildItemsBuffer(200, [
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 1600000000, mediaKind: 131072, platformBitmask: 1 },
      ]);

      const loginResponse = makeMockResponse(loginBuf);
      const updateResponse = makeMockResponse(updateBuf);
      const itemsResponse = makeMockResponse(itemsBuf);

      const callSequence = [loginResponse, updateResponse, itemsResponse, loginResponse, updateResponse, itemsResponse];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await fetchOwnedApps(mockAccount);

      // Check the /update request body contains the query
      const updateCalls = vi.mocked(appleRequest).mock.calls.filter(
        (c) => c[0].path.includes("/update"),
      );
      for (const call of updateCalls) {
        expect(call[0].body).toContain(expectedQuery);
      }
    });

    it("should merge and deduplicate apps across storefronts", async () => {
      // Storefront 34 has App A and App B
      // Storefront 13 has App B (same adamId, different purchaseDate) and App C
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);

      const itemsBuf34 = buildItemsBuffer(200, [
        { adamId: 1, bundleId: "com.a", name: "App A", version: "1.0", purchaseDate: 1600000000, mediaKind: 131072, platformBitmask: 1 },
        { adamId: 2, bundleId: "com.b", name: "App B", version: "2.0", purchaseDate: 1590000000, mediaKind: 131072, platformBitmask: 2 },
      ]);

      const itemsBuf13 = buildItemsBuffer(200, [
        { adamId: 2, bundleId: "com.b", name: "App B", version: "2.0", purchaseDate: 1610000000, mediaKind: 131072, platformBitmask: 8 },
        { adamId: 3, bundleId: "com.c", name: "App C", version: "3.0", purchaseDate: 1580000000, mediaKind: 67108864, platformBitmask: 8 },
      ]);

      const loginResp = makeMockResponse(loginBuf);
      const updateResp = makeMockResponse(updateBuf);
      const itemsResp34 = makeMockResponse(itemsBuf34);
      const itemsResp13 = makeMockResponse(itemsBuf13);

      const callSequence = [loginResp, updateResp, itemsResp34, loginResp, updateResp, itemsResp13];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      const result = await fetchOwnedApps(mockAccount);

      // Should have 3 unique apps (App B deduplicated)
      expect(result.apps).toHaveLength(3);

      // Find App B
      const appB = result.apps.find((a) => a.adamId === 2);
      expect(appB).toBeDefined();
      // Should have the max purchase date (1610000000 from storefront 13)
      expect(appB!.purchaseDate).toBe(1610000000);
      // Should have union of platform bitmasks (2 | 8 = 10)
      expect(appB!.platformBitmask).toBe(10);

      // Should be sorted by purchase date descending
      expect(result.apps[0].purchaseDate).toBeGreaterThanOrEqual(result.apps[1].purchaseDate);
      expect(result.apps[1].purchaseDate).toBeGreaterThanOrEqual(result.apps[2].purchaseDate);
    });

    it("should retry on 401/403 by throwing DaapAuthError", async () => {
      // Return 401 on the items call
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const errorBuf = writeDmapContainer("adbs", [writeDmapUInt32("mstt", 401)]);

      const loginResp = makeMockResponse(loginBuf);
      const updateResp = makeMockResponse(updateBuf);
      const errorResp = makeMockResponse(errorBuf);

      const callSequence = [loginResp, updateResp, errorResp];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await expect(fetchOwnedApps(mockAccount)).rejects.toThrow(DaapAuthError);
    });

    it("should throw DaapAuthError on HTTP 401 with a non-DMAP body (F-A)", async () => {
      // Apple may answer HTTP 401 with an empty/non-DMAP body. Before the
      // status check, parseDmap returned [] -> no mstt node -> the call
      // reported SUCCESS with a silently empty purchase list, which is
      // indistinguishable from "you own no apps".
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);

      const loginResp = makeMockResponse(loginBuf);
      const updateResp = makeMockResponse(updateBuf);
      const itemsResp = makeMockResponse(new Uint8Array(0), 401);

      const callSequence = [loginResp, updateResp, itemsResp];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await expect(fetchOwnedApps(mockAccount)).rejects.toThrow(DaapAuthError);
    });

    it("should throw DaapAuthError on HTTP 403 from /login (F-A)", async () => {
      const loginResp = makeMockResponse(new Uint8Array(0), 403);
      vi.mocked(appleRequest).mockImplementation(async () => loginResp);

      await expect(fetchOwnedApps(mockAccount)).rejects.toThrow(DaapAuthError);
    });

    it("should throw DaapAuthError on HTTP 403 from /update (F-A)", async () => {
      const loginResp = makeMockResponse(buildLoginBuffer(100));
      const updateResp = makeMockResponse(new Uint8Array(0), 403);

      const callSequence = [loginResp, updateResp];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await expect(fetchOwnedApps(mockAccount)).rejects.toThrow(DaapAuthError);
    });

    it("should include all common headers on every request", async () => {
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const itemsBuf = buildItemsBuffer(200, [
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 1600000000, mediaKind: 131072, platformBitmask: 1 },
      ]);

      const loginResp = makeMockResponse(loginBuf);
      const updateResp = makeMockResponse(updateBuf);
      const itemsResp = makeMockResponse(itemsBuf);

      const callSequence = [loginResp, updateResp, itemsResp, loginResp, updateResp, itemsResp];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await fetchOwnedApps(mockAccount);

      const calls = vi.mocked(appleRequest).mock.calls;
      for (const call of calls) {
        const h = call[0].headers!;
        expect(h["Accept-Language"]).toBe("en-us");
        expect(h["Client-Cloud-DAAP-Request-Reason"]).toBe("5");
        expect(h["Client-Cloud-Purchase-Daap-Version"]).toBe("1.1/Configurator-2.0");
        expect(h["Client-DAAP-Version"]).toBe("3.12");
        expect(h["Date"]).toBeDefined();
        expect(h["X-Apple-I-Client-Time"]).toBeDefined();
        expect(h["X-Apple-I-Locale"]).toBe("en_US");
        expect(h["X-Apple-I-TimeZone"]).toBeDefined();
        expect(h["X-Apple-TZ"]).toBeDefined();
        expect(h["X-Dsid"]).toBe("12345");
      }
    });

    it("should close the SAP signer after completion", async () => {
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const itemsBuf = buildItemsBuffer(200, [
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 1600000000, mediaKind: 131072, platformBitmask: 1 },
      ]);

      const loginResp = makeMockResponse(loginBuf);
      const updateResp = makeMockResponse(updateBuf);
      const itemsResp = makeMockResponse(itemsBuf);

      const callSequence = [loginResp, updateResp, itemsResp, loginResp, updateResp, itemsResp];
      let callIndex = 0;
      vi.mocked(appleRequest).mockImplementation(async () => callSequence[callIndex++]);

      await fetchOwnedApps(mockAccount);

      expect(mockSigner.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("mergeOwnedApps", () => {
    it("should merge apps by adamId", () => {
      const apps = [
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 100, mediaKind: 131072, platformBitmask: 1 },
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 200, mediaKind: 131072, platformBitmask: 2 },
      ];

      const merged = mergeOwnedApps(apps);
      expect(merged).toHaveLength(1);
      expect(merged[0].purchaseDate).toBe(200);
      expect(merged[0].platformBitmask).toBe(3); // 1 | 2
    });

    it("should sort by purchase date descending", () => {
      const apps = [
        { adamId: 1, bundleId: "com.a", name: "A", version: "1", purchaseDate: 100, mediaKind: 131072, platformBitmask: 1 },
        { adamId: 2, bundleId: "com.b", name: "B", version: "1", purchaseDate: 300, mediaKind: 131072, platformBitmask: 1 },
        { adamId: 3, bundleId: "com.c", name: "C", version: "1", purchaseDate: 200, mediaKind: 131072, platformBitmask: 1 },
      ];

      const merged = mergeOwnedApps(apps);
      expect(merged).toHaveLength(3);
      expect(merged[0].adamId).toBe(2);
      expect(merged[1].adamId).toBe(3);
      expect(merged[2].adamId).toBe(1);
    });

    it("should handle empty input", () => {
      expect(mergeOwnedApps([])).toEqual([]);
    });
  });

  describe("pageOwnedApps", () => {
    const apps = Array.from({ length: 10 }, (_, i) => ({
      adamId: i,
      bundleId: `com.a${i}`,
      name: `App ${i}`,
      version: "1",
      purchaseDate: i,
      mediaKind: 131072,
      platformBitmask: 1,
    }));

    it("should return the first page", () => {
      const page = pageOwnedApps(apps, 0, 3);
      expect(page).toHaveLength(3);
      expect(page[0].adamId).toBe(0);
    });

    it("should return the second page", () => {
      const page = pageOwnedApps(apps, 1, 3);
      expect(page).toHaveLength(3);
      expect(page[0].adamId).toBe(3);
    });

    it("should return the last partial page", () => {
      const page = pageOwnedApps(apps, 3, 3);
      expect(page).toHaveLength(1);
      expect(page[0].adamId).toBe(9);
    });

    it("should return empty for out-of-range page", () => {
      const page = pageOwnedApps(apps, 100, 3);
      expect(page).toEqual([]);
    });
  });

  describe("DAAP login transport (regression)", () => {
    it("sends an explicit Content-Length: 0 on /login", async () => {
      // /login has no body by design. Without an explicit Content-Length,
      // Akamai in front of pd.itunes.apple.com answers with 411 + text/html
      // BEFORE the request reaches Apple, which surfaced to users as the
      // misleading "missing mlog container". libcurl.js treats an empty-string
      // body as falsy (`body ? allocate_array(body) : null`), so the header has
      // to be set explicitly — passing body: "" would NOT fix it.
      const loginBuf = buildLoginBuffer(100);
      const updateBuf = buildUpdateBuffer(200);
      const itemsBuf = buildItemsBuffer(200, []);

      const seq = [
        makeMockResponse(loginBuf),
        makeMockResponse(updateBuf),
        makeMockResponse(itemsBuf),
        makeMockResponse(loginBuf),
        makeMockResponse(updateBuf),
        makeMockResponse(itemsBuf),
      ];
      let i = 0;
      vi.mocked(appleRequest).mockImplementation(async () => seq[i++]);

      await fetchOwnedApps(mockAccount);

      const loginCalls = vi
        .mocked(appleRequest)
        .mock.calls.filter((c) => String(c[0].path).endsWith("/login"));
      expect(loginCalls.length).toBeGreaterThan(0);
      for (const call of loginCalls) {
        expect(call[0].headers!["Content-Length"]).toBe("0");
      }
    });

    it("surfaces Apple's merr/mstt status instead of 'missing mlog'", async () => {
      // Apple's real DMAP error shape: merr → mstt = 400.
      const errBuf = writeDmapContainer("merr", [writeDmapUInt32("mstt", 400)]);
      vi.mocked(appleRequest).mockImplementation(async () =>
        makeMockResponse(errBuf),
      );

      const err = (await fetchOwnedApps(mockAccount).catch(
        (e) => e as Error,
      )) as Error;

      expect(err.message).toMatch(/status 400/);
      expect(err.message).not.toMatch(/missing mlog/);
    });
  });
});