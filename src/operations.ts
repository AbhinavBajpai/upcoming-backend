import { createDatabase } from "./database.js";
import { readConfig } from "./config.js";
const pool = createDatabase(readConfig().databaseUrl);
try {
  const result = await pool.query<{ healthy: boolean }>(`
    SELECT coalesce((SELECT status='succeeded' AND completed_at > now() - interval '36 hours'
      FROM upcoming.sync_runs ORDER BY started_at DESC, id DESC LIMIT 1), false) AS healthy`);
  if (!result.rows[0]?.healthy) throw new Error("STALE_OR_FAILED_SYNC");
  console.log("UPCOMING_SYNC_HEALTH_OK");
} catch {
  console.error("UPCOMING_SYNC_HEALTH_FAILED");
  process.exitCode = 1;
} finally {
  await pool.end();
}
