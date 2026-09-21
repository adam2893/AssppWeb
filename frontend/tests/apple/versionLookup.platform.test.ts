import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVersionMetadata } from "../../src/apple/versionLookup";
import type { Account, Software } from "../../src/types";

// Mock appleRequest to prevent libcurl.js from loading in test environment
vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

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
  displayVersion?: string,
  releaseDate?: string,
): any {
  return {
    results: {
      [String(appId)]: {
        offers: [
          {
            version: {
              externalId,
              displayVersion: displayVersion ?? "2.0",
              releaseDate: releaseDate ?? "2024-06-15T00:00:00Z",
            },
            buyParams: `appExtVrsId=${externalId};foo=bar`,
          },
        ],
      },
    },
  };
}

describe("apple/versionLookup (platform-aware)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("MZStorePlatform request URL", () => {
    it("uses enterprisestore catalog for iphone", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      await getVersionMetadata(mockAccount, mockApp, "98765", "iphone");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("platform")).toBe("enterprisestore");
    });

    it("uses atv9 catalog for appletv", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      await getVersionMetadata(mockAccount, mockApp, "98765", "appletv");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("platform")).toBe("atv9");
    });
  });

  describe("metadata extraction", () => {
    it("returns displayVersion and releaseDate from the response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makePlatformResponse(1234567890, "98765", "3.1.0", "2025-01-10T00:00:00Z"),
          ),
      });

      const result = await getVersionMetadata(
        mockAccount,
        mockApp,
        "98765",
        "iphone",
      );

      expect(result.metadata.displayVersion).toBe("3.1.0");
      expect(result.metadata.releaseDate).toBe("2025-01-10T00:00:00Z");
    });

    it("falls back to externalId when displayVersion is missing", async () => {
      const response = {
        results: {
          "1234567890": {
            offers: [
              {
                version: {
                  externalId: "55555",
                  releaseDate: "2024-01-01T00:00:00Z",
                },
                buyParams: "appExtVrsId=55555",
              },
            ],
          },
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const result = await getVersionMetadata(
        mockAccount,
        mockApp,
        "55555",
        "iphone",
      );

      expect(result.metadata.displayVersion).toBe("55555");
    });
  });

  describe("enterprisestore retry for mobile platforms", () => {
    it("retries with iphone then ipad when enterprisestore fails for ipad", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve(makePlatformResponse(1234567890, "44444", "1.0")),
        });

      const result = await getVersionMetadata(
        mockAccount,
        mockApp,
        "44444",
        "ipad",
      );

      expect(result.metadata.displayVersion).toBe("1.0");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const calls = mockFetch.mock.calls;
      expect(new URL(calls[0][0]).searchParams.get("platform")).toBe(
        "enterprisestore",
      );
      expect(new URL(calls[1][0]).searchParams.get("platform")).toBe("iphone");
    });

    it("does NOT retry for appletv when atv9 fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      await expect(
        getVersionMetadata(mockAccount, mockApp, "98765", "appletv"),
      ).rejects.toThrow("No version metadata found for app");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("backward compatibility", () => {
    it("returns existing cookies when platform is specified", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(makePlatformResponse(1234567890, "98765")),
      });

      const result = await getVersionMetadata(
        mockAccount,
        mockApp,
        "98765",
        "iphone",
      );
      expect(result.updatedCookies).toBe(mockAccount.cookies);
    });
  });
});