import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthDiagnostics from "../../src/components/Account/AuthDiagnostics";
import type { AuthenticationDiagnostics } from "../../src/apple/authenticate";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { milliseconds?: number }) =>
      options?.milliseconds === undefined
        ? key
        : `${key}:${options.milliseconds}`,
  }),
}));

describe("AuthDiagnostics", () => {
  it("renders only safe authentication fields", () => {
    const diagnostics: AuthenticationDiagnostics = {
      bagFetchStatus: "ready",
      resolvedAuthEndpoint: "https://auth.itunes.apple.com/auth/v1/native/fast",
      pod: "25",
      storefront: "143441",
      sapAssetReadiness: "not-required",
      wispConnection: "ready",
      lastAppleStatusCode: 200,
      retryCount: 1,
      retryDelayMs: 1000,
      failureReason: "HTTP 503",
    };

    render(<AuthDiagnostics diagnostics={diagnostics} />);

    expect(screen.getByText("accounts.authDiagnostics.title")).toBeInTheDocument();
    expect(screen.getByText("https://auth.itunes.apple.com/auth/v1/native/fast")).toBeInTheDocument();
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    expect(screen.queryByText(/password|cookie|token|signature|header/i)).toBeNull();
  });
});
