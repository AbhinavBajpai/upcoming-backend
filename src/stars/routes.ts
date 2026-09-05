import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/routes.js";
import type { AccountAuth } from "../auth/service.js";
import type { AuthConfig } from "../auth/config.js";
import type { StarStore } from "./store.js";
const filmIdSchema = z.uuid();
export function starRoutes(
  store: StarStore,
  accounts: { auth: AccountAuth; config: AuthConfig } | undefined,
  clock: () => Date,
) {
  const router = Router();
  router.use("/api/stars", async (req, res, next) => {
    try {
      const user = accounts ? await currentUser(accounts.auth, req) : null;
      if (!user) {
        res.status(401).json({
          error: {
            code: "SIGN_IN_REQUIRED",
            message: "Please sign in to manage your stars.",
          },
        });
        return;
      }
      res.locals.starUserId = user.id;
      if (req.method === "PUT" || req.method === "DELETE") {
        if (
          req.get("origin") !== accounts!.config.origin ||
          !req.is("application/json")
        ) {
          res.status(403).json({
            error: {
              code: "INVALID_ORIGIN",
              message: "Please reload the page and try again.",
            },
          });
          return;
        }
        if (!z.object({}).strict().safeParse(req.body).success) {
          res.status(400).json({
            error: {
              code: "INVALID_BODY",
              message: "Send an empty JSON object.",
            },
          });
          return;
        }
      }
      next();
    } catch {
      res.status(503).json({
        error: {
          code: "STARS_UNAVAILABLE",
          message: "Your stars are temporarily unavailable.",
        },
      });
    }
  });
  router.get("/api/stars", async (_req, res) => {
    try {
      res.json(await store.list(res.locals.starUserId, clock()));
    } catch {
      res.status(503).json({
        error: {
          code: "STARS_UNAVAILABLE",
          message: "Your stars are temporarily unavailable.",
        },
      });
    }
  });
  router.route("/api/stars/:filmId").put(change).delete(change);
  async function change(
    req: import("express").Request,
    res: import("express").Response,
  ) {
    const parsed = filmIdSchema.safeParse(req.params.filmId);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: { code: "INVALID_FILM", message: "Invalid film ID." } });
      return;
    }
    try {
      const starred = req.method === "PUT";
      if (!(await store.set(res.locals.starUserId, parsed.data, starred))) {
        res.status(404).json({
          error: {
            code: "FILM_NOT_FOUND",
            message: "That film is no longer available.",
          },
        });
        return;
      }
      res.json({ filmId: parsed.data, starred });
    } catch {
      res.status(503).json({
        error: {
          code: "STARS_UNAVAILABLE",
          message: "We couldn’t save your change. Please try again.",
        },
      });
    }
  }
  return router;
}
