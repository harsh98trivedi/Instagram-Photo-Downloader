// Main Instagram Photo Downloader Logic

function decodeUnicode(str) {
    return str
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)))
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
}

function extractInstagramImage(rawHtmlContent) {
    if (!rawHtmlContent) return null;
    
    // Pre-decode HTML content to resolve all JSON unicode escapes (e.g. \u0026 -> &)
    // and JSON slash escapes (e.g. \/ -> /). This transforms all escaped URLs
    // into standard normal URLs, making pattern matching extremely reliable.
    const htmlContent = decodeUnicode(rawHtmlContent);

    // Strict guard: a URL must look like an actual photo, not a JS/CSS/avatar/static file
    function isValidImageUrl(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        // Must be from a known Instagram CDN domain
        if (!lower.includes('cdninstagram.com') && !lower.includes('fbcdn.net')) return false;
        // Must not be a static resource (JS, CSS, ico, webp icons, rsrc.php)
        if (lower.includes('/rsrc.php')) return false;
        if (lower.includes('static.cdninstagram.com')) return false;
        if (/\.(js|css|ico|woff|woff2|ttf|svg)(\?|$)/.test(lower)) return false;
        // Must not be a profile avatar (t51.2885-19 is Instagram's avatar size type)
        if (lower.includes('t51.2885-19')) return false;
        // Must include a signature parameter — real post images always have 'oh=' or 'oe='
        if (!lower.includes('oh=') && !lower.includes('oe=')) return false;
        // Must have an image-like path segment (t51.2885-15 is the post photo type)
        // or at least be a scontent CDN subdomain
        if (!lower.includes('scontent') && !lower.includes('fbcdn.net')) return false;
        return true;
    }

    // Strategy 1: og:image or twitter:image meta tag
    const metaPatterns = [
        /property=[\"']og:image[\"'][^>]*content=[\"']([^\"']+)[\"']/i,
        /content=[\"']([^\"']+)[\"'][^>]*property=[\"']og:image[\"']/i,
        /name=[\"']twitter:image[\"'][^>]*content=[\"']([^\"']+)[\"']/i,
        /content=[\"']([^\"']+)[\"'][^>]*name=[\"']twitter:image[\"']/i,
    ];
    for (const pat of metaPatterns) {
        const m = htmlContent.match(pat);
        if (m && m[1] && isValidImageUrl(m[1])) {
            return m[1];
        }
    }

    // Strategy 2: JSON display_url field (Instagram's internal data blob)
    const jsonMatch = htmlContent.match(/[\"']display_url[\"']\s*:\s*[\"']([^\"']+)[\"']/i);
    if (jsonMatch && jsonMatch[1] && isValidImageUrl(jsonMatch[1])) {
        return jsonMatch[1];
    }

    // Strategy 3: Any CDN URL — regex sweep, then filter strictly
    const regexNormal  = /https?:\/\/[^"'`\s<>]+(?:cdninstagram|fbcdn)[^"'`\s<>]*/gi;

    const allMatches = htmlContent.match(regexNormal) || [];
    const uniqueUrls = [...new Set(allMatches)];

    // First pass: prefer high-res post images with signature tokens
    const best = uniqueUrls.filter(isValidImageUrl);
    if (best.length > 0) return best[0];

    return null;
}


// Strip residual escape backslashes that survive the JSON-in-JSON decoding.
// Sidecar URLs arrive as e.g. https:\\\/\\\/scontent...
function cleanInstagramUrl(url) {
    return url ? url.replace(/\\+/g, '') : url;
}

// Lighter validator for URLs parsed from the trusted sidecar JSON region.
// isValidImageUrl's strict signature-param rule is meant for the noisy raw
// HTML sweep, where static assets and avatars are common false positives.
function isValidSidecarImageUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    if (!lower.includes('cdninstagram.com') && !lower.includes('fbcdn.net')) return false;
    if (lower.includes('/rsrc.php')) return false;
    if (lower.includes('static.cdninstagram.com')) return false;
    if (/\.(js|css|ico|woff|woff2|ttf|svg)(\?|$)/.test(lower)) return false;
    if (lower.includes('t51.2885-19')) return false;
    return true;
}

// Carousel posts expose every slide inside an "edge_sidecar_to_children"
// JSON blob embedded in the /embed/ HTML. Nodes appear in carousel order as
//   \"shortcode\":\"X\",\"is_video\":false,\"display_url\":\"...\"
// and video slides additionally carry \"video_url\":\"...\".
function parseSidecarImages(rawHtmlContent) {
    if (!rawHtmlContent || rawHtmlContent.indexOf('edge_sidecar_to_children') === -1) return [];

    // Un-nest the double-encoded JSON (\" -> " and \\ -> \) on top of the
    // unicode/slash/html-entity decode that extractInstagramImage already does.
    const htmlContent = decodeUnicode(rawHtmlContent)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

    const nodeRegex = /"shortcode":"([A-Za-z0-9_-]+)","is_video":(true|false),"display_url":"([^"]+)"/g;

    const items = [];
    const seenUrls = new Set();
    let match;
    while ((match = nodeRegex.exec(htmlContent)) !== null) {
        const isVideo = match[2] === 'true';
        const thumb = cleanInstagramUrl(match[3]);
        if (!isValidSidecarImageUrl(thumb) || seenUrls.has(thumb)) continue;
        seenUrls.add(thumb);

        const item = { type: isVideo ? 'video' : 'photo', thumb };
        if (isVideo) {
            // video_url lives in the same node after display_url. Search up to
            // the NEXT node boundary instead of a fixed window — large video
            // metadata (e.g. dash manifests) can push video_url far away.
            const searchStart = match.index + match[0].length;
            const rest = htmlContent.slice(searchStart);
            let nodeEnd = rest.search(/"shortcode":"|"is_video":/);
            if (nodeEnd === -1) nodeEnd = rest.length;
            const videoMatch = rest.slice(0, nodeEnd).match(/"video_url":"([^"]+)"/);
            const videoUrl = videoMatch ? cleanInstagramUrl(videoMatch[1]) : null;
            if (!videoUrl || !(videoUrl.includes('cdninstagram.com') || videoUrl.includes('fbcdn.net'))) continue;
            item.url = videoUrl;
        } else {
            item.url = thumb;
        }
        items.push(item);
    }
    return items;
}

// Full extraction used by every HTML-scraping strategy: prefer the ordered
// sidecar slides, then any single-video node (reels), then legacy heuristics.
function extractAllImages(rawHtmlContent) {
    const sidecarItems = parseSidecarImages(rawHtmlContent);
    if (sidecarItems.length > 0) return sidecarItems;

    // Single media posts (reels, one-off videos) carry no sidecar blob, but
    // their contextJSON node has the same shape the sidecar scan knows —
    // "shortcode":"X","is_video":true,"display_url":… — with video_url in
    // the node window. Recover it directly so reels resolve as videos.
    const videoItem = parseSingleVideoPost(rawHtmlContent);
    if (videoItem) return [videoItem];

    const legacyUrl = extractInstagramImage(rawHtmlContent);
    return legacyUrl ? [{ type: 'photo', thumb: legacyUrl, url: legacyUrl }] : [];
}

// Single-video pass: the parse contract mirrors parseSidecarImages exactly
// (same decode, same validators, same bounded video_url window) minus the
// edge_sidecar_to_children gate. Ignores is_video:false singles — those stay
// with the legacy photo heuristics. Returns one item or null.
function parseSingleVideoPost(rawHtmlContent) {
    if (!rawHtmlContent) return null;

    // Decode FIRST: the contextJSON blob stores escaped quotes
    // (\"is_video\":true), so a pre-decode gate on the unescaped substring
    // would never fire on real pages.
    const htmlContent = decodeUnicode(rawHtmlContent)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');

    if (htmlContent.indexOf('"is_video":true') === -1 && htmlContent.indexOf('"is_video": true') === -1) return null;

    // 1. Try standard shortcode + is_video + display_url pattern
    let match = /"shortcode"\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*"is_video"\s*:\s*true\s*,\s*"display_url"\s*:\s*"([^"]+)"/.exec(htmlContent);
    let thumb = null;
    let rest = '';

    if (match) {
        thumb = cleanInstagramUrl(match[2]);
        rest = htmlContent.slice(match.index + match[0].length);
    } else {
        // Fallback: look for is_video: true and display_url separately
        const displayMatch = /"display_url"\s*:\s*"([^"]+)"/.exec(htmlContent);
        if (displayMatch) {
            thumb = cleanInstagramUrl(displayMatch[1]);
        }
        const isVideoIdx = htmlContent.indexOf('"is_video":true') !== -1 
            ? htmlContent.indexOf('"is_video":true') 
            : htmlContent.indexOf('"is_video": true');
        rest = isVideoIdx !== -1 ? htmlContent.slice(isVideoIdx) : htmlContent;
    }

    if (!thumb || !isValidSidecarImageUrl(thumb)) {
        thumb = extractInstagramImage(rawHtmlContent);
        if (!thumb) return null;
    }

    // Identical window rule to the sidecar scan: heavy video metadata
    // (dash manifests) can push video_url far past display_url.
    let nodeEnd = rest.search(/"shortcode"\s*:\s*"|"is_video"\s*:\s*/);
    if (nodeEnd === -1) nodeEnd = rest.length;
    const videoMatch = rest.slice(0, nodeEnd).match(/"video_url"\s*:\s*"([^"]+)"/);
    let videoUrl = videoMatch ? cleanInstagramUrl(videoMatch[1]) : null;

    // Fallback: if video_url is not in the immediate slice, search the decoded content globally
    if (!videoUrl) {
        const globalVideoMatch = htmlContent.match(/"video_url"\s*:\s*"([^"]+)"/);
        if (globalVideoMatch) {
            videoUrl = cleanInstagramUrl(globalVideoMatch[1]);
        }
    }

    if (!videoUrl || !(videoUrl.includes('cdninstagram.com') || videoUrl.includes('fbcdn.net'))) return null;

    return { type: 'video', thumb, url: videoUrl };
}


