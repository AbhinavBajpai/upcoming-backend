import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";

try {
  await runner({
    databaseUrl: readConfig().databaseUrl,
    dir: fileURLToPath(new URL("../migrations", import.meta.url)),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: (message) => console.log(message),
  });
} catch {
  console.error(
    "Database migration failed. Check database connectivity and migration files.",
  );
  process.exitCode = 1;
}
