# Hosted email and DNS (UP-21 / UP-22)

The hosted test uses `https://upcoming.crashpalace.uk` on the owner's Ubuntu server through its existing Cloudflare Tunnel. Resend sends account verification and password-reset messages. Local development retains Mailpit.

| Setting                              | Value                                              |
| ------------------------------------ | -------------------------------------------------- |
| Cloudflare DNS zone                  | `crashpalace.uk`                                   |
| App hostname / authentication origin | `https://upcoming.crashpalace.uk`                  |
| Resend sending domain                | `mail.upcoming.crashpalace.uk`                     |
| Sender                               | `Upcoming <accounts@mail.upcoming.crashpalace.uk>` |

Status: configuration prepared; Resend verification, live DNS/tunnel changes and hosted email tests are still pending. UP-13 owns production Compose, migrations and the sync schedule. The current `compose.yaml` is local-only and explicitly overrides authentication to local mode.

## 1. Add the Resend domain

In Resend, add `mail.upcoming.crashpalace.uk` with sending enabled. Receiving is not needed for verification/reset emails. Save the generated DNS names, types, values and MX priority; these are public records. Do not share API keys or verification/reset links in tickets.

Resend can publish the records through its **Sign in to Cloudflare** setup, or they can be entered manually in the `crashpalace.uk` zone. Use the account-generated records as authoritative. With the default return-path prefix, the relative Cloudflare record names are expected to be:

| Type             | Name within crashpalace.uk        | Value                                       |
| ---------------- | --------------------------------- | ------------------------------------------- |
| TXT (DKIM)       | `resend._domainkey.mail.upcoming` | Copy the generated public key               |
| TXT (SPF)        | `send.mail.upcoming`              | Copy the generated SPF value                |
| MX (return path) | `send.mail.upcoming`              | Copy the generated mail server and priority |

Keep mail records DNS-only where Cloudflare offers a proxy toggle. Preserve existing root-domain mail records. The return-path MX is for delivery feedback; it does not require enabling inbound email or creating an accounts mailbox. Check any existing DMARC policy and confirm SPF/DKIM/DMARC results in the received message during testing.

Click **Verify DNS Records** in Resend and wait for verified status. Troubleshoot by comparing the full record names and values, including the `mail.upcoming` suffix. Do not add a second SPF record at the same name.

Sources: [Resend's Cloudflare instructions](https://resend.com/docs/knowledge-base/cloudflare), [sending domains and return paths](https://resend.com/docs/dashboard/domains/introduction).

## 2. Prepare application credentials

Create a **Sending access** API key restricted to `mail.upcoming.crashpalace.uk`. The backend already calls Resend's HTTPS API in public mode; it needs neither an SMTP password nor a new SDK. [API key permissions](https://resend.com/docs/dashboard/api-keys/introduction).

Copy the tracked template without overwriting an existing private file:

```bash
cp -n .env.public.example .env.public
chmod 600 .env.public
```

Fill `RESEND_API_KEY` and a unique random `AUTH_SECRET` of at least 32 characters using a private editor/password manager. `.env.public` is ignored by Git and excluded from Docker builds. Keep the existing local `.env` intact. The template contains authentication settings only; production database/TMDB settings and explicit Compose environment wiring are handled in UP-13.

`AUTH_TRUSTED_PROXY_IPS` must be the exact direct proxy socket addresses observed at the app, not the public Cloudflare edge ranges or the server's guessed LAN address. Until configured, forwarding headers are ignored and users may share the proxy's rate limit. Verify the controlled ingress before enabling trust.

For Resend key rotation, create a replacement sending key, update the private runtime environment, recreate the app container through the production release procedure, test a delivery, then revoke the old key. Do not rotate AUTH_SECRET as part of routine email-key rotation.

## 3. Route the app through the existing tunnel

First inspect Ubuntu's running containers, networks and listening ports. Determine whether cloudflared is a host service, uses host networking, or runs on a Docker bridge. Record the existing tunnel name and management mode without copying its token.

For a dashboard-managed tunnel, add a published application route for `upcoming.crashpalace.uk` to the existing tunnel. Its service URL depends on the actual deployment:

- Host service or host-networked cloudflared: use the app's chosen loopback port, for example `http://127.0.0.1:PORT`, after confirming it is available.
- Bridge-networked cloudflared: attach the app to a suitable shared Docker network and use its unique network alias and container port. `localhost` inside that container refers to cloudflared itself.

Only the app should join the tunnel network; PostgreSQL stays on the application's private network without a published port. The browser uses HTTPS while the tunnel may connect to the app using HTTP on that controlled local path.

The dashboard creates the hostname's tunnel DNS record. For a locally managed tunnel, add the Upcoming ingress rule before the catch-all and create its DNS route using `cloudflared tunnel route dns TUNNEL_NAME upcoming.crashpalace.uk`. Preserve all existing ingress rules. Do not create a competing A record pointing at the home's public IP. [Cloudflare routing](https://developers.cloudflare.com/tunnel/routing/), [locally managed tunnel instructions](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/).

Confirm HTTPS and the hostname's certificate. Keep the app's own login flow; do not add a second Cloudflare Access login. Check for existing wildcard Access policies and custom cache rules affecting this hostname. `/api/*` and authentication pages must retain their no-store behavior. Resend delivery goes outbound over HTTPS, independently of the tunnel route.

## 4. Verify before closing the tickets

After UP-13 starts the public-mode app, check:

```bash
curl --fail --silent --show-error https://upcoming.crashpalace.uk/api/ready
curl --head --silent --show-error https://upcoming.crashpalace.uk/releases
```

Open a release-month deep link in a browser and refresh it. Register with an owner-controlled inbox, inspect the delivered verification message, verify and sign in. Request a password reset, open the hosted HTTPS link, change the password and sign in again. Check Secure/HttpOnly/SameSite cookies and the absence of cache hits for account responses. Record pass/fail and provider delivery status, not message bodies or token URLs.

Verify the Resend dashboard and mailbox headers for successful delivery/authentication. A provider accepting a message does not alone prove inbox delivery. Check spam folders if necessary. If delivery fails, first check the verified domain, sender address, key scope and quota; app logs deliberately omit provider response bodies and account URLs.

Resend's free transactional allowance is currently 3,000 emails/month and 100/day. The app reserves at most 90 delivery attempts per UTC day and enforces a 60-second cooldown per recipient/message type. Failed attempts count; quota/cooldown suppression deliberately keeps account responses generic. Normal password sign-in sends no email. Plan beta invitations across days if necessary; do not enable a paid upgrade automatically. [Current Resend limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits).

To roll back routing, remove only Upcoming's published route and its DNS record, preserving the existing tunnel and other apps. If retiring email delivery, revoke the app's Resend key and remove only records created for its sending domain after confirming they are no longer used. Never delete database storage as part of DNS rollback.

## Remaining account/server inputs

- Resend's generated public records and verified status.
- The private API-key file location (not the key itself).
- Ubuntu SSH host alias, if accessible from this workspace.
- Existing cloudflared management mode, networking and app port/network selection.

These inputs are needed before live configuration and end-to-end verification can be completed.
