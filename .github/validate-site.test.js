#!/usr/bin/env node
// Regression tests for the cross-file invariants in
// `.github/validate-site.js`: the per-provider `allow` list in
// `static/js/home.js` (T5/S6, commit a64a111), CSP coverage, file references,
// JSON-LD, the markdown twin, the API catalog, the ARD manifest, the Q14 OAuth
// pins, `_headers` overlap and `_redirects` syntax.
//
// Each mutation test copies the real site files into a scratch directory,
// applies one targeted mutation to a copy, and asserts the validator's exit
// code (and, where relevant, its stderr message) match what the invariant is
// supposed to catch. Nothing under the real repo tree is ever modified.
//
// The embed-referrerpolicy cases that used to lead this file are gone with the
// text scan they covered (B3-B5, B7-B12, S23-S28). That invariant is now a
// behavioral one: `.github/embed-referrerpolicy.test.mjs` mounts the page in a
// DOM and reads the iframes it really built.
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
// Full tree (minus VCS/tooling dirs) so the file-reference check — unrelated to
// what these tests probe — sees every asset it expects.
const skipTopLevel = new Set(['.git', '.github', '.idea', '.wrangler', 'node_modules']);
const originalHomeJs = fs.readFileSync(path.join(repoRoot, 'static/js/home.js'), 'utf8');

const originalHeaders = fs.readFileSync(path.join(repoRoot, '_headers'), 'utf8');
const originalIndexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

// The homepage description is written twice — index.html's <meta
// name="description"> and index.md's summary blockquote — and validate-site.js
// pins them to each other byte for byte (T5a/B3). So these belong to the whole
// file, not to one block: any fixture that rewrites one copy must rewrite the
// other, or it trips the drift guard instead of the invariant it meant to test.
const originalIndexMd = fs.readFileSync(path.join(repoRoot, 'index.md'), 'utf8');
const META_DESCRIPTION = (originalIndexHtml.match(/<meta name="description" content="([^"]*)">/) ?? [])[1];
assert.ok(META_DESCRIPTION, 'fixture assumption broken: index.html has no <meta name="description">');
// B3: the description is the twin's summary blockquote, not its first
// paragraph — anything under it carries only what the summary does not say.
// Read as "the block after the H1", never as a hardcoded line range: the
// summary is soft-wrapped, so a re-wrap or a longer description changes how
// many lines it occupies, and a slice would then compare the wrong text —
// a test that passes for the wrong reason rather than one that fails loudly.
/** @param {string} markdown @returns {string[]} */
const blockAfterH1 = (markdown) => {
  const lines = markdown.split('\n').slice(1);
  const start = lines.findIndex((line) => line.trim() !== '');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '');
  return lines.slice(start, end === -1 ? undefined : end);
};
const SUMMARY_BLOCKQUOTE = blockAfterH1(originalIndexMd);
assert.strictEqual(
  SUMMARY_BLOCKQUOTE.map((line) => line.trim().replace(/^>[ \t]?/, '')).join(' '), META_DESCRIPTION,
  'fixture assumption broken: index.md no longer quotes the meta description as its summary blockquote');
assert.ok(SUMMARY_BLOCKQUOTE.every((line) => line.startsWith('> ')),
  'fixture assumption broken: index.md summary is no longer a blockquote');

// Rewrite the description in both places at once, for tests that are about
// something else and only need it to hold still. Tests that are about the drift
// guard itself deliberately edit one side and must not use this. Replacements
// are functions so a `$` in the text stays literal.
/** @param {string} text @returns {Record<string, string>} */
const withDescription = (text) => ({
  'index.html': originalIndexHtml.replace(/(name="description" content=)"[^"]+"/, (_, lead) => `${lead}"${text}"`),
  'index.md': originalIndexMd.replace(SUMMARY_BLOCKQUOTE.join('\n'), () => `> ${text}`),
});

// The measurement endpoints the CSP must list. `_headers` is production and
// index.html mirrors it, so a source has to be dropped from both at once or the
// parity check fires first and masks the coverage check under test.
const MEASUREMENT_SOURCES = [
  'https://analytics.google.com',
  'https://stats.g.doubleclick.net',
  'https://www.google.com',
];
// The edge-injected Cloudflare beacon origins. Same shape as above, but these
// back an unconditional requirement: nothing in the markup implies them.
const EDGE_INJECTED_SOURCES = [
  'https://static.cloudflareinsights.com',
  'https://cloudflareinsights.com',
];
for (const source of [...MEASUREMENT_SOURCES, ...EDGE_INJECTED_SOURCES]) {
  for (const [name, content] of [['_headers', originalHeaders], ['index.html', originalIndexHtml]]) {
    assert.ok(content.includes(` ${source} `),
      `fixture assumption broken: ${name} no longer lists ${source} in its CSP`);
  }
}

let passed = 0;
let failed = 0;

