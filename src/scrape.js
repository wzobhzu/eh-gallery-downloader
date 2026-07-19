// Shared scraping + image-fetch logic, used by the downloader page.
//
// Runs inside an extension page (chrome-extension://), which — with the
// host_permissions in the manifest — can fetch e-hentai.org and *.hath.network
// cross-origin, with cookies, and without CORS. So no background relay needed.
//
// Selectors verified live against e-hentai.org: #gn, .gpc, #gdt a,
// a[href*="fullimg"], #img, #loadfail's nl('...') token, and the nw=session
// Content-Warning bypass.

const SLINK = /\/s\/[0-9a-f]+\/\d+-\d+/;

// Every network wait is abort-bounded. A stalled connection that is accepted but never
// answered would otherwise park an image worker forever, and runImageWorkers' Promise.all
// then never resolves — the run becomes unkillable because no flag can break the await.
const NET_TIMEOUT_MS = 60000; // large original images are slow but must not hang a worker forever

export async function fetchDoc(url) {
  const res = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new DOMParser().parseFromString(await res.text(), "text/html");
}

// Resolve any e-hentai gallery/image URL to the canonical /g/{id}/{token}/ URL.
// Accepts a /g URL directly, or a /s image URL (whose parent gallery link is
// fetched). Returns { galleryUrl, title } or throws.
export async function resolveGallery(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  const origin = u.origin;
  const g = u.pathname.match(/^\/g\/(\d+)\/([0-9a-f]+)/);
  if (g) return { galleryUrl: `${origin}/g/${g[1]}/${g[2]}/` };

  const s = u.pathname.match(/^\/s\/[0-9a-f]+\/(\d+)-\d+/);
  if (s) {
    const gid = s[1];
    const doc = await fetchDoc(rawUrl);
    const back = doc.querySelector(`a[href*="/g/${gid}/"]`);
    const m = back && back.getAttribute("href").match(/\/g\/\d+\/[0-9a-f]+/);
    if (m) return { galleryUrl: `${origin}${m[0]}/` };
    throw new Error("Could not resolve the parent gallery from this image page");
  }
  throw new Error("Not an e-hentai gallery (/g) or image (/s) URL");
}

export function imageLinksIn(doc) {
  return [...doc.querySelectorAll("#gdt a")]
    .map((a) => a.href)
    .filter((h) => SLINK.test(h));
}

// Walk every paginated page and collect image-page links in reading order.
// `state.nw` flips on once a flagged-gallery Content Warning is bypassed.
export async function collectImageLinks(galleryUrl, state, onPage) {
  const nwq = (url) => (state.nw ? url + (url.includes("?") ? "&" : "?") + "nw=session" : url);

  let first = await fetchDoc(galleryUrl + "?p=0");
  if (!first.querySelector("#gdt a") && first.querySelector('a[href*="nw=session"]')) {
    state.nw = true;
    first = await fetchDoc(nwq(galleryUrl + "?p=0"));
  }

  const title =
    first.querySelector("#gn")?.textContent?.trim() ||
    first.querySelector("#gj")?.textContent?.trim() ||
    "gallery";
  const gpc = first.querySelector(".gpc")?.textContent || "";
  const total = parseInt((gpc.match(/of\s+([\d,]+)\s+images/) || [])[1]?.replace(/,/g, ""), 10);

  const links = imageLinksIn(first);
  const perPage = links.length || 20;
  const pageCount = total ? Math.ceil(total / perPage) : 1;
  onPage && onPage(1, pageCount);

  for (let p = 1; p < pageCount; p++) {
    if (state.cancelled) break;
    const doc = await fetchDoc(nwq(galleryUrl + "?p=" + p));
    links.push(...imageLinksIn(doc));
    onPage && onPage(p + 1, pageCount);
  }

  const seen = new Set();
  return { title, links: links.filter((h) => (seen.has(h) ? false : seen.add(h))) };
}