function getShortcode(url) {
    if (!url) return null;
    url = url.trim();

    // 1) Match Instagram path patterns:
    // /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE, /reels/videos/CODE, /share/p/CODE, /share/reel/CODE, /share/reels/CODE, etc.
    const match = url.match(/(?:p|reels?|tv)(?:\/videos?)?\/([A-Za-z0-9_-]+)/i)
        || url.match(/(?:share|reels)\/([A-Za-z0-9_-]+)/i);
    if (match && match[1]) {
        return match[1];
    }

    // 2) If it is just a shortcode of typical Instagram length (5 to 25 characters)
    // and consists of valid alphanumeric + underscore/hyphen characters without slashes or dots
    if (/^[A-Za-z0-9_-]{5,25}$/.test(url)) {
        return url;
    }

    return null;
}

async function fetchFromProxy(proxyUrl, isAllOrigins, timeoutMs = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        if (isAllOrigins) {
            const json = await res.json();
            if (json && json.contents) return json.contents;
            throw new Error('Invalid AllOrigins response');
        }
        return await res.text();
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}


// Custom AggregateError fallback for older browsers
if (typeof AggregateError === 'undefined') {
    class AggregateError extends Error {
        constructor(errors, message = '') {
            super(message);
            this.errors = errors;
            this.name = 'AggregateError';
        }
    }
    window.AggregateError = AggregateError;
}

// Robust Promise.any fallback that works in all browsers
const promiseAny = Promise.any ? Promise.any.bind(Promise) : function(promises) {
    return new Promise((resolve, reject) => {
        let errors = [];
        let rejectedCount = 0;
        if (promises.length === 0) {
            reject(new AggregateError([], "No promises passed"));
            return;
        }
        promises.forEach((p, i) => {
            Promise.resolve(p).then(resolve).catch(err => {
                errors[i] = err;
                rejectedCount++;
                if (rejectedCount === promises.length) {
                    reject(new AggregateError(errors, "All promises rejected"));
                }
            });
        });
    });
};

