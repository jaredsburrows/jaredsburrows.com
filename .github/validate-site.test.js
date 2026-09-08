#!/usr/bin/env node
// Regression tests for the embed-referrerpolicy invariant in
// `.github/validate-site.js` (fixed for B3/S1/S2 in 85cb0ab) and for the
// per-provider `allow` list in `static/js/home.js` (T5/S6, commit a64a111).
//
// Each mutation test copies the real site files into a scratch directory,
// applies one targeted mutation to a copy of home.js, and asserts the
// validator's exit code (and, where relevant, its stderr message) match what
// the invariant is supposed to catch. Nothing under the real repo tree is
// ever modified.
//
// Known gaps this suite documents rather than "fixes closed" (not one-line
// fixes; filed to .team/BUGS.md instead of touched here):
//   - B4: setAttribute('referrerpolicy', <strict value>) on an element other
//     than the embed iframe still satisfies the invariant.
//   - B5: the same call placed after `return frame;` (unreachable) still
//     satisfies the invariant.
//
// Usage: node .github/validate-site.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const validator = path.join(__dirname, 'validate-site.js');
// Full tree (minus VCS/tooling dirs) so the file-reference and _redirects-stub
// checks — unrelated to what these tests probe — see every asset they expect.
const skipTopLevel = new Set(['.git', '.github', '.idea', '.wrangler', 'node_modules']);
const originalHomeJs = fs.readFileSync(path.join(repoRoot, 'static/js/home.js'), 'utf8');

const REFERRERPOLICY_LINE = "    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');";
assert.ok(originalHomeJs.includes(REFERRERPOLICY_LINE),
  'fixture assumption broken: home.js no longer contains the expected referrerpolicy line verbatim');

let passed = 0;
let failed = 0;

const runValidator = (homeJsContent) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-site-test-'));
  try {
    for (const name of fs.readdirSync(repoRoot)) {
      if (skipTopLevel.has(name)) continue;
      fs.cpSync(path.join(repoRoot, name), path.join(tmp, name), { recursive: true });
    }
    fs.writeFileSync(path.join(tmp, 'static/js/home.js'), homeJsContent);
    try {
      const stdout = execFileSync('node', [validator, tmp], { encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

const test = (name, mutate, expectCode, expectStderrIncludes) => {
  let result;
  try {
    result = runValidator(mutate(originalHomeJs));
    assert.strictEqual(result.code, expectCode,
      `expected exit ${expectCode}, got ${result.code}\nstderr:\n${result.stderr}`);
    if (expectStderrIncludes) {
      assert.ok(result.stderr.includes(expectStderrIncludes),
        `expected stderr to include ${JSON.stringify(expectStderrIncludes)}\nstderr:\n${result.stderr}`);
    }
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(`  ${error.message}`);
    failed += 1;
  }
};

// --- Control: unmodified home.js must pass.
test('unmodified home.js passes', (src) => src, 0);

// --- B3 (fixed 85cb0ab): a //-commented call is inert and must fail closed.
test('// -commented referrerpolicy call fails closed', (src) =>
  src.replace(REFERRERPOLICY_LINE, `    // ${REFERRERPOLICY_LINE.trim()}`),
  1, 'without a live setAttribute');

// --- B3 (fixed 85cb0ab): a /* */ block-commented call must fail closed.
test('/* */ -commented referrerpolicy call fails closed', (src) =>
  src.replace(REFERRERPOLICY_LINE, `    /* ${REFERRERPOLICY_LINE.trim()} */`),
  1, 'without a live setAttribute');

// --- B3 (fixed 85cb0ab): a live weak value beside the strict literal
// surviving only in a comment must fail closed on the weak value.
test('live unsafe-url beside a commented-out strict literal fails closed', (src) =>
  src.replace(REFERRERPOLICY_LINE,
    `    // was: ${REFERRERPOLICY_LINE.trim()}\n    frame.setAttribute('referrerpolicy', 'unsafe-url');`),
  1, "sets referrerpolicy 'unsafe-url'");

// --- S1 (fixed 85cb0ab): the `.referrerPolicy =` property form with a weak
// value must fail closed.
test('.referrerPolicy = "no-referrer-when-downgrade" fails closed', (src) =>
  src.replace(REFERRERPOLICY_LINE, "    frame.referrerPolicy = 'no-referrer-when-downgrade';"),
  1, "sets referrerpolicy 'no-referrer-when-downgrade'");

// --- The `.referrerPolicy =` property form with the strict value must pass.
test('.referrerPolicy = "strict-origin-when-cross-origin" passes', (src) =>
  src.replace(REFERRERPOLICY_LINE, "    frame.referrerPolicy = 'strict-origin-when-cross-origin';"),
  0);

// --- S2 (fixed 85cb0ab): rewriting the embed URL paths (while keeping the
// hosts) plus deleting the attribute must still fail closed.
test('rewritten embed paths with the attribute deleted still fail closed', (src) => {
  let out = src.replace(`${REFERRERPOLICY_LINE}\n`, '');
  out = out.replace('youtube-nocookie.com/embed/', 'youtube-nocookie.com/watch/');
  out = out.replace(/speakerdeck\.com\/player\//g, 'speakerdeck.com/show/');
  return out;
}, 1, 'without a live setAttribute');

// --- Benign variant: double quotes + extra whitespace must still pass.
test('double-quoted / extra-whitespace call passes', (src) =>
  src.replace(REFERRERPOLICY_LINE,
    '    frame.setAttribute(  "referrerpolicy" ,   "strict-origin-when-cross-origin"  ) ;'),
  0);

// --- T5/S6: exact per-provider allow list at each embed() call site.
test('T5: Speaker Deck allow is fullscreen-only, YouTube unchanged', (src) => {
  const speakerdeckCall = /embed\(`https:\/\/speakerdeck\.com\/player\/[^`]+`,[^,]+,\s*\n?\s*'([^']+)'\)/;
  const youtubeCall = /embed\(`https:\/\/www\.youtube-nocookie\.com\/embed\/[^`]+`,[^,]+,\s*\n?\s*'([^']+)'\)/;
  const sd = src.match(speakerdeckCall);
  const yt = src.match(youtubeCall);
  assert.ok(sd, 'Speaker Deck embed() call not found');
  assert.ok(yt, 'YouTube embed() call not found');
  assert.strictEqual(sd[1], 'fullscreen', 'Speaker Deck allow list changed');
  assert.strictEqual(yt[1], 'fullscreen; encrypted-media; picture-in-picture', 'YouTube allow list changed');
  return src; // assertion-only: no mutation, must still validate clean
}, 0);

// --- Signature fallout: no embed() caller may omit the third `allow` arg
// (which would set the literal string "undefined" as the allow attribute).
test('no embed() call site omits the allow argument', (src) => {
  const calls = [...src.matchAll(/embed\(([\s\S]*?)\)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `expected at least 2 embed() calls, found ${calls.length}`);
  for (const args of calls) {
    const parts = args.split(',');
    assert.ok(parts.length >= 3, `embed() call missing allow argument: embed(${args})`);
    assert.ok(!/\bundefined\b/.test(args), `embed() call passes undefined: embed(${args})`);
  }
  return src;
}, 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
