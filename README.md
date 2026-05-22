# AI Netscape

A recreation of a 1997 HTML composer with one anachronistic addition: an
**AI Composer** button that generates complete, state-of-the-art websites.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Single static `index.html` — no framework, no build step |
| Backend | One Vercel serverless function, `/api/generate` |
| Rate limiting | Upstash Redis (durable, global) with an in-memory fallback |
| Logging | Optional — MongoDB Atlas, gated on `MONGODB_URI` |
| Hosting | Vercel |
| Model | `claude-sonnet-4-6` |

## Project layout

```
ainetscape/
├── index.html            # The whole UI: chrome, editor, dialogs, AI Composer
├── api/
│   ├── generate.js       # Anthropic proxy: system prompt, rate limit, cache
│   └── _db.js            # Optional Mongo logging helper (loaded only if enabled)
├── public/               # favicon.ico/.svg, apple-touch-icon.png, og-image.png
├── scripts/
│   ├── build_favicons.py # Generates the favicons (needs Pillow)
│   ├── og-template.html  # 1200x630 social-card source
│   └── build_og.mjs      # Renders og-template.html -> public/og-image.png
├── vercel.json           # Security headers, function config
├── package.json
├── .env.example
├── DEPLOYMENT.md         # Step-by-step deploy guide
└── README.md
```

## Architecture notes

- The Anthropic key **and the system prompt** both live server-side in
  `/api/generate.js`. The browser only ever sends a brief — it cannot supply
  its own system prompt.
- `index.html` is intentionally a single hand-written file. No bundler.
- AI generation runs through a triage step: the model first classifies the
  brief (`build` / `warn_*` / `refuse_*`); the client renders the result.

## Local development

```bash
npm install
vercel link            # first time only
vercel env pull .env.local
vercel dev             # → http://localhost:3000
```

The AI Composer button needs `ANTHROPIC_API_KEY` available locally (via
`vercel env pull`) to work end-to-end.

## Building assets

```bash
pip install pillow
npm install && npx playwright install chromium
npm run build:assets   # favicons + OG card → public/
```

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md).
