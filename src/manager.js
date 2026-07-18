import { collectGalleriesFromSearch } from "./search.js";
import { resolveGallery, collectImageLinks, fetchImage, pool, pageNumOf, sanitize } from "./scrape.js";
import { ZipStreamWriter } from "./zip-stream.js";
import { pickOutputDir, zipSinkFor, fileExists, persistDir, restoreDir, ensurePermission } from "./output.js";
import { Job } from "./queue.js";

const $ = (id) => document.getElementById(id);
const storage = { async get(k){ return (await chrome.storage.local.get(k))[k]; }, async set(k,v){ await chrome.storage.local.set({ [k]: v }); } };
const state = { nw:false, cancelled:false, quotaHit:false, paused:false };
let dir = null, job = null;

function setStatus(t, cls=""){ $("status").textContent = t; $("status").className = cls; }

async function ingestInbox() {
  const inbox = (await storage.get("ehdl.inbox")) || [];
  if (inbox.length) { const cur = $("urls").value.trim(); $("urls").value = (cur ? cur + "\n" : "") + inbox.join("\n"); await storage.set("ehdl.inbox", []); }
}

$("pick").onclick = async () => { dir = await pickOutputDir(); await persistDir(dir); $("start").disabled = false; setStatus("Output folder set."); };

$("start").onclick = async () => {
  const urls = $("urls").value.split(/\s+/).map((s)=>s.trim()).filter(Boolean);
  if (!urls.length || !dir) return;
  job = new Job(storage);
  await job.init({ preferOriginal: $("orig").checked, imgConcurrency: +$("conc").value, galleryConcurrency: +$("gconc").value, delayMs: +$("delay").value });
  state.cancelled = false; state.paused = false;
  $("start").classList.add("hidden"); $("pause").classList.remove("hidden"); $("cancel").classList.remove("hidden");

  // Phase 1: discovery (search URLs expand; /g URLs pass through).
  const galleries = [];
  for (const u of urls) {
    if (/\/g\/\d+\/[0-9a-f]+/.test(u)) galleries.push(u.replace(/(\/g\/\d+\/[0-9a-f]+).*/, "$1/"));
    else { setStatus(`Scanning ${u} ...`); galleries.push(...await collectGalleriesFromSearch(u, state, (p,n)=>setStatus(`Scanning ${u}: page ${p}, ${n} galleries`))); }
  }
  await job.addGalleries(galleries);
  renderRows();

  // Phase 2: process galleries with gallery-level concurrency.
  const pend = await job.pending();
  await pool(pend, job.data.settings.galleryConcurrency, (g)=>processGallery(g), ()=>{}, state, 0);

  setStatus(state.cancelled ? "Cancelled." : "All galleries processed.", state.cancelled ? "err":"ok");
  $("pause").classList.add("hidden"); $("cancel").classList.add("hidden");
};

async function processGallery(g) {
  if (state.cancelled) return;
  await routeGallery(g);            // sets g.route (torrent path added Task 7)
  if (g.route === "image") await imageRoute(g);
}

// Task 7 replaces this stub with real torrent routing; for now everything is image route.
async function routeGallery(g) { await job.setRoute(g.gid, "image"); }

async function imageRoute(g) {
  const zipName = sanitizeUnique(g);
  if (await fileExists(dir, zipName)) { await job.setStatus(g.gid, "done"); updateRow(g); return; }
  await job.setStatus(g.gid, "scanning"); updateRow(g);
  const { galleryUrl } = await resolveGallery(g.galleryUrl);
  const res = await collectImageLinks(galleryUrl, state, ()=>{});
  const links = res.links;
  await job.setStatus(g.gid, "downloading", { title: res.title, image: { total: links.length, savedPages: [], failedPages: [] } });

  const sink = await zipSinkFor(dir, zipName);
  const zip = new ZipStreamWriter(sink.write);
  const width = String(links.length).length;
  let saved = 0; let chain = Promise.resolve();
  const remaining = new Set(links);
  const backoffs = [2000, 8000, 30000];
  for (let round = 0; round < 4 && remaining.size && !state.cancelled; round++) {
    if (round > 0) { await sleep(backoffs[Math.min(round-1, backoffs.length-1)]); }
    await pool([...remaining], job.data.settings.imgConcurrency, async (sUrl) => {
      await waitIfPaused();
      const img = await fetchImage(sUrl, job.data.settings.preferOriginal, state);
      const page = pageNumOf(sUrl);
      chain = chain.then(()=>zip.add(`${String(page).padStart(width,"0")}.${img.ext}`, img.data));
      await chain;
      remaining.delete(sUrl); saved++;
      updateRowProgress(g, saved, links.length);
    }, ()=>{}, state, job.data.settings.delayMs);
    if (state.quotaHit) { await handle509(); }   // pause + resume, then retry same round set
    if (state.quotaHit) { state.quotaHit = false; round--; }  // resumed: retry without consuming a round
  }
  await chain; await zip.close(); await sink.done();
  await job.markImageProgress(g.gid, [...links].filter((l)=>!remaining.has(l)).map(pageNumOf), [...remaining].map(pageNumOf));
  await job.setStatus(g.gid, remaining.size ? "failed" : "done");
  updateRow(g);
}

async function handle509() {
  state.paused = true; setStatus("Image limit (509) hit — pausing to let quota recover...", "warn");
  const COOLDOWN = 20*60*1000;
  await sleep(COOLDOWN);
  state.paused = false; setStatus("Resuming after cooldown...");
}
async function waitIfPaused(){ while (state.paused && !state.cancelled) await sleep(1000); }
const sleep = (ms) => new Promise((r)=>setTimeout(r, ms));

const usedNames = new Set();
function sanitizeUnique(g){ let base = sanitize(g.title || g.gid); let name = base + ".zip"; let i = 2; while (usedNames.has(name)) name = `${base} (${i++}).zip`; usedNames.add(name); return name; }

// --- rendering ---
function renderRows(){ $("rows").innerHTML=""; job.data.galleries.forEach((g,i)=>{ const tr=document.createElement("tr"); tr.id="r"+g.gid; tr.innerHTML=`<td>${i+1}</td><td>${g.gid}</td><td class="route"></td><td class="st"></td><td><div class="bar"><div class="fill"></div></div></td>`; $("rows").appendChild(tr); updateRow(g); }); }
function updateRow(g){ const tr=$("r"+g.gid); if(!tr) return; tr.querySelector(".route").textContent=g.route; tr.querySelector(".st").textContent=g.status; }
function updateRowProgress(g, saved, total){ const tr=$("r"+g.gid); if(tr) tr.querySelector(".fill").style.width=Math.round(saved/total*100)+"%"; }

$("pause").onclick=()=>{ state.paused=true; $("pause").classList.add("hidden"); $("resume").classList.remove("hidden"); };
$("resume").onclick=()=>{ state.paused=false; $("resume").classList.add("hidden"); $("pause").classList.remove("hidden"); };
$("cancel").onclick=()=>{ state.cancelled=true; };

// Resume a prior job on load.
(async function boot(){ await ingestInbox(); dir = await restoreDir(); if (dir && await ensurePermission(dir)) $("start").disabled=false; const j=new Job(storage); if (await j.load()){ job=j; renderRows(); setStatus("Previous job loaded — press Start to resume pending galleries."); } })();
