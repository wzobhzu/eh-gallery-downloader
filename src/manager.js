import { collectGalleriesFromSearch } from "./search.js";
import { resolveGallery, collectImageLinks, fetchImage, pool, pageNumOf, sanitize } from "./scrape.js";
import { ZipStreamWriter } from "./zip-stream.js";
import { pickOutputDir, zipSinkFor, fileExists, persistDir, restoreDir, ensurePermission, hasPermission, renameFile } from "./output.js";
import { Job } from "./queue.js";
import { isBlocked, on509, manualPause, resume as gateResume, cancel as gateCancel } from "./pause.js";
import { getGalleryTorrents, pickBestTorrent } from "./torrents.js";
import { QbClient } from "./qbittorrent.js";

const $ = (id) => document.getElementById(id);
const storage = { async get(k){ return (await chrome.storage.local.get(k))[k]; }, async set(k,v){ await chrome.storage.local.set({ [k]: v }); } };
const state = { nw:false, cancelled:false, quotaHit:false, paused:false, manualPause:false, userCancelled:false, pauseOn509:true, _iv:null };
let dir = null, job = null;
const qb = new QbClient({});
let qbOk = false;
const COOLDOWN_MS = 20 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(t, cls=""){ $("status").textContent = t; $("status").className = cls; }
function showPauseBtn(){ $("pause").classList.remove("hidden"); $("resume").classList.add("hidden"); }
function showResumeBtn(){ $("resume").classList.remove("hidden"); $("pause").classList.add("hidden"); }

const pauseDeps = {
  cooldownMs: COOLDOWN_MS,
  now: () => Date.now(),
  setTimer: (fn, ms) => setInterval(fn, ms),
  clearTimer: (id) => clearInterval(id),
  onStatus: (kind, min) => {
    if (kind === "cooldown") { setStatus(`Image limit (509): paused, auto-resume in ${min} min (or press Resume).`, "warn"); showResumeBtn(); }
    else if (kind === "resume") { setStatus("Resuming after 509 cooldown..."); showPauseBtn(); }
  },
};

async function gate(){ while (isBlocked(state)) await sleep(500); }

async function ingestInbox() {
  const inbox = (await storage.get("ehdl.inbox")) || [];
  if (inbox.length) { const cur = $("urls").value.trim(); $("urls").value = (cur ? cur + "\n" : "") + inbox.join("\n"); await storage.set("ehdl.inbox", []); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["ehdl.inbox"] && (changes["ehdl.inbox"].newValue || []).length) ingestInbox();
});

function settingsFromUI(){ return { preferOriginal: $("orig").checked, imgConcurrency: +$("conc").value, galleryConcurrency: +$("gconc").value, delayMs: +$("delay").value }; }

$("pick").onclick = async () => { dir = await pickOutputDir(); await persistDir(dir); $("start").disabled = false; setStatus("Output folder set."); };

$("start").onclick = async () => {
  if (!dir) { setStatus("Pick an output folder first.", "err"); return; }
  if (!(await ensurePermission(dir))) { setStatus("Folder write permission denied.", "err"); return; }
  const urls = $("urls").value.split(/\s+/).map((s)=>s.trim()).filter(Boolean);
  state.userCancelled=false; state.cancelled=false; state.paused=false; state.manualPause=false; state.quotaHit=false;

  if (urls.length) {
    // Additive: append (dedup) to the existing/loaded job, or create one — never wipes prior progress.
    if (!job || !job.data) { job = new Job(storage); await job.init(settingsFromUI()); }
    else { job.data.settings = settingsFromUI(); await job.save(); }
    const galleries = [];
    for (const u of urls) {
      if (state.userCancelled) break;
      if (/\/g\/\d+\/[0-9a-f]+/.test(u)) galleries.push(u.replace(/(\/g\/\d+\/[0-9a-f]+).*/, "$1/"));
      else { setStatus(`Scanning ${u} ...`); galleries.push(...await collectGalleriesFromSearch(u, state, (p,n)=>setStatus(`Scanning ${u}: page ${p}, ${n} galleries`))); }
    }
    await job.addGalleries(galleries);
    $("urls").value = "";
  } else if (!job || !(await job.pending()).length) {
    setStatus("Paste at least one URL, or load a prior job to resume.", "err"); return;
  } // else: resume the boot-loaded job as-is

  usedNames.clear();
  for (const gg of job.data.galleries) if (gg.zipName) usedNames.add(gg.zipName);  // reserve already-assigned names so a distinct gallery can never resolve to a sibling's ZIP
  renderRows();
  $("start").classList.add("hidden"); showPauseBtn(); $("cancel").classList.remove("hidden");
  await pool(await job.pending(), job.data.settings.galleryConcurrency, (g)=>processGallery(g), ()=>{}, state, 0);
  const failedCount = job.data.galleries.filter((g)=>g.status === "failed").length;
  setStatus(
    state.userCancelled ? "Cancelled — partial galleries left as .part; press Start to resume."
      : (failedCount ? `Done — ${failedCount} gallery(ies) failed; press Start to retry them.` : "All galleries processed."),
    (state.userCancelled || failedCount) ? "err" : "ok"
  );
  $("pause").classList.add("hidden"); $("resume").classList.add("hidden"); $("cancel").classList.add("hidden"); $("start").classList.remove("hidden");
};

