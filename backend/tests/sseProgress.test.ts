import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import http from "http";
import downloadRoutes from "../src/routes/downloads.js";
import { accessAuth } from "../src/middleware/accessAuth.js";

// Mock config so accessPasswordHash is set and verifyAccessToken works
vi.mock("../src/config.js", () => ({
  accessPasswordHash: "valid-password-hash",
  verifyAccessToken: (token: string) => token === "valid-token",
  config: {
    port: 8080,
    dataDir: "./data",
    publicBaseUrl: "",
    disableHttpsRedirect: false,
    autoCleanupDays: 0,
    autoCleanupMaxMB: 0,
    maxDownloadMB: 0,
    buildCommit: "test",
    buildDate: "test",
    accessPassword: "test",
  },
  MAX_DOWNLOAD_SIZE: 8 * 1024 * 1024 * 1024,
  DOWNLOAD_TIMEOUT_MS: 8 * 60 * 60 * 1000,
  BAG_TIMEOUT_MS: 15_000,
  BAG_MAX_BYTES: 1024 * 1024,
  MIN_ACCOUNT_HASH_LENGTH: 8,
  DOWNLOAD_THREADS: 8,
  CHUNK_RETRY_COUNT: 3,
  CHUNK_RETRY_DELAY_MS: 2000,
}));

function createApp() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use("/api", accessAuth);
  app.use("/api", downloadRoutes);
  return app;
}

/**
 * Fetch an SSE endpoint and return the first data frame.
 * The SSE stream never closes, so we destroy the socket after the first chunk.
 */
function fetchSseFrame(
  app: express.Express,
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.get(
        `http://127.0.0.1:${addr.port}${url}`,
        { timeout: 5000 },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            // We have the first frame — close the connection
            req.destroy();
          });
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode!, headers: res.headers, body: data });
          });
          res.on("error", () => {
            // destroy() causes an error — resolve if we have data
            if (data) {
              server.close();
              resolve({ status: res.statusCode!, headers: res.headers, body: data });
            }
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe("SSE progress endpoint integration", () => {
  const app = createApp();
  const accountHash = "abcdef1234567890";
  const validToken = "valid-token";

  let taskId: string;

  beforeEach(async () => {
    // Create a download task via the API so we have something to subscribe to
    const res = await request(app)
      .post("/api/downloads")
      .set("X-Access-Token", validToken)
      .send({
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
        accountHash,
        downloadURL: "https://valid.apple.com/test.ipa",
        sinfs: [{ id: 1, sinf: "dGVzdC1zaW5m" }],
      });

    expect(res.status).toBe(201);
    taskId = res.body.id;
  });

  afterEach(async () => {
    // Clean up the task
    if (taskId) {
      await request(app)
        .delete(`/api/downloads/${taskId}?accountHash=${accountHash}`)
        .set("X-Access-Token", validToken);
    }
  });

  it("should return 200 and text/event-stream with valid token and accountHash", async () => {
    const result = await fetchSseFrame(
      app,
      `/api/downloads/${taskId}/progress?token=${validToken}&accountHash=${accountHash}`,
    );

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.headers["cache-control"]).toContain("no-cache");

    // Should have received an initial data frame with the task JSON
    expect(result.body).toContain("data: ");
    const parsed = JSON.parse(result.body.replace(/^data: /, "").trim());
    expect(parsed.id).toBe(taskId);
    // Assert only on stable fields: `status` depends on a real (unstubbed)
    // download attempt and can flip to "failed" on a slow runner.
    expect(parsed.accountHash).toBe(accountHash);
  });

  it("should return 400 when accountHash is missing", async () => {
    const res = await request(app)
      .get(`/api/downloads/${taskId}/progress?token=${validToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("accountHash");
  });

  it("should return 403 when accountHash does not match", async () => {
    const res = await request(app)
      .get(`/api/downloads/${taskId}/progress?token=${validToken}&accountHash=wronghash12345`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Access denied");
  });

  it("should return 404 when task does not exist", async () => {
    const res = await request(app)
      .get(`/api/downloads/nonexistent-id/progress?token=${validToken}&accountHash=${accountHash}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Download not found");
  });

  it("should return 401 when token is invalid", async () => {
    const res = await request(app)
      .get(`/api/downloads/${taskId}/progress?token=wrong-token&accountHash=${accountHash}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Unauthorized");
  });
});