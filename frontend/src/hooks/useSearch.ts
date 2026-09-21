import { create } from "zustand";
import type { Software } from "../types";
import { searchApps, lookupApp } from "../api/search";
import type { PlatformId } from "../apple/platform";

interface SearchState {
  term: string;
  country: string;
  /** Empty until the page seeds it from the user's default platform. */
  platform: PlatformId | "";
  results: Software[];
  loading: boolean;
  error: string | null;
  setSearchParam: (
    param: Partial<Pick<SearchState, "term" | "country" | "platform">>,
  ) => void;
  search: (term: string, country: string, platform: PlatformId) => Promise<void>;
  lookup: (bundleId: string, country: string) => Promise<void>;
  clear: () => void; // 新增：清空搜索状态的方法
}

export const useSearch = create<SearchState>((set) => ({
  term: "",
  country: "",
  platform: "",
  results: [],
  loading: false,
  error: null,
  setSearchParam: (param) => set((state) => ({ ...state, ...param })),
  search: async (term, country, platform) => {
    set({ loading: true, error: null, term, country, platform });
    try {
      // `api/search` resolves the platform id to the right iTunes entity.
      const apps = await searchApps(term, country, platform);
      set({ results: apps });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Search failed",
        results: [],
      });
    } finally {
      set({ loading: false });
    }
  },
  lookup: async (bundleId, country) => {
    set({ loading: true, error: null });
    try {
      const state = useSearch.getState();
      const app = await lookupApp(bundleId, country, state.platform || undefined);
      set({ results: app ? [app] : [] });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Lookup failed",
        results: [],
      });
    } finally {
      set({ loading: false });
    }
  },
  // 清空关键词、结果和错误信息，但保留选择的国家和设备类型（作为用户偏好）
  clear: () => set({ term: "", results: [], error: null }),
}));
