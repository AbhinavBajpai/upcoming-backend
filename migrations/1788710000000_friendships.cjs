exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE upcoming.friendships (
    id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    user_low text COLLATE "C" NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    user_high text COLLATE "C" NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    requester_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    PRIMARY KEY (user_low,user_high),
    CHECK (user_low < user_high),
    CHECK (requester_id IN (user_low,user_high)),
    CHECK ((status='pending' AND accepted_at IS NULL) OR (status='accepted' AND accepted_at IS NOT NULL))
  );
  CREATE INDEX friendships_high_idx ON upcoming.friendships(user_high);`);
};
exports.down = (pgm) => pgm.sql("DROP TABLE upcoming.friendships");