function getProxiedImageUrl(imageUrl, winningProxy) {
    if (!imageUrl) return '';
    if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
        return imageUrl;
    }
    if (winningProxy === 'AllOrigins Raw' || winningProxy === 'AllOrigins Get' || winningProxy === 'AllOrigins Raw HTML' || winningProxy === 'AllOrigins Get HTML' || winningProxy === 'AllOrigins Media' || winningProxy === 'AllOrigins Raw Media') {
        return `https://api.allorigins.win/raw?url=${encodeURIComponent(imageUrl)}`;
    } else if (winningProxy === 'CorsProxy.io' || winningProxy === 'CorsProxy.io HTML') {
        return `https://corsproxy.io/?url=${encodeURIComponent(imageUrl)}`;
    } else if (winningProxy === 'Codetabs' || winningProxy === 'Codetabs HTML') {
        return `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(imageUrl)}`;
    } else if (winningProxy === 'OwnWorker HTML') {
        // Instagram CDN URLs signed by our worker's embed are hotlinkable AND
        // CORS-open (verified live: ACAO * on both image/webp and video/mp4),
        // so they work directly in <img>, <video>, fetch() and canvas export.
        return imageUrl;
    }
    // Fallback: try allorigins first, then corsproxy
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(imageUrl)}`;
}


// Turns a raw race result into the normalized { items, winningProxy, coverOnly }
// shape consumed by the UI layer, wrapping cover-only blobs as a 1-slide list.
function normalizeResult(result) {
    if (result.items && result.items.length > 0) {
        return { items: result.items, winningProxy: result.proxyName, coverOnly: !!result.coverOnly };
    }
    return {
        items: [{ type: 'photo', thumb: result.coverBlobUrl, url: result.coverBlobUrl }],
        winningProxy: result.proxyName,
        coverOnly: true
    };
}

async function getPostHtmlAndImage(shortcode) {
    const targetUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
    const mediaUrl = `https://www.instagram.com/p/${shortcode}/media?size=l`;

    // Primary strategy: Weserv Media Direct (very fast, reliable, bypasses
    // cookie wall). It can only ever return the cover slide, so the result is
    // flagged cover-only and the full carousel gets enumerated in background.
    const primaryPromise = (async () => {
        const startTime = Date.now();
        const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(mediaUrl)}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const blob = await res.blob();
        if (blob && blob.size > 2048 && blob.type.startsWith('image/')) {
            const latency = Date.now() - startTime;
            console.log(`[Proxy Success] Weserv Media Direct resolved in ${latency}ms`);
            const dataUrl = URL.createObjectURL(blob);
            return { proxyName: 'Weserv Media', coverBlobUrl: dataUrl, items: [], coverOnly: true };
        }
        throw new Error('Weserv Media did not return a valid image blob');
    })();

    // Backup strategies: media endpoints resolve a cover-only slide list, the
    // HTML scrapers parse the embed page and resolve the FULL ordered slides.
    const runBackupStrategies = () => {
        console.log('Weserv took longer than 600ms or failed. Launching backup parallel proxy race...');
        const backupPromises = [
            // Direct Media fetch via AllOrigins JSON (cover-only)
            new Promise(async (resolve, reject) => {
                const startTime = Date.now();
                try {
                    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(mediaUrl)}`;
                    const res = await fetch(proxyUrl);
                    if (!res.ok) throw new Error(`Status ${res.status}`);
                    const json = await res.json();

                    let coverUrl = null;
                    if (json && json.status && json.status.url) {
                        const cdnUrl = json.status.url;
                        if (cdnUrl.includes('cdninstagram.com') || cdnUrl.includes('fbcdn.net')) {
                            coverUrl = cdnUrl;
                        }
                    }
                    if (!coverUrl && json && json.contents && json.contents.startsWith('data:image/')) {
                        coverUrl = json.contents;
                    }
                    if (!coverUrl) throw new Error('AllOrigins Media did not return image data');

                    const latency = Date.now() - startTime;
                    console.log(`[Proxy Success] AllOrigins Media Direct resolved in ${latency}ms`);
                    resolve({
                        proxyName: 'AllOrigins Media',
                        items: [{ type: 'photo', thumb: coverUrl, url: coverUrl }],
                        coverOnly: true
                    });
                } catch (e) {
                    console.warn(`[Proxy Error] AllOrigins Media failed: ${e.message}`);
                    reject(e);
                }
            }),

            // Direct Media fetch via AllOrigins Raw (cover-only)
            new Promise(async (resolve, reject) => {
                const startTime = Date.now();
                try {
                    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(mediaUrl)}`;
                    const res = await fetch(proxyUrl);
                    if (!res.ok) throw new Error(`Status ${res.status}`);
                    const blob = await res.blob();
                    if (blob && blob.size > 2048 && blob.type.startsWith('image/')) {
                        const latency = Date.now() - startTime;
                        console.log(`[Proxy Success] AllOrigins Raw Media responded in ${latency}ms`);
                        const dataUrl = URL.createObjectURL(blob);
                        resolve({
                            proxyName: 'AllOrigins Raw Media',
                            items: [{ type: 'photo', thumb: dataUrl, url: dataUrl }],
                            coverOnly: true
                        });
                        return;
                    }
                    throw new Error('AllOrigins Raw Media did not return a valid image blob');
                } catch (e) {
                    console.warn(`[Proxy Error] AllOrigins Raw Media failed: ${e.message}`);
                    reject(e);
                }
            }),

            // Race other proxies for the embed HTML page (full slide list)
            ...embedHtmlProxyConfigs(targetUrl, shortcode).map(proxy => {
                return new Promise(async (resolve, reject) => {
                    const startTime = Date.now();
                    try {
                        const html = await fetchFromProxy(proxy.url, proxy.isAllOrigins);
                        if (html && html.trim().length > 0) {
                            const items = extractAllImages(html);
                            if (items.length > 0) {
                                const latency = Date.now() - startTime;
                                console.log(`[Proxy Success] ${proxy.name} responded in ${latency}ms${items.length > 1 ? ` (${items.length} slides)` : ''}`);
                                resolve({ proxyName: proxy.name, items, coverOnly: false });
                                return;
                            }
                        }
                        reject(new Error(`${proxy.name} returned HTML, but no image URL could be parsed`));
                    } catch (e) {
                        console.warn(`[Proxy Error] ${proxy.name} failed: ${e.message}`);
                        reject(e);
                    }
                });
            })
        ];
        return promiseAny(backupPromises);
    };

    // Staggered race logic:
    // Try primary Weserv first. If it finishes within 600ms, return immediately.
    // Otherwise, trigger the backup race and race it against the still-running primary Weserv.
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('Primary timeout'));
        }, 600);
    });

    try {
        const result = await Promise.race([primaryPromise, timeoutPromise]);
        return normalizeResult(result);
    } catch (err) {
        if (err.message === 'Primary timeout') {
            const backupPromiseObj = runBackupStrategies();
            try {
                const result = await promiseAny([primaryPromise, backupPromiseObj]);
                return normalizeResult(result);
            } catch (backupErr) {
                console.error("All proxies failed (including backups):", backupErr.errors);
                throw new Error("Could not retrieve image content. Please verify the link is correct and try again.");
            }
        } else {
            console.warn(`[Proxy Warning] Primary Weserv failed immediately: ${err.message}`);
            try {
                const result = await runBackupStrategies();
                return normalizeResult(result);
            } catch (backupErr) {
                console.error("All proxies failed:", backupErr.errors);
                throw new Error("Could not retrieve image content. Please verify the link is correct and try again.");
            }
        }
    }
}

