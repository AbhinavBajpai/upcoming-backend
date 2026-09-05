import pg from "pg";

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 3000,
  });
  pool.on("error", () => console.error("An idle database connection failed."));
  return pool;
}
