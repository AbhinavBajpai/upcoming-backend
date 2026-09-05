import { resolve } from "node:path";

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production.");
  }
  return {
    port,
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://upcoming:upcoming_local@localhost:55432/upcoming",
    frontendDir: resolve(env.FRONTEND_DIST_DIR ?? "../upcoming-frontend/dist"),
  };
}
