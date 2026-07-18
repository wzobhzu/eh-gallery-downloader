import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

export function docFromFixture(name) {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return parseHTML(html).document;
}

test("fixtures load and expose gallery links", () => {
  const doc = docFromFixture("search-results.html");
  const links = [...doc.querySelectorAll('a[href*="/g/"]')];
  assert.ok(links.length > 0, "expected at least one gallery link in fixture");
});
