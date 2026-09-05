exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE upcoming.films (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tmdb_id integer NOT NULL UNIQUE CHECK (tmdb_id > 0),
      title text NOT NULL CHECK (length(btrim(title)) > 0),
      poster_path text,
      source_refreshed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE upcoming.releases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      film_id uuid NOT NULL REFERENCES upcoming.films(id) ON DELETE RESTRICT,
      country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
      release_type smallint NOT NULL CHECK (release_type BETWEEN 1 AND 6),
      release_date date,
      source_refreshed_at timestamptz NOT NULL,
      UNIQUE NULLS NOT DISTINCT (film_id, country, release_type, release_date)
    );
    CREATE INDEX releases_calendar_idx ON upcoming.releases (country, release_type, release_date, film_id);
    CREATE TABLE upcoming.sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      window_start date NOT NULL,
      window_end date NOT NULL CHECK (window_end >= window_start),
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      discovered_count integer NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
      refreshed_count integer NOT NULL DEFAULT 0 CHECK (refreshed_count >= 0),
      error_code text,
      CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
    );
    CREATE INDEX sync_runs_latest_success_idx ON upcoming.sync_runs (completed_at DESC) WHERE status = 'succeeded';
  `);
};
exports.down = (pgm) => {
  pgm.dropTable({ schema: "upcoming", name: "sync_runs" });
  pgm.dropTable({ schema: "upcoming", name: "releases" });
  pgm.dropTable({ schema: "upcoming", name: "films" });
};
