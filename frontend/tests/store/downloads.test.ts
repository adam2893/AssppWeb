import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDownloadsStore } from "../../src/store/downloads";
import type { DownloadTask } from "../../src/types";

// --- Mock EventSource ---
type EventSourceCb = (event: { data: string }) => void;
type EventSourceErrorCb = (event: Event) => void;

interface MockEventSourceInstance {
  onmessage: EventSourceCb | null;
  onerror: EventSourceErrorCb | null;
  readyState: number;
  close: ReturnType<typeof vi.fn>;
  CONNECTING: number;
  OPEN: number;
  CLOSED: number;
}

let mockEventSourceInstances: MockEventSourceInstance[] = [];

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  onmessage: EventSourceCb | null = null;
  onerror: EventSourceErrorCb | null = null;
  readyState = MockEventSource.CONNECTING;
  close = vi.fn();
  CONNECTING = MockEventSource.CONNECTING;
  OPEN = MockEventSource.OPEN;
  CLOSED = MockEventSource.CLOSED;

  /** The URL passed to the constructor — exposed for test assertions. */
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    mockEventSourceInstances.push(this);
    // Simulate successful connection after microtask
    setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
    }, 0);
  }
}

// --- Mock sessionStorage wrapper ---
function setTestToken(token: string | null) {
  if (token) {
    sessionStorage.setItem("auth-token", token);
  } else {
    sessionStorage.removeItem("auth-token");
  }
}

// --- Mock API ---
vi.mock("../../src/api/downloads", () => ({
  fetchDownloads: vi.fn(),
  startDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));

import * as downloadsApi from "../../src/api/downloads";

describe("store/downloads - SSE subscription & polling fallback", () => {
  const mockActiveTask: DownloadTask = {
    id: "task-1",
    software: {
      id: 123,
      bundleID: "com.test.app",
      name: "Test App",
      version: "1.0",
      artistName: "Test",
      sellerName: "Test Seller",
      description: "A test app",
      averageUserRating: 4.5,
      userRatingCount: 100,
      artworkUrl: "https://example.com/icon.png",
      screenshotUrls: [],
      minimumOsVersion: "15.0",
      releaseDate: "2024-01-01",
    },
    accountHash: "hash123",
    status: "downloading",
    progress: 50,
    speed: "5 MB/s",
    createdAt: "2024-01-01T00:00:00Z",
  };

  const mockCompletedTask: DownloadTask = {
    ...mockActiveTask,
    id: "task-2",
    status: "completed",
    progress: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventSourceInstances = [];
    setTestToken("test-token");
    useDownloadsStore.setState({
      tasks: [],
      loading: false,
      accountHashes: ["hash123"],
    });
    // Reset module-level state by calling destroy
    useDownloadsStore.getState().destroy();
  });

  afterEach(() => {
    useDownloadsStore.getState().destroy();
    setTestToken(null);
  });

  it("should subscribe to EventSource for active tasks after fetchTasks", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    // Should have created one EventSource for the active task
    expect(mockEventSourceInstances.length).toBe(1);
    const es = mockEventSourceInstances[0];
    expect(es.close).not.toHaveBeenCalled();

    // Restore
    globalThis.EventSource = originalEventSource;
  });

  it("should build SSE URL with accountHash and token", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    expect(mockEventSourceInstances.length).toBe(1);
    const url = mockEventSourceInstances[0].url;

    // Must contain accountHash
    expect(url).toContain("accountHash=hash123");
    // Must contain token
    expect(url).toContain("token=test-token");
    // Must point to the progress endpoint
    expect(url).toContain("/api/downloads/task-1/progress");

    globalThis.EventSource = originalEventSource;
  });

  it("should build SSE URL without token when no password is configured", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    setTestToken(null);

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    // Should still create an EventSource (no token → middleware allows through)
    expect(mockEventSourceInstances.length).toBe(1);
    const url = mockEventSourceInstances[0].url;

    // Must contain accountHash
    expect(url).toContain("accountHash=hash123");
    // Must NOT contain token param
    expect(url).not.toContain("token=");
    // Must point to the progress endpoint
    expect(url).toContain("/api/downloads/task-1/progress");

    globalThis.EventSource = originalEventSource;
  });

  it("should update task state when EventSource receives a message", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    // Start with the task in the store
    useDownloadsStore.setState({ tasks: [mockActiveTask] });
    await useDownloadsStore.getState().fetchTasks();

    const es = mockEventSourceInstances[0];
    expect(es).toBeDefined();

    // Simulate an SSE update
    const updatedTask = { ...mockActiveTask, progress: 75, speed: "8 MB/s" };
    es.onmessage!({ data: JSON.stringify(updatedTask) });

    const state = useDownloadsStore.getState();
    const storedTask = state.tasks.find((t) => t.id === "task-1");
    expect(storedTask?.progress).toBe(75);
    expect(storedTask?.speed).toBe("8 MB/s");

    globalThis.EventSource = originalEventSource;
  });

  it("should close EventSource when task is no longer active", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    // First call returns active task (starts subscription)
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();
    expect(mockEventSourceInstances.length).toBe(1);

    // Second call returns completed task (closes subscription)
    mockFetch.mockResolvedValueOnce([mockCompletedTask]);
    await useDownloadsStore.getState().fetchTasks();

    // EventSource should have been closed
    const es = mockEventSourceInstances[0];
    expect(es.close).toHaveBeenCalledTimes(1);

    globalThis.EventSource = originalEventSource;
  });

  it("should fall back to polling when EventSource connection fails", async () => {
    vi.useFakeTimers();
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValue([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    // Simulate EventSource permanent failure
    const es = mockEventSourceInstances[0];
    es.readyState = MockEventSource.CLOSED;
    es.onerror!(new Event("error"));

    // Advance past the 2s polling interval
    await vi.advanceTimersByTimeAsync(2100);

    // Should have called fetchDownloads again via polling
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Clean up
    useDownloadsStore.getState().destroy();
    globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
  });

  it("should attempt EventSource even without auth token (middleware allows unauthenticated when no password set)", async () => {
    vi.useFakeTimers();
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    setTestToken(null);

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValue([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    // Should have created an EventSource (no token → URL omits token param,
    // middleware allows through when no password configured)
    expect(mockEventSourceInstances.length).toBe(1);
    expect(mockEventSourceInstances[0].url).not.toContain("token=");

    // No polling should have started since EventSource was created
    await vi.advanceTimersByTimeAsync(2100);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Clean up
    useDownloadsStore.getState().destroy();
    globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
  });

  it("should close all subscriptions on destroy", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    mockFetch.mockResolvedValueOnce([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();

    expect(mockEventSourceInstances.length).toBe(1);
    const es = mockEventSourceInstances[0];

    useDownloadsStore.getState().destroy();

    expect(es.close).toHaveBeenCalled();

    globalThis.EventSource = originalEventSource;
  });

  it("should not leak duplicate EventSource connections for the same task", async () => {
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    const mockFetch = vi.mocked(downloadsApi.fetchDownloads);
    // Always returns an array with an active task
    mockFetch.mockResolvedValue([mockActiveTask]);

    await useDownloadsStore.getState().fetchTasks();
    await useDownloadsStore.getState().fetchTasks();

    // Should only have created ONE EventSource (second call sees it already exists)
    expect(mockEventSourceInstances.length).toBe(1);

    useDownloadsStore.getState().destroy();
    globalThis.EventSource = originalEventSource;
  });
});
