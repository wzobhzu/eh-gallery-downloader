// Discovery: parse e-hentai search results and walk ?next= cursor pagination.
// Selectors verified live 2026-07-18: gallery links are a[href*="/g/{gid}/{token}/"]
// inside table.itg; pagination is a "Next >" link whose href carries next=<gid>.
import { fetchDoc } from "./scrape.js";

const GLINK = /\/g\/(\d+)\/([0-9a-f]+)/;

export function parseSearchGalleries(doc, origin) {
  const seen = new Set();
  const out = [];
  for (const a of doc.querySelectorAll('a[href*="/g/"]')) {
    const m = (a.getAttribute("href") || "").match(GLINK);
    if (!m) continue;
    const gid = m[1];
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push(`${origin}/g/${m[1]}/${m[2]}/`);
  }
  return out;
}

// Prefer the on-page "Next >" link. Verified live 2026-07-18: it is <a id="unext">
// (top) / <a id="dnext"> (bottom) with an href carrying next=<gid>. Fall back to
// any next=-bearing anchor, then to constructing next=<smallest gid on page>.
export function nextCursorUrl(doc, currentUrl) {
  const nav = doc.querySelector("#unext, #dnext");
  const navHref = nav && nav.getAttribute("href");
  if (navHref && /[?&]next=\d+/.test(navHref)) {
    try { return new URL(navHref, currentUrl).href; } catch { /* ignore */ }
  }
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (/[?&]next=\d+/.test(href) && /(next\s*&gt;|next|›|»|>)/i.test(a.textContent || "")) {
      try { return new URL(href, currentUrl).href; } catch { /* ignore */ }
    }
  }
  const gids = [...doc.querySelectorAll('a[href*="/g/"]')]
    .map((a) => (a.getAttribute("href") || "").match(GLINK))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  if (!gids.length) return null;
  const smallest = Math.min(...gids);
  const u = new URL(currentUrl);
  u.searchParams.set("next", String(smallest));
  return u.href;
}

// Walk all pages, dedup galleries by gid across pages. Stops at MAX_SEARCH_PAGES
// (logged if hit — no silent truncation) or when a page yields nothing new.
export async function collectGalleriesFromSearch(searchUrl, state, onPage, opts = {}) {
  const maxPages = opts.maxPages || 200;
  const origin = new URL(searchUrl).origin;
  const seen = new Set();
  const all = [];
  let url = searchUrl;
  let page = 0;
  while (url && page < maxPages && !state.cancelled) {
    const doc = await fetchDoc(url);
    const before = all.length;
    for (const g of parseSearchGalleries(doc, origin)) {
      const gid = g.match(GLINK)[1];
      if (seen.has(gid)) continue;
      seen.add(gid);
      all.push(g);
    }
    page++;
    onPage && onPage(page, all.length);
    if (all.length === before) break; // no new galleries -> reached the end
    const next = nextCursorUrl(doc, url);
    url = next && next !== url ? next : null;
  }
  if (page >= maxPages && url) {
    onPage && onPage(page, all.length, { truncated: true });
  }
  return all;
}
