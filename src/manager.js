import { collectGalleriesFromSearch } from "./search.js";
import { resolveGallery, collectImageLinks, fetchImage, pool, pageNumOf, sanitize, fetchDoc, NET_TIMEOUT_MS } from "./scrape.js";
import { pickOutputDir, saveBytes, persistDir, restoreDir, ensurePermission, subDir, existingBasenames, folderHasFile } from "./output.js";
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

function settingsFromUI(){ return { preferOriginal: $("orig").checked, imgConcurrency: +$("conc").value, galleryConcurrency: +$("gconc").value, delayMs: +$("delay").value, qbSavePath: $("qbpath").value.trim() }; }

$("pick").onclick = async () => { dir = await pickOutputDir(); await persistDir(dir); $("start").disabled = false; setStatus("Output folder set."); };

$("start").onclick = async () => {
  if (!dir) { setStatus("Pick an output folder first.", "err"); return; }
  if (!(await ensurePermission(dir))) { setStatus("Folder write permission denied.", "err"); return; }
  const urls = $("urls").value.split(/\s+/).map((s)=>s.trim()).filter(Boolean);
  state.userCancelled=false; state.cancelled=false; state.paused=false; state.manualPause=false; state.quotaHit=false;
  await storage.set("ehdl.qbpath", $("qbpath").value.trim());

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
  for (const gg of job.data.galleries) if (gg.folderName) usedNames.add(gg.folderName);
  renderRows();
  $("start").classList.add("hidden"); showPauseBtn(); $("cancel").classList.remove("hidden");

  const pend = await job.pending();
  const imageWork = [];          // dynamic queue of galleries to image-fetch (grows if a torrent falls back)
  const torrentGids = new Set(); // galleries handed to qBittorrent, monitored in the background

  // Phase 1: route every gallery. Torrent -> add to qBittorrent NOW and move on (non-blocking);
  // image (or torrent that couldn't be added) -> the image queue.
  qbOk = await qb.available();   // re-probe here: don't leave the torrent route disabled if qBittorrent came up after boot
  let qbByHash = {};
  if (qbOk) { try { for (const i of await qb.info()) qbByHash[i.hash] = i; } catch { /* ignore */ } }
  await pool(pend, Math.max(1, job.data.settings.galleryConcurrency), async (g) => {
    if (state.userCancelled) return;
    // Reconcile: a torrent already in qBittorrent (persisted infohash) is never re-added.
    const known = g.torrent && g.torrent.infohash ? qbByHash[g.torrent.infohash] : null;
    if (known) {
      g._torrent = g.torrent;
      if ((known.progress || 0) >= 1) {
        // Disk-verify gate: "done" only if the .zip qBittorrent reports as complete is
        // actually on disk. If it was deleted externally, recheck forces qB to re-hash
        // (drops below 100%) and re-download if seeds exist, instead of silently skipping.
        if (await folderHasFile(dir, torrentFolder(g))) { await job.setStatus(g.gid, "done"); }
        else { try { await qb.recheck(g.torrent.infohash); } catch { /* best effort */ } await job.setStatus(g.gid, "downloading"); torrentGids.add(g.gid); }
      }
      else { await job.setStatus(g.gid, "downloading"); torrentGids.add(g.gid); }
      updateRow(g); return;
    }
    await routeGallery(g);
    if (g.route === "torrent") {
      const ok = await addTorrent(g);
      if (ok) torrentGids.add(g.gid);
      else { await job.setRoute(g.gid, "image"); updateRow(g); imageWork.push(g); }
    } else {
      imageWork.push(g);
    }
  }, ()=>{}, state, 0);

  // Phase 2: image workers + torrent monitor run concurrently. The monitor may push
  // stalled/seedless torrent galleries into imageWork, which the workers then drain.
  let torrentsActive = torrentGids.size > 0;
  const imageDone = runImageWorkers(imageWork, () => torrentsActive, job.data.settings.galleryConcurrency);
  const monitorDone = monitorTorrents(torrentGids, imageWork).finally(() => { torrentsActive = false; });
  await Promise.all([imageDone, monitorDone]);

  const failedCount = job.data.galleries.filter((g)=>g.status === "failed").length;
  setStatus(
    state.userCancelled ? "Cancelled — partly-downloaded folders kept; press Start to resume only what's missing."
      : (failedCount ? `Done — ${failedCount} gallery(ies) failed; press Start to retry them.` : "All galleries processed."),
    (state.userCancelled || failedCount) ? "err" : "ok"
  );
  $("pause").classList.add("hidden"); $("resume").classList.add("hidden"); $("cancel").classList.add("hidden"); $("start").classList.remove("hidden");
};