// Global state variables
let galleryItems = [];            // ordered slides of the current post (photos + videos)
let selectedIndex = 0;            // slide currently shown in the main viewer
let winningProxyName = null;
let currentShortcode = null;
const imageBlobCache = new Map(); // item.url -> pre-fetched blob URL for instant downloads

// Shared inline icon markup so buttons, tray thumbnails and bulk button all
// reuse one definition.
const DOWNLOAD_ARROW_SVG = `
    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>`;
const DOWNLOAD_ARROW_MINI_SVG = '<svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>';

function setDownloadReadyLabel(label = 'DOWNLOAD PHOTO') {
    const btn = document.getElementById('download-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = `${DOWNLOAD_ARROW_SVG}
        <span>${label}</span>`;
}

function setDownloadButtonLoading(label = 'Resolving Download Link...') {
    const btn = document.getElementById('download-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>${label}</span>
    `;
}

function revokeAllCachedBlobs() {
    for (const blobUrl of imageBlobCache.values()) URL.revokeObjectURL(blobUrl);
    imageBlobCache.clear();
}

// ── Self-hosted Instagram relay (see worker/README.md) ─────────────────────
// Deploy worker/ig-embed-worker.js to Cloudflare (free, ~5 minutes) and paste
// your worker URL below. When set, it becomes the PRIMARY slide source and all
// volunteer proxies are kept as automatic fallbacks. Empty = app acts exactly
// as before.
const OWN_WORKER_BASE = ''; // self-hosted relay (deploy steps: worker/README.md) — paste YOUR worker URL here
// PR convention: the repo ships OWN_WORKER_BASE as ''. A deployment arms the
// relay by pasting a URL above OR by opening the site with ?worker=<url> —
// this runtime fallback reads it, enabling zero-code demos on any hosting.
const runtimeWorkerBase = (() => {
    try {
        const fromUrl = new URLSearchParams(location.search).get('worker') || '';
        return /^https?:\/\/[a-z0-9.:-]+([\/?].*)?$/i.test(fromUrl) ? fromUrl : '';
    } catch (e) { return ''; } // non-browser environment (no location): stay inert
})();
// config.js fallback: static hosting has no environment variables, so a
// deployment may set window.IG_WORKER_URL in that file to arm the relay by
// default on this site — no source edits, and the file ships inert upstream.
const persistedWorkerBase = (() => {
    try {
        const fromConfig = typeof window !== 'undefined' && typeof window.IG_WORKER_URL === 'string' ? window.IG_WORKER_URL : '';
        return /^https?:\/\/[a-z0-9.:-]+([\/?].*)?$/i.test(fromConfig) ? fromConfig : '';
    } catch (e) { return ''; } // non-browser environment (no window): stay inert
})();
// Baked constant wins over live overrides; the ?worker= param (a deliberate
// per-visit demo override) beats the site's config-file default.
const effectiveWorkerBase = OWN_WORKER_BASE || runtimeWorkerBase || persistedWorkerBase;

// The HTML-scraping proxies, shared by the backup race and carousel enrichment.
function embedHtmlProxyConfigs(targetUrl, shortcode) {
    const configs = [
        { name: 'AllOrigins Raw HTML', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, isAllOrigins: false },
        { name: 'CorsProxy.io HTML',   url: `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,           isAllOrigins: false },
        { name: 'AllOrigins Get HTML', url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,   isAllOrigins: true  },
        { name: 'Codetabs HTML',       url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, isAllOrigins: false }
    ];
    if (effectiveWorkerBase) {
        // Yours goes first: fast, cached per post, immune to volunteer outages.
        configs.unshift({
            name: 'OwnWorker HTML',
            url: `${effectiveWorkerBase}/?shortcode=${encodeURIComponent(shortcode || '')}`,
            isAllOrigins: false
        });
    }
    return configs;
}

// ── Carousel gallery UI ────────────────────────────────────────────────────

// Show/hide tray, arrows, counter and the bulk button. Single-slide posts keep
// the exact pre-carousel UI, with no extra chrome at all.
function setGalleryChrome(slideCount) {
    const multi = slideCount > 1;

    const tray = document.getElementById('gallery-tray');
    if (tray) tray.classList.toggle('hidden', !multi);

    ['carousel-prev', 'carousel-next', 'carousel-counter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !multi);
    });

    const allBtn = document.getElementById('download-all-btn');
    if (allBtn) {
        allBtn.classList.toggle('hidden', !multi);
        allBtn.disabled = false;
        if (multi) {
            allBtn.innerHTML = `${DOWNLOAD_ARROW_SVG}
                <span>DOWNLOAD ALL (${slideCount})</span>`;
        }
    }
}

function renderGallery() {
    const thumbs = document.getElementById('gallery-thumbs');
    setGalleryChrome(galleryItems.length);
    if (!thumbs || galleryItems.length <= 1) return;

    thumbs.innerHTML = galleryItems.map((item, index) => {
        const selected = index === selectedIndex;
        const borderClass = selected ? 'border-instagram-magenta' : 'border-instagram-border hover:border-gray-400';
        const thumbSrc = getProxiedImageUrl(item.thumb, winningProxyName);
        // Video slides get a play badge; EVERY slide carries its own mini
        // download button, honoring "separate button per image".
        const badge = item.type === 'video' ? `
            <span class="absolute bottom-1 left-1 bg-instagram-dark/80 rounded-full p-1">
                <svg class="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            </span>` : '';
        const miniDownload = `
            <span role="button" title="Download slide ${index + 1}" class="absolute bottom-1 right-1 bg-instagram-dark/80 hover:bg-instagram-magenta rounded-full p-1 cursor-pointer transition-colors duration-200" onclick="event.stopPropagation(); downloadItem(${index})">
                ${DOWNLOAD_ARROW_MINI_SVG}
            </span>`;
        return `<button type="button" onclick="selectImage(${index})" title="Slide ${index + 1}" class="relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 ${borderClass} transition-all duration-200 focus:outline-none">
            <img src="${thumbSrc}" alt="Slide ${index + 1}" class="w-full h-full object-cover" loading="lazy" />${badge}${miniDownload}
        </button>`;
    }).join('');

    updateCarouselCounter();
}

function updateCarouselCounter() {
    const counter = document.getElementById('carousel-counter');
    if (!counter || galleryItems.length === 0) return;
    counter.textContent = `${selectedIndex + 1}/${galleryItems.length}`;
}

function stepCarousel(delta) {
    if (galleryItems.length === 0) return;
    selectImage(selectedIndex + delta);
}

function selectImage(index) {
    if (galleryItems.length === 0) return;
    selectedIndex = ((index % galleryItems.length) + galleryItems.length) % galleryItems.length;
    const item = galleryItems[selectedIndex];

    updateCarouselCounter();

    // Refresh the selected-thumbnail highlight without re-rendering images
    document.querySelectorAll('#gallery-thumbs > button').forEach((el, i) => {
        el.classList.toggle('border-instagram-magenta', i === selectedIndex);
        el.classList.toggle('border-instagram-border', i !== selectedIndex);
    });

    showItem(item);
    setDownloadReadyLabel(item.type === 'video' ? 'DOWNLOAD VIDEO (.MP4)' : 'DOWNLOAD PHOTO');
    if (item.type === 'photo') prefetchItem(item);
}

// Puts one slide into the main viewer: <img> for photos, <video> for videos.
// The embed iframe is always the reliable cross-origin fallback underneath.
function showItem(item) {
    const imgPreview   = document.getElementById('imgpreview');
    const embedIframe  = document.getElementById('embed-iframe');
    const previewLoader = document.getElementById('preview-loader');
    const wantedIndex = selectedIndex;
    const startShortcode = currentShortcode;

    if (item.type === 'video') {
        if (imgPreview) { imgPreview.classList.add('hidden'); imgPreview.removeAttribute('src'); }
        if (embedIframe) embedIframe.classList.add('hidden');
        setVideoPreviewActive(item, wantedIndex, startShortcode);
        return;
    }

    clearVideoPreview();
    if (!imgPreview) return;

    imgPreview.onload = () => {
        if (currentShortcode !== startShortcode || selectedIndex !== wantedIndex) return;
        if (previewLoader) previewLoader.classList.add('hidden');
        imgPreview.classList.remove('hidden');
        if (embedIframe) embedIframe.classList.add('hidden');
    };
    imgPreview.onerror = () => {
        if (currentShortcode !== startShortcode) return;
        if (previewLoader) previewLoader.classList.add('hidden');
        // The resolved image failed to load (expired CDN signature, hotlink
        // block) — fall back to the native iframe embed, mirroring the video
        // path, so the viewer is never left blank.
        if (embedIframe) {
            embedIframe.classList.remove('hidden');
            embedIframe.src = `https://www.instagram.com/p/${startShortcode}/embed/`;
        }
    };
    imgPreview.src = getProxiedImageUrl(item.thumb, winningProxyName);
}

function setVideoPreviewActive(item, wantedIndex, startShortcode) {
    const videoEl = document.getElementById('video-preview');
    if (!videoEl) return;

    const previewLoader = document.getElementById('preview-loader');
    const embedIframe = document.getElementById('embed-iframe');

    videoEl.onerror = () => {
        if (currentShortcode !== startShortcode || selectedIndex !== wantedIndex) return;
        console.warn('[Preview] Proxied video failed to load; falling back to the embed iframe');
        clearVideoPreview();
        if (embedIframe) {
            embedIframe.classList.remove('hidden');
            embedIframe.src = `https://www.instagram.com/p/${startShortcode}/embed/`;
        }
        if (previewLoader) previewLoader.classList.add('hidden');
    };
    videoEl.onloadeddata = () => {
        if (currentShortcode !== startShortcode || selectedIndex !== wantedIndex) return;
        if (previewLoader) previewLoader.classList.add('hidden');
    };

    videoEl.src = getProxiedImageUrl(item.url, winningProxyName);
    videoEl.classList.remove('hidden');

    // Cross-origin <video> may never fire loadeddata reliably — mirror the
    // iframe pattern and hide the loader after a 3s grace period.
    setTimeout(() => {
        if (currentShortcode === startShortcode && selectedIndex === wantedIndex && previewLoader) {
            previewLoader.classList.add('hidden');
        }
    }, 3000);
}

function clearVideoPreview() {
    const videoEl = document.getElementById('video-preview');
    if (!videoEl) return;
    videoEl.onerror = null;
    videoEl.onloadeddata = null;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load(); // flush any buffered media for the removed src
    videoEl.classList.add('hidden');
}

// Shared "get me the bytes" helper: abort-timed fetch that rejects on a bad
// status or a suspiciously small payload. Preview prefetching and the download
// strategies share the same contract, so the timeout/ok/size logic lives here.
async function fetchBlobWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (blob.size < 2048) throw new Error(`Too small (${blob.size}B)`);
        return blob;
    } finally {
        clearTimeout(tid);
    }
}

