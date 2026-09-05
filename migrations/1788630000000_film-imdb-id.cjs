exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE upcoming.films ADD COLUMN imdb_id text
    CHECK (imdb_id IS NULL OR imdb_id ~ '^tt[0-9]+$')`);
};
exports.down = (pgm) => {
  pgm.sql("ALTER TABLE upcoming.films DROP COLUMN imdb_id");
};
