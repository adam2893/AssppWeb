import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/store/settings";
import { DEFAULT_PLATFORM } from "../../src/apple/platform";

describe("store/settings", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the zustand store
    useSettingsStore.setState({
      defaultCountry: "US",
      platform: DEFAULT_PLATFORM,
    });
  });

  it("should have default country US", () => {
    const state = useSettingsStore.getState();
    expect(state.defaultCountry).toBe("US");
  });

  it("should have default platform iphone", () => {
    const state = useSettingsStore.getState();
    expect(state.platform).toBe("iphone");
  });

  it("should update default country", () => {
    useSettingsStore.getState().setDefaultCountry("GB");
    expect(useSettingsStore.getState().defaultCountry).toBe("GB");
  });

  it("should update platform", () => {
    useSettingsStore.getState().setPlatform("ipad");
    expect(useSettingsStore.getState().platform).toBe("ipad");
  });

  it("migrates a legacy defaultEntity into platform", async () => {
    localStorage.setItem(
      "asspp-settings",
      JSON.stringify({
        state: { defaultEntity: "iPad", defaultCountry: "GB" },
        version: 0,
      }),
    );

    await useSettingsStore.persist.rehydrate();

    const state = useSettingsStore.getState();
    expect(state.platform).toBe("ipad");
    expect(state.defaultCountry).toBe("GB");
    expect((state as Record<string, unknown>).defaultEntity).toBeUndefined();
  });

  it("falls back to the default platform for an unknown legacy entity", async () => {
    localStorage.setItem(
      "asspp-settings",
      JSON.stringify({ state: { defaultEntity: "somethingElse" }, version: 0 }),
    );

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().platform).toBe(DEFAULT_PLATFORM);
  });
});
