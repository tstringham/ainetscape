# Deployment

Step-by-step replay of getting AI Netscape from local to live on
`ainetscape.com`. Phases mirror the kickoff plan.

## Prerequisites

- `vercel` CLI, logged in (`vercel login`)
- `gh` CLI, logged in (`gh auth login`) — for the GitHub repo
- Node 20+, Python 3 with Pillow

## Phase 1 — local

```bash
npm install
pip install pillow
npx playwright install chromium
npm run build:assets          # favicons + og-image.png → public/
vercel link                   # create/link the Vercel project
vercel env pull .env.local    # once env vars exist
vercel dev                    # http://localhost:3000
```

## Phase 2 — GitHub (private) + Vercel staging

```bash
# Repo starts PRIVATE; flip to public only the day the link goes out.
gh repo create ainetscape --private --source=. --push --description "ainetscape.com"
```

### Environment variables (Vercel → Project → Settings → Environment Variables)

Set on the **Production** scope:

| Variable | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | provided by the owner | never from git history |
| `IP_HASH_SALT` | random 32+ char string | only used if Mongo logging is on |
| `MONGODB_URI` | Atlas connection string | optional — omit to skip logging |
| `AI_KILL_SWITCH` | (leave unset) | set to `1` to instantly disable generation |

### Rate limiting — Upstash Redis (recommended)

Two paths — both wire the same two env vars into Vercel.

**A) Vercel Marketplace (easiest)** — Vercel dashboard → **Storage /
Marketplace → Upstash → Redis**, attach it to the project. The integration
injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically.

**B) Direct via Upstash console (manual)** — if you created the DB at
`console.upstash.com/redis` directly:

1. On the DB details page, scroll to **REST API** and copy:
   - `UPSTASH_REDIS_REST_URL` (`https://xxxx-xxxxx.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN` (long opaque string)
   - **Not** the `redis://` URL — the code uses the REST client.
2. Vercel → Project → Settings → Environment Variables → add both, ticking
   **Production**, **Preview**, and **Development** for each.
3. Redeploy (`vercel --prod`) — Vercel only injects env vars at build time.

**Recommended DB settings:** Primary Region `us-east-1` (matches Vercel's
default `iad1` function region — keeps `INCR`/`EXPIRE` in single-digit ms),
Eviction **OFF** (rate limit keys self-expire via `EXPIRE`; eviction could
drop a live counter mid-window).

If both env vars are absent, the proxy falls back to a weaker per-instance
in-memory limiter — fine for local dev, not for production.

### Deploy to staging

```bash
vercel --prod          # produces a *.vercel.app URL — this is staging
vercel env ls          # confirm ANTHROPIC_API_KEY landed on Production
```

**Do not point the custom domain yet.**

## Phase 3 — smoke test the staging URL

Run the Definition of Done (brief 01 §2) and the 34-scenario plan
(brief 02 §7 + brief 03) against the `*.vercel.app` URL. Verify rate limiting,
mobile, OG card (https://opengraph.xyz/), console cleanliness, Lighthouse.

## Phase 4 — production cutover

```bash
vercel domains add ainetscape.com
vercel domains add www.ainetscape.com
```

Add the DNS records Vercel prints, at GoDaddy → AINetscape.com → DNS:

```
A      @     76.76.21.21
CNAME  www   cname.vercel-dns.com
```

### Email forwarding (GoDaddy)

The site references `webmaster@ainetscape.com`. Set up forwarding:

- GoDaddy → AINetscape.com → Email & Office → Email Forwarding
- `webmaster@ainetscape.com → thomas@trainflow.ai`
- catch-all: `*@ainetscape.com → thomas@trainflow.ai`

Verify:

```bash
dig ainetscape.com +short          # expect 76.76.21.21
curl -I https://ainetscape.com     # expect HTTP/2 200, valid SSL
# send a test email to webmaster@ainetscape.com — confirm it arrives
```

### Go public

```bash
gh repo edit ainetscape --visibility public
```

## Operations

- **Cost spike?** Set `AI_KILL_SWITCH=1` in Vercel — generation stops
  immediately, no redeploy. Also set a hard spend cap in the Anthropic console.
- **Logs:** Vercel → Project → Logs (function `api/generate.js`).
- **Analytics:** if Mongo is enabled, the `generations` collection.