// `overrides` maps a repo-relative path to the content to write over its copy,
// or to `null` to delete it — a missing file is its own failure mode, and
// writing empty content does not exercise it.
/**
 * @param {Record<string, string | null>} overrides Repo-relative path to the
 *   content to write over its copy, or null to delete it.
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
const runValidator = (overrides) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-site-test-'));
  try {
    for (const name of fs.readdirSync(repoRoot)) {
      if (skipTopLevel.has(name)) continue;
      fs.cpSync(path.join(repoRoot, name), path.join(tmp, name), { recursive: true });
    }
    for (const [name, content] of Object.entries(overrides)) {
      if (content === null) fs.rmSync(path.join(tmp, name), { force: true });
      else fs.writeFileSync(path.join(tmp, name), content);
    }
    try {
      const stdout = execFileSync('node', [validator, tmp], { encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      // execFileSync throws an Error carrying the child's exit status and pipes.
      const failure = /** @type {{ status: number, stdout?: string, stderr?: string }} */ (error);
      return { code: failure.status, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

/**
 * @param {string} name
 * @param {(src: string) => string} mutate Applied to static/js/home.js.
 * @param {number} expectCode
 * @param {string} [expectStderrIncludes]
 */
const test = (name, mutate, expectCode, expectStderrIncludes) => {
  let result;
  try {
    result = runValidator({ 'static/js/home.js': mutate(originalHomeJs) });
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
    console.error(`  ${/** @type {Error} */ (error).message}`);
    failed += 1;
  }
};

// --- Control: unmodified home.js must pass.
test('unmodified home.js passes', (src) => src, 0);

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

// --- Measurement CSP coverage: gtag.js fans /g/collect out to hosts that
// appear nowhere in the markup, so only an explicit list catches a missing one.
// Every case below was blocked in production (PageSpeed console, Sept 2026).
// `expectStderrIncludes` takes one substring or a list of them — a list is how
// a case proves that a later, unrelated invariant still ran (S20).
/**
 * @param {string} name
 * @param {Record<string, string | null>} overrides
 * @param {number} expectCode
 * @param {string | string[]} [expectStderrIncludes] One substring or a list.
 */
const testFiles = (name, overrides, expectCode, expectStderrIncludes) => {
  let result;
  try {
    result = runValidator(overrides);
    assert.strictEqual(result.code, expectCode,
      `expected exit ${expectCode}, got ${result.code}\nstderr:\n${result.stderr}`);
    for (const expected of [expectStderrIncludes ?? []].flat()) {
      assert.ok(result.stderr.includes(expected),
        `expected stderr to include ${JSON.stringify(expected)}\nstderr:\n${result.stderr}`);
    }
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(`  ${/** @type {Error} */ (error).message}`);
    failed += 1;
  }
};

// Drop sources from both the _headers policy and its index.html mirror at once,
// so CSP parity still holds and the coverage check is what fails.
/** @param {string[]} sources @returns {Record<string, string>} */
const dropSources = (sources) => {
  /** @param {string} content */
  const strip = (content) => sources.reduce((out, source) => out.split(` ${source} `).join(' '), content);
  return { '_headers': strip(originalHeaders), 'index.html': strip(originalIndexHtml) };
};

for (const source of MEASUREMENT_SOURCES) {
  testFiles(`dropping ${source} from connect-src fails closed`,
    dropSources([source]), 1, `connect-src does not allow ${source}`);
}

// The apex case specifically: `https://*.analytics.google.com` stays in the
// policy here, and must NOT be accepted as covering `analytics.google.com` —
// a `*.` source requires at least one label in front of the pattern.
testFiles('the *.analytics.google.com wildcard does not satisfy the apex requirement',
  dropSources(['https://analytics.google.com']), 1,
  'connect-src does not allow https://analytics.google.com');

// Gate: with no gtag.js/gtm.js load in index.html the requirement drops out
// instead of freezing a host list into a site that no longer measures.
testFiles('removing the tag loads drops the measurement requirement', (() => {
  /** @param {string} content */
  const neutralize = (content) =>
    content.replace(/googletagmanager\.com\/(?:gtag\/js|gtm\.js)/g, 'googletagmanager.com/ns.html');
  const dropped = dropSources(MEASUREMENT_SOURCES);
  return { ...dropped, 'index.html': neutralize(dropped['index.html']) };
})(), 0);

// The gate matches the loader by parsed host and path, so a URL that merely
// contains the tag host as a substring must not switch the requirement on.
// An unanchored /googletagmanager\.com\/gtm\.js/ over the raw HTML accepted
// both of these (CodeQL js/regex/missing-regexp-anchor, alert 5).
// The lookalike goes in GTM's inline loader string rather than a src
// attribute, so the script-src coverage loop stays out of the result.
for (const lookalike of [
  'https://notgoogletagmanager.com/gtm.js',
  'https://evil.example/?x=googletagmanager.com/gtm.js',
]) {
  testFiles(`${lookalike} does not satisfy the tag-load gate`, (() => {
    const dropped = dropSources(MEASUREMENT_SOURCES);
    const html = dropped['index.html']
      .replace('googletagmanager.com/gtag/js', 'googletagmanager.com/ns.html')
      .replace('https://www.googletagmanager.com/gtm.js', lookalike);
    assert.ok(html.includes(lookalike), `fixture assumption broken: ${lookalike} was not substituted in`);
    return { ...dropped, 'index.html': html };
  })(), 0);
}

// --- Edge-injected CSP coverage: Cloudflare adds the Web Analytics beacon to
// the HTML at the edge, so index.html never mentions it and only an explicit
// list catches a missing source. Blocked in production until listed
// (PageSpeed console, September 2026).
for (const [source, directive] of [
  ['https://static.cloudflareinsights.com', 'script-src'],
  ['https://cloudflareinsights.com', 'connect-src'],
]) {
  testFiles(`dropping ${source} from ${directive} fails closed`,
    dropSources([source]), 1, `${directive} does not allow ${source}`);
}

// The two origins are distinct hosts, not one covering the other: dropping the
// apex must not be masked by `static.` still being listed, and neither is a
// `*.` wildcard that could swallow the other.
testFiles('static.cloudflareinsights.com does not satisfy the apex connect-src requirement',
  dropSources(['https://cloudflareinsights.com']), 1,
  'connect-src does not allow https://cloudflareinsights.com');

// Unlike the measurement hosts this requirement is ungated on purpose — the
// injection is a Cloudflare zone setting with no in-repo signal — so removing
// the tag loads must NOT drop it the way it drops the measurement list.
testFiles('the beacon requirement survives removing the gtag/gtm loads', (() => {
  /** @param {string} content */
  const neutralize = (content) =>
    content.replace(/googletagmanager\.com\/(?:gtag\/js|gtm\.js)/g, 'googletagmanager.com/ns.html');
  const dropped = dropSources(EDGE_INJECTED_SOURCES);
  return { ...dropped, 'index.html': neutralize(dropped['index.html']) };
})(), 1, 'script-src does not allow https://static.cloudflareinsights.com');

// --- RFC 9727 API catalog. The catalog, the OpenAPI description and
// api/talks.json are three files that all restate the same facts, and nothing
// at runtime notices when one drifts: a stale talks.json serves last year's
// talks forever, and a catalog href to a deleted file is a 404 an agent finds
// before a human does.
const originalCatalog = fs.readFileSync(path.join(repoRoot, '.well-known/api-catalog'), 'utf8');
const originalTalksJs = fs.readFileSync(path.join(repoRoot, 'static/js/talks.js'), 'utf8');
assert.ok(originalCatalog.includes('https://jaredsburrows.com/api/openapi.json'),
  'fixture assumption broken: the catalog no longer links api/openapi.json');
assert.ok(originalHeaders.includes('application/linkset+json'),
  'fixture assumption broken: _headers no longer sets the linkset content type');

// The realistic drift: README says "add a talk by adding one entry to
// talks.js", so the entry that never reaches api/talks.json is the regression
// to catch.
testFiles('a talk added to talks.js but not api/talks.json fails closed', {
  'static/js/talks.js': originalTalksJs.replace(
    'window.TALKS = [',
    "window.TALKS = [\n  {\n    date: '2018-01-01',\n    title: 'Unpublished',\n    where: 'Nowhere',\n    youtube: 'aaaaaaaaaaa'\n  },"),
}, 1, 'api/talks.json is out of sync');

// The same drift from the other side: editing the JSON without the JS.
testFiles('api/talks.json edited away from talks.js fails closed', {
  'api/talks.json': JSON.stringify({ talks: [{ date: '1999-01-01', title: 'Drifted', where: 'Nowhere' }] }, null, 2),
}, 1, 'api/talks.json is out of sync');

// Without the content-type rule the catalog is served as whatever Cloudflare
// infers for an extensionless file, and RFC 9727 §6.2 makes
// application/linkset+json a MUST.
testFiles('dropping the linkset content type from _headers fails closed', {
  '_headers': originalHeaders.split('\n')
    .filter((line) => !line.includes('application/linkset+json')).join('\n'),
}, 1, 'application/linkset+json');

// A catalog that does not parse is worse than no catalog: the well-known URI
// exists, so a client stops looking.
testFiles('a catalog that is not valid JSON fails closed', {
  '.well-known/api-catalog': '{ "linkset": [ ',
}, 1, 'is not valid JSON');

// Every same-origin href must resolve, or the catalog advertises a 404.
testFiles('a catalog href pointing at a missing file fails closed', {
  '.well-known/api-catalog': originalCatalog.replace('/api/openapi.json', '/api/openapi-v2.json'),
}, 1, 'references missing file');

// An entry without an anchor has no link context, so nothing in it identifies
// which API is being described.
testFiles('a linkset entry without an anchor fails closed', {
  '.well-known/api-catalog': JSON.stringify({ linkset: [{ 'service-doc': [{ href: 'https://jaredsburrows.com/api/' }] }] }, null, 2),
}, 1, 'entry 1 has no anchor');

// The OpenAPI document names the paths it describes; a renamed or deleted
// endpoint file must not keep being advertised as one.
testFiles('an openapi.json path with no file behind it fails closed', {
  'api/openapi.json': fs.readFileSync(path.join(repoRoot, 'api/openapi.json'), 'utf8')
    .replace('"/api/health.json"', '"/api/status.json"'),
}, 1, 'openapi.json describes /api/status.json');
// --- /auth.md discovery: agent tooling locates the document by fetching
// /auth.md and matching an H1 that contains "auth.md". Both halves are load-
// bearing and neither is visible to any other check: deleting the file leaves
// a 404 that no test notices, and retitling the heading to something like
// "# Authentication" keeps a file that reads fine to a human while silently
// failing discovery. Nothing else in the build would go red either way.
const originalAuthMd = fs.readFileSync(path.join(repoRoot, 'auth.md'), 'utf8');
assert.ok(/^#\s+.*auth\.md/im.test(originalAuthMd),
  'fixture assumption broken: auth.md no longer has an H1 containing "auth.md"');

testFiles('a missing auth.md fails closed', { 'auth.md': null }, 1, 'auth.md is missing');

testFiles('auth.md retitled to a heading without "auth.md" fails closed',
  { 'auth.md': originalAuthMd.replace(/^#\s+.*$/m, '# Authentication') },
  1, 'H1 heading containing "auth.md"');

// Demoting the heading breaks discovery just as surely as renaming it: the
// document must be found by an H1, not by any heading that mentions the name.
testFiles('auth.md with the name only in an H2 fails closed',
  { 'auth.md': originalAuthMd.replace(/^#\s+(.*)$/m, '## $1') },
  1, 'H1 heading containing "auth.md"');

// "contains" is the requirement, not equality — a titled variant must pass.
testFiles('auth.md with a titled H1 containing the name passes',
  { 'auth.md': originalAuthMd.replace(/^#\s+.*$/m, "# Jared Burrows' auth.md") }, 0);

// --- T4: JSON-LD. Nothing renders it and vnu never reads inside the script
// element, so a block that stops parsing breaks in complete silence: the page
// looks perfect and search engines drop the whole thing. The mutations below
// are structural rather than field-by-field on purpose — they must keep
// working when the block is restructured.
const JSONLD_BLOCK = /(<script[^>]*type="application\/ld\+json"[^>]*>)([\s\S]*?)(<\/script>)/i;
assert.ok(JSONLD_BLOCK.test(originalIndexHtml),
  'fixture assumption broken: index.html no longer has a JSON-LD block');

/** @param {(body: string) => string} transform @returns {string} */
const mutateJsonLd = (transform) =>
  originalIndexHtml.replace(JSONLD_BLOCK, (match, open, body, close) => `${open}${transform(body)}${close}`);

// A trailing comma is the classic hand-edit defect: valid-looking, fatal to
// every consumer, and invisible on the rendered page.
testFiles('a trailing comma in the JSON-LD block fails closed', {
  'index.html': mutateJsonLd((body) => {
    const close = body.lastIndexOf('}');
    return `${body.slice(0, close)},${body.slice(close)}`;
  }),
}, 1, 'index.html JSON-LD block 1 is not valid JSON');

// A typo'd @context parses fine and means nothing: every field below it stops
// being schema.org vocabulary.
testFiles('a JSON-LD @context that is not schema.org fails closed', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("@context"\s*:\s*)"[^"]*"/, '$1"https://example.org"')),
}, 1, 'it must resolve to the schema.org host');

// A lookalike host is the typo this guard is actually for: every one of these
// CONTAINS the string "schema.org", so a substring test passes them while a
// consumer resolves the context to a host that serves no vocabulary at all.
for (const lookalike of [
  'https://schema.org.org',
  'https://schema.org.example.com',
  'https://notschema.org',
]) {
  testFiles(`a JSON-LD @context of ${lookalike} fails closed`, {
    'index.html': mutateJsonLd((body) =>
      body.replace(/("@context"\s*:\s*)"[^"]*"/, `$1"${lookalike}"`)),
  }, 1, 'it must resolve to the schema.org host');
}

// ...and the guard must not over-tighten: the legacy http:// form and an array
// context are both real, both resolve to the schema.org host, and must pass.
testFiles('a JSON-LD @context of http://schema.org passes', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("@context"\s*:\s*)"[^"]*"/, '$1"http://schema.org"')),
}, 0);

testFiles('a JSON-LD @context array containing schema.org passes', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("@context"\s*:\s*)"[^"]*"/, '$1["https://example.org/ctx", "https://schema.org"]')),
}, 0);

// More than one block is the shape this site is heading for (a second block
// alongside the first), so each has to be parsed and named on its own.
/** @param {string} json */
const SECOND_BLOCK = (json) => `<script type="application/ld+json">${json}</script>`;
/** @param {string} json */
const withSecondBlock = (json) =>
  originalIndexHtml.replace(JSONLD_BLOCK, (match) => `${match}\n    ${SECOND_BLOCK(json)}`);

testFiles('a second, valid JSON-LD block passes', {
  'index.html': withSecondBlock('{"@context": "https://schema.org", "@type": "WebSite", "name": "Jared Burrows", "url": "https://jaredsburrows.com/"}'),
}, 0);

testFiles('a malformed second JSON-LD block fails closed naming block 2', {
  'index.html': withSecondBlock('{"@context": "https://schema.org", "@type": "WebSite",}'),
}, 1, 'index.html JSON-LD block 2 is not valid JSON');

// --- S11: same-origin ABSOLUTE references. og:image, twitter:image and the
// JSON-LD image must be absolute for the scrapers, and static/image/avatar-460.jpg
// is referenced by nothing else — so before this check a rename of that file
// left three dangling references with the build green. Image TTLs are 30 days
// and a Cloudflare purge never reaches a browser cache, which makes the rename
// the only cache-bust available: a half-done one is a 30-day 404.
const AVATAR = 'static/image/avatar-460.jpg';
assert.ok(originalIndexHtml.includes(`https://jaredsburrows.com/${AVATAR}`),
  `fixture assumption broken: index.html no longer references ${AVATAR} absolutely`);
assert.ok(!originalIndexHtml.includes(`"${AVATAR}"`),
  `fixture assumption broken: ${AVATAR} is now referenced relatively too, so the absolute refs are no longer the only ones`);

testFiles(`renaming ${AVATAR} without updating the meta tags fails closed`, {
  [AVATAR]: null,
  'static/image/avatar-461.jpg': 'not really a JPEG, and existence is all that is checked',
}, 1, `index.html references missing file /${AVATAR}`);

testFiles('an og:image pointing at a file that does not exist fails closed', {
  'index.html': originalIndexHtml.replace(
    /(property="og:image" content="https:\/\/jaredsburrows\.com)\/[^"]+"/,
    '$1/static/image/avatar-gone.jpg"'),
}, 1, 'index.html references missing file /static/image/avatar-gone.jpg');

// The JSON-LD image is the same absolute URL in a place the attribute walk
// cannot see, so it needs its own proof.
testFiles('a JSON-LD image pointing at a file that does not exist fails closed', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("image"\s*:\s*"https:\/\/jaredsburrows\.com)\/[^"]+"/, '$1/static/image/avatar-gone.jpg"')),
}, 1, 'JSON-LD block 1 references missing file /static/image/avatar-gone.jpg');

// The other half of the invariant: only SAME-origin absolute URLs name a file
// in this tree. A third-party image URL is not a local reference and must not
// be reported as a missing file, or the check would be unusable.
testFiles('an off-origin og:image is not treated as a local file', {
  'index.html': originalIndexHtml.replace(
    /(property="og:image" content=)"[^"]+"/, '$1"https://example.com/avatar.jpg"'),
}, 0);
// --- ARD capability manifest. Two hand-maintained copies of one document at
// two well-known paths, plus a robots.txt pointer and two head link tags. None
// of it renders, nothing at runtime reads it, and a conforming robots parser
// ignores the directive it does not know — so every failure mode below is
// silent in a browser and only shows up as an agent fetching a capability that
// is not there, which is worse than publishing nothing.
const AI_CATALOG = '.well-known/ai-catalog.json';
const ARD = '.well-known/ard.json';
const originalAiCatalog = fs.readFileSync(path.join(repoRoot, AI_CATALOG), 'utf8');
const originalRobots = fs.readFileSync(path.join(repoRoot, 'robots.txt'), 'utf8');
assert.strictEqual(originalAiCatalog, fs.readFileSync(path.join(repoRoot, ARD), 'utf8'),
  `fixture assumption broken: ${AI_CATALOG} and ${ARD} are no longer byte-identical`);
assert.ok(originalAiCatalog.includes('https://jaredsburrows.com/api/openapi.json'),
  `fixture assumption broken: ${AI_CATALOG} no longer advertises api/openapi.json`);
assert.ok(/^Agentmap:\s*\S+$/m.test(originalRobots),
  'fixture assumption broken: robots.txt no longer has an Agentmap directive');

// Edit one copy to valid-but-different and the pair silently disagrees about
// what this origin offers, depending on which path the agent's spec revision
// told it to fetch. One character is enough to prove the check is byte-exact
// rather than structural.
testFiles('a one-character drift between the two manifest copies fails closed',
  { [ARD]: originalAiCatalog.replace('"Talks dataset"', '"Talks Dataset"') },
  1, 'are not byte-identical');

// A manifest that does not parse is worse than no manifest: the well-known
// path answers 200, so a client stops looking for one.
testFiles('a manifest that is not valid JSON fails closed',
  { [AI_CATALOG]: originalAiCatalog.replace('"entries": [', '"entries": [,') },
  1, `${AI_CATALOG} is not valid JSON`);

// One well-known path missing entirely (not just malformed) is its own
// failure mode — the read() call throws before JSON.parse ever runs — and
// nothing above exercises it.
testFiles('one manifest copy missing entirely fails closed',
  { [ARD]: null },
  1, `${ARD} is missing — the ARD manifest is published at both well-known paths`);

// The truthfulness gate, mechanised: renaming or deleting an advertised file
// must not leave the manifest pointing at a 404. Both copies are mutated so the
// byte-equality check stays quiet and the URL check is what fires.
testFiles('an entry url pointing at a missing file fails closed', (() => {
  const broken = originalAiCatalog.replace('/api/openapi.json', '/api/nope.json');
  assert.notStrictEqual(broken, originalAiCatalog, 'fixture assumption broken: no openapi.json url to break');
  return { [AI_CATALOG]: broken, [ARD]: broken };
})(), 1, 'references missing file /api/nope.json');

// ARD Section 4.3: exactly one of url or data. Both is ambiguous about which
// is authoritative; neither is an entry that resolves to nothing.
/** @type {Array<[string, (entry: any) => any, string]>} */
const ardEntryMutations = [
  ['both url and data', (entry) => ({ ...entry, data: { talks: [] } }), 'has both'],
  ['neither url nor data', ({ url, ...entry }) => entry, 'has neither'],
];
for (const [name, mutate, expected] of ardEntryMutations) {
  testFiles(`an entry with ${name} fails closed`, (() => {
    const manifest = JSON.parse(originalAiCatalog);
    manifest.entries[0] = mutate(manifest.entries[0]);
    const text = JSON.stringify(manifest, null, 2);
    return { [AI_CATALOG]: text, [ARD]: text };
  })(), 1, `entry 1 must have exactly one of url or data (ARD Section 4.3) but ${expected}`);
}

// The Agentmap URL is checked against the tree for the same reason as the
// entry urls, and it needs the check more: no crawler, no page and no other
// invariant would ever report it.
testFiles('a robots.txt Agentmap pointing at a missing file fails closed',
  { 'robots.txt': originalRobots.replace(/^Agentmap:.*$/m, 'Agentmap: https://jaredsburrows.com/.well-known/nope.json') },
  1, 'robots.txt Agentmap references missing file /.well-known/nope.json');

// --- S12: every same-origin URL check must fail CLOSED on a path that escapes
// the repo. The unfixed checkLocal sliced off the query/fragment, stripped ONE
// leading slash and called path.join(root, …) with no normalization and no
// containment check, so a url with enough `..` segments to clamp at the
// filesystem root landed on a real file outside the tree, fs.existsSync
// returned true and the truthfulness gate stayed silent — green-lighting a
// manifest whose url every real client normalizes to
// https://jaredsburrows.com/etc/hosts, a 404 in production.
//
// The traversal is deliberately deeper than any plausible tree: `path.join`
// clamps at `/`, so the escape target does not depend on how deep the scratch
// directory happens to sit (four segments is enough from the repo root but not
// from a macOS `/var/folders/...` temp dir, which would make the test pass for
// the wrong reason).
const ESCAPE_TARGET = '/etc/hosts';
const TRAVERSAL = `/${'../'.repeat(10)}${ESCAPE_TARGET.slice(1)}`;
const ENCODED_TRAVERSAL = `/${'%2e%2e%2f'.repeat(10)}${ESCAPE_TARGET.slice(1)}`;
assert.ok(fs.existsSync(ESCAPE_TARGET),
  `fixture assumption broken: ${ESCAPE_TARGET} does not exist, so the traversal cases cannot prove an escape`);
assert.strictEqual(path.join('/deep/scratch/dir', TRAVERSAL.replace(/^\//, '')), ESCAPE_TARGET,
  'fixture assumption broken: the traversal no longer reaches outside the tree the way the unfixed check resolved it');

/** @param {string} url */
const withManifestUrl = (url) => {
  const manifest = JSON.parse(originalAiCatalog);
  manifest.entries[0].url = url;
  const text = JSON.stringify(manifest, null, 2);
  return { [AI_CATALOG]: text, [ARD]: text };
};

// Raw `..` segments: the URL parser collapses them exactly as a browser does,
// so the entry is judged as /etc/hosts on this origin — a path this tree does
// not contain. Exit 0 before the fix, exit 1 after.
testFiles('a manifest entry url with a ../ traversal out of the repo fails closed',
  withManifestUrl(`${'https://jaredsburrows.com'}${TRAVERSAL}`),
  1, `references missing file ${TRAVERSAL}`);

// Percent-encoded traversal: `%2e%2e%2f…` is one opaque segment to the URL
// parser, so only decoding exposes the `../`, which is why containment is
// checked after the decode and not before. This one already exited non-zero
// before the fix, but for the wrong reason (the unfixed check never decoded,
// so it looked for a file literally named `%2e%2e%2f…`); the message assertion
// is what pins it to the containment guard.
testFiles('a manifest entry url with a percent-encoded traversal fails closed',
  withManifestUrl(`${'https://jaredsburrows.com'}${ENCODED_TRAVERSAL}`),
  1, 'escapes the site root');

// The Agentmap directive reaches the same helper, so the single fix covers it …
testFiles('a robots.txt Agentmap with a ../ traversal out of the repo fails closed',
  { 'robots.txt': originalRobots.replace(/^Agentmap:.*$/m, `Agentmap: https://jaredsburrows.com${TRAVERSAL}`) },
  1, `robots.txt Agentmap references missing file ${TRAVERSAL}`);

// … and so does the pre-existing api-catalog href caller, which had the same
// defect and is closed by the same change instead of a per-call-site guard.
testFiles('an api-catalog href with a ../ traversal out of the repo fails closed',
  {
    '.well-known/api-catalog': fs.readFileSync(path.join(repoRoot, '.well-known/api-catalog'), 'utf8')
      .replace('https://jaredsburrows.com/api/openapi.json', `https://jaredsburrows.com${TRAVERSAL}`),
  },
  1, `.well-known/api-catalog entry 1 references missing file ${TRAVERSAL}`);

// The same-origin walk added for S11 is a second family of callers — the
// widened content="" attribute walk and the recursive JSON-LD walk both hand
// sameOriginPath's output to checkLocal, so containment has to hold on that
// route too. It does, because the guard lives in checkLocal rather than at any
// call site: sameOriginPath strips the origin, checkLocal resolves what is
// left against the same origin again, and the `..` collapses either way.
testFiles('a JSON-LD same-origin URL with a ../ traversal out of the repo fails closed', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("image"\s*:\s*"https:\/\/jaredsburrows\.com)\/[^"]+"/, `$1${TRAVERSAL}"`)),
}, 1, `index.html JSON-LD block 1 references missing file ${TRAVERSAL}`);

// The same walk, percent-encoded: this is the only JSON-LD case that reaches
// the decode step. The raw-`..` case above collapses in the URL parser, so it
// is judged missing and never exercises decodeURIComponent; `%2e%2e%2f` stays
// one opaque segment until the decode, and only then does containment have
// anything to catch. Asserting on 'escapes the site root' rather than a
// missing-file message is what pins it to the containment guard instead of
// letting a literal lookup for a file named `%2e%2e%2f…` pass it for free.
testFiles('a JSON-LD image with a percent-encoded traversal fails closed', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("image"\s*:\s*"https:\/\/jaredsburrows\.com)\/[^"]+"/, `$1${ENCODED_TRAVERSAL}"`)),
}, 1, 'escapes the site root');

testFiles('an og:image with a ../ traversal out of the repo fails closed', {
  'index.html': originalIndexHtml.replace(
    /(property="og:image" content="https:\/\/jaredsburrows\.com)\/[^"]+"/,
    `$1${TRAVERSAL}"`),
}, 1, `index.html references missing file ${TRAVERSAL}`);

// --- S18: which references are ours is decided by the parsed HOST, not by a
// string prefix. `https://jaredsburrows.com/…` is one of several forms every
// client resolves to this origin, and while the prefix test was right about
// lookalikes it skipped all the others as "off-origin" — so the S11 rename
// invariant could be switched back off by REWRITING a reference instead of
// deleting it, which is the easier mistake of the two to make by accident: a
// protocol-relative og:image is a normal thing to write. Every case below was
// exit 0 before the fix, with the referenced file genuinely absent.
const GONE = '/static/image/avatar-gone.jpg';
/** @param {string} value */
const withOgImage = (value) =>
  originalIndexHtml.replace(/(property="og:image" content=)"[^"]+"/, `$1"${value}"`);
/** @param {string} value */
const withJsonLdImage = (value) =>
  mutateJsonLd((body) => body.replace(/("image"\s*:\s*)"[^"]+"/, `$1"${value}"`));
assert.notStrictEqual(withOgImage('x'), originalIndexHtml,
  'fixture assumption broken: no og:image content attribute to rewrite');
assert.notStrictEqual(withJsonLdImage('x'), originalIndexHtml,
  'fixture assumption broken: the JSON-LD block has no image field to rewrite');

// The third element is how the same origin has to be SPELLED inside a JSON
// string, which differs only for the backslash form: `\` is an escape
// character to JSON, so the block has to carry `\\` to mean the one backslash
// a consumer then resolves.
for (const [origin, why, jsonOrigin = origin] of [
  ['//jaredsburrows.com', 'protocol-relative, which every scraper resolves against the page origin'],
  ['http://jaredsburrows.com', 'the legacy scheme, which redirects here rather than going elsewhere'],
  ['HTTPS://JaredsBurrows.COM', 'case variants, which no host comparison may be sensitive to'],
  ['https://jaredsburrows.com:443', 'the default port spelled out, which is the same origin'],
  ['https:/\\jaredsburrows.com', 'a backslash separator, which the URL parser normalises to /', 'https:/\\\\jaredsburrows.com'],
]) {
  testFiles(`an og:image of ${origin}${GONE} fails closed (${why})`,
    { 'index.html': withOgImage(`${origin}${GONE}`) },
    1, `index.html references missing file ${GONE}`);

  testFiles(`a JSON-LD image of ${origin}${GONE} fails closed (${why})`,
    { 'index.html': withJsonLdImage(`${jsonOrigin}${GONE}`) },
    1, `index.html JSON-LD block 1 references missing file ${GONE}`);
}

// The other half, and the half a host check is easy to get wrong: none of
// these is this origin, so none of them names a file in this tree and none may
// be reported as missing. blog.jaredsburrows.com is in the block's sameAs list
// today — a real subdomain served by something else entirely.
for (const offOrigin of [
  'https://jaredsburrows.com.evil.test',
  'https://notjaredsburrows.com',
  '//jaredsburrows.com.evil.test',
  'https://blog.jaredsburrows.com',
  'https://example.com',
]) {
  testFiles(`an og:image of ${offOrigin}${GONE} is not treated as a local file`,
    { 'index.html': withOgImage(`${offOrigin}${GONE}`) }, 0);

  testFiles(`a JSON-LD image of ${offOrigin}${GONE} is not treated as a local file`,
    { 'index.html': withJsonLdImage(`${offOrigin}${GONE}`) }, 0);
}

// Prose in a content="" attribute must stay prose: parsing every value against
// the site origin — rather than only the ones carrying an authority — would
// turn the description, the viewport and the CSP mirror into file references
// and fail the build on a sentence.
testFiles('a description that starts with a word and a colon is still prose',
  withDescription('Android: Kotlin, Gradle, and //100% coverage.'), 0);

// The api-catalog hrefs ran the same string-prefix test and had the same blind
// spot, so the single helper closes both. Same for the robots.txt Agentmap.
testFiles('an api-catalog href of //jaredsburrows.com/api/nope.json fails closed', {
  '.well-known/api-catalog': originalCatalog.replace(
    'https://jaredsburrows.com/api/openapi.json', '//jaredsburrows.com/api/nope.json'),
}, 1, '.well-known/api-catalog entry 1 references missing file /api/nope.json');

testFiles('an api-catalog href on a lookalike host is not checked against this tree', {
  '.well-known/api-catalog': originalCatalog.replace(
    'https://jaredsburrows.com/api/openapi.json', 'https://jaredsburrows.com.evil.test/api/nope.json'),
}, 0);

testFiles('a robots.txt Agentmap of //jaredsburrows.com/.well-known/nope.json fails closed', {
  'robots.txt': originalRobots.replace(/^Agentmap:.*$/m, 'Agentmap: //jaredsburrows.com/.well-known/nope.json'),
}, 1, 'robots.txt Agentmap references missing file /.well-known/nope.json');

// --- S19: the HTML tokenizer ends script data at `</script` followed by a
// space, tab, LF, FF, `/` or `>`, while the block match only stops at a
// literal `</script>`. Every body below is valid JSON and was read in full —
// and reported clean — while a browser or scraper stopped at the breakout and
// parsed the rest as markup, into a page whose script-src is 'self'
// 'unsafe-inline'. Nothing in the committed blocks is anywhere near this
// today; the guard is what keeps the class closed as `description` and the
// other free-prose fields get edited again.
/** @param {string} field */
const addJsonLdField = (field) =>
  mutateJsonLd((body) => body.replace(/("@type"\s*:)/, `${field},\n        $1`));
assert.notStrictEqual(addJsonLdField('"x": 1'), originalIndexHtml,
  'fixture assumption broken: the JSON-LD block has no @type to insert a field before');

// The comment family needs more than `-->`: the tokenizer has a
// comment-end-BANG state, so `--!>` closes a comment too, and the abrupt-close
// forms `<!-->` and `<!--->` are whole comments in themselves. A guard that
// knew only `-->` was incomplete in exactly the way S19 is about (CodeQL
// js/bad-tag-filter, alert 8 on PR #147) — these blocks sit BETWEEN HTML
// comments, so a body carrying one of these ends a construct a reader thinks
// encloses it.
for (const [breakout, why] of [
  ['</script  >', 'whitespace after the tag name ends it just as `>` does'],
  ['</script/>', 'a slash ends it too'],
  ['<!--', 'a comment opener moves the tokenizer into script-data-escaped state'],
  ['-->', 'and a comment closer moves it back out'],
  ['--!>', 'the comment-end-bang state ends a comment on --!> as surely as on -->'],
  ['<!-->', 'an abrupt-closed empty comment, caught by the <!-- branch'],
  ['<!--->', 'the same with the dash the comment-start-dash state swallows'],
]) {
  testFiles(`a JSON-LD string containing ${breakout} fails closed (${why})`, {
    'index.html': addJsonLdField(`"alternateName": "x${breakout}<script>alert(1)<\\/script>"`),
  }, 1, 'index.html JSON-LD block 1 contains a sequence that ends the script element early');
}

// … and the escape the message tells the author to use has to actually pass,
// or the guard just moves the problem: `<\/script` is the same string to JSON
// and invisible to every HTML tokenizer.
testFiles('a JSON-LD string with a correctly escaped <\\/script passes', {
  'index.html': addJsonLdField('"alternateName": "x<\\/script><script>alert(1)<\\/script>"'),
}, 0);

// --- S20: the same-origin walk recursed once per nesting level and was called
// outside the try guarding JSON.parse, so a deep block threw an uncaught
// RangeError — a stack trace with no message and no file name, and none of the
// four invariants declared after the JSON-LD loop (API catalog, auth.md
// discovery, _headers overlap, _redirects syntax) ever ran. Deleting auth.md
// alongside the deep block is what proves they run now: before the fix that
// second error was never reported at all.
const NESTED_LEVELS = 20000;
/** @param {number} levels */
const nestedBlock = (levels) =>
  `{"@context": "https://schema.org", "@type": "Person", "deep": ${'{"a": '.repeat(levels)}1${'}'.repeat(levels)}}`;

testFiles(`a JSON-LD block nested ${NESTED_LEVELS} levels deep fails by name, and the checks after it still run`, {
  'index.html': withSecondBlock(nestedBlock(NESTED_LEVELS)),
  'auth.md': null,
}, 1, ['index.html JSON-LD block 2 nests more than', 'auth.md is missing']);

// The depth cap is far above anything hand-written: ordinary nesting passes.
testFiles('an ordinarily nested JSON-LD block passes', {
  'index.html': withSecondBlock(nestedBlock(20)),
}, 0);
// --- /index.md, the markdown twin of the homepage. For an agent that sends
// `Accept: text/markdown` src/worker.mts makes this file the homepage, and
// nothing renders it, so every mutation below ships a broken or stale homepage
// to agents against a green browser experience and an otherwise green build.
const originalTalksJson = fs.readFileSync(path.join(repoRoot, 'api/talks.json'), 'utf8');
const ALTERNATE_LINK = '<link rel="alternate" type="text/markdown" href="/index.md">';
assert.ok(/^#[ \t]+\S/.test(originalIndexMd),
  'fixture assumption broken: index.md no longer starts with an ATX H1');
assert.ok(originalIndexHtml.includes(ALTERNATE_LINK),
  'fixture assumption broken: index.html no longer carries the rel=alternate markdown link verbatim');
assert.ok(/^\s+Vary:\s*Accept\b/m.test(originalHeaders),
  'fixture assumption broken: _headers no longer sets Vary: Accept');

// Deleting the twin leaves the Worker with nothing to serve: / would answer
// `Accept: text/markdown` with the HTML page, silently, forever.
testFiles('a missing index.md fails closed', { 'index.md': null }, 1, 'index.md is missing');

// Front matter is both a broken title (the H1 is no longer first) and the
// leading edge of the generator this site does not have.
testFiles('index.md with front matter ahead of the H1 fails closed',
  { 'index.md': `---\ntitle: Jared Burrows\n---\n\n${originalIndexMd}` },
  1, 'does not start with an ATX H1');

// Demoting the title is the same failure without the visual tell.
testFiles('index.md whose title is an H2 fails closed',
  { 'index.md': originalIndexMd.replace(/^#[ \t]+/, '## ') },
  1, 'does not start with an ATX H1');

// The realistic drift: README says to add a talk to talks.js and mirror it into
// api/talks.json — neither step mentions the twin, so both are updated here and
// only index.md is left behind, exactly as it would happen in practice.
testFiles('a talk added to talks.js and api/talks.json but not index.md fails closed', (() => {
  const talk = { date: '2018-01-01', title: 'Unpublished Twin Talk', where: 'Nowhere', location: 'Nowhere, USA' };
  return {
    'static/js/talks.js': originalTalksJs.replace('window.TALKS = [',
      `window.TALKS = [\n  {\n    date: '${talk.date}',\n    title: '${talk.title}',\n    where: '${talk.where}',\n    location: '${talk.location}'\n  },`),
    'api/talks.json': `${JSON.stringify({ talks: [talk, ...JSON.parse(originalTalksJson).talks] }, null, 2)}\n`,
  };
})(), 1, 'does not list the talk "Unpublished Twin Talk"');

// Dropping a talk from the twin alone is the same drift seen from the other
// side, and it is the one a human proofreading index.md can cause by accident.
testFiles('a talk deleted from index.md alone fails closed',
  { 'index.md': originalIndexMd.split('\n').filter((line) => !line.includes('Make Your Build Great Again')).join('\n') },
  1, 'does not list the talk "Make Your Build Great Again"');

// rel=alternate is the only discovery path that survives the Worker being rolled
// back, so losing it is a real regression even while / still serves markdown.
testFiles('index.html without the rel=alternate markdown link fails closed',
  { 'index.html': originalIndexHtml.replace(ALTERNATE_LINK, '') },
  1, 'no <link rel="alternate" type="text/markdown">');

// Only the head counts: a link element parsed out of the body is not part of
// the document metadata agents read, so it must not satisfy the requirement.
testFiles('the rel=alternate link in the body rather than the head fails closed',
  { 'index.html': originalIndexHtml.replace(ALTERNATE_LINK, '').replace('<body>', `<body>\n    ${ALTERNATE_LINK}`) },
  1, 'no <link rel="alternate" type="text/markdown">');

// A link that resolves to a real file but the wrong one passes the existing
// file-reference check, so only an explicit target check catches it.
testFiles('the rel=alternate link pointing at another markdown file fails closed',
  { 'index.html': originalIndexHtml.replace(ALTERNATE_LINK, ALTERNATE_LINK.replace('/index.md', '/auth.md')) },
  1, 'does not point at /index.md');

// Without Vary: Accept a downstream cache may reuse one representation for the
// other — the markdown homepage served to a browser, or vice versa.
testFiles('dropping Vary: Accept from the "/" rule fails closed',
  { '_headers': originalHeaders.split('\n').filter((line) => line.trim() !== 'Vary: Accept').join('\n') },
  1, 'does not set Vary: Accept');

// Vary is a list header: adding a second field name must not read as removing
// the first.
testFiles('Vary listing Accept alongside another field passes',
  { '_headers': originalHeaders.replace('Vary: Accept', 'Vary: Accept, Accept-Encoding') }, 0);

// --- S2: and the half Vary cannot cover. Cloudflare's cache keys on the URL
// and Accept-Encoding only — it ignores Vary for every other request header —
// so with two representations on one URL the sole thing keeping markdown out of
// browsers' hands is that / is never stored (Workers Assets serves it
// max-age=0, must-revalidate). This repo has already shipped a TTL for other
// paths twice, so the edit below is the likely one; nothing else in the build
// would notice it.
const HOMEPAGE_RULE = '\n/\n  Link: </static/css/home.css>; rel=preload; as=style';
assert.ok(originalHeaders.includes(HOMEPAGE_RULE),
  'fixture assumption broken: the _headers "/" rule no longer starts with the home.css preload');

testFiles('a positive max-age on the "/" rule fails closed',
  { '_headers': originalHeaders.replace(HOMEPAGE_RULE, '\n/\n  Cache-Control: public, max-age=3600\n  Link: </static/css/home.css>; rel=preload; as=style') },
  1, "Cloudflare's cache ignores Vary");

// s-maxage is the shared-cache TTL specifically — the one an edge reads — so it
// must not be a way around a check written in terms of max-age.
testFiles('a positive s-maxage on the "/" rule fails closed',
  { '_headers': originalHeaders.replace(HOMEPAGE_RULE, '\n/\n  Cache-Control: public, s-maxage=60\n  Link: </static/css/home.css>; rel=preload; as=style') },
  1, "Cloudflare's cache ignores Vary");

// The rule that carries the TTL need not be "/" itself: /* matches / too, and
// that is how a site-wide TTL would arrive. Every other Cache-Control is
// stripped from the fixture so this cannot pass on the overlap check instead.
testFiles('a positive max-age on a glob that also matches "/" fails closed',
  { '_headers': `${originalHeaders.split('\n').filter((line) => !line.trim().startsWith('Cache-Control:')).join('\n')}`
      .replace('/*\n  X-Content-Type-Options: nosniff', '/*\n  Cache-Control: public, max-age=3600\n  X-Content-Type-Options: nosniff') },
  1, "Cloudflare's cache ignores Vary");

// B4: delta-seconds is 1*DIGIT, so a fractional max-age is not a legal TTL —
// but an edge that reads the leading digits stores / for a minute all the same,
// and the check must not depend on which kind of cache is in front of the site.
// `+600` and `6e2` are the same argument, which is why the check asks whether
// the value is zero rather than listing the spellings of not-zero.
for (const ttl of ['60.0', '+600', '6e2', '0x10']) {
  testFiles(`a max-age of "${ttl}" on the "/" rule fails closed`,
    { '_headers': originalHeaders.replace(HOMEPAGE_RULE, `\n/\n  Cache-Control: public, max-age=${ttl}\n  Link: </static/css/home.css>; rel=preload; as=style`) },
    1, "Cloudflare's cache ignores Vary");
}

// Zero is not a TTL: pinning the Workers Assets default on / states what
// already happens and must keep passing, or the check would forbid the very
// fix it is asking for.
testFiles('pinning max-age=0, must-revalidate on "/" passes',
  { '_headers': originalHeaders.replace(HOMEPAGE_RULE, '\n/\n  Cache-Control: public, max-age=0, must-revalidate\n  Link: </static/css/home.css>; rel=preload; as=style') },
  0);

// S7: the same TTL, spelled the other ways. Cloudflare reads CDN-Cache-Control
// for its own cache and Cloudflare-CDN-Cache-Control ahead of everything, and
// neither reaches the browser — so a check written against Cache-Control alone
// misses them, and misses them invisibly. stale-while-revalidate and
// stale-if-error reopen the same window after max-age has run out, and a quoted
// value is legal syntax that must not hide the number behind it.
const HOMEPAGE_TTL_FORMS = [
  ['CDN-Cache-Control', 'CDN-Cache-Control: public, max-age=600'],
  ['Cloudflare-CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control: public, max-age=600'],
  ['stale-while-revalidate', 'Cache-Control: public, max-age=0, stale-while-revalidate=600'],
  ['stale-if-error', 'Cache-Control: public, max-age=0, stale-if-error=600'],
  ['a quoted max-age', 'Cache-Control: public, max-age="600"'],
  ['a far-future Expires', 'Expires: Thu, 31 Dec 2099 23:59:59 GMT'],
];
for (const [what, header] of HOMEPAGE_TTL_FORMS) {
  testFiles(`${what} on the "/" rule fails closed`,
    { '_headers': originalHeaders.replace(HOMEPAGE_RULE, `\n/\n  ${header}\n  Link: </static/css/home.css>; rel=preload; as=style`) },
    1, "Cloudflare's cache ignores Vary");
}

// And the other side of each: saying "do not store this" in any of those
// spellings is the property the invariant wants, not a violation of it.
// `Expires: 0` is the conventional "already stale", not a TTL.
const HOMEPAGE_NO_TTL_FORMS = [
  'CDN-Cache-Control: no-store',
  'Cloudflare-CDN-Cache-Control: public, max-age=0, must-revalidate',
  'Cache-Control: public, max-age="0"',
  'Cache-Control: public, max-age=0, stale-while-revalidate=0',
  'Expires: 0',
];
for (const header of HOMEPAGE_NO_TTL_FORMS) {
  testFiles(`"${header}" on the "/" rule passes`,
    { '_headers': originalHeaders.replace(HOMEPAGE_RULE, `\n/\n  ${header}\n  Link: </static/css/home.css>; rel=preload; as=style`) },
    0);
}

// The TTLs the rest of the site relies on are untouched by this: none of those
// paths is negotiated, and this must not turn into a no-caching-anywhere rule.
testFiles('the unmodified TTLs on /static/* and /api/* still pass',
  { '_headers': originalHeaders }, 0);

// --- T5a drift guards: the twin is hand-written, so CI is the only thing that
// can hold it to the files it restates. Each mutation below leaves a green
// browser experience and a green build while an agent reading /index.md is
// served something the site no longer says.
// The sentence exists twice — once as the meta description, once as the twin's
// summary — and nothing renders both, so only a comparison catches a one-sided
// edit. Both sides are tested: either file can be the one that moves.
testFiles('editing the twin summary away from the meta description fails closed',
  { 'index.md': originalIndexMd.replace('Android and Kotlin development', 'Android development') },
  1, "summary blockquote is not index.html's meta description");

testFiles('editing the meta description away from the twin summary fails closed',
  { 'index.html': originalIndexHtml.replace(META_DESCRIPTION, 'Jared Burrows — software engineer.') },
  1, "summary blockquote is not index.html's meta description");

// Markdown soft-wraps: a newline inside a blockquote renders as a space, so
// re-wrapping the summary changes no rendered byte and must keep passing.
// Without this the invariant would be a line-length rule wearing a
// content-check hat.
testFiles('re-wrapping the twin summary onto one line passes',
  { 'index.md': originalIndexMd.replace(SUMMARY_BLOCKQUOTE.join('\n'), `> ${META_DESCRIPTION}`) },
  0);

// Un-quoting the summary is the B3 regression coming back: as a plain paragraph
// it reads as prose the twin owns, which is what invites a second paragraph
// restating it — the shape this file had when B3 was filed.
testFiles('a summary that is no longer a blockquote fails closed',
  { 'index.md': originalIndexMd.replace(SUMMARY_BLOCKQUOTE.join('\n'),
    SUMMARY_BLOCKQUOTE.map((line) => line.replace(/^>[ \t]?/, '')).join('\n')) },
  1, 'has no summary blockquote under its H1');

// The reverse drift the forward check could never see: a talk is retired from
// talks.js and api/talks.json, and the twin keeps publishing it to agents.
testFiles('a talk deleted from talks.js but left in index.md fails closed', (() => {
  const remaining = JSON.parse(originalTalksJson).talks.filter((/** @type {Talk} */ talk) => talk.title !== 'Make Your Build Great Again');
  assert.strictEqual(remaining.length, JSON.parse(originalTalksJson).talks.length - 1,
    'fixture assumption broken: talks.js no longer publishes "Make Your Build Great Again"');
  return {
    'static/js/talks.js': `window.TALKS = ${JSON.stringify(remaining, null, 2)};\n`,
    'api/talks.json': `${JSON.stringify({ talks: remaining }, null, 2)}\n`,
  };
})(), 1, 'lists a talk "Make Your Build Great Again" that static/js/talks.js does not publish');

// Two talks share the title "The Road to Single Dex", so dropping one of them
// is invisible to a containment test — the other heading still satisfies it.
// Counting the headings is what makes this fail.
testFiles('dropping one of the two same-titled talk headings fails closed',
  { 'index.md': originalIndexMd.replace('### The Road to Single Dex\n\nGDG SF Meetup', 'GDG SF Meetup') },
  1, 'lists the talk "The Road to Single Dex" 1 time(s) but static/js/talks.js publishes it 2 time(s)');

// Only `### ` headings inside `## Talks` count as listing a talk: a title that
// survives in prose elsewhere reads like coverage and is not.
testFiles('a talk title kept only in prose outside the Talks section fails closed',
  { 'index.md': `${originalIndexMd.replace('### Make Your Build Great Again\n\n', '')}\nSee also Make Your Build Great Again.\n` },
  1, 'does not list the talk "Make Your Build Great Again"');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
