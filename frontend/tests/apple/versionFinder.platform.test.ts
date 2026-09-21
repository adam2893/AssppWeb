import { beforeEach, describe, expect, it, vi } from "vitest";
import { listVersions } from "../../src/apple/versionFinder";
import type { Account, Software } from "../../src/types";

// Mock appleRequest to prevent libcurl.js from loading in test environment
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mockAccount: Account = {
  email: "test@example.com",
  password: "password",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token123",
  directoryServicesIdentifier: "dsid-abc",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "25",
};

const mockApp: Software = {
  id: 1234567890,
  bundleID: "com.example.app",
  name: "Test App",
  version: "1.0",
  price: 0,
  artistName: "Test Artist",
  sellerName: "Test Seller",
  description: "A test app",
  averageUserRating: 4.5,
  userRatingCount: 100,
  artworkUrl: "https://example.com/artwork.png",
  screenshotUrls: [],
  minimumOsVersion: "12.0",
  fileSizeBytes: "1048576",
  releaseDate: "2024-01-01",
  releaseNotes: "Initial release",
  formattedPrice: "Free",
  primaryGenreName: "Utilities",
};

function makePlatformResponse(
  appId: number,
  externalId: string,
  buyParams?: string,
): any {
  return {
    results: {
      [String(appId)]: {
        offers: [
          {
            version: { externalId },
            buyParams: buyParams ?? `appExtVrsId=${externalId};foo=bar`,
          },
        ],
      },
    },
  };
}

function makeEmptyResponse(): any {
  return { results: {} };
}

describe("apple/versionFinder (platform-aware)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("MZStorePlatform request URL", () => {
    it("uses enterprisestore catalog for iphone", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      await listVersions(mockAccount, mockApp, "iphone");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("platform")).toBe("enterprisestore");
    });

    it("uses enterprisestore catalog for ipad", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      await listVersions(mockAccount, mockApp, "ipad");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("platform")).toBe("enterprisestore");
    });

    it("uses atv9 catalog for appletv", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      await listVersions(mockAccount, mockApp, "appletv");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("platform")).toBe("atv9");
    });
  });

  describe("enterprisestore retry for mobile platforms", () => {
    it("retries with iphone then ipad when enterprisestore returns empty for iphone", async () => {
      // enterprisestore → empty
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeEmptyResponse()),
        })
        // iphone → empty
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeEmptyResponse()),
        })
        // ipad → success
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve(makePlatformResponse(1234567890, "55555")),
        });

      const result = await listVersions(mockAccount, mockApp, "iphone");

      expect(result.versions).toEqual(["55555"]);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const calls = mockFetch.mock.calls;
      expect(new URL(calls[0][0]).searchParams.get("platform")).toBe(
        "enterprisestore",
      );
      expect(new URL(calls[1][0]).searchParams.get("platform")).toBe("iphone");
      expect(new URL(calls[2][0]).searchParams.get("platform")).toBe("ipad");
    });

    it("does NOT retry for appletv when atv9 returns empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeEmptyResponse()),
      });

      await expect(
        listVersions(mockAccount, mockApp, "appletv"),
      ).rejects.toThrow("No version data found");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("externalId extraction", () => {
    it("reads externalId from offers[0].version.externalId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePlatformResponse(1234567890, "99999")),
      });

      const result = await listVersions(mockAccount, mockApp, "iphone");
      expect(result.versions).toEqual(["99999"]);
    });

    it("falls back to appExtVrsId from buyParams when externalId is missing", async () => {
      const response = {
        results: {
          "1234567890": {
            offers: [
              {
                version: {}, // no externalId
                buyParams: "appExtVrsId=77777;foo=bar",
              },
            ],
          },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const result = await listVersions(mockAccount, mockApp, "iphone");
      expect(result.versions).toEqual(["77777"]);
    });

    it("throws when neither externalId nor buyParams has a version", async () => {
      const response = {
        results: {
          "1234567890": {
            offers: [
              {
                version: {},
                buyParams: "foo=bar",
              },
            ],
          },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      await expect(
        listVersions(mockAccount, mockApp, "iphone"),
      ).rejects.toThrow("No version identifier found");
    });
  });

  describe("backward compatibility", () => {
    it("returns existing cookies when platform is specified", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      const result = await listVersions(mockAccount, mockApp, "iphone");
      expect(result.updatedCookies).toBe(mockAccount.cookies);
    });
  });
});