async function processGallery(g) {
  if (state.userCancelled) return;
  await routeGallery(g);
  if (g.route === "torrent") {
    const ok = await torrentRoute(g);
    if (!ok && !state.userCancelled) {
      try { if (g._torrent) await qb.deleteTorrent(g._torrent.infohash, true); } catch { /* best-effort cleanup */ }
      await job.setRoute(g.gid, "image"); updateRow(g); await imageRoute(g);
    }
  } else {
    await imageRoute(g);
  }
}

// Route to torrent when qBittorrent is reachable AND the gallery has a live-seeded
// torrent; otherwise (or if the torrent stalls) fall back to image fetch.
async function routeGallery(g) {
  if (qbOk) {
    try {
      const best = pickBestTorrent(await getGalleryTorrents(g.galleryUrl));
      if (best) { await job.setRoute(g.gid, "torrent"); g._torrent = best; updateRow(g); return; }
    } catch { /* fall through to image */ }
  }
  await job.setRoute(g.gid, "image"); updateRow(g);
}

// Fetch the personalized .torrent (with cookies) and hand it to qBittorrent, then
// poll its progress. Returns true when complete (or cancelled); false to signal the
// caller to fall back to image fetch (couldn't fetch/add, or stalled with no seeds).
async function torrentRoute(g) {
  await job.setStatus(g.gid, "downloading"); updateRow(g);
  const t = g._torrent;
  let bytes;
  try { bytes = new Uint8Array(await (await fetch(t.torrentUrl, { credentials: "include" })).arrayBuffer()); }
  catch { return false; }
  const folder = sanitize(g.title || g.gid);
  try { await qb.addTorrent(bytes, { savepath: folder, category: "eh-bulk", rename: folder }); }
  catch { return false; }
  const STALL_MS = 3 * 60 * 1000; let stalledSince = 0;
  for (;;) {
    if (state.userCancelled) return true;
    await sleep(4000);
    let info;
    try { [info] = await qb.info(t.infohash); } catch { continue; }
    if (!info) continue;
    updateRowProgress(g, Math.round((info.progress || 0) * 100), 100);
    if ((info.progress || 0) >= 1) { await job.setStatus(g.gid, "done"); updateRow(g); return true; }
    if (qb.stalled(info)) { stalledSince = stalledSince || Date.now(); if (Date.now() - stalledSince > STALL_MS) return false; }
    else stalledSince = 0;
  }
}

// One image page, resilient to 509: waits out the global cooldown and retries the
// SAME page. Uses state.quotaHit, which pause.js keeps true for the whole pause, so
// concurrent workers can't race on it.
async function fetchOneImage(sUrl) {
  for (;;) {
    await gate();
    if (state.userCancelled) throw new Error("cancelled");
    try { return await fetchImage(sUrl, job.data.settings.preferOriginal, state); }
    catch (e) { if (state.quotaHit) { on509(state, pauseDeps); continue; } throw e; }
  }
}

