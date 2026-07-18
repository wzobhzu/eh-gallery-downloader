// Torrent discovery. Verified live 2026-07-18: gallerytorrents.php lists torrents
// with an ehtracker.org/get/{gid}/{infohash}.torrent download link; the infohash
// is the filename, so no bencode parsing is needed for tracking.
import { fetchDoc } from "./scrape.js";

const GLINK = /\/g\/(\d+)\/([0-9a-f]+)/;
const THREF = /ehtracker\.org\/get\/\d+\/([0-9a-f]{40})\.torrent/;

export function torrentsUrlFor(galleryUrl) {
  const u = new URL(galleryUrl);
  const m = u.pathname.match(GLINK);
  if (!m) throw new Error("Not a gallery URL");
  return `${u.origin}/gallerytorrents.php?gid=${m[1]}&t=${m[2]}`;
}

// Each torrent lives in its own row/form. We anchor on the .torrent link, then
// read seeds/peers from the nearest containing block's text.
export function parseTorrents(doc) {
  const out = [];
  for (const a of doc.querySelectorAll('a[href*="ehtracker.org/get/"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(THREF);
    if (!m) continue;
    const block = a.closest("form, table, div") || a.parentElement;
    const text = block ? block.textContent || "" : "";
    const seeds = parseInt((text.match(/Seeds:\s*(\d+)/i) || [])[1] || "0", 10);
    const peers = parseInt((text.match(/Peers:\s*(\d+)/i) || [])[1] || "0", 10);
    const sizeText = (text.match(/Size:\s*([\d.]+\s*[KMGT]i?B)/i) || [])[1] || "";
    out.push({ name: (a.textContent || "").trim(), seeds, peers, sizeText, torrentUrl: href, infohash: m[1] });
  }
  return out;
}

export function pickBestTorrent(torrents) {
  const live = (torrents || []).filter((t) => (t.seeds || 0) > 0);
  if (!live.length) return null;
  return live.reduce((best, t) => (t.seeds > best.seeds ? t : best));
}

export async function getGalleryTorrents(galleryUrl) {
  return parseTorrents(await fetchDoc(torrentsUrlFor(galleryUrl)));
}
