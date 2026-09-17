#!/usr/bin/env node
// Validates cross-file invariants that node --check and vnu cannot see.
// Most checks below are a regression that actually shipped or nearly did:
// - the _headers CSP and its index.html meta mirror drifting apart
// - the CSP missing a host the page really loads from (talk embeds were
//   blocked in production for a month this way)
// - the CSP missing an origin Cloudflare injects at the edge rather than one
//   the markup loads, which blocked the Web Analytics beacon (September 2026)
// - home.js targeting an id index.html no longer has (emptied the live
//   Presentations section in July 2026)
// - an embed iframe built without an explicit referrerpolicy, which broke
//   both YouTube talks with Error 153 in September 2026
// - a page or _headers preload referencing a local file that doesn't exist,
//   including the same-origin ABSOLUTE references (og:image, twitter:image,
//   the JSON-LD image) a rename leaves dangling: image TTLs are 30 days and a
//   Cloudflare purge never reaches a browser cache, so renaming the file is
//   the only cache-bust there is and half a rename is a 30-day 404
// - /auth.md losing the H1 that agent discovery matches on
// - two _headers rules setting the same header on overlapping paths
//   (values from all matching rules comma-join into one broken header)
// The API catalog and JSON-LD checks are the exception: nothing has broken
// yet, because both are new. The catalog exists because RFC 9727 makes
// machine-read promises about other files, and a broken one is invisible from
// a browser — no page renders it, so only an agent hitting a 404 would ever
// find out. JSON-LD fails the same way: no browser renders it, so one trailing
// comma makes search engines drop the whole block off a page that still looks
// perfect.
// Usage: node .github/validate-site.js [site root]
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const errors = [];
const bad = (message) => errors.push(message);

const indexHtml = read('index.html');
const notFoundHtml = read('404.html');
const headers = read('_headers');
const redirects = read('_redirects');
const homeJs = read('static/js/home.js');

// --- CSP parity: _headers is production, the meta tag is the GH Pages mirror.
// frame-ancestors is header-only by spec, so it may exist only in _headers.
const parseCsp = (csp) => {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources.sort());
  }
  return directives;
};

const metaMatch = indexHtml.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
const headerMatch = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
if (!metaMatch) bad('index.html: meta CSP tag not found');
if (!headerMatch) bad('_headers: Content-Security-Policy line not found');

const headerCsp = headerMatch ? parseCsp(headerMatch[1]) : new Map();
if (metaMatch && headerMatch) {
  const metaCsp = parseCsp(metaMatch[1]);
  for (const name of new Set([...metaCsp.keys(), ...headerCsp.keys()])) {
    const meta = metaCsp.get(name);
    const header = headerCsp.get(name);
    if (!meta && name === 'frame-ancestors') continue;
    if (!meta) bad(`CSP drift: ${name} is in _headers but not the index.html meta mirror`);
    else if (!header) bad(`CSP drift: ${name} is in the index.html meta mirror but not _headers`);
    else if (meta.join(' ') !== header.join(' ')) {
      bad(`CSP drift: ${name} differs — _headers [${header.join(' ')}] vs meta [${meta.join(' ')}]`);
    }
  }
}

// --- CSP coverage: every external origin the site actually uses must be
// allowed by the right directive ('self' covers everything same-origin).
const matchesSource = (origin, source) =>
  source === origin
  || (source.startsWith('https://*.') && origin.startsWith('https://')
      && origin.slice('https://'.length).endsWith(`.${source.slice('https://*.'.length)}`));

const requireCsp = (directive, origin, why) => {
  const sources = headerCsp.get(directive) ?? [];
  if (!sources.some((source) => matchesSource(origin, source))) {
    bad(`CSP: ${directive} does not allow ${origin} (${why})`);
  }
};

for (const [, origin] of homeJs.matchAll(/fetch\('(https:\/\/[^/']+)/g)) {
  requireCsp('connect-src', origin, 'home.js fetches it');
}
// Talk embeds and their file:// preview thumbnails, built in home.js; each
// requirement drops out automatically if home.js stops using the host.
const embedHosts = [
  ['frame-src', 'https://www.youtube-nocookie.com', 'home.js embeds talk videos'],
  ['frame-src', 'https://speakerdeck.com', 'home.js embeds talk slides'],
  ['img-src', 'https://img.youtube.com', 'home.js file:// fallback thumbnails'],
  ['img-src', 'https://speakerd.s3.amazonaws.com', 'home.js file:// fallback thumbnails'],
];
for (const [directive, origin, why] of embedHosts) {
  if (homeJs.includes(origin)) requireCsp(directive, origin, why);
}
for (const [, origin] of indexHtml.matchAll(/<script[^>]+src="(https:\/\/[^"/]+)/g)) {
  requireCsp('script-src', origin, 'index.html loads it as a script');
}
for (const [, origin] of indexHtml.matchAll(/<iframe[^>]+src="(https:\/\/[^"/]+)/g)) {
  requireCsp('frame-src', origin, 'index.html embeds it as an iframe');
}

