import test from "node:test";
import assert from "node:assert/strict";
import { readAuthConfig } from "../src/auth/config.js";
import { clientIp } from "../src/auth/routes.js";
import type { Request } from "express";
test("local and public auth configuration have distinct transport requirements", () => {
  assert.equal(readAuthConfig({}).secure, false);
  assert.throws(() =>
    readAuthConfig({ AUTH_BASE_URL: "https://upcoming.example" }),
  );
  assert.throws(() =>
    readAuthConfig({
      AUTH_MODE: "public",
      AUTH_BASE_URL: "http://upcoming.example",
    }),
  );
  assert.throws(() => readAuthConfig({ SMTP_PORT: "invalid" }));
  const config = readAuthConfig({
    AUTH_MODE: "public",
    AUTH_BASE_URL: "https://upcoming.example",
    AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    RESEND_API_KEY: "test-key",
    AUTH_EMAIL_FROM: "accounts@upcoming.example",
  });
  assert.equal(config.secure, true);
  assert.deepEqual(config.trustedProxyIps, []);
});
test("only an explicitly trusted direct proxy can supply the client IP", () => {
  const req = {
    socket: { remoteAddress: "192.0.2.1" },
    headers: { "cf-connecting-ip": "203.0.113.5" },
  } as unknown as Request;
  assert.equal(clientIp(req, []), "192.0.2.1");
  assert.equal(clientIp(req, ["192.0.2.1"]), "203.0.113.5");
  req.headers["cf-connecting-ip"] = "203.0.113.5, 192.0.2.2";
  assert.equal(clientIp(req, ["192.0.2.1"]), "192.0.2.1");
});
