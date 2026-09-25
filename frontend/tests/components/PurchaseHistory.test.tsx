import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PurchaseHistory from "../../src/components/Purchase/PurchaseHistory";
import { DaapAuthError, type OwnedApp } from "../../src/apple/purchaseHistory";
import type { Account } from "../../src/types";

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[],
  loadAccounts: vi.fn(),
  updateAccount: vi.fn(),
  fetchOwnedApps: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({
    accounts: mocks.accounts,
    loading: false,
    loadAccounts: mocks.loadAccounts,
    updateAccount: mocks.updateAccount,
  }),
}));

vi.mock("../../src/apple/authenticate", () => ({
  authenticate: mocks.authenticate,
}));

vi.mock("../../src/apple/purchaseHistory", () => {
  class MockDaapAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DaapAuthError";
    }
  }
  return {
    DaapAuthError: MockDaapAuthError,
    fetchOwnedApps: mocks.fetchOwnedApps,
    mergeOwnedApps: (apps: OwnedApp[]) => apps,
    pageOwnedApps: (apps: OwnedApp[], page: number, pageSize: number) =>
      apps.slice(page * pageSize, page * pageSize + pageSize),
  };
});

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

/** What a silent re-login hands back: a fresh token and cookies. */
const renewedAccount: Account = {
  ...account,
  passwordToken: "renewed-token",
  cookies: [{ name: "session", value: "renewed", path: "/" }],
};

function makeApp(index: number): OwnedApp {
  return {
    adamId: 1000 + index,
    bundleId: `com.example.app${index}`,
    name: `App ${index}`,
    version: `1.${index}`,
    purchaseDate: 1700000000 + index,
    mediaKind: 131072,
    platformBitmask: 1,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PurchaseHistory />
    </MemoryRouter>,
  );
}

