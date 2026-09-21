export type PlatformId = "iphone" | "ipad" | "appletv";

export interface PlatformDef {
  id: PlatformId;
  /** iTunes Search `entity` parameter. */
  searchEntity: string;
  /** iTunes Lookup `entity` parameter. */
  lookupEntity: string;
  /** `platform` value for the MZStorePlatform version lookup. */
  versionCatalog: string;
  /** Expected entry in the IPA's CFBundleSupportedPlatforms. */
  bundlePlatform: string;
}

export const PLATFORMS: Record<PlatformId, PlatformDef> = {
  iphone: {
    id: "iphone",
    searchEntity: "software",
    lookupEntity: "software",
    versionCatalog: "enterprisestore",
    bundlePlatform: "iPhoneOS",
  },
  ipad: {
    id: "ipad",
    searchEntity: "iPadSoftware",
    lookupEntity: "iPadSoftware",
    versionCatalog: "enterprisestore",
    bundlePlatform: "iPhoneOS",
  },
  appletv: {
    id: "appletv",
    searchEntity: "software,tvSoftware",
    lookupEntity: "tvSoftware",
    versionCatalog: "atv9",
    bundlePlatform: "AppleTVOS",
  },
};

export const DEFAULT_PLATFORM: PlatformId = "iphone";