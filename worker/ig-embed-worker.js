/**
 * ig-embed-relay — Cloudflare Worker for Instagram Photo Downloader
 * ------------------------------------------------------------------
 * WHAT THIS DOES (why the project needs it):
 *   Browsers may not fetch instagram.com pages (CORS blocks it). This Worker
 *   runs on Cloudflare's edge — a server, where that rule doesn't apply — so
 *   it can read any Instagram embed page and hand it to the website with
 *   permission headers added. It makes photo + full-carousel + video slide
 *   resolution work without depending on third-party volunteers.
 *
 * FREE: Cloudflare Workers free plan = 100,000 requests/day, no credit card.
 * Each post is kept in the Worker's memory for 1 hour, so repeat visitors
 * rarely re-contact Instagram.
 *
 * HOW TO DEPLOY (≈5 minutes, see worker/README.md for the full walkthrough):
 *   1) Create a free account at https://dash.cloudflare.com (sign up)
 *   2) Left menu: "Workers & Pages" → "Create" → "Create Worker"
 *   3) Name it (e.g. "ig-embed") → Deploy (the default code is fine for now)
 *   4) "Edit code" → delete everything → paste THIS file → Deploy
 *   5) Copy the URL it shows (https://ig-embed.<you>.workers.dev)
 *   6) Paste that URL into js/instaimage.js → OWN_WORKER_BASE — done.
 */

// Same-Origin Policy: these standard headers are what make a cross-origin
// response legal for the site to read (plus the preflight contract).
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
};

// Instagram serves the embed page even from a server, but it fingerprints
// "claimed-Chrome" requests (full desktop UA without the matching client-hint
// headers) and serves a generic page instead of the embed. A plain desktop
// UA passes consistently — verified against live embeds.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

// Worker-rendered embed pages: the same headers served for cache hits and
// fresh fetches alike.
const HTML_RESPONSE_HEADERS = {
    ...CORS_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
};

// In-Worker cache with a 1-hour TTL. Deliberately NOT the Cache API: the
// documented behavior of caches.default on *.workers.dev domains is a no-op,
// and this relay must work with zero configuration. Entries live as long as
// Cloudflare keeps the isolate warm, so repeat visitors get the fast path.
const TTL_MS = 60 * 60 * 1000;
const embedCache = new Map(); // shortcode -> { html, fetchedAt }

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
    });
}

// Cloudflare Workers entry point — plain Web-standard Request/Response, no
// dependencies.
export default {
    async fetch(request, env) {
        // Browsers send a preflight OPTIONS before some requests — answer it
        // so the site's fetch() never gets stuck.
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        if (request.method !== 'GET') {
            return jsonResponse({ error: 'method-not-allowed' }, 405);
        }

        const shortcode = (new URL(request.url).searchParams.get('shortcode') || '').trim();
        // Whitelist input at the boundary: Instagram shortcodes are 5-20
        // letters/digits/_/-. Everything else is rejected before any upstream hit.
        if (!/^[A-Za-z0-9_-]{5,20}$/.test(shortcode)) {
            return jsonResponse({ error: 'invalid-shortcode' }, 400);
        }

        // 1) Repeat visitor within the TTL? Serve the cached page.
        const cached = embedCache.get(shortcode);
        if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
            return new Response(cached.html, { status: 200, headers: HTML_RESPONSE_HEADERS });
        }

        // 2) Fetch the embed page server-side.
        let upstream;
        try {
            upstream = await fetch(`https://www.instagram.com/p/${shortcode}/embed/`, {
                headers: { 'User-Agent': BROWSER_UA }
            });
        } catch (e) {
            return jsonResponse({ error: 'upstream-unreachable' }, 502);
        }
        const html = await upstream.text();

        // 3) Only trust pages that actually look like a post embed — a valid
        //    embed is >50KB and contains either carousel JSON or the media
        //    <img>; profile/login/error walls are much smaller and are
        //    rejected so the app can fall back to its backup proxies.
        const looksLikeEmbed = upstream.ok
            && html.length > 50000
            && (html.includes('edge_sidecar_to_children') || html.includes('EmbeddedMediaImage'));
        if (!looksLikeEmbed) {
            return jsonResponse({ error: 'upstream-rejected', status: upstream.status }, 502);
        }

        // 4) Serve and remember for an hour (in-isolate Map; see note above).
        embedCache.set(shortcode, { html, fetchedAt: Date.now() });
        return new Response(html, { status: 200, headers: HTML_RESPONSE_HEADERS });
    }
};