function parseImagePage(doc) {
  return {
    original: doc.querySelector('a[href*="fullimg"]')?.href || null,
    normal: doc.querySelector("#img")?.getAttribute("src") || null,
    nl: (doc.querySelector("#loadfail")?.getAttribute("onclick") || "").match(/nl\('([^']+)'\)/)?.[1] || null,
  };
}

function extFor(url, contentType) {
  const fromUrl = (url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1];
  if (fromUrl) return fromUrl.toLowerCase();
  if (/png/.test(contentType)) return "png";
  if (/webp/.test(contentType)) return "webp";
  if (/gif/.test(contentType)) return "gif";
  return "jpg";
}

async function tryBytes(url, state) {
  // A timeout/network error returns null, exactly like a bad response: the fallback
  // ladder in fetchImage moves to the next tier and, if every tier fails, the caller
  // throws "no usable image", which imageRoute's backoff rounds retry. Deliberately
  // does NOT touch state.quotaHit — a timeout is not the 509 quota path.
  let r;
  try {
    r = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
  } catch {
    return null;
  }
  // 509 = e-hentai image/bandwidth limit reached. Stop the whole job instead of
  // hammering, which only prolongs the temporary block.
  if (r.status === 509) {
    state.quotaHit = true;
    if (!state.pauseOn509) state.cancelled = true;
    return null;
  }
  if (!r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) return null; // quota page / HTML -> reject
  let buf;
  try { buf = new Uint8Array(await r.arrayBuffer()); } catch { return null; } // body stalled mid-stream
  return buf.length ? { data: buf, ext: extFor(r.url || url, ct) } : null;
}

// Resolve one /s page to image bytes via the 3-tier fallback ladder:
// original -> normal -> nl() retry from a different Hath node.
export async function fetchImage(sUrl, preferOriginal, state) {
  const nwq = (url) => (state.nw ? url + (url.includes("?") ? "&" : "?") + "nw=session" : url);
  const info = parseImagePage(await fetchDoc(nwq(sUrl)));

  if (preferOriginal && info.original) {
    const got = await tryBytes(info.original, state);
    if (got) return { ...got, source: "original" };
  }
  if (state.quotaHit) throw new Error("image limit (509)");
  if (info.normal) {
    const got = await tryBytes(info.normal, state);
    if (got) return { ...got, source: "normal" };
  }
  if (state.quotaHit) throw new Error("image limit (509)");
  if (info.nl) {
    const sep = sUrl.includes("?") ? "&" : "?";
    const retry = parseImagePage(await fetchDoc(nwq(sUrl + sep + "nl=" + encodeURIComponent(info.nl))));
    if (preferOriginal && retry.original) {
      const got = await tryBytes(retry.original, state);
      if (got) return { ...got, source: "original-retry" };
    }
    if (retry.normal) {
      const got = await tryBytes(retry.normal, state);
      if (got) return { ...got, source: "normal-retry" };
    }
  }
  throw new Error("no usable image");
}

// Bounded-concurrency runner. Work is I/O-bound, so concurrency (not threads)
// is the speed lever; kept low because e-hentai throttles aggressive scraping.
// `delay` (ms) throttles each runner between items to stay polite and reduce
// the chance of a rate-limit / image-quota block.
export async function pool(items, limit, worker, onDone, state, delay = 0) {
  let idx = 0;
  let done = 0;
  async function runner() {
    while (idx < items.length && !state.cancelled) {
      const i = idx++;
      try {
        await worker(items[i], i);
        onDone(++done, null);
      } catch (e) {
        onDone(++done, { index: i, error: String(e && e.message ? e.message : e) });
      }
      if (delay && !state.cancelled) await new Promise((r) => setTimeout(r, delay));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

export function pageNumOf(sUrl) {
  return parseInt((sUrl.match(/-(\d+)(?:\?|$)/) || [])[1], 10) || 0;
}

export function sanitize(name) {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150) || "gallery"
  );
}
