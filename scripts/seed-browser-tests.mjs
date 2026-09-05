// Fictional catalogue fixture for browser CI only; never writes to the local app DB.
import pg from "pg";
import { createAuth } from "../dist/auth/service.js";
import { readAuthConfig } from "../dist/auth/config.js";
const connectionString = process.env.DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).pathname !== "/upcoming_test"
)
  throw new Error(
    "Browser fixtures require the isolated upcoming_test database.",
  );
const pool = new pg.Pool({ connectionString });
try {
  const { rows } = await pool.query("SELECT current_database() AS name");
  if (rows[0].name !== "upcoming_test") throw new Error("Unexpected database");
  await pool.query(`INSERT INTO upcoming.films(id,tmdb_id,title,source_refreshed_at)
    VALUES ('00000000-0000-4000-8000-000000000101',2000000001,'Browser Test Feature',now())
    ON CONFLICT(id) DO NOTHING`);
  await pool.query(`INSERT INTO upcoming.releases(film_id,country,release_type,release_date,source_refreshed_at)
    VALUES ('00000000-0000-4000-8000-000000000101','GB',3,(now() AT TIME ZONE 'Europe/London')::date,now())
    ON CONFLICT DO NOTHING`);
  const auth = createAuth(
    pool,
    readAuthConfig({ AUTH_BASE_URL: "http://127.0.0.1:4173" }),
    async () => {},
  );
  for (const device of ["desktop", "mobile"]) {
    for (const name of ["Alice", "Bob"]) {
      const email = `friends-${device}-${name.toLowerCase()}@example.test`;
      const existing = await pool.query(
        "SELECT id FROM auth_user WHERE email=$1",
        [email],
      );
      if (!existing.rowCount)
        await auth.api.signUpEmail({
          body: { name, email, password: "browser-friend-test-password" },
        });
      await pool.query(
        'UPDATE auth_user SET "emailVerified"=true WHERE email=$1',
        [email],
      );
    }
  }
  console.log("Browser test catalogue and friendship accounts ready.");
} finally {
  await pool.end();
}
