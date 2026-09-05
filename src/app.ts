import express from "express";
import { accountRoutes, currentUser } from "./auth/routes.js";
import type { AccountAuth } from "./auth/service.js";
import type { AuthConfig } from "./auth/config.js";
import {
  CalendarError,
  parseMonth,
  type ReleaseCalendar,
} from "./catalog/calendar.js";
import { ukToday } from "./catalog/dates.js";
import type { ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface AppOptions {
  checkDatabase: () => Promise<void>;
  accounts?: { auth: AccountAuth; config: AuthConfig };
  frontendDir?: string;
  getCalendar?: (month: string, now: Date) => Promise<ReleaseCalendar>;
  clock?: () => Date;
}

export function createApp({
  checkDatabase,
  accounts,
  frontendDir,
  getCalendar,
  clock = () => new Date(),
}: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  if (accounts) app.use(accountRoutes(accounts.auth, accounts.config));
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/me", async (req, res) => {
    try {
      const user = accounts ? await currentUser(accounts.auth, req) : null;
      if (!user) {
        res
          .status(401)
          .json({
            error: { code: "SIGN_IN_REQUIRED", message: "Please sign in." },
          });
        return;
      }
      res.json({ user });
    } catch {
      res
        .status(503)
        .json({
          error: {
            code: "ACCOUNTS_UNAVAILABLE",
            message: "Accounts are temporarily unavailable.",
          },
        });
    }
  });
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "upcoming-api", version: "0.1.0" });
  });
  app.get("/api/ready", async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: "ok", database: "connected" });
    } catch {
      res.status(503).json({ status: "unavailable", database: "unavailable" });
    }
  });
  app.get("/api/releases", async (req, res) => {
    try {
      const now = clock();
      const month = parseMonth(req.query.month, ukToday(now));
      if (!getCalendar) {
        res.status(503).json({
          error: {
            code: "CATALOGUE_UNAVAILABLE",
            message: "The release calendar is temporarily unavailable.",
          },
        });
        return;
      }
      res.json(await getCalendar(month, now));
    } catch (error) {
      if (error instanceof CalendarError) {
        res.status(400).json({
          error: {
            code: error.code,
            message:
              error.code === "INVALID_MONTH"
                ? "Use a month in YYYY-MM format."
                : "That month is outside the available calendar.",
          },
        });
        return;
      }
      console.error("Release calendar query failed.");
      res.status(503).json({
        error: {
          code: "CATALOGUE_UNAVAILABLE",
          message: "The release calendar is temporarily unavailable.",
        },
      });
    }
  });
  app.use("/api", (_req, res) => {
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "API route not found." } });
  });
  if (frontendDir && existsSync(join(frontendDir, "index.html"))) {
    const root = resolve(frontendDir);
    app.use(express.static(root));
    // Only known client routes receive HTML; missing assets stay 404s.
    app.get(
      [
        "/",
        "/releases",
        "/starred",
        "/friends",
        "/login",
        "/signup",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/account",
      ],
      (_req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.sendFile(join(root, "index.html"));
      },
    );
  }
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Page not found." } });
  });
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (
      error instanceof SyntaxError &&
      "status" in error &&
      error.status === 400
    ) {
      res.status(400).json({
        error: { code: "INVALID_JSON", message: "Invalid JSON body." },
      });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
    ) {
      res.status(413).json({
        error: {
          code: "BODY_TOO_LARGE",
          message: "Request body is too large.",
        },
      });
      return;
    }
    console.error("An API request failed unexpectedly.");
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
    });
  };
  app.use(onError);
  return app;
}
