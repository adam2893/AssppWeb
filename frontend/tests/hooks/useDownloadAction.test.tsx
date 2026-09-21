import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadAction } from "../../src/hooks/useDownloadAction";
import { useToastStore } from "../../src/store/toast";
import type { Account, Software } from "../../src/types";

const mocks = vi.hoisted(() => ({
  updateAccount: vi.fn(),
  getDownloadInfo: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  fetchTasks: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({ updateAccount: mocks.updateAccount }),
}));

vi.mock("../../src/apple/download", () => ({
  getDownloadInfo: mocks.getDownloadInfo,
}));

vi.mock("../../src/apple/purchase", () => ({
  purchaseApp: vi.fn(),
}));

vi.mock("../../src/apple/authenticate", () => ({
  authenticate: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}));

vi.mock("../../src/utils/account", () => ({
  accountHash: async () => "account-hash",
}));

vi.mock("../../src/store/downloads", () => ({
  useDownloadsStore: (selector: (state: unknown) => unknown) =>
    selector({ fetchTasks: mocks.fetchTasks }),
}));

const account: Account = {
  email: "owner@example.test",
  password: "password",
  appleId: "owner@example.test",
  store: "143441",
  firstName: "Owner",
  lastName: "Account",
  passwordToken: "token",
  directoryServicesIdentifier: "12345",
  cookies: [],
  deviceIdentifier: "aabbccddeeff",
};

const app: Software = {
  id: 1,
  bundleID: "com.example.app",
  name: "Example",
  version: "1.0",
  artistName: "Example",
  sellerName: "Example LLC",
  description: "",
  averageUserRating: 5,
  userRatingCount: 1,
  artworkUrl: "",
  screenshotUrls: [],
  minimumOsVersion: "16.0",
  releaseDate: "2026-01-01T00:00:00Z",
  primaryGenreName: "Utilities",
};

function downloadInfo(unlicensed: boolean) {
  return {
    output: {
      downloadURL: "https://example.test/app.ipa",
      sinfs: unlicensed ? [] : [{ id: 1, sinf: "AAAA" }],
      bundleShortVersionString: "1.0",
      bundleVersion: "1",
    },
    updatedCookies: [],
    unlicensed,
  };
}

describe("useDownloadAction unlicensed handling", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    mocks.updateAccount.mockReset();
    mocks.getDownloadInfo.mockReset();
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.fetchTasks.mockReset();
    mocks.apiGet.mockResolvedValue({ maxDownloadMB: 0 });
    mocks.apiPost.mockResolvedValue(undefined);
  });

  afterEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("raises a warning toast when the response carried no sinf data", async () => {
    mocks.getDownloadInfo.mockResolvedValue(downloadInfo(true));

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "errors.download.noSinf",
          type: "warning",
        }),
      ]),
    );
    expect(toasts.filter((toast) => toast.type === "warning")).toHaveLength(1);
  });

  it("does not warn when the package was licensed normally", async () => {
    mocks.getDownloadInfo.mockResolvedValue(downloadInfo(false));

    const { result } = renderHook(() => useDownloadAction());
    await act(async () => {
      await result.current.startDownload(account, app);
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((toast) => toast.type === "warning")).toBe(false);
    expect(toasts.some((toast) => toast.type === "info")).toBe(true);
  });
});
