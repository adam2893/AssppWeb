import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../src/components/Settings/SettingsPage";
import { useSettingsStore } from "../../src/store/settings";
import { DEFAULT_PLATFORM } from "../../src/apple/platform";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
}));

vi.mock("../../src/api/client", () => ({
  // Never settles: the page fetches server info on mount, and a late resolution
  // would update state outside act(). These tests do not assert on it.
  apiGet: vi.fn(() => new Promise(() => {})),
  apiPost: vi.fn(async () => ({})),
  authHeaders: () => ({}),
}));

const COUNTRY_LABEL = "settings.defaults.country";

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    defaultCountry: "US",
    platform: DEFAULT_PLATFORM,
    theme: "light",
  });
});

afterEach(cleanup);

function renderPage() {
  // PageContainer reads the current location, so a router is required.
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

/**
 * The default-country control used to write a localStorage key that nothing
 * read, so picking a country had no effect anywhere. These tests assert the
 * control and the rest of the app now share one source of truth.
 */
describe("SettingsPage default country", () => {
  it("writes the selected country to the settings store", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(screen.getByLabelText(COUNTRY_LABEL), "GB");

    expect(useSettingsStore.getState().defaultCountry).toBe("GB");
  });

  it("does not write the retired localStorage key", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(screen.getByLabelText(COUNTRY_LABEL), "JP");

    expect(localStorage.getItem("asspp-default-country")).toBeNull();
  });

  it("shows the country held in the settings store", () => {
    useSettingsStore.setState({ defaultCountry: "DE" });

    renderPage();

    expect(screen.getByLabelText(COUNTRY_LABEL)).toHaveValue("DE");
  });
});
