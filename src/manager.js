import { collectGalleriesFromSearch } from "./search.js";
import { resolveGallery, collectImageLinks, fetchImage, pool, pageNumOf, sanitize } from "./scrape.js";
import { ZipStreamWriter } from "./zip-stream.js";
import { pickOutputDir, zipSinkFor, fileExists, persistDir, restoreDir, ensurePermission, hasPermission, renameFile } from "./output.js";
import { Job } from "./queue.js";

const $ = (id) => document.getElementById(id);
const storage = { async get(k){ return (await chrome.storage.local.get(k))[k]; }, async set(k,v){ await chrome.storage.local.set({ [k]: v }); } };
// pauseOn509: tell scrape.js NOT to cancel on 509 — the gate handles it as a pause.
const state = { nw:false, cancelled:false, quotaHit:false, paused:false, manualPause:false, userCancelled:false, pauseOn509:true };
let dir = null, job = null, cooldownIv = null;
const COOLDOWN_MS = 20 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(t, cls=""){ $("status").textContent = t; $("status").className = cls; }

async function ingestInbox() {
  const inbox = (await storage.get("ehdl.inbox")) || [];
  if (inbox.length) { const cur = $("urls").value.trim(); $("urls").value = (cur ? cur + "\n" : "") + inbox.join("\n"); await storage.set("ehdl.inbox", []); }
}

// A newly-queued search URL arriving while the manager is already open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["ehdl.inbox"] && (changes["ehdl.inbox"].newValue || []).length) ingestInbox();
});

// --- pause / 509 gate ---
async function gate() { while ((state.paused || state.manualPause) && !state.userCancelled) await sleep(500); }

function trigger509() {
  state.quotaHit = false;          // consume the signal; the gate now holds all workers
  if (state.paused) return;        // a cooldown is already running
  state.paused = true;
  const until = Date.now() + COOLDOWN_MS;
  const tick = () => {
    if (state.userCancelled) { clearInterval(cooldownIv); cooldownIv = null; state.paused = false; return; }
    const left = until - Date.now();
    if (left <= 0) { clearInterval(cooldownIv); cooldownIv = null; state.paused = false; setStatus("Resuming after 509 cooldown..."); }
    else setStatus(`Image limit (509): paused, auto-resume in ${Math.ceil(left/60000)} min (or press Resume).`, "warn");
  };
  tick();
  cooldownIv = setInterval(tick, 5000);
}

function resumeNow() { if (cooldownIv) { clearInterval(cooldownIv); cooldownIv = null; } state.paused = false; state.manualPause = false; }

$("pick").onclick = async () => { dir = await pickOutputDir(); await persistDir(dir); $("start").disabled = false; setStatus("Output folder set."); };

$("start").onclick = async () => {
  if (!dir) { setStatus("Pick an output folder first.", "err"); return; }
  if (!(await ensurePermission(dir))) { setStatus("Folder write permission denied.", "err"); return; }
  const urls = $("urls").value.split(/\s+/).map((s)=>s.trim()).filter(Boolean);
  state.userCancelled=false; state.cancelled=false; state.paused=false; state.manualPause=false; state.quotaHit=false;

  if (urls.length) {
    job = new Job(storage);
    await job.init({ preferOriginal: $("orig").checked, imgConcurrency: +$("conc").value, galleryConcurrency: +$("gconc").value, delayMs: +$("delay").value });
    const galleries = [];
    for (const u of urls) {
      if (state.userCancelled) break;
      if (/\/g\/\d+\/[0-9a-f]+/.test(u)) galleries.push(u.replace(/(\/g\/\d+\/[0-9a-f]+).*/, "$1/"));
      else { setStatus(`Scanning ${u} ...`); galleries.push(...await collectGalleriesFromSearch(u, state, (p,n)=>setStatus(`Scanning ${u}: page ${p}, ${n} galleries`))); }
    }
    await job.addGalleries(galleries);
  } else if (!job || !(await job.pending()).length) {
    setStatus("Paste at least one URL, or load a prior job to resume.", "err"); return;
  } // else: resume the boot-loaded job as-is

  usedNames.clear();
  renderRows();
  $("start").classList.add("hidden"); $("pause").classList.remove("hidden"); $("cancel").classList.remove("hidden"); $("resume").classList.add("hidden");
  await pool(await job.pending(), job.data.settings.galleryConcurrency, (g)=>processGallery(g), ()=>{}, state, 0);
  setStatus(state.userCancelled ? "Cancelled — partial ZIPs left as .part; press Start to resume." : "All galleries processed.", state.userCancelled ? "err" : "ok");
  $("pause").classList.add("hidden"); $("resume").classList.add("hidden"); $("cancel").classList.add("hidden"); $("start").classList.remove("hidden");
};

