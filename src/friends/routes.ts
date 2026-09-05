import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/routes.js";
import type { AccountAuth } from "../auth/service.js";
import type { AuthConfig } from "../auth/config.js";
import { FriendError, type FriendStore } from "./store.js";
const userId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const action = z.enum(["accept", "decline", "cancel", "remove"]);
export function friendRoutes(
  store: FriendStore,
  accounts: { auth: AccountAuth; config: AuthConfig } | undefined,
  clock: () => Date,
) {
  const router = Router();
  router.use("/api/friends", async (req, res, next) => {
    try {
      const user = accounts ? await currentUser(accounts.auth, req) : null;
      if (!user) {
        res.status(401).json({
          error: {
            code: "SIGN_IN_REQUIRED",
            message: "Please sign in to connect with friends.",
          },
        });
        return;
      }
      res.locals.friendUserId = user.id;
      if (req.method === "POST") {
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
    } catch (error) {
      failure(error, res);
    }
  });
  router.get("/api/friends/interest", async (req, res) => {
    const query = z
      .object({
        filmIds: z
          .string()
          .transform((value) => value.split(","))
          .pipe(z.array(z.uuid()).min(1).max(100)),
      })
      .strict()
      .safeParse(req.query);
    if (!query.success) {
      invalid(res);
      return;
    }
    try {
      res.json(
        await store.interest(res.locals.friendUserId, query.data.filmIds),
      );
    } catch (error) {
      failure(error, res);
    }
  });
  router.get("/api/friends", async (_req, res) => {
    try {
      res.json(await store.list(res.locals.friendUserId));
    } catch (error) {
      failure(error, res);
    }
  });
  router.get("/api/friends/profiles/:userId", async (req, res) => {
    const parsed = userId.safeParse(req.params.userId);
    if (!parsed.success) {
      invalid(res);
      return;
    }
    try {
      res.json({
        profile: await store.profile(res.locals.friendUserId, parsed.data),
      });
    } catch (error) {
      failure(error, res);
    }
  });
  router.get("/api/friends/profiles/:userId/watch-list", async (req, res) => {
    const parsed = userId.safeParse(req.params.userId);
    if (!parsed.success) {
      invalid(res);
      return;
    }
    try {
      res.json(
        await store.watchList(res.locals.friendUserId, parsed.data, clock()),
      );
    } catch (error) {
      failure(error, res);
    }
  });
  router.post("/api/friends/requests/:userId", async (req, res) => {
    const parsed = userId.safeParse(req.params.userId);
    if (!parsed.success) {
      invalid(res);
      return;
    }
    try {
      res.json({
        profile: await store.request(res.locals.friendUserId, parsed.data),
      });
    } catch (error) {
      failure(error, res);
    }
  });
  router.post("/api/friends/relationships/:id/:action", async (req, res) => {
    const id = z.uuid().safeParse(req.params.id),
      operation = action.safeParse(req.params.action);
    if (!id.success || !operation.success) {
      invalid(res);
      return;
    }
    try {
      res.json(
        await store.act(res.locals.friendUserId, id.data, operation.data),
      );
    } catch (error) {
      failure(error, res);
    }
  });
  return router;
}
function invalid(res: import("express").Response) {
  res.status(400).json({
    error: {
      code: "INVALID_REQUEST",
      message: "Invalid profile or friendship action.",
    },
  });
}
function failure(error: unknown, res: import("express").Response) {
  if (error instanceof FriendError) {
    const status =
      error.code === "SELF_REQUEST"
        ? 400
        : error.code === "RELATIONSHIP_CONFLICT"
          ? 409
          : 404;
    const message =
      error.code === "SELF_REQUEST"
        ? "You cannot send yourself a friend request."
        : error.code === "RELATIONSHIP_CONFLICT"
          ? "That friendship has changed or the action is not available. Please refresh."
          : error.code === "PROFILE_NOT_FOUND"
            ? "That profile is unavailable."
            : "This watch list is unavailable. Connect as friends to see it.";
    res.status(status).json({ error: { code: error.code, message } });
    return;
  }
  res.status(503).json({
    error: {
      code: "FRIENDS_UNAVAILABLE",
      message: "Friends are temporarily unavailable. Please try again.",
    },
  });
}
