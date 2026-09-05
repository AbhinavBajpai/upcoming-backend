import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import type { AuthConfig } from "./config.js";
export interface AccountEmail {
  to: string;
  url: string;
  kind: "verify" | "reset";
}
export type DeliverEmail = (mail: AccountEmail) => Promise<void>;
export function createEmailDelivery(config: AuthConfig): DeliverEmail {
  const smtp =
    config.mode === "local"
      ? nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: false,
          connectionTimeout: 5000,
          socketTimeout: 10000,
        })
      : null;
  return async ({ to, url, kind }) => {
    const subject =
      kind === "verify"
        ? "Verify your Upcoming email"
        : "Reset your Upcoming password";
    const text = `${subject}\n\n${url}\n\nThis link expires ${kind === "verify" ? "in one hour" : "in 30 minutes"}. If you didn't request this, you can ignore this email.`;
    if (smtp) {
      await smtp.sendMail({ from: config.emailFrom, to, subject, text });
      return;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
  };
}
// Reserve quotas before contacting a provider. A failed delivery still counts towards
// the budget, since a timeout does not prove that the provider rejected the message.
export function budgetedEmail(
  pool: Pool,
  secret: string,
  deliver: DeliverEmail,
): DeliverEmail {
  return async (mail) => {
    const address = createHmac("sha256", secret)
      .update(mail.to.trim().toLowerCase())
      .digest("hex");
    const client = await pool.connect();
    let allowed = false;
    try {
      await client.query("BEGIN");
      const cooldown = await client.query(
        `INSERT INTO auth_email_limits (key, count, expires_at) VALUES ($1, 1, now() + interval '60 seconds') ON CONFLICT (key) DO UPDATE SET count=1, expires_at=now() + interval '60 seconds' WHERE auth_email_limits.expires_at <= now() RETURNING key`,
        [`${mail.kind}:address:${address}`],
      );
      if (cooldown.rowCount) {
        const budget = await client.query(
          `INSERT INTO auth_email_limits (key, count, expires_at) VALUES ('daily', 1, date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day') ON CONFLICT (key) DO UPDATE SET count=CASE WHEN auth_email_limits.expires_at <= now() THEN 1 ELSE auth_email_limits.count+1 END, expires_at=date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day' WHERE auth_email_limits.expires_at <= now() OR auth_email_limits.count < 90 RETURNING key`,
        );
        allowed = !!budget.rowCount;
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error("EMAIL_BUDGET_UNAVAILABLE");
    } finally {
      client.release();
    }
    if (allowed) await deliver(mail);
  };
}
