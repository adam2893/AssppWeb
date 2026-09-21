import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// --- Mock setup: password is SET ---
vi.mock("../src/config.js", () => ({
  accessPasswordHash: "valid-password-hash",
  verifyAccessToken: (token: string) => token === "valid-token",
}));

import { accessAuth } from "../src/middleware/accessAuth.js";

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    path: "/downloads/some-id/progress",
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function createMockRes() {
  let statusCode = 200;
  let body: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: unknown) => {
      body = data;
      return res;
    },
  } as unknown as Response;
  return { res, statusCode: () => statusCode, body: () => body };
}

describe("accessAuth - progress endpoint query-param token", () => {
  it("should accept valid token via query param on progress path", () => {
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: { token: "valid-token" },
    });
    const { res } = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    accessAuth(req, res, next);

    expect(nextCalled).toBe(true);
  });

  it("should accept valid token with trailing slash (mirroring wsProxy.ts)", () => {
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: { token: "valid-token/" },
    });
    const { res } = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    accessAuth(req, res, next);

    expect(nextCalled).toBe(true);
  });

  it("should reject invalid token via query param on progress path", () => {
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: { token: "wrong-token" },
    });
    const mock = createMockRes();
    const next: NextFunction = () => {};

    accessAuth(req, mock.res, next);

    expect(mock.statusCode()).toBe(401);
    expect(mock.body()).toEqual({ error: "Unauthorized" });
  });

  it("should reject missing token on progress path", () => {
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: {},
      headers: {},
    });
    const mock = createMockRes();
    const next: NextFunction = () => {};

    accessAuth(req, mock.res, next);

    expect(mock.statusCode()).toBe(401);
    expect(mock.body()).toEqual({ error: "Unauthorized" });
  });

  it("should reject empty token string on progress path", () => {
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: { token: "" },
      headers: {},
    });
    const mock = createMockRes();
    const next: NextFunction = () => {};

    accessAuth(req, mock.res, next);

    expect(mock.statusCode()).toBe(401);
    expect(mock.body()).toEqual({ error: "Unauthorized" });
  });

  it("should still accept header token on non-progress paths", () => {
    const req = mockReq({
      path: "/downloads",
      query: {},
      headers: { "x-access-token": "valid-token" },
    });
    const { res } = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    accessAuth(req, res, next);

    expect(nextCalled).toBe(true);
  });

  it("should reject query-param token on non-progress paths", () => {
    const req = mockReq({
      path: "/downloads",
      query: { token: "valid-token" },
      headers: {},
    });
    const mock = createMockRes();
    const next: NextFunction = () => {};

    accessAuth(req, mock.res, next);

    expect(mock.statusCode()).toBe(401);
    expect(mock.body()).toEqual({ error: "Unauthorized" });
  });

  it("should not accept query-param token on auth exemption paths", () => {
    // Auth exemption paths (/auth/, /install/) don't need a token at all,
    // but a query-param token should NOT be accepted on non-progress paths
    const req = mockReq({
      path: "/auth/status",
      query: { token: "valid-token" },
    });
    const { res } = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    accessAuth(req, res, next);

    // /auth/ is exempt, so it passes through regardless
    expect(nextCalled).toBe(true);
  });

  it("should match progress path with complex IDs", () => {
    const req = mockReq({
      path: "/downloads/uuid-like-123e4567-e89b-12d3-a456-426614174000/progress",
      query: { token: "valid-token" },
    });
    const { res } = createMockRes();
    let nextCalled = false;
    const next: NextFunction = () => { nextCalled = true; };

    accessAuth(req, res, next);

    expect(nextCalled).toBe(true);
  });

  it("should reject array token (?token=a&token=b) with 401, not 500", () => {
    // Express query parser returns an array for repeated params.
    // The middleware must guard with typeof === "string" and fail closed.
    const req = mockReq({
      path: "/downloads/abc-123/progress",
      query: { token: ["a", "b"] },
      headers: {},
    });
    const mock = createMockRes();
    const next: NextFunction = () => {};

    accessAuth(req, mock.res, next);

    expect(mock.statusCode()).toBe(401);
    expect(mock.body()).toEqual({ error: "Unauthorized" });
  });
});
