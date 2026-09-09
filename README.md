# LucentGPT

A plain HTML personal website with a human answering anonymous questions. No frontend JavaScript, analytics, framework, accounts, or visitor email addresses. The personal links, photo, and retro styling remain.

## How it works

1. A visitor posts a message and receives an unguessable conversation URL.
2. The Worker saves it in Cloudflare D1 and emails your verified Gmail inbox.
3. You hit **Reply** in Gmail and write above the quoted message. The special Reply-To address routes your answer to the Worker, which publishes its plain text in the conversation.
4. The visitor bookmarks the page and uses **Check for replies** to reload it. They can post followups on the same page; you get another email in the same conversation subject.

The site remains on your existing Cloudflare Pages project. The separate `lucentgpt-mail` Worker handles only `lucentlu.com/api/*`, incoming replies, and a five-minute notification retry/cleanup job. No email is sent to visitors. At personal-site volume, this fits Workers Free, D1 Free, and free sends to a verified Email Routing destination. Free-tier limits still apply across your account.

## Cloudflare setup

### 1. Install dependencies and enable Email Routing

Use Node.js 22.13+ (a current LTS is recommended) and run from the repository root:

```sh
npm ci
npx wrangler login
```

In Cloudflare, select `lucentlu.com` and open Email Routing / Email Service:

- Enable Email Routing and follow the DNS setup instructions. Preserve any existing mail hosting; review MX changes before applying them.
- Use `1215.lucent@gmail.com` as the destination (already verified in Cloudflare).
- The sender `lucentgpt@lucentlu.com` must belong to the domain onboarded to Email Service.
- Remain on Workers Free. Paid sending to arbitrary recipients is unnecessary.

If your verified inbox changes, update both `TO_EMAIL` and `send_email.destination_address` in `worker/wrangler.toml`. Incoming replies must come from that exact inbox, including its From address.

### 2. Create the D1 database

```sh
npx wrangler d1 create lucentgpt
```

Copy the returned database ID into `worker/wrangler.toml`, replacing the all-zero `database_id`. Keep the binding name `DB`. Then apply the schema and deploy the Worker:

```sh
npx wrangler d1 migrations apply lucentgpt --remote --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

The Worker and domain must belong to the same Cloudflare account. Keep your domain attached to Pages, with proxied DNS. Do not replace the Pages domain with a Worker Custom Domain. The five-minute Cron Trigger retries saved notifications and removes expired conversations; initial trigger propagation can take several minutes.

### 3. Route your email replies to the Worker

In Email Routing:

- Create the custom address **`replies@lucentlu.com`**.
- Set its action to **Send to a Worker**, selecting **`lucentgpt-mail`**.
- **Enable subaddressing / plus addressing** for the zone. Cloudflare must route mail to `replies+TOKEN@lucentlu.com` through this rule while passing the full recipient address to the Worker.

No catch-all rule or per-conversation address creation is needed. `REPLY_EMAIL` in the Worker config must match this base address.

Each notification sets Reply-To to a unique, secret `replies+TOKEN@lucentlu.com` address. **Use Reply in Gmail, not a new message to the plain base address.** Write your answer above the quoted notification. Standard Gmail, Apple Mail, and Outlook top-posted text is supported. Plain text is published; HTML and attachments are not. The signature delimiter `-- ` stops publication, but signatures without that delimiter can appear on the page. Remove signatures you don't want posted. Inline/bottom-posted answers and unusual localized quotation formats are not reliably extracted.

An invalid, empty, oversized, expired, or unauthorized reply is rejected at the email handler. Check your inbox for delivery failures. Automatic replies are rejected. A repeated email delivery with the same Message-ID is not published twice.

### 4. Deploy the Pages frontend

For your existing Git-connected Pages project:

- Framework: None
- Root: repository root
- Build command: `sh build.sh`
- Output directory: `dist`

Commit and push when ready. The build copies only public assets; it excludes the Worker, database schema, and development files. For a Direct Upload project instead:

```sh
npm run build
npx wrangler pages deploy dist --project-name YOUR_EXISTING_PAGES_PROJECT
```

Deploy the Worker, database migration, and email rule **before** the frontend. The anonymous version replaces the previous email-required endpoint. Previously sent emails still have the original visitor Reply-To and can be answered normally.

### 5. Verify the live round trip

1. Send a test question on `https://lucentlu.com` without entering an email.
2. Bookmark the returned secret link. Check Gmail, including spam.
3. Hit Reply and confirm the recipient starts with `replies+` and ends with `@lucentlu.com`.
4. Write a short answer above the quote and send it.
5. Reload the bookmarked page: your answer should appear under **Lucent**.
6. Wait 30 seconds after the previous visitor message, post a followup, and repeat.

