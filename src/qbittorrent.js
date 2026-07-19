// qBittorrent Web API v2 bridge. Called from the manager extension page, which
// (with http://127.0.0.1:8080/* in host_permissions) can read localhost responses
// cross-origin. qBittorrent is configured to bypass auth for localhost, so no
// login call is needed. Localhost is exempt from mixed-content blocking.
//
// Every request is abort-bounded: qBittorrent can accept the TCP connection and then
// never answer (mid-shutdown, hung on a large re-hash, blocked Web UI thread). A bare
// fetch() then never settles, which wedges monitorTorrents() and makes the whole run
// unkillable — cancel flags can't break an await that never resolves.
const QB_TIMEOUT_MS = 15000; // qBittorrent is local; a longer wait means it is wedged, not slow

export class QbClient {
  constructor({ base = "http://127.0.0.1:8080" } = {}) {
    this.base = base.replace(/\/$/, "");
  }

  async available() {
    try {
      const r = await fetch(`${this.base}/api/v2/app/version`, { signal: AbortSignal.timeout(QB_TIMEOUT_MS) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async addTorrent(bytes, { savepath, category = "eh-bulk", rename } = {}) {
    const fd = new FormData();
    fd.append("torrents", new Blob([bytes], { type: "application/x-bittorrent" }), "g.torrent");
    if (savepath) fd.append("savepath", savepath);
    if (category) fd.append("category", category);
    if (rename) fd.append("rename", rename);
    const r = await fetch(`${this.base}/api/v2/torrents/add`, { method: "POST", body: fd, signal: AbortSignal.timeout(QB_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`qB add HTTP ${r.status}`);
  }

  async info(hashes) {
    const q = hashes ? `?hashes=${Array.isArray(hashes) ? hashes.join("|") : hashes}` : "";
    const r = await fetch(`${this.base}/api/v2/torrents/info${q}`, { signal: AbortSignal.timeout(QB_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`qB info HTTP ${r.status}`);
    return r.json();
  }

  async deleteTorrent(hashes, deleteFiles = true) {
    const fd = new FormData();
    fd.append("hashes", Array.isArray(hashes) ? hashes.join("|") : hashes);
    fd.append("deleteFiles", String(deleteFiles));
    const r = await fetch(`${this.base}/api/v2/torrents/delete`, { method: "POST", body: fd, signal: AbortSignal.timeout(QB_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`qB delete HTTP ${r.status}`);
  }

  async recheck(hashes) {
    const fd = new FormData();
    fd.append("hashes", Array.isArray(hashes) ? hashes.join("|") : hashes);
    const r = await fetch(`${this.base}/api/v2/torrents/recheck`, { method: "POST", body: fd, signal: AbortSignal.timeout(QB_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`qB recheck HTTP ${r.status}`);
  }

  stalled(t) {
    return t && t.state === "stalledDL" && (t.num_seeds || 0) === 0;
  }
}