// --- Measurement CSP coverage: a GA4 hit does not stay on the tag's own
// origin. gtag.js fans /g/collect out to google-analytics.com, to
// analytics.google.com, and — with Google signals on the property — to
// stats.g.doubleclick.net and www.google.com. None of that is visible in the
// markup, so the loops above cannot infer it; every one of these was blocked
// in production until listed (PageSpeed console, September 2026).
// Note the apex: `https://*.analytics.google.com` does NOT match
// `analytics.google.com` — a `*.` source requires at least one label in front
// — so the wildcard that looks like it covers the apex silently does not.
const measurementEndpoints = [
  ['https://www.google-analytics.com', 'gtag.js posts /g/collect there'],
  ['https://analytics.google.com', 'gtag.js posts /g/collect to the apex, which no *. wildcard covers'],
  ['https://stats.g.doubleclick.net', 'Google signals posts /g/collect there'],
  ['https://www.google.com', 'Google signals posts /g/collect and /ccm/collect there'],
];
// Gate on the tag actually being loaded, so removing analytics drops the
// requirement instead of freezing it in. The loader URL is matched by parsed
// host and path, not by a substring or a regex over the raw HTML: a pattern
// like /googletagmanager\.com\/gtag\/js/ is unanchored at both ends, so both
// `https://notgoogletagmanager.com/gtag/js` and any URL merely carrying that
// text in a query string satisfy it. GTM's own loader builds its URL inline
// rather than a src attribute, so this scans every URL in the file, not just
// the ones the <script src> loop above can see.
const TAG_HOST = 'www.googletagmanager.com';
const TAG_PATHS = new Set(['/gtag/js', '/gtm.js']);
const loadsTag = [...indexHtml.matchAll(/https:\/\/[^\s"'<>]+/g)].some(([reference]) => {
  let url;
  try {
    url = new URL(reference);
  } catch {
    return false;
  }
  return url.host === TAG_HOST && TAG_PATHS.has(url.pathname);
});
if (loadsTag) {
  for (const [origin, why] of measurementEndpoints) {
    requireCsp('connect-src', origin, why);
  }
}

// --- Edge-injected CSP coverage: Cloudflare injects its Web Analytics RUM
// beacon into every proxied HTML response. That tag is added after these files
// leave the build, so index.html contains no reference to it and none of the
// markup loops above can infer it — yet the script-src violation is real and
// fired on every page view until listed (PageSpeed console, September 2026).
// Unlike the measurement endpoints there is no in-repo signal to gate on: the
// injection is a zone setting, not a file. So if Web Analytics is ever turned
// off for the zone, delete this block and both sources with it rather than
// leaving origins trusted for script execution that nothing loads any more.
const edgeInjectedOrigins = [
  ['script-src', 'https://static.cloudflareinsights.com', 'Cloudflare injects beacon.min.js into proxied HTML'],
  ['connect-src', 'https://cloudflareinsights.com', 'the beacon posts RUM samples to its /cdn-cgi/rum'],
];
for (const [directive, origin, why] of edgeInjectedOrigins) {
  requireCsp(directive, origin, why);
}

// --- Embed referer: the talk iframes are cross-origin, and YouTube's player
// refuses to configure without a referer. The document Referrer-Policy is not
// enough — an unfixed Cloudflare zone rule overrides it (see .team/SECURITY.md)
// — so home.js must set the attribute on the frames it builds, in live code:
// comments are stripped first, so a commented-out call cannot satisfy this.
// String literals are matched before comment openers so URLs keep their //.
const stripComments = (source) => source.replace(
  /`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"|\/\*[\s\S]*?\*\/|\/\/.*/g,
  (match) => (match.startsWith('/') ? ' ' : match));
const liveHomeJs = stripComments(homeJs);

// Equal-or-tighter than the _headers policy and still referer enough for
// YouTube. Anything else is a defect: unsafe-url, no-referrer-when-downgrade,
// origin-when-cross-origin and origin leak more, while no-referrer and
// same-origin send nothing cross-origin — Error 153 again.
const allowedReferrerPolicies = ['strict-origin-when-cross-origin', 'strict-origin'];
const referrerPolicies = [
  /setAttribute\(\s*(['"`])referrerpolicy\1\s*,\s*(['"`])(?<value>[^'"`]*)\2\s*\)/gi,
  /\.referrerPolicy\s*=\s*(['"`])(?<value>[^'"`]*)\1/g,
].flatMap((pattern) => [...liveHomeJs.matchAll(pattern)]
  .map((match) => match.groups.value.trim().toLowerCase()));

// Gate on the embed hosts above, not on URL path shapes: rewriting a path must
// not silently switch this invariant off.
const embedOrigins = embedHosts.filter(([directive]) => directive === 'frame-src').map(([, origin]) => origin);
if (embedOrigins.some((origin) => liveHomeJs.includes(origin))
    && !referrerPolicies.some((value) => allowedReferrerPolicies.includes(value))) {
  bad(`home.js builds cross-origin embed iframes without a live setAttribute('referrerpolicy', 'strict-origin-when-cross-origin') — YouTube talk embeds break with Error 153 when the document Referrer-Policy suppresses the referer`);
}
for (const policy of new Set(referrerPolicies.filter((value) => !allowedReferrerPolicies.includes(value)))) {
  bad(`home.js sets referrerpolicy '${policy}' on an embed iframe — only ${allowedReferrerPolicies.join(' or ')} may be used (weaker values leak more than the origin; no-referrer/same-origin bring back Error 153)`);
}

// --- HTML <-> JS contract: ids home.js looks up must exist in index.html.
for (const [, id] of homeJs.matchAll(/getElementById\('([^']+)'\)/g)) {
  if (!indexHtml.includes(`id="${id}"`)) {
    bad(`home.js targets #${id} but index.html has no id="${id}"`);
  }
}

// --- Referenced local files must exist (pages plus _headers preloads).
const checkLocal = (source, reference) => {
  const clean = reference.replace(/[?#].*$/, '').replace(/^\//, '');
  if (!fs.existsSync(path.join(root, clean))) {
    bad(`${source} references missing file ${reference}`);
  }
};
// An absolute URL back to this origin names a file in this tree just as surely
// as a relative path does. og:image and twitter:image have to be absolute for
// the scrapers, so skipping every https: reference left them unchecked: a
// rename of static/image/avatar-460.jpg landed half-done with CI green
// (.team/SECURITY.md S11). With image TTLs at 30 days and Cloudflare purge
// unable to reach a browser cache, the rename IS the cache-bust — so every
// reference to a renamed asset has to move in the same commit.
const SITE_ORIGIN = 'https://jaredsburrows.com';
const sameOriginPath = (reference) =>
  (reference.startsWith(`${SITE_ORIGIN}/`) ? reference.slice(SITE_ORIGIN.length) : undefined);
// Walks parsed data (JSON-LD, any object or array) for the same absolute URLs.
const checkSameOriginUrls = (source, value) => {
  if (typeof value === 'string') {
    const reference = sameOriginPath(value);
    if (reference !== undefined && reference !== '/') checkLocal(source, reference);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) checkSameOriginUrls(source, item);
  }
};
for (const [file, html] of [['index.html', indexHtml], ['404.html', notFoundHtml]]) {
  // content="" is prose far more often than a reference — the description, the
  // viewport, the CSP mirror — so only its same-origin absolute URLs count.
  // src/href keep taking relative values as well.
  for (const [, attribute, value] of html.matchAll(/(src|href|content)="([^"]+)"/g)) {
    const reference = sameOriginPath(value) ?? (attribute === 'content' ? undefined : value);
    if (reference === undefined || /^(https?:|mailto:|#|data:)/.test(reference) || reference === '/') continue;
    checkLocal(file, reference);
  }
}
for (const [, reference] of headers.matchAll(/Link:\s*<([^>]+)>/g)) {
  checkLocal('_headers Link', reference);
}

// --- JSON-LD: structured data no browser renders and vnu does not read (it
// validates the script element, never its contents), so a break shows up
// nowhere until the search result quietly loses its rich data. One trailing
// comma and a search engine drops the entire block; an @context that does not
// name schema.org leaves every field in it unrecognized vocabulary.
// Same-origin URLs inside a block are references like any other — the image
// field carries the same absolute avatar URL the meta tags do, and a rename
// has to move all of them together.
//
// Every block is parsed and reported on its own: a page carries more than one
// (a ProfilePage plus a WebSite site name), and a check that stopped at the
// first match would cover the second never at all. Everything below reads the
// PARSED object, never the file text — the blocks sit next to HTML comments
// documenting what was deliberately left out, so `grep SearchAction
// index.html` prints 1 on a page whose JSON-LD contains no such thing, and an
// invariant written as a text search would fire on the comment.
//
// @context is matched by URL host, not by substring: 'https://schema.org.org'
// and 'https://schema.org.example.com' both contain the string and both mean
// nothing to a consumer, so both have to fail here.
const namesSchemaOrg = (context) => [context].flat().some((value) => {
  if (typeof value !== 'string') return false;
  try {
    return ['schema.org', 'www.schema.org'].includes(new URL(value).host);
  } catch {
    return false;
  }
});
for (const [file, html] of [['index.html', indexHtml], ['404.html', notFoundHtml]]) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach(([, body], index) => {
    const name = `${file} JSON-LD block ${index + 1}`;
    let data;
    try {
      data = JSON.parse(body);
    } catch (error) {
      bad(`${name} is not valid JSON: ${error.message} — search engines drop the whole block, and the page still looks perfect`);
      return;
    }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (!namesSchemaOrg(node?.['@context'])) {
        bad(`${name} has @context ${JSON.stringify(node?.['@context'] ?? null)} — it must resolve to the schema.org host (a lookalike like schema.org.org parses fine and means nothing) or every field in the block is unrecognized vocabulary`);
      }
    }
    checkSameOriginUrls(name, data);
  });
}

// --- RFC 9727 API catalog. The catalog, api/openapi.json and api/talks.json
// restate facts that live elsewhere, and nothing at runtime notices when one
// drifts: a stale talks.json serves last year's talks forever, and a catalog
// href to a renamed file is a 404 that an agent hits before any human does.
const parseJson = (name) => {
  try {
    return JSON.parse(read(name));
  } catch (error) {
    bad(`${name} is not valid JSON: ${error.message}`);
    return undefined;
  }
};

// talks.js is the file a contributor edits (README: "add one entry to
// talks.js"); api/talks.json is the copy the API serves. talks.js assigns to
// window and loads under Node, which is how validate-talks.js reads it too, so
// this compares parsed data rather than text — reformatting is not drift.
let talksFromJs;
try {
  global.window = {};
  require(path.join(root, 'static/js/talks.js'));
  talksFromJs = global.window.TALKS;
} catch (error) {
  bad(`static/js/talks.js failed to load: ${error.message}`);
}
const talksJson = parseJson('api/talks.json');
if (talksFromJs && talksJson && !isDeepStrictEqual(talksJson.talks, talksFromJs)) {
  bad('api/talks.json is out of sync with static/js/talks.js — the homepage and the API would disagree about the talks');
}

const catalog = parseJson('.well-known/api-catalog');
if (catalog && !Array.isArray(catalog.linkset)) {
  bad('.well-known/api-catalog has no linkset array (RFC 9727 Section 4.2)');
} else if (catalog) {
  catalog.linkset.forEach((entry, index) => {
    const name = `.well-known/api-catalog entry ${index + 1}`;
    if (typeof entry.anchor !== 'string' || !entry.anchor.startsWith('https://')) {
      bad(`${name} has no anchor — nothing says which API its links describe`);
    }
    // Only hrefs are checked against the tree: they are what a client fetches,
    // while an anchor is a link context and need not be retrievable.
    for (const [relation, links] of Object.entries(entry)) {
      if (relation === 'anchor' || !Array.isArray(links)) continue;
      for (const link of links) {
        if (typeof link?.href !== 'string') {
          bad(`${name} has a ${relation} link with no href`);
        } else if (link.href.startsWith(`${SITE_ORIGIN}/`)) {
          checkLocal(name, link.href.slice(SITE_ORIGIN.length));
        }
      }
    }
  });
}

// RFC 9727 Section 6.2 makes application/linkset+json a MUST, and the
// well-known URI has no extension for Cloudflare to infer a type from — the
// _headers rule is the only thing standing between it and the wrong type.
const headerRuleValues = (pattern) => {
  const lines = headers.split('\n');
  const start = lines.findIndex((line) => /^\S/.test(line) && line.trim() === pattern);
  if (start === -1) return undefined;
  const values = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) {
    if (lines[i].trim() !== '') values.push(lines[i].trim());
  }
  return values;
};
const catalogRule = headerRuleValues('/.well-known/api-catalog');
if (!catalogRule) {
  bad('_headers has no /.well-known/api-catalog rule, so the catalog is not served as application/linkset+json');
} else if (!catalogRule.some((line) => /^Content-Type:\s*application\/linkset\+json\b/i.test(line))) {
  bad('_headers does not set Content-Type: application/linkset+json on /.well-known/api-catalog (RFC 9727 Section 6.2 makes it a MUST)');
}

// Every path the description advertises must have a file behind it, or the
// OpenAPI document promises an endpoint that 404s.
const openapi = parseJson('api/openapi.json');
for (const endpoint of Object.keys(openapi?.paths ?? {})) {
  if (!fs.existsSync(path.join(root, endpoint.replace(/^\//, '')))) {
    bad(`api/openapi.json describes ${endpoint} but no file serves it`);
  }
}

// --- /auth.md discovery: agent tooling finds this document by fetching
// /auth.md and matching an H1 that contains "auth.md". Both the file and the
// heading are load-bearing, and neither failure is visible anywhere else in
// the build: the file is not linked from any page (so the file-reference check
// above never sees it) and Markdown has no schema, so a retitled heading —
// "# Authentication" reads perfectly well to a human — silently breaks
// discovery against a green build.
//
// Only ATX (`#`) headings count, deliberately. A setext heading ("auth.md"
// over "======") is a valid Markdown H1 that scanners looking for a literal
// `#` will still miss, so accepting it here would pass files that fail in
// production. This check stays at least as strict as the consumer.
const authMdPath = path.join(root, 'auth.md');
if (!fs.existsSync(authMdPath)) {
  bad('auth.md is missing — /auth.md is the discovery document agents fetch for this origin');
} else {
  // Fenced blocks first: a `# auth.md` inside a shell example is a comment,
  // not a heading, and must not satisfy the requirement.
  const authMd = fs.readFileSync(authMdPath, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  const h1s = [...authMd.matchAll(/^#[ \t]+(.*)$/gm)].map(([, text]) => text.trim());
  if (!h1s.some((text) => text.toLowerCase().includes('auth.md'))) {
    bad(h1s.length === 0
      ? 'auth.md has no H1 heading containing "auth.md" (found no ATX H1 at all) — agents locate the document by that heading'
      : `auth.md has no H1 heading containing "auth.md" — found [${h1s.join(', ')}]`);
  }
}

// --- _headers: the same header set by two rules that can match one path
// comma-joins into a single broken value. Overlap heuristic: a glob's
// "sample" is the glob with * removed; two patterns overlap when either
// pattern's regex matches the other's sample.
const rules = [];
for (const line of headers.split('\n')) {
  if (/^\s*(#|$)/.test(line)) continue;
  if (/^\S/.test(line)) {
    if (!line.startsWith('/')) bad(`_headers: pattern "${line.trim()}" must start with /`);
    rules.push({ pattern: line.trim(), names: [] });
  } else {
    const match = line.trim().match(/^([A-Za-z-]+):\s/);
    if (!match) bad(`_headers: malformed header line "${line.trim()}"`);
    else if (rules.length === 0) bad(`_headers: header line "${line.trim()}" before any pattern`);
    else rules.at(-1).names.push(match[1]);
  }
}
const globRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const overlaps = (a, b) => globRegex(a).test(b.replace(/\*/g, '')) || globRegex(b).test(a.replace(/\*/g, ''));
for (let i = 0; i < rules.length; i += 1) {
  for (let j = i + 1; j < rules.length; j += 1) {
    if (!overlaps(rules[i].pattern, rules[j].pattern)) continue;
    for (const name of rules[i].names) {
      if (rules[j].names.includes(name)) {
        bad(`_headers: ${name} is set by overlapping rules ${rules[i].pattern} and ${rules[j].pattern} — the values would comma-join`);
      }
    }
  }
}

// --- _redirects: well-formed lines. Cloudflare consumes this file and issues
// the 301 before any asset is served, so a source needs no file behind it.
for (const line of redirects.split('\n')) {
  if (/^\s*(#|$)/.test(line)) continue;
  const [source, target, status, extra] = line.trim().split(/\s+/);
  if (!source?.startsWith('/') || !target || extra !== undefined
      || (status !== undefined && !['301', '302', '307', '308'].includes(status))) {
    bad(`_redirects: malformed line "${line.trim()}"`);
  }
}

if (errors.length > 0) {
  console.error(`✗ ${root}:`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('✓ site invariants hold (CSP parity + coverage, embed referer, id contract, file references, JSON-LD, auth.md discovery, API catalog, _headers overlap, _redirects syntax)');