// Pre-fetch the big blob NOW while the user is looking at the preview, so the
// Download click is instant. Videos are not pre-fetched (they are large).
function prefetchItem(item) {
    if (imageBlobCache.has(item.url)) return;
    if (item.url.startsWith('data:') || item.url.startsWith('blob:')) {
        imageBlobCache.set(item.url, item.url);
        console.log('[Cache] Slide is already a data/blob URL, skipping pre-fetch');
        return;
    }

    const proxiedImgUrl = getProxiedImageUrl(item.url, winningProxyName);
    const shortcodeAtStart = currentShortcode;
    (async () => {
        try {
            const blob = await fetchBlobWithTimeout(proxiedImgUrl, 15000);
            // Accept the cache entry only while the user still wants this post
            if (currentShortcode === shortcodeAtStart) {
                const extMatch = item.url.match(/\.(jpg|jpeg|png|webp)/i);
                const mime = (extMatch && extMatch[1].toLowerCase() === 'png') ? 'image/png' : 'image/jpeg';
                const finalBlob = blob.type.startsWith('image/')
                    ? blob
                    : new Blob([blob], { type: mime });
                imageBlobCache.set(item.url, URL.createObjectURL(finalBlob));
                console.log(`[Pre-fetch] Image blob cached (${Math.round(finalBlob.size / 1024)}KB, type: ${finalBlob.type})`);
            }
        } catch (e) {
            console.warn('[Pre-fetch] Could not pre-cache blob:', e.message);
        }
    })();
}

