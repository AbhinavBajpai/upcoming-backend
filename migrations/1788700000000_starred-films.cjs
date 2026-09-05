exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE upcoming.stars (
    user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    film_id uuid NOT NULL REFERENCES upcoming.films(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, film_id)
  );
  CREATE INDEX stars_film_idx ON upcoming.stars(film_id);`);
};
exports.down = (pgm) => {
  pgm.sql("DROP TABLE upcoming.stars");
};
