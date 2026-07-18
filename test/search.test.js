import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { docFromFixture } from "./smoke.test.js";
import { parseSearchGalleries, nextCursorUrl, collectGalleriesFromSearch } from "../src/search.js";

test("parseSearchGalleries extracts canonical, deduped gallery URLs", () => {
  const doc = docFromFixture("search-results.html");
  const urls = parseSearchGalleries(doc, "https://e-hentai.org");
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => /^https:\/\/e-hentai\.org\/g\/\d+\/[0-9a-f]+\/$/.test(u)));
  assert.equal(urls.length, new Set(urls).size, "must be deduped");
});

test("parseSearchGalleries dedupes a repeated gallery href within one page", () => {
  const html = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/111/aaaaaaaaaa/">A</a></td></tr>
    <tr><td><a href="https://e-hentai.org/g/111/aaaaaaaaaa/">A again (thumbnail link)</a></td></tr>
  </table>`;
  const doc = parseHTML(html).document;
  const urls = parseSearchGalleries(doc, "https://e-hentai.org");
  assert.equal(urls.length, 1, "same gid href repeated on page must be deduped");
});

test("nextCursorUrl returns a next= cursor URL when present", () => {
  const doc = docFromFixture("search-results.html");
  const next = nextCursorUrl(doc, "https://e-hentai.org/?f_search=x");
  assert.ok(next === null || /[?&]next=\d+/.test(next));
});

test("nextCursorUrl returns null at end-of-results (span, not anchor)", () => {
  const html = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/300/aaaaaaaaaa/">C</a></td></tr>
  </table>
  <span id="unext">Next &gt;</span>`;
  const doc = parseHTML(html).document;
  const next = nextCursorUrl(doc, "https://e-hentai.org/?f_search=x&next=200");
  assert.equal(next, null, "span (no href) at #unext must be treated as authoritative end-of-results");
});

test("collectGalleriesFromSearch walks pages, dedups across pages, and stops at end-of-results", async () => {
  const page1 = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/100/aaaaaaaaaa/">A</a></td></tr>
    <tr><td><a href="https://e-hentai.org/g/200/bbbbbbbbbb/">B</a></td></tr>
  </table>
  <a id="unext" href="https://e-hentai.org/?f_search=x&next=200">Next &gt;</a>`;
  const page2 = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/200/bbbbbbbbbb/">B</a></td></tr>
    <tr><td><a href="https://e-hentai.org/g/300/cccccccccc/">C</a></td></tr>
  </table>
  <span id="unext">Next &gt;</span>`;

  let calls = 0;
  const fakeFetchDoc = async () => {
    calls++;
    const html = calls === 1 ? page1 : page2;
    return parseHTML(html).document;
  };

  const state = { cancelled: false };
  const pages = [];
  const onPage = (page, count, extra) => pages.push({ page, count, extra });

  const urls = await collectGalleriesFromSearch(
    "https://e-hentai.org/?f_search=x",
    state,
    onPage,
    { fetchDoc: fakeFetchDoc },
  );

  assert.deepEqual(
    urls,
    [
      "https://e-hentai.org/g/100/aaaaaaaaaa/",
      "https://e-hentai.org/g/200/bbbbbbbbbb/",
      "https://e-hentai.org/g/300/cccccccccc/",
    ],
    "expected A,B,C in order with B deduped across pages",
  );
  assert.equal(calls, 2, "walk must stop after end-of-results page, not fetch a 3rd page");
});

test("collectGalleriesFromSearch stops early when state.cancelled is set mid-walk", async () => {
  const page1 = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/100/aaaaaaaaaa/">A</a></td></tr>
  </table>
  <a id="unext" href="https://e-hentai.org/?f_search=x&next=100">Next &gt;</a>`;

  const state = { cancelled: false };
  let calls = 0;
  const fakeFetchDoc = async () => {
    calls++;
    state.cancelled = true; // cancel after the first page is fetched
    return parseHTML(page1).document;
  };

  const urls = await collectGalleriesFromSearch(
    "https://e-hentai.org/?f_search=x",
    state,
    () => {},
    { fetchDoc: fakeFetchDoc },
  );

  assert.deepEqual(urls, ["https://e-hentai.org/g/100/aaaaaaaaaa/"]);
  assert.equal(calls, 1, "cancellation must prevent fetching further pages");
});

test("collectGalleriesFromSearch reports truncated:true via onPage when maxPages caps a longer walk", async () => {
  const page1 = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/100/aaaaaaaaaa/">A</a></td></tr>
  </table>
  <a id="unext" href="https://e-hentai.org/?f_search=x&next=100">Next &gt;</a>`;
  const page2 = `<table class="itg">
    <tr><td><a href="https://e-hentai.org/g/200/bbbbbbbbbb/">B</a></td></tr>
  </table>
  <a id="unext" href="https://e-hentai.org/?f_search=x&next=200">Next &gt;</a>`;

  let calls = 0;
  const fakeFetchDoc = async () => {
    calls++;
    return parseHTML(calls === 1 ? page1 : page2).document;
  };

  const state = { cancelled: false };
  const pages = [];
  const onPage = (page, count, extra) => pages.push({ page, count, extra });

  await collectGalleriesFromSearch(
    "https://e-hentai.org/?f_search=x",
    state,
    onPage,
    { fetchDoc: fakeFetchDoc, maxPages: 1 },
  );

  assert.equal(calls, 1, "must not fetch beyond maxPages");
  const truncatedCall = pages.find((p) => p.extra && p.extra.truncated);
  assert.ok(truncatedCall, "onPage must be called with a third arg {truncated:true} when more pages exist beyond the cap");
  assert.equal(truncatedCall.page, 1);
  assert.equal(truncatedCall.count, 1);
});
