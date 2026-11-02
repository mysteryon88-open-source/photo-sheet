import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the browser entry point loads without an HTTP server", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<script defer src="photo-sheet\.js\?v=20261102-selection-fit"><\/script>/);
  assert.doesNotMatch(html, /<script[^>]+type="module"/);
  await assert.doesNotReject(readFile(new URL("../photo-sheet.js", import.meta.url), "utf8"));
});
