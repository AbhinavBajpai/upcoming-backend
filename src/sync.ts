import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { monthWindows } from "./catalog/dates.js";
import { TmdbSource } from "./catalog/tmdb.js";
import { SourceError } from "./catalog/types.js";
import { syncCatalog } from "./catalog/sync.js";

async function main() {
  const source = new TmdbSource(process.env.TMDB_READ_ACCESS_TOKEN ?? "");
  const windows = monthWindows(process.argv[2], Number(process.argv[3] ?? 7));
  const database = createDatabase(readConfig().databaseUrl);
  try {
    const result = await syncCatalog(database, source, windows);
    console.log(JSON.stringify(result));
  } finally {
    await database.end();
  }
}
main().catch((error) => {
  const code =
    error instanceof SourceError
      ? error.code
      : "SYNC_FAILED_CHECK_CONFIGURATION";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
});
