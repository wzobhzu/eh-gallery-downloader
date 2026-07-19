// Output directory management. Pick one directory (one dialog), then write each
// gallery's ZIP into it with no further prompts. The handle is persisted in
// IndexedDB (structured-cloneable) so a resumed session can re-acquire it.
const IDB_DB = "ehdl";
const IDB_STORE = "handles";
const IDB_KEY = "outputDir";

export async function pickOutputDir() {
  return window.showDirectoryPicker({ id: "ehdl-out", mode: "readwrite", startIn: "downloads" });
}

export async function zipSinkFor(dirHandle, filename) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  return { write: (u) => writable.write(u), done: () => writable.close() };
}

export async function saveBytes(dirHandle, relPath, bytes) {
  const parts = relPath.split("/");
  let dir = dirHandle;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

export async function fileExists(dirHandle, name) {
  try { await dirHandle.getFileHandle(name); return true; } catch { return false; }
}

function idb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function persistDir(dirHandle) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dirHandle, IDB_KEY);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function restoreDir() {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}

export async function ensurePermission(dirHandle) {
  if (!dirHandle) return false;
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

// Atomic rename within the same directory. Requires Chromium 110+ (declared via
// manifest minimum_chrome_version) so FileSystemFileHandle.move is always present —
// no non-atomic copy fallback that could leave a truncated final-named file.
export async function renameFile(dirHandle, fromName, toName) {
  const fh = await dirHandle.getFileHandle(fromName);
  await fh.move(toName);
}

// Query-only permission check (no user gesture) for use during boot/resume.
export async function hasPermission(dirHandle) {
  if (!dirHandle) return false;
  return (await dirHandle.queryPermission({ mode: "readwrite" })) === "granted";
}

// Get/create a per-gallery subfolder handle for loose-image output.
export async function subDir(dirHandle, name) { return dirHandle.getDirectoryHandle(name, { create: true }); }

// Basenames (page number, extension stripped) of files already in a folder — for per-image resume.
export async function existingBasenames(subHandle) {
  const set = new Set();
  for await (const entry of subHandle.values()) {
    if (entry.kind === "file") set.add(entry.name.replace(/\.[a-z0-9]+$/i, ""));
  }
  return set;
}