// Background enumeration for posts where a media endpoint could only resolve
// the cover image. Races the HTML-scraping proxies and returns the slide list
// when strictly more slides were found — or when the scrape retrofits a photo
// cover into its video (single media posts, same success shape).
async function enrichCarouselItems(shortcode, knownCount, knownHasVideo = false) {
    const targetUrl = `https://www.instagram.com/p/${shortcode}/embed/`;

    const attemptScrape = async () => {
        return await promiseAny(embedHtmlProxyConfigs(targetUrl, shortcode).map(proxy => {
            return new Promise(async (resolve, reject) => {
                try {
                    const html = await fetchFromProxy(proxy.url, proxy.isAllOrigins, 10000);
                    if (html && html.trim().length > 0) {
                        const items = extractAllImages(html);
                        if (items.length > 0) {
                            resolve({ items, proxyName: proxy.name });
                            return;
                        }
                    }
                    reject(new Error(`${proxy.name}: no slides parseable`));
                } catch (e) {
                    reject(e);
                }
            });
        }));
    };

    // A SUCCESSFUL scrape is ground truth for the post's slide list — if it
    // reports the same count as the cover-only result, retrying cannot add
    // slides, so stop immediately. EXCEPT the single-media case: a video node
    // and its photo cover share the SAME count (reels arrive poster-only from
    // the media endpoint), so an equal count must still upgrade when the
    // scrape found a video the cover lacked. Retries only pay off when ALL
    // scrapers failed (transient upstream outage, e.g. an echo of a 522).
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const scraped = await attemptScrape();
            const upgradesKind = scraped.items.length === knownCount
                && !knownHasVideo
                && scraped.items.some(item => item.type === 'video');
            if (scraped.items.length > knownCount || upgradesKind) {
                console.log(`[Carousel] Enrichment via ${scraped.proxyName}: ${scraped.items.length} slides total`);
                // Pure result: the CALLER applies proxy bookkeeping after its
                // staleness check, so a late enrich can never repoint a page
                // the user has already moved away from.
                return { items: scraped.items, proxyName: scraped.proxyName };
            }
            console.log(`[Carousel] Enrichment scrape (${scraped.proxyName}) agrees with ${knownCount} slide(s); no upgrade`);
            return null;
        } catch (e) {
            if (attempt < 2) {
                console.warn('[Carousel] Enrichment pass 1 failed; retrying once in 3s');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    console.warn('[Carousel] Enrichment unavailable; keeping the resolved cover');
    return null;
}

// The URL-entry row only matters before a post is resolved; the result card
// with START OVER owns the screen afterward.
function setUrlEntryVisible(visible) {
    const form = document.getElementById('form-container');
    if (form) form.classList.toggle('hidden', !visible);
}

async function fetchInstaPhoto() {
    if (!navigator.onLine) {
        showError('You appear to be offline. Check your connection and try again.');
        return;
    }

    const urlInput = document.getElementById('instalink').value.trim();
    if (!urlInput) {
        showError('Please enter an Instagram post or reel URL.');
        return;
    }

    const shortcode = getShortcode(urlInput);
    if (!shortcode) {
        showError('Invalid Instagram URL. Please enter a valid post or reel URL (e.g. /reel/SHORTCODE/ or /p/SHORTCODE/).');
        return;
    }

    currentShortcode = shortcode;

    // Reset previous states
    hideError();
    setGalleryChrome(0);
    clearVideoPreview();
    galleryItems = [];
    selectedIndex = 0;
    winningProxyName = null;
    revokeAllCachedBlobs();

    const imgPreview   = document.getElementById('imgpreview');
    const embedIframe  = document.getElementById('embed-iframe');
    const previewLoader = document.getElementById('preview-loader');

    // Hide previous preview elements
    if (imgPreview)  { imgPreview.classList.add('hidden'); imgPreview.removeAttribute('src'); }
    if (embedIframe) { embedIframe.classList.add('hidden'); embedIframe.removeAttribute('src'); }
    if (previewLoader) previewLoader.classList.remove('hidden');

    // Show result card immediately
    document.getElementById('result-section').classList.remove('hidden');

    // ── STEP 1: Show iframe embed immediately (no CORS, browser loads it natively) ──
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
    if (embedIframe) {
        embedIframe.classList.remove('hidden');
        embedIframe.src = embedUrl;

        // Hide spinner/loader after a short timeout because cross-origin iframes 
        // may not trigger onload reliably in all browser configurations.
        setTimeout(() => {
            if (currentShortcode === shortcode && previewLoader) {
                previewLoader.classList.add('hidden');
            }
        }, 3000);

        embedIframe.onload = () => {
            if (currentShortcode === shortcode) {
                if (previewLoader) previewLoader.classList.add('hidden');
            }
        };
    }

    // Scroll to result
    document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });

    // ── STEP 2: Try CORS proxies in background for direct downloadable CDN URLs ──
    setDownloadButtonLoading();

    try {
        const { items, winningProxy, coverOnly } = await getPostHtmlAndImage(shortcode);

        // Guard against stale responses if user typed a new URL
        if (currentShortcode !== shortcode) return;

        galleryItems = items;
        winningProxyName = winningProxy;
        console.log(`[Carousel] Resolved ${items.length} slide(s) via ${winningProxy}`);

        renderGallery();
        selectImage(0);
        setUrlEntryVisible(false);

        // Media endpoints can only ever resolve the cover slide — enumerate the
        // full carousel in the background and upgrade the gallery if useful.
        if (coverOnly) {
            enrichCarouselItems(shortcode, items.length, items.some(item => item.type === 'video')).then(enriched => {
                if (!enriched || currentShortcode !== shortcode) return;
                revokeAllCachedBlobs(); // cover blob and stale prefetches are gone
                // Proxy bookkeeping applies HERE — after the staleness check —
                // so previews route through the proxy that produced these slides.
                winningProxyName = enriched.proxyName;
                galleryItems = enriched.items;
                console.log(`[Carousel] Upgraded gallery to ${enriched.items.length} slides after enrichment`);
                renderGallery();
                selectImage(selectedIndex);
            });
        }

    } catch (err) {
        if (currentShortcode !== shortcode) return;

        console.warn('Direct link extraction failed (all proxies blocked):', err.message);

        if (previewLoader) previewLoader.classList.add('hidden');
        // The page still degrades to the embed + media URL — tell the user what
        // degraded instead of silently changing behavior.
        showError('Could not resolve the direct media link through any proxy — showing the Instagram embed instead. Downloads will open the original file in a new tab.');

        // Fallback to the media endpoint without trailing slash (to prevent
        // cookie-based 404 redirects). No tray chrome: the embed iframe stays
        // as the preview and downloads open the URL in a new tab.
        galleryItems = [{
            type: 'photo',
            thumb: `https://www.instagram.com/p/${shortcode}/media?size=l`,
            url: `https://www.instagram.com/p/${shortcode}/media?size=l`
        }];
        selectedIndex = 0;
        setDownloadReadyLabel();
        setUrlEntryVisible(false); // a degraded result is still a result — START OVER owns the screen now
    }
}


