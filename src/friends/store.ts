import type { Pool } from "pg";
import { starStore } from "../stars/store.js";
export type FriendAction = "accept" | "decline" | "cancel" | "remove";
export class FriendError extends Error {
  constructor(
    public code:
      | "SELF_REQUEST"
      | "PROFILE_NOT_FOUND"
      | "RELATIONSHIP_CONFLICT"
      | "WATCH_LIST_UNAVAILABLE",
  ) {
    super(code);
  }
}
interface Connection {
  id: string;
  userId: string;
  displayName: string;
  relationship: "incoming" | "outgoing" | "accepted";
}
export function friendStore(pool: Pool) {
  async function profile(viewer: string, target: string) {
    const result = await pool.query(
      `SELECT u.id, u.name AS "displayName", f.id AS "relationshipId",
      CASE WHEN u.id=$1 THEN 'self' WHEN f.status='accepted' THEN 'accepted'
      WHEN f.requester_id=$1 THEN 'outgoing' WHEN f.id IS NOT NULL THEN 'incoming' ELSE 'none' END AS relationship
      FROM auth_user u LEFT JOIN upcoming.friendships f ON
        f.user_low=least($1::text COLLATE "C",u.id COLLATE "C") AND f.user_high=greatest($1::text COLLATE "C",u.id COLLATE "C")
      WHERE u.id=$2 AND u."emailVerified"=true`,
      [viewer, target],
    );
    if (!result.rowCount) throw new FriendError("PROFILE_NOT_FOUND");
    return result.rows[0] as {
      id: string;
      displayName: string;
      relationshipId: string | null;
      relationship: "self" | "none" | Connection["relationship"];
    };
  }
  return {
    profile,
    async list(userId: string) {
      const result = await pool.query<Connection>(
        `SELECT f.id, u.id AS "userId", u.name AS "displayName",
        CASE WHEN f.status='accepted' THEN 'accepted' WHEN f.requester_id=$1 THEN 'outgoing' ELSE 'incoming' END AS relationship
        FROM upcoming.friendships f JOIN auth_user u ON u.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
        WHERE $1 IN (f.user_low,f.user_high) AND u."emailVerified"=true
        ORDER BY u.name COLLATE "C",u.id`,
        [userId],
      );
      return {
        accepted: result.rows.filter((r) => r.relationship === "accepted"),
        incoming: result.rows.filter((r) => r.relationship === "incoming"),
        outgoing: result.rows.filter((r) => r.relationship === "outgoing"),
      };
    },
    async request(userId: string, target: string) {
      if (userId === target) throw new FriendError("SELF_REQUEST");
      // A crossed/repeated request never changes who must explicitly accept.
      const result = await pool.query(
        `INSERT INTO upcoming.friendships(user_low,user_high,requester_id)
        SELECT least($1::text COLLATE "C",u.id COLLATE "C"),greatest($1::text COLLATE "C",u.id COLLATE "C"),$1
        FROM auth_user u WHERE u.id=$2 AND u."emailVerified"=true
        ON CONFLICT(user_low,user_high) DO UPDATE SET requester_id=upcoming.friendships.requester_id
        RETURNING id`,
        [userId, target],
      );
      if (!result.rowCount) throw new FriendError("PROFILE_NOT_FOUND");
      return profile(userId, target);
    },
    async act(userId: string, id: string, action: FriendAction) {
      // Conditional writes acquire the row lock and recheck the current state.
      // UUIDs identify this particular request, so stale actions cannot affect a new request.
      const result =
        action === "accept"
          ? await pool.query(
              `UPDATE upcoming.friendships SET status='accepted',accepted_at=coalesce(accepted_at,now())
            WHERE id=$2 AND $1 IN (user_low,user_high) AND requester_id<>$1 RETURNING id`,
              [userId, id],
            )
          : await pool.query(
              `DELETE FROM upcoming.friendships WHERE id=$2 AND $1 IN (user_low,user_high)
            AND (($3='decline' AND status='pending' AND requester_id<>$1)
              OR ($3='cancel' AND status='pending' AND requester_id=$1)
              OR ($3='remove' AND status='accepted')) RETURNING id`,
              [userId, id, action],
            );
      if (!result.rowCount) throw new FriendError("RELATIONSHIP_CONFLICT");
      return { id, action };
    },
    async watchList(userId: string, target: string, now: Date) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Hold a shared relationship lock until the private data has been read.
        // Disconnect waits for this read; a read after disconnect commits is denied.
        const allowed = await client.query(
          `SELECT u.id,u.name AS "displayName" FROM upcoming.friendships f
          JOIN auth_user u ON u.id=$2 AND u."emailVerified"=true
          WHERE f.user_low=least($1::text COLLATE "C",$2::text COLLATE "C")
            AND f.user_high=greatest($1::text COLLATE "C",$2::text COLLATE "C") AND f.status='accepted'
          FOR SHARE OF f`,
          [userId, target],
        );
        if (!allowed.rowCount) throw new FriendError("WATCH_LIST_UNAVAILABLE");
        const list = await starStore(client).list(target, now);
        await client.query("COMMIT");
        return {
          profile: allowed.rows[0] as { id: string; displayName: string },
          ...list,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export type FriendStore = ReturnType<typeof friendStore>;
