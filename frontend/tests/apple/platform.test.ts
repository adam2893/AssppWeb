import { describe, it, expect } from "vitest";
import {
  PLATFORMS,
  DEFAULT_PLATFORM,
} from "../../src/apple/platform";
import type { PlatformId } from "../../src/apple/platform";

describe("apple/platform", () => {
  describe("PLATFORMS table", () => {
    it("has exactly three platforms", () => {
      const keys = Object.keys(PLATFORMS);
      expect(keys).toEqual(["iphone", "ipad", "appletv"]);
    });

    describe("iphone", () => {
      const def = PLATFORMS.iphone;

      it("has id iphone", () => {
        expect(def.id).toBe("iphone");
      });

      it("uses software for search entity", () => {
        expect(def.searchEntity).toBe("software");
      });

      it("uses software for lookup entity", () => {
        expect(def.lookupEntity).toBe("software");
      });

      it("uses enterprisestore for version catalog", () => {
        expect(def.versionCatalog).toBe("enterprisestore");
      });

      it("uses iPhoneOS for bundle platform", () => {
        expect(def.bundlePlatform).toBe("iPhoneOS");
      });
    });

    describe("ipad", () => {
      const def = PLATFORMS.ipad;

      it("has id ipad", () => {
        expect(def.id).toBe("ipad");
      });

      it("uses iPadSoftware for search entity", () => {
        expect(def.searchEntity).toBe("iPadSoftware");
      });

      it("uses iPadSoftware for lookup entity", () => {
        expect(def.lookupEntity).toBe("iPadSoftware");
      });

      it("uses enterprisestore for version catalog", () => {
        expect(def.versionCatalog).toBe("enterprisestore");
      });

      it("uses iPhoneOS for bundle platform", () => {
        expect(def.bundlePlatform).toBe("iPhoneOS");
      });
    });

    describe("appletv", () => {
      const def = PLATFORMS.appletv;

      it("has id appletv", () => {
        expect(def.id).toBe("appletv");
      });

      it("uses software,tvSoftware for search entity (asymmetry)", () => {
        expect(def.searchEntity).toBe("software,tvSoftware");
      });

      it("uses tvSoftware alone for lookup entity (asymmetry)", () => {
        expect(def.lookupEntity).toBe("tvSoftware");
      });

      it("uses atv9 for version catalog", () => {
        expect(def.versionCatalog).toBe("atv9");
      });

      it("uses AppleTVOS for bundle platform", () => {
        expect(def.bundlePlatform).toBe("AppleTVOS");
      });
    });
  });

  describe("DEFAULT_PLATFORM", () => {
    it("is iphone", () => {
      expect(DEFAULT_PLATFORM).toBe("iphone");
    });
  });

  describe("type safety", () => {
    it("all PlatformId values are covered by PLATFORMS", () => {
      const ids: PlatformId[] = ["iphone", "ipad", "appletv"];
      for (const id of ids) {
        expect(PLATFORMS[id]).toBeDefined();
        expect(PLATFORMS[id].id).toBe(id);
      }
    });
  });
});