async function processGallery(g) {
  if (state.userCancelled) return;
  await routeGallery(g);            // sets g.route (torrent path added in Task 7)
  if (g.route === "image") await imageRoute(g);
}

// Task 7 replaces this stub with real torrent routing; for now everything is image route.
async function routeGallery(g) { await job.setRoute(g.gid, "image"); updateRow(g); }

// One image page, resilient to 509: on quota it waits out the global cooldown and
// retries the SAME page (never counts a 509 as a failure). Genuine errors bubble up
// to the round-retry loop.
async function fetchOneImage(sUrl) {
  for (;;) {
    await gate();
    if (state.userCancelled) throw new Error("cancelled");
    try { return await fetchImage(sUrl, job.data.settings.preferOriginal, state); }
    catch (e) { if (state.quotaHit) { trigger509(); continue; } throw e; }
  }
}

async function imageRoute(g) {
  await job.setStatus(g.gid, "scanning"); updateRow(g);
  const { galleryUrl } = await resolveGallery(g.galleryUrl);
  const res = await collectImageLinks(galleryUrl, state, ()=>{});
  const links = res.links;
  const zipName = sanitizeUnique(res.title || g.gid, g.gid);
  if (await fileExists(dir, zipName)) { await job.setStatus(g.gid, "done", { title: res.title }); updateRow(g); return; }
  await job.setStatus(g.gid, "downloading", { title: res.title, image: { total: links.length, savedPages: [], failedPages: [] } });
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
      chain = chain.then(()=>zip.add(`${String(page).padStart(width,"0")}.${img.ext}`, img.data));
      await chain;
      remaining.delete(sUrl); saved++;
      updateRowProgress(g, saved, links.length);
    }, ()=>{}, state, job.data.settings.delayMs);
  }
  await chain; await zip.close(); await sink.done();
  await job.markImageProgress(g.gid, [...links].filter((l)=>!remaining.has(l)).map(pageNumOf), [...remaining].map(pageNumOf));
  if (remaining.size === 0 && !state.userCancelled) {
    await renameFile(dir, partName, zipName);
    await job.setStatus(g.gid, "done");
  } else {
    await job.setStatus(g.gid, state.userCancelled ? "cancelled" : "failed"); // .part remains; resume redoes this gallery
  }
  updateRow(g);
}

// Deterministic per-gallery name: title, disambiguated by gid on a title collision
// (gid is unique), so a resume reproduces the same filename.
const usedNames = new Set();
function sanitizeUnique(titleOrGid, gid){ const base = sanitize(titleOrGid); let name = base + ".zip"; if (usedNames.has(name)) name = `${base} [${gid}].zip`; usedNames.add(name); return name; }

// --- rendering ---
function renderRows(){ $("rows").innerHTML=""; job.data.galleries.forEach((g,i)=>{ const tr=document.createElement("tr"); tr.id="r"+g.gid; tr.innerHTML=`<td>${i+1}</td><td>${g.gid}</td><td class="route"></td><td class="st"></td><td><div class="bar"><div class="fill"></div></div></td>`; $("rows").appendChild(tr); updateRow(g); }); }
function updateRow(g){ const tr=$("r"+g.gid); if(!tr) return; tr.querySelector(".route").textContent=g.route; tr.querySelector(".st").textContent=g.status; }
function updateRowProgress(g, saved, total){ const tr=$("r"+g.gid); if(tr) tr.querySelector(".fill").style.width=Math.round(saved/total*100)+"%"; }

$("pause").onclick=()=>{ state.manualPause=true; $("pause").classList.add("hidden"); $("resume").classList.remove("hidden"); setStatus("Paused."); };
$("resume").onclick=()=>{ resumeNow(); $("resume").classList.add("hidden"); $("pause").classList.remove("hidden"); setStatus("Resumed."); };
$("cancel").onclick=()=>{ state.userCancelled=true; state.cancelled=true; resumeNow(); setStatus("Cancelling..."); };

// Resume a prior job on load (query-only permission check — requestPermission needs a gesture, done on Start).
(async function boot(){
  await ingestInbox();
  dir = await restoreDir();
  if (dir && await hasPermission(dir)) $("start").disabled=false;
  const j = new Job(storage);
  if (await j.load()){ job=j; renderRows(); setStatus("Previous job loaded — press Start to resume pending galleries (folder permission may re-prompt)."); }
})();
