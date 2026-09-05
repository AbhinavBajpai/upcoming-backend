import { Router, json, type Request } from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { isIP } from "node:net";
import type { AccountAuth } from "./service.js";
import type { AuthConfig } from "./config.js";
const paths = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-out",
  "/get-session",
  "/send-verification-email",
  "/verify-email",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/update-user",
  "/revoke-other-sessions",
]);
export function clientIp(req: Request, trustedProxies: string[]) {
  const peer = req.socket.remoteAddress ?? "127.0.0.1";
  const forwarded = req.headers["cf-connecting-ip"];
  return trustedProxies.includes(peer) &&
    typeof forwarded === "string" &&
    isIP(forwarded)
    ? forwarded
    : peer;
}
export function accountRoutes(auth: AccountAuth, config: AuthConfig) {
  const router = Router();
  router.use((req, res, next) => {
    if (!req.path.startsWith("/api/auth/")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    // The internal header is always overwritten. Neither Express nor the library
    // trusts a client's X-Forwarded-For, Host or Proto for session decisions.
    req.headers["x-upcoming-client-ip"] = clientIp(req, config.trustedProxyIps);
    const path = req.path.slice("/api/auth".length);
    if (!paths.has(path) && !/^\/reset-password\/[^/]+$/.test(path)) {
      res.sendStatus(404);
      return;
    }
    if (!["GET", "POST"].includes(req.method)) {
      res.sendStatus(405);
      return;
    }
    if (
      req.method === "POST" &&
      (req.get("origin") !== config.origin || !req.is("application/json"))
    ) {
      res.status(403).json({
        code: "INVALID_ORIGIN",
        message: "Please reload the page and try again.",
      });
      return;
    }
    next();
  });
  // The pinned node adapter supports an already-parsed body. Bound JSON sizes
  // here before passing it on, including chunked requests.
  router.all("/api/auth/{*path}", json({ limit: "32kb" }), toNodeHandler(auth));
  return router;
}
export async function currentUser(auth: AccountAuth, req: Request) {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return result?.user.emailVerified
    ? { id: result.user.id, displayName: result.user.name }
    : null;
}
