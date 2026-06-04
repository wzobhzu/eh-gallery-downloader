// Downloader engine page. Lives in its own tab, independent of the gallery tab,
// so navigating/closing the gallery never interrupts the job. Streams a single
// ZIP straight to disk via the File System Access API, so memory stays bounded
// (only the in-flight images) and there is no download-shelf spam.

import { resolveGallery, collectImageLinks, fetchImage, pool, pageNumOf, sanitize } from "./scrape.js";
import { ZipStreamWriter } from "./zip-stream.js";

const $ = (id) => document.getElementById(id);
const state = { nw: false, cancelled: false, quotaHit: false };
let links = [];
let title = "gallery";

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = cls;
}

async function init() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return showPaste("Paste a gallery URL to begin.");
  try {
    const { galleryUrl } = await resolveGallery(raw);
    setStatus("Scanning pages…");
    const res = await collectImageLinks(galleryUrl, state, (cur, tot) => setStatus(`Scanning pages ${cur}/${tot}…`));
    title = res.title;
    links = res.links;
    if (!links.length) return showPaste("No images found (you may need to log in, or the gallery is restricted).");
    $("title").textContent = title;
    document.title = title;
    $("opts").classList.remove("hidden");
    $("save").classList.remove("hidden");
    setStatus(`${links.length} images ready.`);
  } catch (e) {
    showPaste("Could not resolve gallery: " + (e && e.message ? e.message : e));
  }
}

function showPaste(msg) {
  $("title").textContent = "EH Gallery Downloader";
  setStatus(msg, "err");
  $("paste").classList.remove("hidden");
  $("load").onclick = () => {
    const v = $("url").value.trim();
    if (v) {
      location.hash = encodeURIComponent(v);
      location.reload();
    }
  };
}

// Prefer File System Access (streams to disk, bounded memory, no download-shelf
// entry); fall back to an in-memory Blob download where the API is missing.
async function openSink() {
  const name = sanitize(title) + ".zip";
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      startIn: "downloads",
      types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
    });
    const writable = await handle.createWritable();
    return { write: (u) => writable.write(u), done: () => writable.close() };
  }
  const chunks = [];
  return {
    write: (u) => { chunks.push(u.slice()); },
    done: () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
  };
}

async function run() {
  const preferOriginal = $("orig").checked;
  const limit = Math.min(6, Math.max(1, parseInt($("conc").value, 10) || 2));
  const delay = Math.min(5000, Math.max(0, parseInt($("delay").value, 10) || 0));

  let sink;
  try {
    sink = await openSink();
  } catch {
    setStatus("Save cancelled.", "err");
    return;
  }

  $("save").classList.add("hidden");
  $("opts").classList.add("hidden");
  $("cancel").classList.remove("hidden");
  $("bar").classList.remove("hidden");
  state.cancelled = false;
  state.quotaHit = false;

  const zip = new ZipStreamWriter(sink.write);
  const width = String(links.length).length;
  const failures = [];
  let origCount = 0;
  let saved = 0;
  let writeChain = Promise.resolve();

  // Fetches run concurrently; writes are serialized to keep ZIP offsets valid.
  const serialAdd = (name, data) => {
    const p = writeChain.then(() => zip.add(name, data));
    writeChain = p.catch(() => {});
    return p;
  };

  await pool(
    links,
    limit,
    async (sUrl) => {
      const page = pageNumOf(sUrl);
      const img = await fetchImage(sUrl, preferOriginal, state);
      if (String(img.source).startsWith("original")) origCount++;
      await serialAdd(`${String(page).padStart(width, "0")}.${img.ext}`, img.data);
    },
    (done, fail) => {
      if (fail) failures.push(fail);
      else saved++;
      $("fill").style.width = Math.round((done / links.length) * 100) + "%";
      setStatus(`Downloading ${done}/${links.length}… (${saved} saved)`);
    },
    state,
    delay
  );

  await writeChain;
  await zip.close();
  await sink.done();

  if (state.quotaHit) {
    setStatus(
      `Stopped at ${saved} images: e-hentai image limit reached (HTTP 509). The partial ZIP was saved. Wait a while, lower parallelism / raise the delay, or uncheck "prefer originals" (originals use far more quota).`,
      "err"
    );
  } else if (state.cancelled) {
    setStatus(`Cancelled. Partial ZIP saved with ${saved} images.`, "err");
  } else {
    let msg = `Done: ${saved} images zipped (${origCount} original, ${saved - origCount} normal).`;
    if (failures.length) {
      const pages = failures.map((f) => pageNumOf(links[f.index])).sort((a, b) => a - b);
      msg += ` ${failures.length} failed: page ${pages.join(", ")}.`;
    }
    setStatus(msg, "ok");
  }
  $("cancel").classList.add("hidden");
}

$("save").onclick = run;
$("cancel").onclick = () => {
  state.cancelled = true;
  setStatus("Cancelling…");
};

init();
