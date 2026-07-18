import { test } from "node:test";
import assert from "node:assert/strict";
import { docFromFixture } from "./smoke.test.js";
import { parseSearchGalleries, nextCursorUrl } from "../src/search.js";

test("parseSearchGalleries extracts canonical, deduped gallery URLs", () => {
  const doc = docFromFixture("search-results.html");
  const urls = parseSearchGalleries(doc, "https://e-hentai.org");
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => /^https:\/\/e-hentai\.org\/g\/\d+\/[0-9a-f]+\/$/.test(u)));
  assert.equal(urls.length, new Set(urls).size, "must be deduped");
});

test("nextCursorUrl returns a next= cursor URL when present", () => {
  const doc = docFromFixture("search-results.html");
  const next = nextCursorUrl(doc, "https://e-hentai.org/?f_search=x");
  assert.ok(next === null || /[?&]next=\d+/.test(next));
});
