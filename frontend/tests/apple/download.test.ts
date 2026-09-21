import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { getDownloadInfo, DownloadError } from "../../src/apple/download";
import { appleRequest } from "../../src/apple/request";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

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

function successResponse(overrides?: {
  sinfs?: Record<string, any>[];
  bundleShortVersionString?: string;
  bundleVersion?: string;
  url?: string;
}): string {
  return buildPlist({
    songList: [
      {
        URL: overrides?.url ?? "https://example.com/download.ipa",
        metadata: {
          bundleShortVersionString:
            overrides?.bundleShortVersionString ?? "1.0",
          bundleVersion: overrides?.bundleVersion ?? "1.0.0",
          appleId: "test@example.com",
        },
        sinfs: overrides?.sinfs ?? [
          { id: 1, sinf: "c2luZmRhdGE=" },
        ],
      },
    ],
  });
}

function failureResponse(failureType: string, customerMessage?: string): string {
  const dict: Record<string, any> = { failureType };
  if (customerMessage) {
    dict.customerMessage = customerMessage;
  }
  return buildPlist(dict);
}

function emptySongListResponse(): string {
  return buildPlist({ songList: [] });
}

function noSongListResponse(): string {
  return buildPlist({});
}

describe("apple/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Item #7 — empty sinfs", () => {
    it("resolves with unlicensed flag when sinfs array is empty", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: successResponse({ sinfs: [] }),
      });

      const result = await getDownloadInfo(mockAccount, mockApp);

      expect(result.unlicensed).toBe(true);
      expect(result.output.sinfs).toEqual([]);
      expect(result.output.downloadURL).toBe(
        "https://example.com/download.ipa",
      );
      expect(result.output.bundleShortVersionString).toBe("1.0");
      expect(result.output.bundleVersion).toBe("1.0.0");
      expect(result.output.iTunesMetadata).toBeDefined();
    });

    it("resolves without unlicensed flag when sinfs are present", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: successResponse({
          sinfs: [{ id: 1, sinf: "c2luZmRhdGE=" }],
        }),
      });

      const result = await getDownloadInfo(mockAccount, mockApp);

      expect(result.unlicensed).toBe(false);
      expect(result.output.sinfs).toHaveLength(1);
    });

    it("does not throw DownloadError for missing sinfs", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: successResponse({ sinfs: [] }),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).resolves.toBeDefined();
    });
  });

  describe("Item #4 — download fallback chain", () => {
    it("advances to redownload when primary returns 5002", async () => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: failureResponse("5002"),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: successResponse(),
        });

      const result = await getDownloadInfo(mockAccount, mockApp);

      expect(result.output.downloadURL).toBe(
        "https://example.com/download.ipa",
      );
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(2);

      // First call should be volumeStore (pod host)
      const firstCall = vi.mocked(appleRequest).mock.calls[0][0];
      expect(firstCall.host).toContain("buy.itunes.apple.com");

      // Second call should be redownload (downloaddispatch, /r/redownload)
      const secondCall = vi.mocked(appleRequest).mock.calls[1][0];
      expect(secondCall.host).toBe("downloaddispatch.itunes.apple.com");
      expect(secondCall.path).toContain("/r/redownload");
    });

    it("advances to redownload when primary returns empty songList", async () => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: emptySongListResponse(),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: successResponse(),
        });

      const result = await getDownloadInfo(mockAccount, mockApp);

      expect(result.output.downloadURL).toBe(
        "https://example.com/download.ipa",
      );
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(2);

      const secondCall = vi.mocked(appleRequest).mock.calls[1][0];
      expect(secondCall.host).toBe("downloaddispatch.itunes.apple.com");
      expect(secondCall.path).toContain("/r/redownload");
    });

    it("advances to updateProduct when redownload also yields nothing", async () => {
      // Primary returns 5002 → advances to redownload
      // Redownload returns empty songList → advances to updateProduct
      // UpdateProduct succeeds
      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: failureResponse("5002"),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: emptySongListResponse(),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: successResponse(),
        });

      const result = await getDownloadInfo(mockAccount, mockApp);

      expect(result.output.downloadURL).toBe(
        "https://example.com/download.ipa",
      );
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(3);

      const thirdCall = vi.mocked(appleRequest).mock.calls[2][0];
      expect(thirdCall.host).toBe("downloaddispatch.itunes.apple.com");
      expect(thirdCall.path).toContain("/up/updateProduct");
    });

    it("throws noItems when all three endpoints return empty songList", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: emptySongListResponse(),
      });

      await expect(
        getDownloadInfo(mockAccount, mockApp),
      ).rejects.toThrow(DownloadError);

      // Exactly 3 attempts — one per endpoint, no looping
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(3);
    });

    it("throws noItems when all three endpoints return no songList key", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: noSongListResponse(),
      });

      await expect(
        getDownloadInfo(mockAccount, mockApp),
      ).rejects.toThrow(DownloadError);

      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(3);
    });

    it("throws tooManyRedirects when a single endpoint redirects more than 3 times", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 302,
        statusText: "Found",
        headers: { location: "https://redirect.example.com/new-path" },
        rawHeaders: [],
        body: "",
      });

      await expect(
        getDownloadInfo(mockAccount, mockApp),
      ).rejects.toThrow(DownloadError);

      // 4 attempts (0, 1, 2, 3) before exceeding limit
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(4);
    });

    it("passes externalVersionId with the correct key for each endpoint", async () => {
      const versionId = "12345";

      vi.mocked(appleRequest)
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: failureResponse("5002"),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: failureResponse("5002"),
        })
        .mockResolvedValueOnce({
          status: 200,
          statusText: "OK",
          headers: {},
          rawHeaders: [],
          body: successResponse(),
        });

      await getDownloadInfo(mockAccount, mockApp, versionId);

      // Each call should include the version ID under the endpoint-specific key
      const calls = vi.mocked(appleRequest).mock.calls;

      // volumeStore uses externalVersionId
      expect(calls[0][0].body).toContain("externalVersionId");
      expect(calls[0][0].body).toContain(versionId);

      // redownload uses appExtVrsId
      expect(calls[1][0].body).toContain("appExtVrsId");
      expect(calls[1][0].body).toContain(versionId);

      // updateProduct uses appExtVrsId
      expect(calls[2][0].body).toContain("appExtVrsId");
      expect(calls[2][0].body).toContain(versionId);
    });
  });

  describe("error mapping preserved", () => {
    it("throws passwordExpired for failureType 2034", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: failureResponse("2034"),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Password token is expired",
      );
    });

    it("throws passwordExpired for failureType 2042", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: failureResponse("2042"),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Password token is expired",
      );
    });

    it("throws licenseRequired for failureType 9610", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: failureResponse("9610"),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "License required",
      );
    });

    it("throws passwordExpired when customerMessage is 'Your password has changed.'", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: failureResponse("9999", "Your password has changed."),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Password token is expired",
      );
    });

    it("throws downloadFailed with failureType for unknown failure types", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: failureResponse("9999"),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Download failed: 9999",
      );
    });

    it("throws missingUrl when songList item has no URL", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: successResponse({ url: "" }),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Missing download URL",
      );
    });

    it("throws missingMetadata when songList item has no metadata", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          songList: [
            {
              URL: "https://example.com/download.ipa",
              sinfs: [{ id: 1, sinf: "c2luZmRhdGE=" }],
            },
          ],
        }),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Missing metadata",
      );
    });

    it("throws missingVersion when bundleShortVersionString is missing", async () => {
      vi.mocked(appleRequest).mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: successResponse({ bundleShortVersionString: "" }),
      });

      await expect(getDownloadInfo(mockAccount, mockApp)).rejects.toThrow(
        "Missing required version information",
      );
    });
  });
});