If mail delivery fails, the visitor's message is still saved, with a pending-notification status. Cron retries it automatically; do not resubmit it. A successful send means Cloudflare accepted the email, not proof of inbox delivery. This repository does not provision your Cloudflare account or verify live Gmail delivery automatically.

## Privacy and limits

- Visitor URLs contain 256-bit random access tokens. Only their SHA-256 hashes are stored in D1. Anyone with the URL can read and post as that visitor. There is no lost-link recovery.
- Owner reply tokens are independent 256-bit secrets stored in D1 and shared only with your inbox. They never appear in conversation HTML or visitor notifications. Do not forward notification emails: their Reply-To addresses are credentials for publishing as you. The exact owner envelope and From addresses are also checked; these checks alone are not email authentication.
- Conversation pages use `no-store`, `no-referrer`, `noindex`, and a restrictive CSP. There are no scripts, cookies, tracking pixels, third-party requests, or message contents in logs. Worker observability is disabled. Do not enable request/analytics logging of secret URLs or a cache rule that overrides these headers.
- The app stores message text, timestamps, conversation IDs, and reply credentials. It does not store visitor emails, IPs, or user agents. Cloudflare still handles network metadata, and your Cloudflare account can access D1. This is not a promise of anonymity from the infrastructure owner. Your Gmail retains notification copies according to your email settings.
- Conversations expire **180 days after creation**, even if active; the scheduled job deletes their database messages. Gmail copies and any provider backups have separate retention.
- Messages and replies are limited to 10,000 characters. A conversation holds at most 200 messages. Visitors must wait 30 seconds between followups. A global ceiling of 500 submission attempts/day protects the inbox without storing IP addresses.
- A honeypot, origin checks, body caps, parameterized SQL, and HTML escaping are included. These do not stop determined bots; an attacker could consume the shared daily allowance. If necessary, add Turnstile with server-side verification (requires browser JavaScript).
- Notification delivery is at least once: a crash after sending but before recording success can produce a duplicate notification. Incoming email Message-IDs and followup form request IDs prevent ordinary duplicate publication.
- There are no paid services configured, but exceeding Workers/D1 free quotas can make the app unavailable. Keep the account on the free plan and monitor actual usage.

## Local checks

```sh
npm ci
npm test
npm run build
npm run check:worker
```

Tests use Node's SQLite engine with the actual migration and SQL, plus real MIME parsing. They cover creation, secret separation, escaping, replies, followups, idempotency, failed-email retries, validation, authorization, quotas, and expiration. The dry-run verifies the Cloudflare bundle and bindings without deploying.

For the local Worker runtime:

```sh
npx wrangler d1 migrations apply lucentgpt --local --config worker/wrangler.toml
npm run dev -- --port 8787 --local-upstream localhost:8787 --upstream-protocol http --var ALLOWED_ORIGINS:http://localhost:8787
```

The local emulator doesn't deliver to Gmail. To exercise the API:

```sh
curl -i http://localhost:8787/api/message \
  -H 'Origin: http://localhost:8787' \
  --data-urlencode 'message=Hello from the local test'
```

Open the returned Location on `http://localhost:8787`. For a styled local frontend, use `npm run dev -- --port 8787 --assets ./dist --local-upstream localhost:8787 --upstream-protocol http --var ALLOWED_ORIGINS:http://localhost:8787` after building. The homepage form deliberately targets production; its origin check rejects local and Pages-preview submissions. Use the curl request above to create local conversations. Subsequent conversation forms submit locally. Never use a production conversation URL in local tests.

The pinned `sharp` override fixes a transitive development-tool advisory; image processing is not part of the deployed Worker.

## Official references

- [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Email sending binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Incoming email handler and MIME parsing](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Email Routing subaddressing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
