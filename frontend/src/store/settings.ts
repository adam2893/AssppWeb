import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_PLATFORM, PLATFORMS, type PlatformId } from "../apple/platform";

type ThemeType = "light" | "dark" | "system";

interface SettingsState {
  defaultCountry: string;
  /** Default platform for search & lookups. Replaces the legacy `defaultEntity`. */
  platform: PlatformId;
  theme: ThemeType;
  setDefaultCountry: (country: string) => void;
  setPlatform: (platform: PlatformId) => void;
  setTheme: (theme: ThemeType) => void;
}

/** Shape of the state persisted by older versions of the app. */
interface LegacyPersistedSettings {
  defaultCountry?: string;
  /** Pre-platform field: "iPhone" | "iPad". */
  defaultEntity?: string;
  platform?: string;
  theme?: ThemeType;
}

function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && value in PLATFORMS;
}

/** Map the legacy `defaultEntity` values onto platform ids. */
function platformFromLegacyEntity(entity: unknown): PlatformId {
  if (entity === "iPad") return "ipad";
  if (entity === "iPhone") return "iphone";
  return DEFAULT_PLATFORM;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultCountry: "US",
      platform: DEFAULT_PLATFORM,
      theme: "light",
      setDefaultCountry: (country) => set({ defaultCountry: country }),
      setPlatform: (platform) => set({ platform }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "asspp-settings",
      // Bumped from 0 → 1 when `defaultEntity` became `platform`.
      version: 1,
      migrate: (persistedState) => {
        const persisted = (persistedState ?? {}) as LegacyPersistedSettings;
        const { defaultEntity, platform, ...rest } = persisted;
        return {
          ...rest,
          // Keep an already-valid platform; otherwise derive it from the
          // legacy device type so existing users keep their selection.
          platform: isPlatformId(platform)
            ? platform
            : platformFromLegacyEntity(defaultEntity),
        } as SettingsState;
      },
    },
  ),
);
