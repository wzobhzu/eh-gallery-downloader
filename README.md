# EH Gallery Downloader

A Manifest V3 browser extension (Chrome / Edge / Brave) that downloads every
image of an e-hentai gallery as a single ZIP, **preferring original images**
and **automatically falling back to the normal image** when no original exists
or the original fails to load.

## Features

- On a gallery (`/g/`) or image (`/s/`) page, a small button opens a dedicated
  **downloader tab**. The tab runs independently — you can keep browsing or
  close the gallery tab and the download keeps going.
- The ZIP is **streamed straight to disk** (File System Access API): you pick a
  location once (defaults to your Downloads folder), then each image is written
  as it arrives. Memory stays bounded even for a 2000-image gallery, the file
  is a single ZIP, and there is **no download-shelf spam**. Browsers without the
  API fall back to an in-memory Blob download.
- Walks every paginated page (`?p=0..N`) and collects all image pages.
- Per-image 3-tier fallback ladder:
  1. **Original** (`Download original`, the `fullimg` link) — preferred.
  2. **Normal** image (`#img`, from a Hath@Home node) — when there is no original
     link or the original fetch fails (quota / 509 / non-image).
  3. **Re-fetch from another node** via e-hentai's `nl()` broken-image mechanism.
- **Polite by default** (2 parallel, 400 ms delay) and **stops immediately on
  HTTP 509** (image-limit) instead of hammering, which would only extend a
  temporary block.
- Handles **flagged galleries** (Content Warning) automatically via `nw=session`.
- Works **logged in or as a guest** on e-hentai.org; originals limited by guest
  quota simply fall back to normal images.
- Supports any served format (PNG / WebP / JPEG / GIF).
- ZIP entries named by zero-padded page number to preserve reading order.
- Adjustable parallelism (1–6) and inter-request delay in the downloader tab.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** and select this folder.
4. Be logged in to e-hentai for full-quality originals (guests still work).

> Releases ship a packaged `.zip` of the extension itself. To use it: download,
> extract, then **Load unpacked** the extracted folder. Chrome blocks installing
> `.crx` files from outside the Web Store, so unpacked is the supported path.

Plain JavaScript, zero build — after editing, just hit **Reload** on the
extension card.

## Architecture

| File | Role |
|------|------|
| `manifest.json` | MV3. Permission: `tabs`. `host_permissions`: `e-hentai.org`, `exhentai.org`, `*.hath.network` (match patterns match any port, including Hath nodes on `:2333`). |
| `src/content.js` | Tiny. On a `/g` or `/s` page injects one button that asks the background to open the downloader tab. Nothing stateful lives here. |
| `src/background.js` | Service worker. Opens `download.html` in a new tab with the target URL. That's all. |
| `src/download.html` / `download.js` | The engine, in its own persistent tab. Resolves the gallery, scrapes pages, fetches images, and streams the ZIP to disk. Shows progress, options, and a failure list. |
| `src/scrape.js` | Shared scraping + image-fetch logic (pagination walk, `/s` parsing, fallback ladder, content-warning bypass, ad/nav-link filter, 509 detection, throttle). |
| `src/zip-stream.js` | Streaming ZIP writer (STORE + CRC32) — writes each entry to a sink as bytes arrive, never buffering the whole archive. |
| `src/popup.html` / `popup.js` | Popup: open the downloader for the current page, or for a pasted URL. |

### Why a separate tab + streaming (and one Save dialog)

Running the job in the gallery page's content script ties it to an ephemeral
context: navigating or closing the tab discards progress. Buffering the whole
ZIP is unbounded memory (2000 originals ≈ 4 GB) and hits the 4 GB ZIP offset
limit. The downloader tab is a persistent extension page — unaffected by
gallery-tab navigation — and, with `host_permissions`, fetches e-hentai.org and
`*.hath.network` cross-origin (with cookies, no CORS), then streams each image
into the ZIP on disk. Streaming to disk needs a writable file handle, which the
browser only grants through a Save dialog — that is the single dialog you see,
and it is also why there is no per-file download-shelf spam.

## Notes

- **Quota**: downloading originals consumes your account's image limit / GP.
  Uncheck "prefer originals" to fetch only normal images.
- **Avoiding a block**: e-hentai enforces a per-account/IP image-view limit;
  originals consume far more of it. Defaults are conservative (2 parallel,
  400 ms). On **HTTP 509** the downloader stops and saves the partial ZIP rather
  than hammering. The extension does **not** spoof your IP or evade limits — it
  only behaves politely. For two big galleries, run them one at a time.
- **Re-running** a gallery produces a fresh ZIP; failed pages are simply retried.

## License

MIT — see [LICENSE](LICENSE).