// Decide the route for one gallery and, for torrent, stash the chosen torrent on g._torrent.
async function routeGallery(g) {
  if (qbOk) {
    try {
      const best = pickBestTorrent(await getGalleryTorrents(g.galleryUrl));
      if (best) {
        g._torrent = best;
        await job.setStatus(g.gid, g.status, { route: "torrent", torrent: { infohash: best.infohash, torrentUrl: best.torrentUrl } });
        updateRow(g); return;
      }
    } catch { /* fall through to image */ }
  }
  await job.setRoute(g.gid, "image"); updateRow(g);
}

// Non-blocking: fetch the personalized .torrent and hand it to qBittorrent, then return
// immediately (qBittorrent downloads it in the background). Returns false if it could not
// be fetched/added, so the caller falls back to image fetch.
async function addTorrent(g) {
  let title = g.title;
  if (!title) {
    try {
      const { galleryUrl } = await resolveGallery(g.galleryUrl);
      const doc = await fetchDoc(galleryUrl);
      title = ((doc.querySelector("#gn") || doc.querySelector("#gj") || {}).textContent || "").trim() || g.gid;
    } catch { title = g.gid; }
  }
  // Persist the exact subfolder qBittorrent saves into (reuse a prior run's name to avoid
  // drift) so the reconcile can disk-verify the .zip actually landed.
  const folderName = g.folderName || sanitizeUnique(title || g.gid, g.gid);
  await job.setStatus(g.gid, "downloading", { title, folderName }); updateRow(g);
  const t = g._torrent;
  let bytes;
  try { bytes = new Uint8Array(await (await fetch(t.torrentUrl, { credentials: "include", signal: AbortSignal.timeout(NET_TIMEOUT_MS) })).arrayBuffer()); }
  catch { return false; }
  const raw = job.data.settings.qbSavePath;
  const baseDir = raw ? raw.replace(/[\\/]+$/, "") + (raw.includes("\\") ? "\\" : "/") : "";
  const savepath = baseDir + folderName;
  try { await qb.addTorrent(bytes, { savepath, category: "eh-bulk" }); }
  catch { return false; }
  return true;
}

