# EH Gallery Downloader

A Manifest V3 browser extension (Chrome / Edge / Brave) that downloads every
image of an e-hentai gallery as a single ZIP, **preferring original images**
and **automatically falling back to the normal image** when no original exists
or the original fails to load. A **bulk manager** extends this to whole search
results, routing each gallery to a torrent (when one is live-seeded) or to the
same image-fetch engine as a fallback — see [Bulk downloading](#bulk-downloading).

## Features

- A **bulk manager** tab can queue many galleries at once — from pasted search
  URLs or `/g/` links — and download each to its own ZIP unattended, using a
  live-seeded torrent when available and falling back to image fetch
  otherwise. See [Bulk downloading](#bulk-downloading).

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

## Bulk downloading

For downloading many galleries at once (e.g. everything matching a search),
use the **bulk manager** instead of the per-gallery button.

### Open the bulk manager

- From the toolbar popup, click **Open bulk manager**.
- Or, on any e-hentai/exhentai search or listing page, click the
  **"Add this search to bulk downloader"** button that appears in the
  bottom-right corner — it opens (or focuses) the manager tab and queues that
  page's URL.

### Queue galleries

Paste one or more URLs into the manager, one per line:

- **Search/listing URLs** — filters are kept verbatim (e.g.
  `https://e-hentai.org/?f_search=Paperhero&f_sft=on&f_sfu=on&f_sfl=on`). The
  manager walks every results page and queues every gallery it finds.
- **`/g/` gallery URLs** — queued directly.

Pick an output folder once (a single folder-picker dialog); every gallery is
then written as its own `<title>.zip` inside it, with no further per-file
dialogs. The manager tab is a persistent dashboard — a table lists every
queued gallery with its route (torrent/image), status, and a progress bar,
updating live as galleries complete.

### Torrent + image hybrid routing

For each gallery, the manager first checks whether qBittorrent is reachable
and the gallery has a live-seeded torrent. If so, it hands the personalized
`.torrent` (issued with your session's cookies) to qBittorrent:

- **Free** — the bytes come from peers, not e-hentai's image servers, so this
  route does **not** consume your account/IP image-view limit.
- **Original quality**, same as the "Download original" link.

Torrents are added to qBittorrent **all at once and download in parallel in
the background** — the manager doesn't wait on any single one before moving
to the next gallery, so image-route galleries and every torrent progress
concurrently. A torrent with no seeders (or that makes no progress for
~5 minutes) is automatically pulled from qBittorrent and falls back to image
fetch. Otherwise — qBittorrent isn't reachable, or the gallery has no
live-seeded torrent — the manager falls back to the same fetch-and-stream-ZIP
path used for single-gallery downloads. This guarantees every gallery
eventually completes by one route or the other.

Set the **"Torrent save folder"** field to the same folder you pick below for
ZIPs to keep every gallery together — torrent galleries save there under a
`<title>` subfolder, matching the ZIP naming. Leave it blank to use
qBittorrent's own default save path.

#### One-time qBittorrent setup

In qBittorrent: **Options -> Web UI**:

1. Enable the Web UI, bind to `127.0.0.1`, port `8080`.
2. Check **"Bypass authentication for clients on localhost"**.
3. Uncheck **"Enable CSRF protection"** and **"Enable Host header validation"**.
4. Set a Web UI username/password (any value) — **qBittorrent 5.x will not
   start the Web UI without one set, even with the localhost bypass enabled.**

`http://127.0.0.1:8080/*` is already declared in the extension's
`host_permissions`; nothing else to configure on the extension side. Torrent
downloads land in qBittorrent's own save path — separate from the folder you
pick for ZIPs in the manager. If qBittorrent isn't reachable, the manager just
uses image fetch for every gallery.

### Handling the image-view limit (HTTP 509)

On a 509 response the manager pauses all in-flight image-route galleries,
waits out a cooldown, and resumes automatically — riding out the limit's
natural regeneration instead of retrying immediately, which would only extend
an escalating soft-ban. Manual **Pause** / **Resume** / **Cancel** are also
available.

### Resuming an interrupted run

The queue (which galleries are pending/done/failed) and each gallery's
assigned ZIP name are persisted, and the chosen output folder is remembered
(its write permission may need re-granting after a browser restart). Each
gallery's ZIP is written under a `.part` name and renamed to its final name
only once fully written, so an interrupted gallery's partial ZIP is never
mistaken for a completed one — press **Start** again to pick up where it left
off. Requires Chromium 111+ (uses `FileSystemFileHandle.move` for the atomic
rename).

### Honest limits

- Originals — via either route — are ultimately bounded by your account/IP
  image-view limit: the torrent route sidesteps it, but a gallery that falls
  back to image fetch still consumes it.
- Not every gallery has a torrent, and not every torrent has live seeders;
  those galleries download via image fetch instead.
- The extension does **not** evade e-hentai's limits: no IP/proxy rotation, no
  multi-account switching. It behaves politely within the site's rules, same
  as the single-gallery downloader.

## Architecture

| File | Role |
|------|------|
| `manifest.json` | MV3. Permissions: `tabs`, `storage`. `host_permissions`: `e-hentai.org`, `exhentai.org`, `*.hath.network` (match patterns match any port, including Hath nodes on `:2333`), `ehtracker.org` (torrent downloads), `127.0.0.1:8080` (qBittorrent Web UI). |
| `src/content.js` | Tiny. On a `/g` or `/s` page injects one button that asks the background to open the downloader tab. Nothing stateful lives here. |
| `src/listing.js` | On any e-hentai/exhentai search/listing page (detected via `table.itg`), injects the "Add this search to bulk downloader" button that sends the page's URL to the background script. |
| `src/background.js` | Service worker. Opens `download.html` for a single gallery, and opens/focuses the persistent `manager.html` tab, queuing a URL into it via `chrome.storage.local` when one is passed. |
| `src/download.html` / `download.js` | The single-gallery engine, in its own persistent tab. Resolves the gallery, scrapes pages, fetches images, and streams the ZIP to disk. Shows progress, options, and a failure list. |
| `src/manager.html` / `manager.js` | The bulk orchestrator: a persistent tab holding the job queue, per-gallery routing (torrent vs. image), the progress dashboard, and the pause/resume/cancel controls. |
| `src/search.js` | Parses e-hentai search/listing pages and walks the `next=` cursor pagination to collect every gallery a search matches. |
| `src/torrents.js` | Parses a gallery's torrent-list page and picks the best live-seeded torrent (highest seed count). |
| `src/qbittorrent.js` | Thin client for qBittorrent's local Web API (`127.0.0.1:8080`): checks reachability, adds a torrent, polls its progress, deletes it if the manager falls back to image fetch. |
| `src/output.js` | Bulk-mode output handling: the one-time folder picker, a per-gallery ZIP sink, and persisting/restoring the folder handle (IndexedDB) so a resumed session can reuse it without re-picking. |
| `src/queue.js` | The persisted bulk job model — the list of queued galleries and each one's route/status/assigned ZIP name — so a run can resume after the tab or browser closes. |
| `src/pause.js` | The shared pause gate for bulk mode: unifies manual Pause and the automatic HTTP 509 cooldown so every in-flight worker checks the same state. |
| `src/scrape.js` | Shared scraping + image-fetch logic (pagination walk, `/s` parsing, fallback ladder, content-warning bypass, ad/nav-link filter, 509 detection, throttle). |
| `src/zip-stream.js` | Streaming ZIP writer (STORE + CRC32) — writes each entry to a sink as bytes arrive, never buffering the whole archive. |
| `src/popup.html` / `popup.js` | Popup: open the downloader for the current page or for a pasted URL, or open the bulk manager. |

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
- **Retries**: after the first pass, pages that failed (transient node/network
  errors) are automatically retried for up to 2 more rounds, with a short
  backoff, and merged into the same ZIP. Genuinely missing pages are reported at
  the end; re-running the gallery tries them once more. Retries are skipped on a
  509 (quota) — the job stops instead of prolonging the block.
- **Bulk mode** downloads many galleries unattended and, unlike the
  single-gallery downloader, auto-resumes after a 509 cooldown instead of
  stopping — see [Bulk downloading](#bulk-downloading) for setup, routing, and
  resume behavior.

## License

MIT — see [LICENSE](LICENSE).
