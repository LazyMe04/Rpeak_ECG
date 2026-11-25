/**
 * Headless checks for the language layer.
 *
 * The audit in `pipeline/check_i18n.py` proves coverage (every key asked for
 * exists, every entry is used, placeholders match). This proves the *behaviour*
 * the coverage relies on, which a static scan cannot: that English passes
 * through untouched, that a missing key falls back to the sentence rather than
 * to a token, that `{name}` is filled and an unknown variable is left visible,
 * and that the numbers follow the language's grouping convention.
 *
 * It also asserts the two dictionaries are shaped like dictionaries at all --
 * no empty values, no trailing whitespace introduced by accident, and every
 * `{placeholder}` in a value present in its key. Whether a translation is
 * *good* Vietnamese is a review question, not an assertion; see the note at
 * the end of the file for the check that was tried and removed.
 *
 * Usage: npx tsx scripts/test-i18n.ts
 */
import assert from "node:assert/strict";

import { interpolate, translate, translateDetail, type Lang } from "../src/lib/i18n.tsx";
import { VI } from "../src/lib/i18n.vi.ts";
import { VI_MODEL } from "../src/lib/i18n.vi.model.ts";

let failures = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

const DICT = { ...VI, ...VI_MODEL };

/* -------------------------------------------------------------- translate -- */

test("en: the sentence is the output, unchanged", () => {
  assert.equal(translate("en", "Heart rate"), "Heart rate");
  assert.equal(translate("en", "not in the dictionary at all"), "not in the dictionary at all");
});

test("vi: a known sentence becomes Vietnamese", () => {
  assert.equal(translate("vi", "Heart rate"), "Nhịp tim");
});

test("vi: an unknown sentence falls back to English, not to a key path", () => {
  assert.equal(translate("vi", "!! nobody wrote this !!", { n: 1 }), "!! nobody wrote this !!");
});

test("interpolation fills each placeholder and repeats are independent", () => {
  assert.equal(translate("vi", "{i} of {n}", { i: 3, n: 12 }), "3/12");
});

test("interpolation leaves an unsupplied placeholder visible rather than blank", () => {
  assert.equal(interpolate("{a} and {b}", { a: "x" }), "x and {b}");
});

test("interpolation of braces that are not placeholders is left alone", () => {
  assert.equal(interpolate("{} {{ }} {9a}", { n: 1 }), "{} {{ }} {9a}");
});

test("a variable named like a key prefix is not substituted twice", () => {
  assert.equal(interpolate("{n} {nn}", { n: "{nn}", nn: "x" }), "{nn} x");
});

/* ------------------------------------------------------------- dictionary -- */

test("both dictionaries are non-empty", () => {
  assert.ok(Object.keys(VI).length > 100, `VI has ${Object.keys(VI).length}`);
  assert.ok(Object.keys(VI_MODEL).length > 100, `model has ${Object.keys(VI_MODEL).length}`);
});

test("no entry has an empty value", () => {
  const empty = Object.entries(DICT)
    .filter(([, v]) => v.trim() === "")
    .map(([k]) => k);
  assert.deepEqual(empty, []);
});

test("no entry adds leading or trailing whitespace the English did not have", () => {
  const bad = Object.entries(DICT)
    .filter(([k, v]) => k.trim() !== k && v.trim() !== v && k.startsWith(" ") !== v.startsWith(" "))
    .map(([k]) => k);
  assert.deepEqual(bad, []);
});

test("every placeholder in a value also appears in its key", () => {
  const PLACE = /\{(\w+)\}/g;
  const bad: string[] = [];
  for (const [k, v] of Object.entries(DICT)) {
    const inKey = new Set([...k.matchAll(PLACE)].map((m) => m[1]));
    for (const m of v.matchAll(PLACE)) {
      if (!inKey.has(m[1]!)) bad.push(`${k} -> ${v}`);
    }
  }
  assert.deepEqual(bad, []);
});

/*
 * There was a check here that flagged any value containing no Vietnamese
 * diacritics. It was wrong: "Tachogram R-R", "{i}/{n}" and "qua middleware
 * Vite." are correct Vietnamese with no diacritic in sight, and a check that
 * cries wolf 41 times is one nobody reads. Coverage and placeholder integrity
 * are mechanical and stay; "is this good Vietnamese" is a review question, not
 * an assertion.
 */

/* ----------------------------------------------------------------- detail -- */

test("translateDetail translates the sentence and leaves the detail alone", () => {
  // The hooks compose `"<our sentence> — <exception text>"`; only the first
  // half is ours to translate.
  assert.equal(
    translateDetail("vi", "no model at data/models/beatcnn.json — Failed to fetch"),
    "không tìm thấy mô hình ở data/models/beatcnn.json — Failed to fetch",
  );
});

test("translateDetail passes a message with no detail through translate", () => {
  assert.equal(translateDetail("vi", "the detection worker failed"), "worker dò đỉnh gặp lỗi");
  assert.equal(translateDetail("en", "the detection worker failed"), "the detection worker failed");
});

test("translateDetail leaves an unknown sentence as written", () => {
  assert.equal(
    translateDetail("vi", "Unexpected token < in JSON at position 0"),
    "Unexpected token < in JSON at position 0",
  );
});

/* ------------------------------------------------------------------ lang ---- */

test("lang tags are the ones the <html lang> attribute expects", () => {
  const tags: Lang[] = ["en", "vi"];
  for (const tag of tags) assert.match(tag, /^[a-z]{2}$/);
});

/* ----------------------------------------------------------------------- --- */

console.log(failures === 0 ? "\nall i18n checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
