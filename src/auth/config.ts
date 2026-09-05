import { isIP } from "node:net";
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.AUTH_MODE ?? "local";
  if (mode !== "local" && mode !== "public")
    throw new Error("AUTH_MODE must be local or public.");
  const origin = new URL(env.AUTH_BASE_URL ?? "http://localhost:5173");
  if (
    origin.origin !== origin.href.replace(/\/$/, "") ||
    origin.username ||
    origin.password
  )
    throw new Error("AUTH_BASE_URL must be an origin without a path.");
  if (
    mode === "local" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new Error("Local authentication requires a localhost origin.");
  if (
    mode === "public" &&
    (origin.protocol !== "https:" ||
      !env.AUTH_SECRET ||
      env.AUTH_SECRET.length < 32 ||
      !env.RESEND_API_KEY ||
      !env.AUTH_EMAIL_FROM)
  )
    throw new Error(
      "Public authentication requires HTTPS, AUTH_SECRET (32+ characters), RESEND_API_KEY and AUTH_EMAIL_FROM.",
    );
  const trustedProxyIps =
    mode === "public"
      ? (env.AUTH_TRUSTED_PROXY_IPS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (trustedProxyIps.some((ip) => !isIP(ip)))
    throw new Error("AUTH_TRUSTED_PROXY_IPS must contain exact IP addresses.");
  const smtpPort = Number(env.SMTP_PORT ?? 1025);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
    throw new Error("SMTP_PORT must be a valid port.");
  const secret =
    env.AUTH_SECRET ?? "upcoming-local-only-secret-change-for-public-use";
  if (secret.length < 32)
    throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return {
    trustedProxyIps,
    mode,
    origin: origin.origin,
    secret,
    secure: origin.protocol === "https:",
    smtpHost: env.SMTP_HOST ?? "127.0.0.1",
    smtpPort,
    emailFrom: env.AUTH_EMAIL_FROM ?? "Upcoming <accounts@upcoming.local>",
    resendKey: env.RESEND_API_KEY,
  };
}
export type AuthConfig = ReturnType<typeof readAuthConfig>;