async function downloadPhoto() {
    // Main download button always targets the slide shown in the viewer.
    await downloadItem(selectedIndex);
}

// Downloads one slide. Returns true when a download was triggered; false when
// it had to fall back to opening the URL in the download helper tab.
async function downloadItem(index, { silent = false } = {}) {
    const item = galleryItems[index];
    if (!item) return false;

    const downloadBtn = document.getElementById('download-btn');

    // If the proxy race never resolved, the media URL can't be fetched
    // cross-origin — open it in a tab synchronously instead.
    if (!winningProxyName) {
        console.info('[Download] Proxy race failed. Opening media URL in new tab.');
        window.open(item.url, '_blank');
        return false;
    }

    const extMatch = item.url.match(/\.(jpg|jpeg|png|webp)/i);
    const ext = item.type === 'video' ? 'mp4' : (extMatch ? extMatch[1].toLowerCase() : 'jpg');
    const mimeType = item.type === 'video' ? 'video/mp4' : (ext === 'png' ? 'image/png' : 'image/jpeg');
    const filename = galleryItems.length > 1
        ? `instagram_${currentShortcode}_${index + 1}.${ext}`
        : `instagram_${currentShortcode}.${ext}`;

    function triggerUrlDownload(url, name) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ── Strategy 1: use the pre-fetched blob (cached while previewing) ──
    if (imageBlobCache.has(item.url)) {
        console.log('[Download] Using pre-fetched blob URL \u2192 instant download');
        triggerUrlDownload(imageBlobCache.get(item.url), filename);
        return true;
    }

    // Open the helper tab synchronously *before* the async work to bypass the
    // browser's popup blocker — only for direct (non-bulk) user interactions.
    let helperTab = null;
    if (!silent) {
        console.log('[Download] No pre-fetch available. Opening helper tab and starting download...');
        helperTab = window.open('about:blank', '_blank');
        if (downloadBtn) {
            downloadBtn.disabled = true;
            downloadBtn.innerHTML = `
                <svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg> Downloading...
            `;
        }
    }

    // ── Strategy 2: canvas export from the rendered preview (photos only) ──
    if (item.type === 'photo') {
        const canvasSuccess = await tryCanvasExport(item, triggerUrlDownload, filename, mimeType);
        if (canvasSuccess) {
            console.log('[Download] Canvas export succeeded.');
            if (helperTab) helperTab.close();
            if (!silent) setDownloadReadyLabel(galleryItems[selectedIndex].type === 'video' ? 'DOWNLOAD VIDEO (.MP4)' : 'DOWNLOAD PHOTO');
            return true;
        }
    }

    // ── Strategy 3: fresh proxy fetch (videos get a longer timeout) ──
    const proxyList = [
        getProxiedImageUrl(item.url, winningProxyName),
        `https://api.allorigins.win/raw?url=${encodeURIComponent(item.url)}`,
        `https://corsproxy.io/?url=${encodeURIComponent(item.url)}`,
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let downloaded = false;
    const timeoutMs = item.type === 'video' ? 30000 : 8000;
    for (const proxyUrl of proxyList) {
        try {
            const blob = await fetchBlobWithTimeout(proxyUrl, timeoutMs);
            const finalBlob = (blob.type.startsWith('image/') || blob.type.startsWith('video/'))
                ? blob
                : new Blob([blob], { type: mimeType });
            const blobUrl = URL.createObjectURL(finalBlob);
            triggerUrlDownload(blobUrl, filename);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
            downloaded = true;
            console.log(`[Download] Fetched via proxy: ${proxyUrl}`);
            break;
        } catch (e) {
            console.warn(`[Download] Proxy failed (${proxyUrl}):`, e.message);
        }
    }

    // ── Strategy 4: fall back to opening target in the helper tab ──
    if (downloaded) {
        if (helperTab) helperTab.close();
    } else if (!silent) {
        console.info('[Download] All download strategies failed. Directing helper tab to target URL.');
        if (helperTab) {
            helperTab.location.href = item.url;
        } else {
            window.open(item.url, '_blank');
        }
    } else {
        console.warn(`[Download All] Slide ${index + 1}: all download strategies failed.`);
    }

    if (!silent) {
        setDownloadReadyLabel(galleryItems[selectedIndex].type === 'video' ? 'DOWNLOAD VIDEO (.MP4)' : 'DOWNLOAD PHOTO');
    }
    return downloaded;
}

// Canvas re-export: draw the resolved image into a canvas and save that as the
// file. Works even when cross-origin saves are blocked, but only for photos.
function tryCanvasExport(item, triggerUrlDownload, filename, mimeType) {
    return new Promise(resolve => {
        try {
            const testImg = new Image();
            testImg.crossOrigin = 'anonymous';
            testImg.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width  = testImg.naturalWidth  || 1080;
                    canvas.height = testImg.naturalHeight || 1080;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(testImg, 0, 0);
                    canvas.toBlob(blob => {
                        if (blob && blob.size > 1024) {
                            triggerUrlDownload(URL.createObjectURL(blob), filename);
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    }, mimeType, 0.95);
                } catch (e) {
                    console.warn('[Download] Canvas tainted or failed:', e.message);
                    resolve(false);
                }
            };
            testImg.onerror = () => resolve(false);
            setTimeout(() => resolve(false), 8000);
            testImg.src = getProxiedImageUrl(item.url, winningProxyName);
        } catch (e) {
            resolve(false);
        }
    });
}

