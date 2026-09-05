import type { Pool, PoolClient } from "pg";
import { monthWindows, type MonthWindow } from "./dates.js";
import { inBatches } from "./tmdb.js";
import { SourceError, type FilmSnapshot, type FilmSource } from "./types.js";

// Session lock covers discovery, refresh and commit, including separate CLI processes.
export const SYNC_LOCK = 1788624000;
export interface SyncResult {
  status: "succeeded" | "skipped";
  runId?: string;
  discovered: number;
  refreshed: number;
}

async function saveFilm(client: PoolClient, film: FilmSnapshot) {
  const saved = await client.query<{ id: string }>(
    `
    INSERT INTO upcoming.films (tmdb_id, title, poster_path, source_refreshed_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (tmdb_id) DO UPDATE SET title = EXCLUDED.title,
      poster_path = EXCLUDED.poster_path, source_refreshed_at = now(), updated_at = now()
    RETURNING id`,
    [film.tmdbId, film.title, film.posterPath],
  );
  const filmId = saved.rows[0]!.id;
  const records = JSON.stringify(
    film.releases.map((r) => ({
      country: r.country,
      release_type: r.type,
      release_date: r.date,
    })),
  );
  // Remove only events absent from a complete, validated detail response.
  await client.query(
    `
    DELETE FROM upcoming.releases existing WHERE film_id = $1 AND country = 'GB'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS fresh(country text, release_type smallint, release_date date)
        WHERE fresh.country = existing.country AND fresh.release_type = existing.release_type
          AND fresh.release_date IS NOT DISTINCT FROM existing.release_date
      )`,
    [filmId, records],
  );
  await client.query(
    `
    INSERT INTO upcoming.releases (film_id, country, release_type, release_date, source_refreshed_at)
    SELECT $1, country, release_type, release_date, now()
    FROM jsonb_to_recordset($2::jsonb) AS fresh(country text, release_type smallint, release_date date)
    ON CONFLICT (film_id, country, release_type, release_date)
    DO UPDATE SET source_refreshed_at = now()`,
    [filmId, records],
  );
}

export async function syncCatalog(
  pool: Pool,
  source: FilmSource,
  windows: MonthWindow[] = monthWindows(),
): Promise<SyncResult> {
  if (!windows.length) throw new Error("INVALID_SYNC_WINDOW");
  const client = await pool.connect();
  let locked = false;
  let transaction = false;
  let runId: string | undefined;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [SYNC_LOCK],
    );
    locked = lock.rows[0]!.acquired;
    if (!locked) return { status: "skipped", discovered: 0, refreshed: 0 };
    // Acquiring the lock proves no earlier importer still owns its running record.
    await client.query(`UPDATE upcoming.sync_runs SET status='failed', completed_at=now(), error_code='INTERRUPTED'
      WHERE status='running'`);
    const run = await client.query<{ id: string }>(
      `INSERT INTO upcoming.sync_runs(status, window_start, window_end)
      VALUES ('running', $1, $2) RETURNING id`,
      [windows[0]!.from, windows.at(-1)!.to],
    );
    runId = run.rows[0]!.id;
    const discovered = [...new Set(await source.discover(windows))];
    await client.query(
      "UPDATE upcoming.sync_runs SET discovered_count=$2 WHERE id=$1",
      [runId, discovered.length],
    );
    // At hobby scale refresh the whole imported catalogue: this includes all future
    // starred films, withdrawn dates and postponements beyond the discovery window.
    const known = await client.query<{ tmdb_id: number }>(
      "SELECT tmdb_id FROM upcoming.films ORDER BY tmdb_id",
    );
    const ids = [
      ...new Set([...discovered, ...known.rows.map((row) => row.tmdb_id)]),
    ];
    const snapshots = await inBatches(ids, (id) => source.film(id));
    await client.query("BEGIN");
    transaction = true;
    for (const snapshot of snapshots) await saveFilm(client, snapshot);
    await client.query(
      `UPDATE upcoming.sync_runs SET status='succeeded', completed_at=now(), refreshed_count=$2 WHERE id=$1`,
      [runId, snapshots.length],
    );
    await client.query("COMMIT");
    transaction = false;
    return {
      status: "succeeded",
      runId,
      discovered: discovered.length,
      refreshed: snapshots.length,
    };
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    const code = error instanceof SourceError ? error.code : "SYNC_FAILED";
    if (runId)
      await client
        .query(
          `UPDATE upcoming.sync_runs SET status='failed', completed_at=now(), error_code=$2 WHERE id=$1`,
          [runId, code],
        )
        .catch(() => {});
    throw new SourceError(code);
  } finally {
    // Destroy the dedicated connection if unlock fails so a lock cannot leak into the pool.
    let discard = false;
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK]);
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}