// Image-route workers: `concurrency` workers drain the shared `queue`, waiting while
// `moreComing()` is true (torrents may still fall back into the queue).
function runImageWorkers(queue, moreComing, concurrency) {
  async function worker() {
    for (;;) {
      if (state.userCancelled) return;
      if (queue.length === 0) {
        if (!moreComing()) return;
        await sleep(1000); continue;
      }
      const g = queue.shift();
      if (!g) continue;
      try { await imageRoute(g); }
      catch (e) { try { await job.setStatus(g.gid, "failed"); updateRow(g); } catch { /* ignore */ } }
    }
  }
  return Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

// Background torrent monitor: polls qBittorrent, marks each gallery done at 100%, and
// re-routes to image fetch a torrent that (a) is seedless-stalled for 3+ min, (b) makes
// no progress for 5+ min, or (c) has vanished from qBittorrent (deleted externally).
async function monitorTorrents(torrentGids, imageWork) {
  if (!torrentGids.size) return;
  const pending = new Set(torrentGids);
  const lastProg = {}, stallSince = {}, seedlessSince = {}, missCount = {}, rechecked = {}, recheckedAt = {};
  let infoFailures = 0;
  const NO_PROGRESS_MS = 5 * 60 * 1000;
  const SEEDLESS_MS = 3 * 60 * 1000;
  const MAX_MISSES = 24; // ~2 min at 5s: torrent no longer in qBittorrent at all
  const MAX_INFO_FAILURES = 24; // ~2 min at 5s: qBittorrent is unreachable, stop waiting on it
  const RECHECK_GRACE_MS = 30 * 1000; // let qBittorrent enter/finish its re-hash before rerouting
  const toImage = async (gid, g, del) => {
    if (del) { try { await qb.deleteTorrent(g._torrent.infohash, true); } catch { /* best effort */ } }
    await job.setRoute(gid, "image"); updateRow(g); imageWork.push(g); pending.delete(gid);
  };
  while (pending.size && !state.userCancelled) {
    await sleep(5000);
    let infos;
    try { infos = await qb.info(); infoFailures = 0; }
    catch {
      // qBittorrent unreachable for too long: stop waiting on it and let the image route
      // finish the job, or `pending` never drains and the monitor never returns. No
      // deleteTorrent here (del=false) — that call would only time out repeatedly too.
      if (++infoFailures >= MAX_INFO_FAILURES) {
        for (const gid of [...pending]) { const g = job.get(gid); if (g) await toImage(gid, g, false); else pending.delete(gid); }
        return;
      }
      continue;
    }
    const byHash = {};
    for (const i of infos) byHash[i.hash] = i;
    for (const gid of [...pending]) {
      const g = job.get(gid);
      const info = g && g._torrent ? byHash[g._torrent.infohash] : null;
      if (!info) { missCount[gid] = (missCount[gid] || 0) + 1; if (missCount[gid] >= MAX_MISSES) await toImage(gid, g, false); continue; }
      missCount[gid] = 0;
      const prog = info.progress || 0;
      updateRowProgress(g, Math.round(prog * 100), 100);
      if (prog >= 1) {
        // Disk-verify done-gate: "done" only if the .zip qBittorrent reports as complete is
        // actually on disk. A complete-in-qB-but-missing-on-disk torrent (deleted externally /
        // stale dedup entry) is rechecked once to force qB to re-hash (drops below 100%) and
        // re-download if seeds exist. If qB still claims complete after that re-hash, the
        // torrent cannot produce data, so fall back to image fetch. Every branch here must
        // eventually drop the gid from `pending`, or the monitor never returns and the image
        // workers spin on an empty queue forever.
        if (await folderHasFile(dir, torrentFolder(g))) { await job.setStatus(gid, "done"); updateRow(g); pending.delete(gid); continue; }
        if (!rechecked[gid]) { rechecked[gid] = true; recheckedAt[gid] = Date.now(); try { await qb.recheck(g._torrent.infohash); } catch { /* best effort */ } continue; }
        if (/checking/i.test(info.state || "")) continue;   // re-hash still running; don't reroute mid-check
        if (Date.now() - (recheckedAt[gid] || 0) < RECHECK_GRACE_MS) continue;   // give qB time to enter the re-hash
        await toImage(gid, g, true);
        continue;
      }
      if (prog !== lastProg[gid]) { lastProg[gid] = prog; stallSince[gid] = Date.now(); }
      if ((info.num_seeds || 0) === 0 && info.state === "stalledDL") { if (!seedlessSince[gid]) seedlessSince[gid] = Date.now(); }
      else seedlessSince[gid] = 0;
      const seedlessTooLong = seedlessSince[gid] && Date.now() - seedlessSince[gid] > SEEDLESS_MS;
      const noProgressTooLong = Date.now() - (stallSince[gid] || Date.now()) > NO_PROGRESS_MS;
      if (seedlessTooLong || noProgressTooLong) await toImage(gid, g, true);
    }
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

// Image route: download each page as a loose file into <outdir>/<title>/, skipping any
// page already present (true per-image resume across reloads). No streaming ZIP.
async function imageRoute(g) {
  await job.setStatus(g.gid, "scanning"); updateRow(g);
  const { galleryUrl } = await resolveGallery(g.galleryUrl);
  const res = await collectImageLinks(galleryUrl, state, ()=>{});
  const links = res.links;
  const title = res.title || g.gid;
  const folderName = sanitizeUnique(title, g.gid);
  await job.setStatus(g.gid, "downloading", { title, folderName, image: { total: links.length } });
  updateRow(g);

  const sub = await subDir(dir, folderName);
  const width = String(links.length).length;
  const have = await existingBasenames(sub);           // page numbers already downloaded
  const remaining = new Set(links.filter((sUrl) => !have.has(String(pageNumOf(sUrl)).padStart(width, "0"))));
  let saved = links.length - remaining.size;
  updateRowProgress(g, saved, links.length);

  const backoffs = [2000, 8000, 30000];
  for (let round = 0; round < 4 && remaining.size && !state.userCancelled; round++) {
    if (round > 0) await sleep(backoffs[Math.min(round - 1, backoffs.length - 1)]);
    await pool([...remaining], job.data.settings.imgConcurrency, async (sUrl) => {
      if (state.userCancelled) return;
      const img = await fetchOneImage(sUrl);
      const name = String(pageNumOf(sUrl)).padStart(width, "0") + "." + img.ext;
      await saveBytes(sub, name, img.data);              // loose file; resumable
      remaining.delete(sUrl); saved++;
      updateRowProgress(g, saved, links.length);
    }, ()=>{}, state, job.data.settings.delayMs);
  }
  // Verify against disk: only "done" if the files are actually present. Guards against
  // marking done when links were empty, all fetches failed, or writes silently failed
  // (any of which would otherwise leave an empty folder falsely marked done).
  const onDisk = (await existingBasenames(sub)).size;
  await job.setStatus(g.gid, (links.length > 0 && onDisk >= links.length) ? "done" : "failed");
  updateRow(g);
}

// Deterministic per-gallery folder name: title, disambiguated by gid on a title collision.
const usedNames = new Set();
function sanitizeUnique(titleOrGid, gid){ const base = sanitize(titleOrGid); let name = base; if (usedNames.has(name)) name = `${base} [${gid}]`; usedNames.add(name); return name; }

// Subfolder qBittorrent saved this gallery's .zip into: the persisted folderName, or (for
// jobs persisted before folderName was tracked) the sanitized title, matching the savepath.
const torrentFolder = (g) => g.folderName || sanitize(g.title || g.gid);

function renderRows(){ $("rows").innerHTML=""; job.data.galleries.forEach((g,i)=>{ const tr=document.createElement("tr"); tr.id="r"+g.gid; tr.innerHTML=`<td>${i+1}</td><td>${g.gid}</td><td class="route"></td><td class="st"></td><td><div class="bar"><div class="fill"></div></div></td>`; $("rows").appendChild(tr); updateRow(g); }); }
function updateRow(g){ const tr=$("r"+g.gid); if(!tr) return; tr.querySelector(".route").textContent=g.route; tr.querySelector(".st").textContent=g.status; }
function updateRowProgress(g, saved, total){ const tr=$("r"+g.gid); if(tr) tr.querySelector(".fill").style.width=Math.round(saved/total*100)+"%"; }

$("pause").onclick=()=>{ manualPause(state); showResumeBtn(); setStatus("Paused."); };
$("resume").onclick=()=>{ gateResume(state, pauseDeps); showPauseBtn(); setStatus("Resumed."); };
$("cancel").onclick=()=>{ gateCancel(state, pauseDeps); setStatus("Cancelling..."); };

(async function boot(){
  await ingestInbox();
  $("qbpath").value = (await storage.get("ehdl.qbpath")) || "";
  dir = await restoreDir();
  if (dir) $("start").disabled=false;   // enable even if permission reverted to 'prompt' after a restart; Start's click drives requestPermission
  qbOk = await qb.available();
  const qbMsg = qbOk ? "" : " qBittorrent not reachable (127.0.0.1:8080) — torrent route disabled; image fetch used for all galleries.";
  const j = new Job(storage);
  if (await j.load()){
    job = j;
    qbOk = await qb.available();  // ensure qbOk set before reconcile (may duplicate the earlier line; harmless)
    if (qbOk) {
      try {
        const byHash = {}; for (const i of await qb.info()) byHash[i.hash] = i;
        for (const g of job.data.galleries) {
          if (g.route === "torrent" && g.torrent && g.torrent.infohash) {
            const info = byHash[g.torrent.infohash];
            // Disk-verify gate: mark "done" only if qB reports 100% AND the .zip is on disk.
            // A complete-in-qB-but-missing-on-disk torrent is left as-is so Start re-processes
            // it (Start's Phase 1 issues the qB recheck). Boot stays side-effect-light.
            if (info && (info.progress || 0) >= 1 && g.status !== "done" && await folderHasFile(dir, torrentFolder(g))) await job.setStatus(g.gid, "done");
          }
        }
      } catch { /* ignore */ }
    }
    renderRows();
    setStatus("Previous job loaded and reconciled with qBittorrent — press Start to resume only what's missing." + (qbOk ? "" : " (qBittorrent not reachable)"), qbOk ? "" : "warn");
  }
  else if (qbMsg) setStatus(qbMsg.trim(), "warn");
})();
