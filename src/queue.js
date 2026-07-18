// Job/queue model persisted through a storage adapter. In the browser the adapter
// wraps chrome.storage.local; in tests it is an in-memory Map. Resume granularity
// is per gallery: a gallery is only "done" once its ZIP is fully closed / torrent
// reaches 100%.
const KEY = "ehdl.job";
const GID = /\/g\/(\d+)\/([0-9a-f]+)/;

export class Job {
  constructor(storage) { this.storage = storage; this.data = null; }

  async init(settings) {
    this.data = { createdAt: new Date().toISOString(), settings: settings || {}, galleries: [] };
    await this.save();
  }

  async load() { this.data = (await this.storage.get(KEY)) || null; return this.data; }
  async save() { await this.storage.set(KEY, this.data); }

  async addGalleries(urls) {
    const seen = new Set(this.data.galleries.map((g) => g.gid));
    for (const url of urls) {
      const m = url.match(GID); if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      this.data.galleries.push({ galleryUrl: url, gid: m[1], title: "", route: "pending", status: "queued", torrent: null, image: { total: 0, savedPages: [], failedPages: [] } });
    }
    await this.save();
  }

  _g(gid) { return this.data.galleries.find((g) => g.gid === String(gid)); }
  get(gid) { return this._g(gid); }
  async setRoute(gid, route) { this._g(gid).route = route; await this.save(); }
  async setStatus(gid, status, extra) { Object.assign(this._g(gid), { status }, extra || {}); await this.save(); }
  async markImageProgress(gid, savedPages, failedPages) { const g = this._g(gid); g.image.savedPages = savedPages; g.image.failedPages = failedPages; await this.save(); }
  isDone(gid) { const g = this._g(gid); return !!g && g.status === "done"; }
  async pending() { return this.data.galleries.filter((g) => g.status !== "done"); }
}