async function imageRoute(g) {
  await job.setStatus(g.gid, "scanning"); updateRow(g);
  const { galleryUrl } = await resolveGallery(g.galleryUrl);
  const res = await collectImageLinks(galleryUrl, state, ()=>{});
  const links = res.links;
  let zipName = g.zipName;
  if (!zipName) zipName = sanitizeUnique(res.title || g.gid, g.gid);
  if (await fileExists(dir, zipName)) { await job.setStatus(g.gid, "done", { title: res.title, zipName }); updateRow(g); return; }
  await job.setStatus(g.gid, "downloading", { title: res.title, zipName, image: { total: links.length, savedPages: [], failedPages: [] } });
  updateRow(g);

  // Stream to a .part name; rename to the final name only on full success so a
  // truncated ZIP is never mistaken for a completed gallery on resume.
  const partName = zipName + ".part";
  const sink = await zipSinkFor(dir, partName);
  const zip = new ZipStreamWriter(sink.write);
  const width = String(links.length).length;
  let saved = 0; let chain = Promise.resolve();
  const remaining = new Set(links);
  const backoffs = [2000, 8000, 30000];
  for (let round = 0; round < 4 && remaining.size && !state.userCancelled; round++) {
    if (round > 0) await sleep(backoffs[Math.min(round-1, backoffs.length-1)]);
    await pool([...remaining], job.data.settings.imgConcurrency, async (sUrl) => {
      if (state.userCancelled) return;
      const img = await fetchOneImage(sUrl);
      const page = pageNumOf(sUrl);
      const p = chain.then(()=>zip.add(`${String(page).padStart(width,"0")}.${img.ext}`, img.data));
      chain = p.catch(()=>{});   // keep the chain alive: one write failure must not skip later adds or block close()
      await p;                    // this worker still sees its own write failure, so the page stays in remaining for retry
      remaining.delete(sUrl); saved++;
      updateRowProgress(g, saved, links.length);
    }, ()=>{}, state, job.data.settings.delayMs);
  }
  await chain; await zip.close(); await sink.done();
  await job.markImageProgress(g.gid, [...links].filter((l)=>!remaining.has(l)).map(pageNumOf), [...remaining].map(pageNumOf));
  if (remaining.size === 0 && !state.userCancelled) { await renameFile(dir, partName, zipName); await job.setStatus(g.gid, "done"); }
  else { await job.setStatus(g.gid, state.userCancelled ? "cancelled" : "failed"); } // .part remains; resume redoes this gallery
  updateRow(g);
}

// Deterministic per-gallery name: title, disambiguated by gid on a title collision.
const usedNames = new Set();
function sanitizeUnique(titleOrGid, gid){ const base = sanitize(titleOrGid); let name = base + ".zip"; if (usedNames.has(name)) name = `${base} [${gid}].zip`; usedNames.add(name); return name; }

function renderRows(){ $("rows").innerHTML=""; job.data.galleries.forEach((g,i)=>{ const tr=document.createElement("tr"); tr.id="r"+g.gid; tr.innerHTML=`<td>${i+1}</td><td>${g.gid}</td><td class="route"></td><td class="st"></td><td><div class="bar"><div class="fill"></div></div></td>`; $("rows").appendChild(tr); updateRow(g); }); }
function updateRow(g){ const tr=$("r"+g.gid); if(!tr) return; tr.querySelector(".route").textContent=g.route; tr.querySelector(".st").textContent=g.status; }
function updateRowProgress(g, saved, total){ const tr=$("r"+g.gid); if(tr) tr.querySelector(".fill").style.width=Math.round(saved/total*100)+"%"; }

$("pause").onclick=()=>{ manualPause(state); showResumeBtn(); setStatus("Paused."); };
$("resume").onclick=()=>{ gateResume(state, pauseDeps); showPauseBtn(); setStatus("Resumed."); };
$("cancel").onclick=()=>{ gateCancel(state, pauseDeps); setStatus("Cancelling..."); };

(async function boot(){
  await ingestInbox();
  dir = await restoreDir();
  if (dir) $("start").disabled=false;   // enable even if permission reverted to 'prompt' after a restart; Start's click drives requestPermission
  qbOk = await qb.available();
  const qbMsg = qbOk ? "" : " qBittorrent not reachable (127.0.0.1:8080) — torrent route disabled; image fetch used for all galleries.";
  const j = new Job(storage);
  if (await j.load()){ job=j; renderRows(); setStatus("Previous job loaded — press Start to resume pending galleries (folder permission may re-prompt)." + qbMsg, qbOk ? "" : "warn"); }
  else if (qbMsg) setStatus(qbMsg.trim(), "warn");
})();
