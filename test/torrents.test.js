import { test } from "node:test";
import assert from "node:assert/strict";
import { docFromFixture } from "./smoke.test.js";
import { parseTorrents, pickBestTorrent, torrentsUrlFor } from "../src/torrents.js";

test("torrentsUrlFor builds gallerytorrents.php URL", () => {
  const u = torrentsUrlFor("https://e-hentai.org/g/4060130/956b387c89/");
  assert.equal(u, "https://e-hentai.org/gallerytorrents.php?gid=4060130&t=956b387c89");
});

test("parseTorrents extracts infohash from ehtracker URL and seed counts", () => {
  const doc = docFromFixture("gallerytorrents.html");
  const ts = parseTorrents(doc);
  assert.ok(ts.length >= 1);
  assert.ok(/^[0-9a-f]{40}$/.test(ts[0].infohash));
  assert.ok(Number.isInteger(ts[0].seeds));
});

test("pickBestTorrent returns highest seeded, null when all dead", () => {
  const best = pickBestTorrent([
    { seeds: 0, infohash: "a" }, { seeds: 5, infohash: "b" }, { seeds: 2, infohash: "c" },
  ]);
  assert.equal(best.infohash, "b");
  assert.equal(pickBestTorrent([{ seeds: 0 }, { seeds: 0 }]), null);
  assert.equal(pickBestTorrent([]), null);
});
