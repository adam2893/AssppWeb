import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchApps, lookupApp } from "../../src/api/search";
import { apiGet } from "../../src/api/client";

vi.mock("../../src/api/client", () => ({
  apiGet: vi.fn(),
}));

/**
 * `searchApps` accepts either a platform id (what the UI passes) or a legacy
 * iTunes entity string. A missing `case "ipad"` previously made the id fall
 * through to the default platform, so iPad search silently returned iPhone
 * results. These tests pin every accepted input.
 */
describe("api/search entity mapping", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValue([]);
  });

  async function entityFor(input: string): Promise<string | null> {
    // Clear first: several tests call this repeatedly, and reading calls[0]
    // without clearing would re-read the FIRST call's URL every time.
    vi.mocked(apiGet).mockClear();
    await searchApps("term", "US", input);
    const url = vi.mocked(apiGet).mock.calls[0][0] as string;
    return new URLSearchParams(url.split("?")[1]).get("entity");
  }

  it("maps platform ids to the correct iTunes search entity", async () => {
    expect(await entityFor("iphone")).toBe("software");
    expect(await entityFor("ipad")).toBe("iPadSoftware");
    // tvOS search uses the compound entity, unlike its lookup entity.
    expect(await entityFor("appletv")).toBe("software,tvSoftware");
  });

  it("still maps legacy entity strings (backward compatibility)", async () => {
    expect(await entityFor("software")).toBe("software");
    expect(await entityFor("iPadSoftware")).toBe("iPadSoftware");
    expect(await entityFor("iPad")).toBe("iPadSoftware");
    expect(await entityFor("tvSoftware")).toBe("software,tvSoftware");
  });

  it("falls back to the default platform for unknown input", async () => {
    expect(await entityFor("nonsense")).toBe("software");
  });

  it("passes term, country and limit through", async () => {
    await searchApps("hello", "GB", "ipad", 10);
    const url = vi.mocked(apiGet).mock.calls[0][0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("term")).toBe("hello");
    expect(params.get("country")).toBe("GB");
    expect(params.get("limit")).toBe("10");
  });
});

/**
 * iTunes honours only one of `id` / `bundleId` and silently returns zero
 * results for the other, so sending the wrong one looks like "app not found".
 * The product route carries a numeric id, so it must not be sent as a bundle id.
 */
describe("api/search lookup identifier", () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValue(null);
  });

  async function lookupParams(
    identifier: string,
    platform?: "iphone" | "ipad" | "appletv",
  ): Promise<URLSearchParams> {
    vi.mocked(apiGet).mockClear();
    await lookupApp(identifier, "GB", platform);
    const url = vi.mocked(apiGet).mock.calls[0][0] as string;
    return new URLSearchParams(url.split("?")[1]);
  }

  it("sends a numeric id as id=", async () => {
    const params = await lookupParams("284882215");
    expect(params.get("id")).toBe("284882215");
    expect(params.get("bundleId")).toBeNull();
    expect(params.get("country")).toBe("GB");
  });

  it("sends a bundle id as bundleId=", async () => {
    const params = await lookupParams("com.example.app");
    expect(params.get("bundleId")).toBe("com.example.app");
    expect(params.get("id")).toBeNull();
  });

  it("still passes the platform's lookup entity", async () => {
    // tvOS lookup takes only tvSoftware, unlike its compound search entity.
    expect((await lookupParams("com.example.app", "appletv")).get("entity")).toBe(
      "tvSoftware",
    );
    expect((await lookupParams("123", "ipad")).get("entity")).toBe(
      "iPadSoftware",
    );
  });
});
