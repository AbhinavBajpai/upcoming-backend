# Authentication proposal (UP-07)

Status: email/password with passkeys deferred was confirmed by the owner on 5 September 2026. Better Auth implementation is in UP-08; production email-domain details remain outstanding. Reviewed 5 September 2026.

## Recommendation and alternatives

Use Better Auth inside Express, with its PostgreSQL adapter and a small same-origin JSON client. Start with email/password, verified email before sign-in, and email-based password recovery. Keep the public calendar available without an account. This fits the existing same-origin deployment and keeps user/session records in the database we already operate. The tradeoff is that we own upgrades, backups and email delivery.

| Option | Fit for this project | Cost and tradeoff |
| --- | --- | --- |
| Better Auth, self-hosted | Express integration, PostgreSQL sessions, our own React screens | No additional hosted-auth service; requires email delivery and ongoing security updates |
| Clerk, managed | Prebuilt account screens and hosted identity management | Hobby currently free for 50,000 monthly retained users; fixed seven-day sessions and vendor dependency. Paid Pro starts at $20/month billed annually, a poor default for our overall £20 budget |

Clerk is a reasonable alternative if minimizing auth operations outweighs the preference for a self-contained Docker app. Neither choice requires capacity planning for thousands of users now. Better Auth is younger than long-established identity servers; its framework integration and small operational footprint are the reasons for this recommendation, not an assumption that self-hosting is maintenance-free. [Express integration](https://better-auth.com/docs/integrations/express), [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql), [Clerk pricing](https://clerk.com/pricing).

## Proposed user experience

1. Register with display name, email and password. Require 12–128 characters, allow password-manager paste, and use the library's password handling. Return a generic registration response for new and existing emails.
2. Show a verification screen with resend and change-email/back controls. Verify via a one-hour link, then ask the user to sign in. Do not create an authenticated session merely on registration.
3. Sign in with email/password; return to a validated local route. A failed sign-in uses a generic credentials error. Unverified users can request another email without exposing account details through a public lookup endpoint.
4. Forgot password always shows the same response. A single-use 30-minute reset link leads to a new-password form. Reset revokes existing sessions and requires a fresh sign-in.
5. Sign out revokes the server session. Account settings provide display-name editing, password change requiring the current password, and sign out of other sessions. Changing password revokes other sessions.

These are application choices implemented using the library's existing flows, with exact options verified against the pinned release during UP-08. [Email/password and verification/recovery documentation](https://better-auth.com/docs/authentication/email-password).

Passkeys are supported by a Better Auth plugin, but would still require decisions about lost devices, recovery, enrollment and a stable HTTPS relying-party domain. Defer them as an optional account sign-in method after the baseline recovery flow works. This is a scope recommendation, not a claim that browsers cannot support them. [Passkey integration](https://better-auth.com/docs/plugins/passkey).

## Email and cost

Propose a small email-delivery interface with local SMTP capture and production Resend. The local Compose stack can add Mailpit, bound to loopback, so verification/reset messages are visible in a local inbox without real delivery or a paid account. Do not print reset/verification URLs in logs. [Mailpit](https://github.com/axllent/mailpit).

Resend currently offers 3,000 emails/month with a 100/day cap for $0. That should suit hundreds of users spread across a small beta, but a single launch day or abusive resend requests can exhaust the daily cap. Rate-limit resend/reset and surface delivery failures with a retry path; never automatically buy an upgrade. Production requires a sending domain controlled by the owner, verified with DNS records. No domain or existing email service is assumed. Domain registration, if needed, is extra and must be selected separately. [Resend pricing](https://resend.com/pricing), [domain verification](https://resend.com/docs/dashboard/domains/introduction).

Expected incremental monthly service spend: £0 while staying within the free email tier and using an existing domain/server. This excludes the existing server's power, internet and backup costs. Keep email sending behind an adapter so a provider change does not affect account records. No personal mailbox or home-server outbound SMTP delivery is required.

## Sessions and request protection

- Use a pinned Better Auth version, its password hashing and database-backed sessions; no custom credential protocols. Keep auth tables separate from film tables and create reviewed node-pg-migrate migrations. Internal user IDs are stable. Public/social DTOs contain ID and display name only, never email, password hashes, tokens or session metadata.
- Browser uses same-origin `/api/auth` cookies. Set HttpOnly, SameSite=Lax, host-only cookies, Secure on the public HTTPS origin. Local HTTP mode is explicit and loopback-only; do not use `NODE_ENV` alone to infer the browser scheme because Docker already builds production assets locally. Do not store session tokens in localStorage.
- Proposed session policy: a fixed seven-day expiry with renewal disabled, requiring sign-in again after expiry. Read sessions from PostgreSQL; disable cookie session caching so revocations take effect on the next request. Sensitive changes require recent authentication. Verify expiry semantics in integration tests. [Session management](https://better-auth.com/docs/concepts/session-management).
- Keep the library's CSRF and origin checks enabled. Fix the external base URL in configuration and list only exact allowed origins, separately for localhost and deployment. Allow only validated local return paths. The pinned Node adapter supports a parsed body; the auth route applies a 32KB JSON limit before passing requests to it. Integration tests cover this boundary.
- Better Auth protects its own routes, not arbitrary application endpoints. For later star/friend mutations require authenticated ownership, JSON content type and an exact trusted Origin; reject absent/untrusted/null Origin on browser mutations. No state-changing GET application endpoints. Test forged requests independently of the frontend. [Security guidance](https://better-auth.com/docs/reference/security).
- Enable auth rate limits explicitly, including local integration tests: proposed global 100 requests/minute/IP; sign-in 10/minute/IP; signup/resend/reset 3/minute/IP. Add per-address, per-email-type 60-second cooldowns and a 90-message UTC-day email budget so one user or distributed requests cannot drain the free tier. Use PostgreSQL-backed counters so a process restart does not reset protection. Hash any email-derived counter keys; log safe event codes only. Tune the limits during beta rather than permanently locking accounts. [Rate limits](https://better-auth.com/docs/concepts/rate-limit).
- Default Express proxy trust is off. On deployment, app ingress must be reachable only through the controlled tunnel path. Configure only the verified proxy addresses/header path; never enable broad `trust proxy: true`. Only accept `CF-Connecting-IP` when the direct ingress is controlled and strips/overwrites attacker-supplied forwarding headers. Local mode derives IP from the socket, ignoring forwarded headers. Better Auth's IP configuration is separate from Express's and must receive the same verified client identity. The exact tunnel/container topology remains a deployment check before enabling proxy mode. Keep `baseURL` fixed rather than trusting forwarded hosts.
- Require an independently generated auth secret and deployment origin in runtime configuration. Exclude secrets from builds, Git, telemetry and request logs. Redact cookies, Authorization and token query parameters. Auth pages should use no-referrer, no-store and avoid remote images/third-party requests while a reset token is in the URL.

## Implementation and verification plan (UP-08)

First implement the library adapter, reviewed schema and test mail delivery. Then build registration, verification, login, reset and account screens in the existing visual style. Add a minimal `/api/me` profile boundary for subsequent stars/friendships; enforce ownership from the session on every protected resource.

Run real PostgreSQL integration tests covering anonymous access, valid registration, no access before verification, expired/replayed reset tokens, invalid credentials, logout/revocation, cross-user access, CSRF, hostile return URLs, spoofed proxy headers and rate limits. Exercise the complete email flow with a local captured inbox, then desktop/mobile browser tests. Keep tests isolated from user data and real recipients.

No real email account, DNS change or tunnel modification is needed for local implementation. Production delivery requires the owner's domain/provider details. UP-09 (stars) follows once authentication is complete.
