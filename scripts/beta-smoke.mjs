// Read-only checks; never registers accounts or sends email.
import assert from "node:assert/strict";
const origin = new URL(process.argv[2] ?? "https://upcoming.crashpalace.uk");
assert.equal(origin.pathname, "/");
assert.ok(
  origin.protocol === "https:" ||
    ["localhost", "127.0.0.1"].includes(origin.hostname),
);
const checks = [
  ["/api/ready", 200],
  ["/api/releases", 200],
  ["/api/me", 401],
  ["/releases", 200],
  ["/login", 200],
];
let failed = false;
for (const [path, status] of checks) {
  const start = performance.now();
  try {
    const response = await fetch(new URL(path, origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, status);
    if (path.startsWith("/api/"))
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    if (path === "/api/ready")
      assert.equal((await response.json()).database, "connected");
    else if (path === "/api/releases") {
      const data = await response.json();
      assert.ok(Array.isArray(data.films));
      assert.equal(data.country, "GB");
    } else if (!path.startsWith("/api/"))
      assert.match(await response.text(), /id="root"/);
    else await response.body?.cancel();
    console.log(
      JSON.stringify({
        path,
        status: "passed",
        milliseconds: Math.round(performance.now() - start),
      }),
    );
  } catch {
    failed = true;
    console.error(JSON.stringify({ path, status: "failed" }));
  }
}
process.exitCode = failed ? 1 : 0;