describe("PurchaseHistory", () => {
  beforeEach(() => {
    mocks.accounts = [account];
    mocks.loadAccounts.mockReset();
    mocks.updateAccount.mockReset();
    mocks.fetchOwnedApps.mockReset();
    mocks.fetchOwnedApps.mockResolvedValue({ apps: [], updatedCookies: [] });
    // The DAAP token is renewed through the same authenticate() the download
    // flow uses; default to success so unrelated tests stay on the happy path.
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue(renewedAccount);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders owned apps without artwork, using name, bundle id, version and date", async () => {
    const updatedCookies = [
      {
        name: "session",
        value: "abc",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ];
    mocks.fetchOwnedApps.mockResolvedValue({
      apps: [makeApp(1), makeApp(2)],
      updatedCookies,
    });

    renderPage();

    expect(await screen.findByText("App 1")).toBeInTheDocument();
    expect(screen.getByText("com.example.app1")).toBeInTheDocument();
    expect(screen.getByText("v1.1")).toBeInTheDocument();
    expect(screen.getByText("App 2")).toBeInTheDocument();
    // No broken image slots are rendered — the icon falls back to a letter.
    expect(document.querySelectorAll("img")).toHaveLength(0);

    await waitFor(() =>
      expect(mocks.updateAccount).toHaveBeenCalledWith(
        expect.objectContaining({ email: account.email, cookies: updatedCookies }),
      ),
    );
  });

  it("links each owned app to its product page", async () => {
    mocks.fetchOwnedApps.mockResolvedValue({
      apps: [makeApp(1), makeApp(2)],
      updatedCookies: [],
    });

    renderPage();

    // The row carries only ids, so the product page looks the app up itself.
    expect(await screen.findByRole("link", { name: /App 1/ })).toHaveAttribute(
      "href",
      "/search/1001",
    );
    expect(screen.getByRole("link", { name: /App 2/ })).toHaveAttribute(
      "href",
      "/search/1002",
    );
  });

  it("renews an expired DAAP token and loads the list without asking to sign in", async () => {
    mocks.fetchOwnedApps
      .mockRejectedValueOnce(new DaapAuthError("token expired"))
      .mockResolvedValue({ apps: [makeApp(1)], updatedCookies: [] });

    renderPage();

    expect(await screen.findByText("App 1")).toBeInTheDocument();
    // The stored password is reused rather than re-prompted for.
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      account.email,
      account.password,
      undefined,
      account.cookies,
      account.deviceIdentifier,
    );
    // The renewed account is persisted, and the retry runs against it.
    expect(mocks.updateAccount).toHaveBeenCalledWith(renewedAccount);
    expect(mocks.fetchOwnedApps).toHaveBeenCalledTimes(2);
    expect(mocks.fetchOwnedApps).toHaveBeenLastCalledWith(renewedAccount);
    expect(screen.queryByText("purchases.authTitle")).not.toBeInTheDocument();
  });

  it("does not retry the fetch when renewal itself fails", async () => {
    mocks.fetchOwnedApps.mockRejectedValue(new DaapAuthError("token expired"));
    mocks.authenticate.mockRejectedValue(new Error("password changed"));

    renderPage();

    expect(await screen.findByText("purchases.authTitle")).toBeInTheDocument();
    // A failed renewal must not loop: one attempt, no retry.
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOwnedApps).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actionable re-authenticate state when renewal does not help", async () => {
    // fetchOwnedApps keeps rejecting, so the single retry fails too.
    mocks.fetchOwnedApps.mockRejectedValue(new DaapAuthError("token expired"));

    renderPage();

    expect(await screen.findByText("purchases.authTitle")).toBeInTheDocument();
    expect(screen.getByText("purchases.authDesc")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "purchases.authAction" }),
    ).toHaveAttribute("href", "/accounts/owner%40example.test");
    // Not an empty list.
    expect(screen.queryByText("purchases.empty")).not.toBeInTheDocument();
    // Exactly one renewal and one retry, then stop.
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOwnedApps).toHaveBeenCalledTimes(2);
  });

  it("shows a retryable error state for other failures", async () => {
    mocks.fetchOwnedApps.mockRejectedValue(new Error("network down"));

    renderPage();

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "purchases.errorRetry" }),
    ).toBeInTheDocument();
    // Only a rejected session triggers a renewal.
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("shows an empty state when the account owns nothing", async () => {
    renderPage();

    expect(await screen.findByText("purchases.empty")).toBeInTheDocument();
  });

  it("prompts to add an account when none exist", async () => {
    mocks.accounts = [];

    renderPage();

    expect(await screen.findByText("purchases.noAccounts")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "purchases.noAccountsLink" }),
    ).toHaveAttribute("href", "/accounts/add");
    expect(mocks.fetchOwnedApps).not.toHaveBeenCalled();
  });

  it("filters the list client-side by name or bundle id", async () => {
    const user = userEvent.setup();
    mocks.fetchOwnedApps.mockResolvedValue({
      apps: [makeApp(1), makeApp(2), makeApp(3)],
      updatedCookies: [],
    });

    renderPage();
    await screen.findByText("App 1");

    await user.type(screen.getByRole("searchbox"), "app2");

    expect(screen.getByText("App 2")).toBeInTheDocument();
    expect(screen.queryByText("App 1")).not.toBeInTheDocument();
    expect(screen.queryByText("App 3")).not.toBeInTheDocument();
  });

  it("pages very long lists in memory and reports the visible range", async () => {
    const user = userEvent.setup();
    mocks.fetchOwnedApps.mockResolvedValue({
      apps: Array.from({ length: 60 }, (_, i) => makeApp(i)),
      updatedCookies: [],
    });

    renderPage();
    await screen.findByText("App 0");

    // First page holds the first 50 apps.
    expect(screen.getByText("App 49")).toBeInTheDocument();
    expect(screen.queryByText("App 50")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /purchases.next/ }));

    expect(screen.getByText("App 50")).toBeInTheDocument();
    expect(screen.queryByText("App 0")).not.toBeInTheDocument();
  });
});
