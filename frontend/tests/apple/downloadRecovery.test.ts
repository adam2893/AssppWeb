import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist, parsePlist } from "../../src/apple/plist";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { getVersionMetadata } from "../../src/apple/versionLookup";
import { listVersions } from "../../src/apple/versionFinder";
import { getDownloadInfo } from "../../src/apple/download";
import type { Account, Software } from "../../src/types";

vi.mock("../../src/apple/request", () => ({ appleRequest: vi.fn() }));
vi.mock("../../src/apple/bag", () => ({ fetchBag: vi.fn() }));

const account: Account = {
  email: "test@example.invalid",
  password: "not-real",
  appleId: "",
  store: "143465-19,32",
  firstName: "",
  lastName: "",
  passwordToken: "private-token",
  directoryServicesIdentifier: "123",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
  pod: "10",
};

const app = {
  id: 736536022,
  bundleID: "tv.danmaku.bilianime",
} as Software;

const versionMetadata = {
  itemId: app.id,
  softwareVersionExternalIdentifier: 891730218,
  softwareVersionBundleId: app.bundleID,
  bundleShortVersionString: "9.13.0",
  bundleVersion: "913000",
  releaseDate: "2026-10-01",
  softwareVersionExternalIdentifiers: [100, 891730218],
};

function plist(dict: Record<string, unknown>, status = 200) {
  return {
    status,
    statusText: "",
    headers: {},
    rawHeaders: [] as [string, string][],
    body: buildPlist(dict),
  };
}

function success(overrides: Record<string, unknown> = {}) {
  return plist({
    songList: [
      {
        URL: "https://example.invalid/app.ipa",
        metadata: { ...versionMetadata, ...overrides },
        sinfs: [{ id: 0, sinf: "AA==" }],
      },
    ],
  });
}

function catalog() {
  return {
    status: 200,
    statusText: "",
    headers: {},
    rawHeaders: [] as [string, string][],
    body: JSON.stringify({
      results: {
        [app.id]: {
          bundleId: app.bundleID,
          offers: [{ version: { externalId: 891730218 } }],
        },
      },
    }),
  };
}

describe("Apple empty-response recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "",
      updateURL:
        "https://downloaddispatch.itunes.apple.com/up/updateProduct",
    });
  });

  it("resolves an unpinned version from the account storefront before listing versions", async () => {
    const first = plist({});
    first.rawHeaders = [
      [
        "set-cookie",
        "storeSession=continued; Domain=.itunes.apple.com; Path=/; Secure",
      ],
    ];
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce(success());

    const result = await listVersions(account, app);

    expect(result.versions).toEqual(["891730218", "100"]);
    const lookup = vi.mocked(appleRequest).mock.calls[1][0];
    expect(lookup.host).toBe("uclient-api.itunes.apple.com");
    expect(lookup.path).toContain("platform=enterprisestore");
    expect(lookup.path).toContain("cc=cn");
    expect(lookup.cookies).toBeUndefined();
    const retry = vi.mocked(appleRequest).mock.calls[2][0];
    expect(retry.host).toBe("downloaddispatch.itunes.apple.com");
    expect(parsePlist(retry.body!)).toMatchObject({
      appExtVrsId: "891730218",
    });
    expect(retry.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "storeSession", value: "continued" }),
      ]),
    );
  });

  it("keeps a selected historical version while recovering version metadata", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(plist({}))
      .mockResolvedValueOnce(success({ softwareVersionExternalIdentifier: 100 }));

    const result = await getVersionMetadata(account, app, "100");

    expect(result.metadata.displayVersion).toBe("9.13.0");
    expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(2);
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[1][0].body!)).toMatchObject({
      appExtVrsId: "100",
    });
  });

  it("rejects a different app returned by the recovery endpoint", async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(plist({}))
      .mockResolvedValueOnce(success({ itemId: 1 }));

    await expect(getVersionMetadata(account, app, "100")).rejects.toThrow(
      "different app or version",
    );
  });

  it("does not trust an unallowlisted updateProduct URL", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: "",
      updateURL: "https://example.invalid/up/updateProduct",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(plist({}))
      .mockResolvedValueOnce(catalog())
      .mockResolvedValue({ status: 500, statusText: "", headers: {}, rawHeaders: [], body: "" });

    await expect(getDownloadInfo(account, app)).rejects.toThrow(
      "HTTP 500; empty response; downloaddispatch.itunes.apple.com/r/redownload",
    );
    expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(3);
  });
});
