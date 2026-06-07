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


function getShortcode(url) {
    if (!url) return null;
    url = url.trim();
    // Try matching pattern (e.g. /p/SHORTCODE, /reel/SHORTCODE, /tv/SHORTCODE) first
    const match = url.match(/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
    if (match && match[1]) {
        return match[1];
    }
    // If it is just a shortcode of typical Instagram length (normally 11 characters, but can range from 9 to 15)
    // and consists of valid alphanumeric + underscore/hyphen characters without slashes or dots
    if (/^[A-Za-z0-9_-]{9,15}$/.test(url)) {
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
    }
    // Fallback: try allorigins first, then corsproxy
    return `https://api.allorigins.win/raw?url=${encodeURIComponent(imageUrl)}`;
}

async function getPostHtmlAndImage(shortcode) {
    const targetUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
    const mediaUrl = `https://www.instagram.com/p/${shortcode}/media?size=l`;
    
    // Define the primary strategy: Weserv Media Direct (very fast, reliable, bypasses cookie wall)
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
            return { proxyName: 'Weserv Media', imageUrl: dataUrl };
        }
        throw new Error('Weserv Media did not return a valid image blob');
    })();

    // Define the backup strategies: AllOrigins, CorsProxy, Codetabs
    const runBackupStrategies = () => {
        console.log('Weserv took longer than 600ms or failed. Launching backup parallel proxy race...');
        const backupPromises = [
            // Strategy 2: Direct Media fetch via AllOrigins JSON
            new Promise(async (resolve, reject) => {
                const startTime = Date.now();
                try {
                    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(mediaUrl)}`;
                    const res = await fetch(proxyUrl);
                    if (!res.ok) throw new Error(`Status ${res.status}`);
                    const json = await res.json();
                    
                    if (json && json.status && json.status.url) {
                        const cdnUrl = json.status.url;
                        if (cdnUrl.includes('cdninstagram.com') || cdnUrl.includes('fbcdn.net')) {
                            const latency = Date.now() - startTime;
                            console.log(`[Proxy Success] AllOrigins Media Direct resolved CDN URL in ${latency}ms: ${cdnUrl}`);
                            resolve({ proxyName: 'AllOrigins Media', imageUrl: cdnUrl });
                            return;
                        }
                    }
                    
                    if (json && json.contents && json.contents.startsWith('data:image/')) {
                        const latency = Date.now() - startTime;
                        console.log(`[Proxy Success] AllOrigins Media Direct data URL responded in ${latency}ms`);
                        resolve({ proxyName: 'AllOrigins Media', imageUrl: json.contents });
                        return;
                    }
                    throw new Error('AllOrigins Media did not return image data');
                } catch (e) {
                    console.warn(`[Proxy Error] AllOrigins Media failed: ${e.message}`);
                    reject(e);
                }
            }),

            // Strategy 3: Direct Media fetch via AllOrigins Raw
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
                        resolve({ proxyName: 'AllOrigins Raw Media', imageUrl: dataUrl });
                        return;
                    }
                    throw new Error('AllOrigins Raw Media did not return a valid image blob');
                } catch (e) {
                    console.warn(`[Proxy Error] AllOrigins Raw Media failed: ${e.message}`);
                    reject(e);
                }
            }),

            // Strategy 4: Race other proxies for the embed HTML page
            ...[
                { name: 'AllOrigins Raw HTML', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, isAllOrigins: false },
                { name: 'CorsProxy.io HTML',   url: `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,           isAllOrigins: false },
                { name: 'AllOrigins Get HTML', url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,   isAllOrigins: true  },
                { name: 'Codetabs HTML',       url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, isAllOrigins: false }
            ].map(proxy => {
                return new Promise(async (resolve, reject) => {
                    const startTime = Date.now();
                    try {
                        const html = await fetchFromProxy(proxy.url, proxy.isAllOrigins);
                        if (html && html.trim().length > 0) {
                            const imageUrl = extractInstagramImage(html);
                            if (imageUrl) {
                                const latency = Date.now() - startTime;
                                console.log(`[Proxy Success] ${proxy.name} responded in ${latency}ms`);
                                resolve({ proxyName: proxy.name, imageUrl });
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
        return { imageUrl: result.imageUrl, winningProxy: result.proxyName };
    } catch (err) {
        if (err.message === 'Primary timeout') {
            const backupPromiseObj = runBackupStrategies();
            try {
                const result = await promiseAny([primaryPromise, backupPromiseObj]);
                return { imageUrl: result.imageUrl, winningProxy: result.proxyName };
            } catch (backupErr) {
                console.error("All proxies failed (including backups):", backupErr.errors);
                throw new Error("Could not retrieve image content. Please verify the link is correct and try again.");
            }
        } else {
            console.warn(`[Proxy Warning] Primary Weserv failed immediately: ${err.message}`);
            try {
                const result = await runBackupStrategies();
                return { imageUrl: result.imageUrl, winningProxy: result.proxyName };
            } catch (backupErr) {
                console.error("All proxies failed:", backupErr.errors);
                throw new Error("Could not retrieve image content. Please verify the link is correct and try again.");
            }
        }
    }
}

// Global state variables
let extractedCdnUrl = null;
let winningProxyName = null;
let currentShortcode = null;
let extractedBlobUrl = null;  // Pre-fetched image blob URL for instant download

async function fetchInstaPhoto() {
    const urlInput = document.getElementById('instalink').value.trim();
    if (!urlInput) {
        showError('Please enter an Instagram post URL.');
        return;
    }

    const shortcode = getShortcode(urlInput);
    if (!shortcode) {
        showError('Invalid Instagram URL. Please enter a valid post URL (e.g. /p/SHORTCODE/).');
        return;
    }

    currentShortcode = shortcode;

    // Reset previous states
    hideError();
    extractedCdnUrl = null;
    winningProxyName = null;
    if (extractedBlobUrl) { URL.revokeObjectURL(extractedBlobUrl); extractedBlobUrl = null; }

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

    // ── STEP 2: Try CORS proxies in background for direct downloadable CDN URL ──
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `
            <svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Resolving Download Link...</span>
        `;
    }

    try {
        const { imageUrl, winningProxy } = await getPostHtmlAndImage(shortcode);

        // Guard against stale responses if user typed a new URL
        if (currentShortcode !== shortcode) return;

        extractedCdnUrl = imageUrl;
        winningProxyName = winningProxy;
        const proxiedImgUrl = getProxiedImageUrl(imageUrl, winningProxyName);

        // Show direct img preview on top of (or instead of) iframe
        if (imgPreview) {
            imgPreview.onload = () => {
                if (currentShortcode !== shortcode) return;
                if (previewLoader) previewLoader.classList.add('hidden');
                imgPreview.classList.remove('hidden');
                if (embedIframe) embedIframe.classList.add('hidden');
            };
            imgPreview.onerror = () => {
                if (previewLoader) previewLoader.classList.add('hidden');
            };
            imgPreview.src = proxiedImgUrl;
        }

        // ── Pre-fetch the image blob NOW while user sees the preview ──
        // This means the blob is ready instantly when they click Download.
        // ── Pre-fetch the image blob NOW while user sees the preview ──
        // This means the blob is ready instantly when they click Download.
        if (imageUrl.startsWith('data:') || imageUrl.startsWith('blob:')) {
            extractedBlobUrl = imageUrl;
            console.log('[Cache] Image is already data/blob URL, skipping pre-fetch');
        } else {
            (async () => {
                try {
                    const controller = new AbortController();
                    const tid = setTimeout(() => controller.abort(), 15000);
                    const res = await fetch(proxiedImgUrl, { signal: controller.signal });
                    clearTimeout(tid);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const blob = await res.blob();
                    // Only keep it if it looks like real image data
                    if (blob.size > 2048 && currentShortcode === shortcode) {
                        const extMatch = imageUrl.match(/\.(jpg|jpeg|png|webp)/i);
                        const mime = (extMatch && extMatch[1].toLowerCase() === 'png') ? 'image/png' : 'image/jpeg';
                        const finalBlob = blob.type.startsWith('image/')
                            ? blob
                            : new Blob([blob], { type: mime });
                        extractedBlobUrl = URL.createObjectURL(finalBlob);
                        console.log(`[Pre-fetch] Image blob cached (${Math.round(blob.size/1024)}KB, type: ${blob.type})`);
                    }
                } catch (e) {
                    console.warn('[Pre-fetch] Could not pre-cache blob:', e.message);
                }
            })();
        }

        // Activate download button
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = `
                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>DOWNLOAD PHOTO</span>
            `;
        }

    } catch (err) {
        if (currentShortcode !== shortcode) return;

        console.warn('Direct link extraction failed (all proxies blocked):', err.message);

        if (previewLoader) previewLoader.classList.add('hidden');

        // Fallback to the media endpoint without trailing slash (to prevent cookie-based 404 redirects)
        extractedCdnUrl = `https://www.instagram.com/p/${shortcode}/media?size=l`;

        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = `
                <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>DOWNLOAD PHOTO</span>
            `;
        }
    }
}


async function downloadPhoto() {
    if (!extractedCdnUrl) return;

    const downloadBtn = document.getElementById('download-btn');
    const originalHTML = downloadBtn.innerHTML;

    // If proxy race failed, open the post page in a new tab synchronously (to prevent popup block)
    if (!winningProxyName) {
        console.info('[Download] Proxy race failed. Opening post URL in new tab.');
        window.open(extractedCdnUrl, '_blank');
        return;
    }

    // ── Strategy 1: Use the pre-fetched blob (available if proxy worked during preview load) ──
    const extMatch = extractedCdnUrl.match(/\.(jpg|jpeg|png|webp)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const filename = `instagram_${currentShortcode}.${ext}`;
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    function triggerUrlDownload(url, name) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    if (extractedBlobUrl) {
        console.log('[Download] Using pre-fetched blob URL \u2192 instant download');
        triggerUrlDownload(extractedBlobUrl, filename);
        return;
    }

    // If no pre-fetch is ready, we must open a blank window synchronously *before* the async work 
    // to bypass the browser's popup blocker.
    console.log('[Download] No pre-fetch available. Opening helper tab and starting download...');
    const helperTab = window.open('about:blank', '_blank');

    downloadBtn.disabled = true;
    downloadBtn.innerHTML = `
        <svg class="animate-spin -ml-1 mr-2 h-5 w-5 text-white inline-block" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg> Downloading...
    `;

    // ── Strategy 2: Canvas export from the already-rendered img element ──
    const imgEl = document.getElementById('imgpreview');
    const canvasSuccess = await new Promise(resolve => {
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
            testImg.src = imgEl && imgEl.src ? imgEl.src : '';
        } catch (e) {
            resolve(false);
        }
    });

    if (canvasSuccess) {
        console.log('[Download] Canvas export succeeded.');
        if (helperTab) helperTab.close();
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = originalHTML;
        return;
    }

    // ── Strategy 3: Fresh proxy fetch ──
    const proxiedSrc = getProxiedImageUrl(extractedCdnUrl, winningProxyName);
    const proxyList = [
        proxiedSrc,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(extractedCdnUrl)}`,
        `https://corsproxy.io/?url=${encodeURIComponent(extractedCdnUrl)}`,
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let downloaded = false;
    for (const proxyUrl of proxyList) {
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(tid);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            if (blob.size < 2048) throw new Error(`Too small (${blob.size}B)`);
            const finalBlob = blob.type.startsWith('image/')
                ? blob
                : new Blob([blob], { type: mimeType });
            const blobUrl = URL.createObjectURL(finalBlob);
            triggerUrlDownload(blobUrl, filename);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
            downloaded = true;
            console.log(`[Download] Fetched via proxy: ${proxyUrl}`);
            break;
        } catch (e) {
            console.warn(`[Download] Proxy failed (${proxyUrl}):`, e.message);
        }
    }

    // ── Strategy 4: Fall back to opening target in the helper tab ──
    if (downloaded) {
        if (helperTab) helperTab.close();
    } else {
        console.info('[Download] All download strategies failed. Directing helper tab to target URL.');
        if (helperTab) {
            helperTab.location.href = extractedCdnUrl;
        } else {
            window.open(extractedCdnUrl, '_blank');
        }
    }

    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalHTML;
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
    // Set text of error element
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
    

    
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = `
            <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>DOWNLOAD PHOTO</span>
        `;
    }
    
    hideError();
    extractedCdnUrl = null;
    winningProxyName = null;
    currentShortcode = null;
    if (extractedBlobUrl) { URL.revokeObjectURL(extractedBlobUrl); extractedBlobUrl = null; }
}


