# Self-hosted Instagram Relay (Cloudflare Worker) — 5-minute setup, free

Your website runs in visitors' browsers, and browsers are not allowed to read
pages from other websites (the CORS rule). Instagram's page lists *every*
image of a post — but only something that is NOT your browser can fetch it.
Free volunteer proxies used to do that; nearly all are now broken or paid.

This folder contains your own permanent middleman. Free tier: **100,000
fetches/day, no credit card**, and each post is kept in the Worker's memory
cache for an hour, so repeat visitors are served instantly.

**Quick demo without any code edit:** open your site with
`?worker=<your-worker-url>` appended, e.g.
`https://yoursite.github.io/Instagram-Photo-Downloader/?worker=https://ig-embed.you.workers.dev`

## Step by step

1. **Create the free account**
   <https://dash.cloudflare.com/sign-up> — email + password. No card needed.
   Onboarding may ask for a "subdomain" — pick any name (e.g. `aman`) and keep it.

2. **Create the Worker**
   Dashboard → **Workers & Pages** → **Create** → **Create Worker**.
   Name: `ig-embed` (anything works). Press **Deploy** (default code is fine).

3. **Paste the code**
   On the worker's page → **Edit code** → delete everything → paste the entire
   contents of [`ig-embed-worker.js`](./ig-embed-worker.js) → **Save and deploy**.

4. **Copy your worker URL**
   It looks like `https://ig-embed.aman.workers.dev` (shown on the deploy page /
   worker settings → Domains & Routes).

5. **Wire it into the site**
   Open `js/instaimage.js` and Ctrl+F for `OWN_WORKER_BASE` (about halfway down
   the file, flagged by a large comment block) and paste yours:
   ```js
   const OWN_WORKER_BASE = 'https://ig-embed.aman.workers.dev';
   ```

6. **Test it in 5 seconds** — open in a browser:
   `https://ig-embed.aman.workers.dev/?shortcode=CgMcTr9u1P_`
   You should see a wall of text containing `edge_sidecar_to_children`.

## What changed in the app

Nothing breaks if you skip steps 1–6: with `OWN_WORKER_BASE` left empty the app
runs exactly as before. When set, your worker is the **primary** slide source
and all the volunteer proxies (Weserv + AllOrigins-class) automatically stay as
fallbacks.

## Checking on it

Dashboard → Workers → `ig-embed` → **Metrics**: requests, cache hits, errors.
If you ever see sustained errors, the Worker is dead-simple to redeploy — paste
again — and the site keeps working in the meantime via fallback proxies.
