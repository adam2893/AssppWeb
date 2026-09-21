import { Request, Response, NextFunction } from "express";
import { accessPasswordHash, verifyAccessToken } from "../config.js";

// Regex matching the SSE progress endpoint: /downloads/<id>/progress
// This is the only route that needs query-param token auth because
// EventSource (browser API) cannot set custom headers.
// Trade-off: query-string tokens can leak into server logs, proxy logs,
// and Referer headers. This is an accepted risk — the Wisp WebSocket
// upgrade path (wsProxy.ts:26-28) already uses the same pattern, so
// this introduces no new class of exposure.
const PROGRESS_PATH_RE = /^\/downloads\/[^\/]+\/progress$/;

export function accessAuth(req: Request, res: Response, next: NextFunction) {
  if (!accessPasswordHash) {
    next();
    return;
  }

  if (req.path.startsWith("/auth/") || req.path.startsWith("/install/")) {
    next();
    return;
  }

  // Accept query-param token for the SSE progress endpoint (EventSource
  // cannot set the X-Access-Token header). Strip trailing slash from the
  // token, mirroring wsProxy.ts:28.
  // Guard with typeof === "string" — Express query parser can return an
  // array for repeated params (e.g. ?token=a&token=b), which would crash
  // .replace(). Fails closed: array → 401, not 500.
  if (PROGRESS_PATH_RE.test(req.path)) {
    const queryToken = req.query.token;
    if (typeof queryToken === "string") {
      const stripped = queryToken.replace(/\/+$/, "");
      if (stripped && verifyAccessToken(stripped)) {
        next();
        return;
      }
    }
  }

  const token = req.headers["x-access-token"];
  if (typeof token === "string" && verifyAccessToken(token)) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
