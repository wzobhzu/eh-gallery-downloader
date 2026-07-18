import { test } from "node:test";
import assert from "node:assert/strict";
import { Job } from "../src/queue.js";

function memStorage() {
  const m = new Map();
  return { async get(k) { return m.get(k); }, async set(k, v) { m.set(k, v); } };
}

test("Job persists galleries and resumes pending, skipping done", async () => {
  const s = memStorage();
  const j = new Job(s);
  await j.init({ preferOriginal: true });
  await j.addGalleries(["https://e-hentai.org/g/1/aa/", "https://e-hentai.org/g/2/bb/"]);
  await j.setStatus("1", "done");
  assert.deepEqual((await j.pending()).map((g) => g.gid), ["2"]);

  const j2 = new Job(s);
  await j2.load();
  assert.equal(j2.isDone("1"), true);
  assert.deepEqual((await j2.pending()).map((g) => g.gid), ["2"]);
});
