# [Instagram Photo Downloader](https://harsh98trivedi.github.io/Instagram-Photo-Downloader) :fire:

Free, Clean & Simple **Instagram Photo Downloader** for you. :slightly_smiling_face: <br>
Download **Instagram Photos** in high quality with ease.

---

![Instagram Photo Downloader](https://raw.github.com/harsh98trivedi/Instagram-Photo-Downloader/master/images/meta.jpg)

### Features

*   **Tailwind CSS v4 Production Build**: Upgraded from the development CDN to a fully compiled and minified production-ready stylesheet for rapid loading times and no console warnings.
*   **Zero-API Resolution**: Instantly parses full URLs, partial paths, or raw shortcodes (e.g. `DW8OReXiPRl`) to download original high-resolution photos without requiring official Instagram API keys.
*   **Staggered Proxy Racing**: Employs a high-performance proxy architecture that queries the ultra-fast cookieless `Weserv Media` proxy first, only falling back to a parallel race of secondary HTML scraper proxies (like `AllOrigins` and `CorsProxy.io`) if needed. This keeps standard requests lightning-fast and prevents console error spam.
*   **Browser Extension Silence**: Injected listeners to suppress console error pollution caused by third-party browser extensions (like Grammarly override timeouts or uncaught extension messaging errors).
*   **Carousel Support**: Detects multi-image posts and resolves *every* slide — the ordered per-slide data (`edge_sidecar_to_children`) is parsed straight out of the embed page, photos and videos alike.
*   **Gallery Viewer**: Thumbnail tray with prev/next navigation, a position counter (e.g. `2/5`), and play badges on video slides.
*   **Per-Image & Bulk Downloads**: Every slide carries its own download button right on its thumbnail, plus a `DOWNLOAD ALL (N)` bulk button that saves the whole post sequentially.
*   **Self-Hosted Relay (optional, recommended)**: Deploy the bundled one-file Cloudflare Worker (`worker/ig-embed-worker.js`, free tier, walkthrough in `worker/README.md`) so every post type — single, multi-photo, and video slides — resolves through *your own* cached proxy instead of depending on volunteer CORS mirrors.

---

### Tech Stack & Libraries Used

*   [Tailwind CSS v4](https://tailwindcss.com/) — Utility-first styling framework
*   [Outfit Font](https://fonts.google.com/specimen/Outfit) — Modern aesthetic typography
*   [Font Awesome 6](https://fontawesome.com/) — Premium vector iconography
*   [jQuery](http://jquery.com/) — DOM utility helper

---

> License: [GNU General Public License v3.0](https://github.com/harsh98trivedi/YouTube-Thumbnail-Downloader/blob/master/LICENSE.md)

![Instagram Photo Downloader](https://img.shields.io/badge/Instagram-Photo%20Downloader-purple.svg)