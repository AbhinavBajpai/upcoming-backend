import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const failure of ["dump", "upload", "none"]) {
  test(`backup ${failure === "none" ? "uploads before retention" : `stops after ${failure} failure`}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "upcoming-backup-test-"));
    try {
      writeFileSync(
        join(dir, "docker"),
        '#!/bin/sh\n[ "$FAILURE" != dump ] || exit 1\nprintf synthetic-dump\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "restic"),
        '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALL_LOG"\nif [ "$1" = backup ]; then\n  cat > "$DUMP_COPY"\n  [ "$FAILURE" != upload ] || exit 1\nfi\n',
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["scripts/backup.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          FAILURE: failure,
          CALL_LOG: join(dir, "calls"),
          DUMP_COPY: join(dir, "dump"),
          RESTIC_REPOSITORY: "sftp:test:repository",
          RESTIC_PASSWORD_FILE: join(dir, "unused-password"),
        },
      });
      const calls = existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8")
        : "";
      assert.equal(result.status, failure === "none" ? 0 : 1);
      assert.equal(
        calls,
        failure === "dump"
          ? ""
          : failure === "upload"
            ? "backup\n"
            : "backup\nforget\n",
      );
      if (failure !== "dump")
        assert.equal(readFileSync(join(dir, "dump"), "utf8"), "synthetic-dump");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
