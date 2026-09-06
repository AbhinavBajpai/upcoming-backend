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

for (const [job, scenario, expectedExit, pings] of [
  ["sync", "success", 0, true],
  ["sync", "failed", 1, false],
  ["sync", "skipped", 0, false],
  ["backup", "success", 0, true],
  ["backup", "failed", 1, false],
  ["sync", "delivery-failed", 1, true],
  ["sync", "unconfigured", 0, false],
  ["sync", "invalid-url", 1, false],
]) {
  test(`scheduled ${job}: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "upcoming-heartbeat-test-"));
    try {
      writeFileSync(
        join(dir, "docker"),
        `#!/bin/sh
[ "$SCENARIO" != failed ] || exit 1
if [ "$JOB" = sync ]; then
  if [ "$SCENARIO" = skipped ]; then printf '{"status":"skipped"}\\n'; else printf '{"status":"succeeded"}\\n'; fi
else printf synthetic-dump; fi
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "restic"),
        '#!/bin/sh\nif [ "$1" = backup ]; then cat >/dev/null; fi\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(dir, "curl"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGS"\ncat > "$PING_FILE"\n[ "$SCENARIO" != delivery-failed ]\n',
        { mode: 0o755 },
      );
      const url =
        scenario === "unconfigured"
          ? ""
          : scenario === "invalid-url"
            ? 'https://example.test/"\noutput=/tmp/invalid'
            : "https://uptime.betterstack.com/api/v1/heartbeat/testtoken";
      const result = spawnSync("bash", ["scripts/run-scheduled-job.sh", job], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          SCENARIO: scenario,
          JOB: job,
          SYNC_HEARTBEAT_URL: url,
          BACKUP_HEARTBEAT_URL: url,
          RESTIC_REPOSITORY: "sftp:test:repo",
          RESTIC_PASSWORD_FILE: join(dir, "unused"),
          PING_FILE: join(dir, "ping"),
          CURL_ARGS: join(dir, "args"),
        },
      });
      assert.equal(result.status, expectedExit, result.stderr);
      assert.equal(existsSync(join(dir, "ping")), pings);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("testtoken"));
      if (pings) {
        assert.equal(
          readFileSync(join(dir, "ping"), "utf8"),
          `url = "${url}"\n`,
        );
        assert.ok(
          !readFileSync(join(dir, "args"), "utf8").includes("testtoken"),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
