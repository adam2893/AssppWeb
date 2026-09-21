import { create } from "zustand";
import type { DownloadTask, Software, Sinf } from "../types";
import * as downloadsApi from "../api/downloads";
import { getAccessToken } from "../components/Auth/PasswordGate";

interface DownloadsState {
  tasks: DownloadTask[];
  loading: boolean;
  accountHashes: string[];
  setAccountHashes: (hashes: string[]) => void;
  fetchTasks: () => Promise<void>;
  startDownload: (data: {
    software: Software;
    accountHash: string;
    downloadURL: string;
    sinfs: Sinf[];
  }) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  deleteDownload: (id: string) => Promise<void>;
  /** Cleanup all subscriptions and polling. Call on unmount. */
  destroy: () => void;
}

// --- Module-level subscription/polling state ---

let pollInterval: ReturnType<typeof setInterval> | null = null;
const eventSources = new Map<string, EventSource>();

function unsubscribeFromTask(id: string) {
  const es = eventSources.get(id);
  if (es) {
    es.close();
    eventSources.delete(id);
  }
}

function unsubscribeAll() {
  for (const [id] of eventSources) {
    unsubscribeFromTask(id);
  }
}

function clearPollInterval() {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/** Build the SSE URL for a task, including accountHash and optional auth token. */
function buildSseUrl(id: string, accountHash: string): string {
  const token = getAccessToken();
  const params = new URLSearchParams({ accountHash });
  if (token) {
    params.set("token", token);
  }
  return `/api/downloads/${id}/progress?${params.toString()}`;
}

/**
 * Subscribe to the SSE progress stream for a single task.
 * Returns true if a subscription exists (created now, or already present),
 * false if EventSource could not be constructed.
 */
function subscribeToTask(id: string, accountHash: string): boolean {
  if (eventSources.has(id)) return true; // already subscribed

  const url = buildSseUrl(id, accountHash);

  const es = new EventSource(url);

  es.onmessage = (event) => {
    try {
      const task = JSON.parse(event.data) as DownloadTask;
      useDownloadsStore.setState((state) => ({
        tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
      }));
    } catch {
      // Ignore malformed JSON from the stream
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects on transient drops (readyState === CONNECTING).
    // Only fall back to polling when the connection is permanently closed.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      eventSources.delete(id);
      // Start polling fallback for all active tasks
      startPollingFallback();
    }
  };

  eventSources.set(id, es);
  return true;
}

/**
 * Fall back to polling when EventSource cannot be established or fails.
 * Clears all EventSource subscriptions first.
 */
function startPollingFallback() {
  unsubscribeAll();
  if (pollInterval === null) {
    pollInterval = setInterval(() => {
      useDownloadsStore.getState().fetchTasks();
    }, 2000);
  }
}

// --- Store ---

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  tasks: [],
  loading: false,
  accountHashes: [],

  setAccountHashes: (hashes) => set({ accountHashes: hashes }),

  fetchTasks: async () => {
    const { accountHashes } = get();
    set({ loading: true });
    try {
      const tasks = await downloadsApi.fetchDownloads(accountHashes);
      set({ tasks, loading: false });

      const activeIds = new Set(
        tasks
          .filter(
            (t) =>
              t.status === "downloading" ||
              t.status === "pending" ||
              t.status === "injecting",
          )
          .map((t) => t.id),
      );

      // Close subscriptions for tasks that are no longer active
      for (const [id] of eventSources) {
        if (!activeIds.has(id)) {
          unsubscribeFromTask(id);
        }
      }

      if (activeIds.size === 0) {
        // No active tasks — clean up everything
        unsubscribeAll();
        clearPollInterval();
        return;
      }

      // If we're already in polling fallback mode, keep polling
      if (pollInterval !== null) return;

      // Try EventSource subscriptions for active tasks
      let allSubscribed = true;
      for (const id of activeIds) {
        const task = tasks.find((t) => t.id === id);
        if (!task || !subscribeToTask(id, task.accountHash)) {
          allSubscribed = false;
        }
      }

      // If any subscription failed, fall back to polling
      if (!allSubscribed) {
        startPollingFallback();
      }
    } catch {
      set({ loading: false });
    }
  },

  startDownload: async (data) => {
    await downloadsApi.startDownload(data);
    await get().fetchTasks();
  },

  pauseDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.pauseDownload(id, task.accountHash);
    await get().fetchTasks();
  },

  resumeDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.resumeDownload(id, task.accountHash);
    await get().fetchTasks();
  },

  deleteDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.deleteDownload(id, task.accountHash);
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },

  destroy: () => {
    unsubscribeAll();
    clearPollInterval();
  },
}));
