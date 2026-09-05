import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";
import type { AuthConfig } from "./config.js";
import type { DeliverEmail } from "./email.js";
export function createAuth(
  pool: Pool,
  config: AuthConfig,
  deliver: DeliverEmail,
) {
  return betterAuth({
    appName: "Upcoming",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
    user: { modelName: "auth_user" },
    account: { modelName: "auth_account", identityStrategy: "provider-id" },
    verification: { modelName: "auth_verification", storeIdentifier: "hashed" },
    session: {
      modelName: "auth_session",
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      freshAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        deliver({ to: user.email, url, kind: "reset" }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) =>
        deliver({ to: user.email, url, kind: "verify" }),
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
      },
    },
    advanced: {
      useSecureCookies: config.secure,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.secure,
      },
      ipAddress: { ipAddressHeaders: ["x-upcoming-client-ip"] },
      backgroundTasks: {
        handler: (task) => {
          void task.catch(() =>
            console.error("Account email delivery failed; retry is available."),
          );
        },
      },
    },
    logger: { disabled: true },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email" || ctx.path === "/update-user") {
          const name = ctx.body?.name;
          if (
            typeof name !== "string" ||
            name.trim().length < 1 ||
            name.trim().length > 60
          )
            throw new APIError("BAD_REQUEST", {
              message: "Use a display name between 1 and 60 characters.",
            });
          ctx.body.name = name.trim();
          if (
            ctx.path === "/update-user" &&
            Object.keys(ctx.body).some((key) => key !== "name")
          )
            throw new APIError("BAD_REQUEST", {
              message: "Only display name can be updated here.",
            });
        }
        if (ctx.path === "/change-password")
          ctx.body.revokeOtherSessions = true;
      }),
    },
  });
}
export type AccountAuth = ReturnType<typeof createAuth>;
