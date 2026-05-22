# AI Netscape Composer

A loving parody of Netscape Composer with one anachronistic twist: an "AI Composer" toolbar button that generates state-of-the-art modern websites via Claude.

Built as a follow-up to an a16z application for Marc Andreessen.

## Stack

- **Frontend:** Single static `index.html` (no build step, no framework)
- **Backend:** One Vercel serverless function (`/api/generate`) that proxies to Anthropic
- **Hosting:** Vercel
- **Domain:** AINetscape.com (registered at GoDaddy)

## Project layout

```
ainetscape/
├── index.html         # The whole UI: chrome, editor, dialogs, AI button
├── api/
│   └── generate.js    # Anthropic proxy (keeps API key server-side)
├── vercel.json        # Trivial Vercel config
└── README.md
```

## Deploy (first time)

```bash
cd ~/Projects/ainetscape

# 1. Git
git init
git add .
git commit -m "Initial commit: AI Netscape Composer"
gh repo create ainetscape --public --source=. --push

# 2. Vercel
vercel link        # creates the project
vercel env add ANTHROPIC_API_KEY production   # paste key when prompted
vercel --prod      # ship it

# 3. Domain (after AINetscape.com is yours at GoDaddy)
vercel domains add ainetscape.com
vercel domains add www.ainetscape.com
# Vercel will show you the exact DNS records to add at GoDaddy:
#   A      @     76.76.21.21
#   CNAME  www   cname.vercel-dns.com
# DNS propagates in 5–60 min.
```

## Deploy (subsequent changes)

```bash
git add . && git commit -m "..." && git push
# Vercel auto-deploys from GitHub on push to main
```

Or just `vercel --prod` for an immediate push without git.

## Local dev

```bash
vercel dev
# → http://localhost:3000
```

This runs the serverless function locally so the AI button works in dev.

## Notes

- The Anthropic API key lives only in Vercel's env vars — never in the repo, never in the bundle.
- `/api/generate.js` caps brief length at 4000 chars so the endpoint can't be weaponized.
- Pinned to `claude-sonnet-4-5-20250929` — fast and cheap enough that a few hundred Marc-curious visitors won't matter.
