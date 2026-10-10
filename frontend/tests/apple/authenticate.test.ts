import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/apple/bag")>();
  return {
    ...actual,
    fetchBag: vi.fn(),
    defaultAuthURL:
      "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
  };
});

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("AABBCCDDEEFF");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it("normalizes relative legacy redirects", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1",
    });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 302,
        statusText: "Found",
        headers: {
          location: "/WebObjects/MZFinance.woa/wa/authenticate?bar=2",
        },
        rawHeaders: [],
        body: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        rawHeaders: [],
        body: buildPlist({
          accountInfo: {
            appleId: "test@example.com",
            address: { firstName: "Test", lastName: "User" },
          },
          passwordToken: "token",
          dsPersonId: "123",
        }),
      });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    expect(vi.mocked(appleRequest).mock.calls[0][0].path).toBe(
      "/WebObjects/MZFinance.woa/wa/authenticate/?foo=1&guid=AABBCCDDEEFF",
    );
    expect(vi.mocked(appleRequest).mock.calls[1][0]).toMatchObject({
      host: "buy.itunes.apple.com",
      path: "/WebObjects/MZFinance.woa/wa/authenticate/?bar=2",
    });
  });

  it.each([204, 404, 429, 500, 503])(
    "retries transient authentication status %s up to three attempts",
    async (status) => {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.stubGlobal("setTimeout", (callback: TimerHandler) => {
        if (typeof callback === "function") callback();
        return 0;
      });
      vi.mocked(appleRequest).mockResolvedValue({
        status,
        statusText: "Transient",
        headers: {},
        rawHeaders: [],
        body: "",
      });

      await expect(
        authenticate(
          "test@example.com",
          "password",
          undefined,
          undefined,
          "aabbccddeeff",
        ),
      ).rejects.toThrow(String(status));
      expect(appleRequest).toHaveBeenCalledTimes(3);
    },
  );
});