// Downloads every slide of the current post, one after another.
async function downloadAll() {
    if (galleryItems.length === 0) return;

    // Same proxy-less fallback as single downloads: open the media URL once.
    if (!winningProxyName) {
        console.info('[Download All] Proxy race failed. Opening media URL in new tab.');
        window.open(galleryItems[0].url, '_blank');
        return;
    }

    const allBtn = document.getElementById('download-all-btn');
    const originalHTML = allBtn ? allBtn.innerHTML : '';
    const total = galleryItems.length;
    let succeeded = 0;

    for (let i = 0; i < total; i++) {
        if (allBtn) {
            allBtn.disabled = true;
            allBtn.innerHTML = `
                <svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>DOWNLOADING ${i + 1}/${total}</span>
            `;
        }
        try {
            const ok = await downloadItem(i, { silent: true });
            if (ok) succeeded++;
        } catch (e) {
            // One bad slide must never strand the button in its loading state.
            console.warn(`[Download All] Slide ${i + 1}: unexpected error:`, e.message);
        }
        // Pause between downloads so the browser treats each one as its own
        // "multiple downloads" event instead of dropping them.
        await new Promise(resolve => setTimeout(resolve, 400));
    }

    console.log(`[Download All] ${succeeded}/${total} slides downloaded`);
    if (allBtn) {
        if (succeeded < total) {
            // Skipped slides surface as a brief count instead of being invisible.
            allBtn.innerHTML = `<span>DONE ${succeeded}/${total}</span>`;
            setTimeout(() => {
                allBtn.disabled = false;
                allBtn.innerHTML = originalHTML;
            }, 2500);
        } else {
            allBtn.disabled = false;
            allBtn.innerHTML = originalHTML;
        }
    }
}



function showLoading(isLoading) {
    const loader = document.getElementById('loader');
    const fetchBtn = document.getElementById('fetch-btn');
    
    if (isLoading) {
        loader.classList.remove('hidden');
        fetchBtn.disabled = true;
        fetchBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        loader.classList.add('hidden');
        fetchBtn.disabled = false;
        fetchBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

function showError(msg) {
    const errorEl = document.getElementById('error-message');
    // Defensive: a future markup change must not crash the fetch flow.
    if (!errorEl) return;
    errorEl.querySelector('span:last-child').textContent = msg;
    errorEl.classList.remove('hidden');
}

function hideError() {
    const errorEl = document.getElementById('error-message');
    errorEl.classList.add('hidden');
}

function resetApp() {
    document.getElementById('instalink').value = '';
    document.getElementById('result-section').classList.add('hidden');

    const imgPreview = document.getElementById('imgpreview');
    if (imgPreview) {
        imgPreview.classList.add('hidden');
        imgPreview.removeAttribute('src');
        imgPreview.onload = null;
        imgPreview.onerror = null;
    }

    const embedIframe = document.getElementById('embed-iframe');
    if (embedIframe) {
        embedIframe.classList.add('hidden');
        embedIframe.removeAttribute('src');
        embedIframe.onload = null;
    }

    const previewLoader = document.getElementById('preview-loader');
    if (previewLoader) previewLoader.classList.add('hidden');

    hideError();
    setUrlEntryVisible(true);
    setGalleryChrome(0);
    clearVideoPreview();
    galleryItems = [];
    selectedIndex = 0;
    winningProxyName = null;
    currentShortcode = null;
    revokeAllCachedBlobs();
    setDownloadReadyLabel();
    const input = document.getElementById('instalink');
    if (input) input.focus();
}


