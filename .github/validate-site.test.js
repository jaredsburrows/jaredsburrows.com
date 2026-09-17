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
// Full tree (minus VCS/tooling dirs) so the file-reference check — unrelated to
// what these tests probe — sees every asset it expects.
const skipTopLevel = new Set(['.git', '.github', '.idea', '.wrangler', 'node_modules']);
const originalHomeJs = fs.readFileSync(path.join(repoRoot, 'static/js/home.js'), 'utf8');

const REFERRERPOLICY_LINE = "    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');";
assert.ok(originalHomeJs.includes(REFERRERPOLICY_LINE),
  'fixture assumption broken: home.js no longer contains the expected referrerpolicy line verbatim');

const originalHeaders = fs.readFileSync(path.join(repoRoot, '_headers'), 'utf8');
const originalIndexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

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
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

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

// --- Measurement CSP coverage: gtag.js fans /g/collect out to hosts that
// appear nowhere in the markup, so only an explicit list catches a missing one.
// Every case below was blocked in production (PageSpeed console, Sept 2026).
const testFiles = (name, overrides, expectCode, expectStderrIncludes) => {
  let result;
  try {
    result = runValidator(overrides);
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

// Drop sources from both the _headers policy and its index.html mirror at once,
// so CSP parity still holds and the coverage check is what fails.
const dropSources = (sources) => {
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
const SECOND_BLOCK = (json) => `<script type="application/ld+json">${json}</script>`;
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
for (const [name, mutate, expected] of [
  ['both url and data', (entry) => ({ ...entry, data: { talks: [] } }), 'has both'],
  ['neither url nor data', ({ url, ...entry }) => entry, 'has neither'],
]) {
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

// The absolute same-origin reference walk (og:image, twitter:image) and the
// JSON-LD walk hand their URLs to the same sameOriginPath + checkLocal pair, so
// containment has to bite there too. They are the newest paths from a published
// string to the filesystem and the ones a reader is most likely to assume are
// guarded somewhere else, so both are proved here rather than reasoned about.
testFiles('an og:image with a ../ traversal out of the repo fails closed', {
  'index.html': originalIndexHtml.replace(
    /(property="og:image" content="https:\/\/jaredsburrows\.com)\/[^"]+"/,
    `$1${TRAVERSAL}"`),
}, 1, `index.html references missing file ${TRAVERSAL}`);

// Percent-encoded, inside the JSON-LD block: decoding before the containment
// check is what catches this one, and the walk through parsed JSON is a
// separate code path from the attribute walk above.
testFiles('a JSON-LD image with a percent-encoded traversal fails closed', {
  'index.html': mutateJsonLd((body) =>
    body.replace(/("image"\s*:\s*"https:\/\/jaredsburrows\.com)\/[^"]+"/,
      `$1${ENCODED_TRAVERSAL}"`)),
}, 1, 'escapes the site root');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
