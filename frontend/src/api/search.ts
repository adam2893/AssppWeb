import { apiGet } from "./client";
import type { Software } from "../types";
import { PLATFORMS, DEFAULT_PLATFORM } from "../apple/platform";
import type { PlatformId } from "../apple/platform";

export async function searchApps(
  term: string,
  country: string,
  entity: string,
  limit: number = 25,
): Promise<Software[]> {
  // Map legacy entity strings through PLATFORMS. "iPad" → "iPadSoftware",
  // "iphone"/"appletv" → their searchEntity, anything else → default.
  const platformId = entityToPlatformId(entity);
  const searchEntity = PLATFORMS[platformId].searchEntity;

  const params = new URLSearchParams({
    term,
    country,
    entity: searchEntity,
    limit: String(limit),
  });
  return apiGet<Software[]>(`/api/search?${params}`);
}

function entityToPlatformId(entity: string): PlatformId {
  switch (entity) {
    // Platform ids (what the UI passes).
    case "iphone":
      return "iphone";
    case "ipad":
      return "ipad";
    case "appletv":
      return "appletv";
    // Legacy iTunes entity strings, kept for backward compatibility.
    case "software":
      return "iphone";
    case "iPad":
    case "iPadSoftware":
      return "ipad";
    case "tvSoftware":
      return "appletv";
    default:
      return DEFAULT_PLATFORM;
  }
}

export async function lookupApp(
  bundleId: string,
  country: string,
  platform?: PlatformId,
): Promise<Software | null> {
  const params = new URLSearchParams({ bundleId, country });
  if (platform) {
    params.set("entity", PLATFORMS[platform].lookupEntity);
  }
  return apiGet<Software | null>(`/api/lookup?${params}`);
}
