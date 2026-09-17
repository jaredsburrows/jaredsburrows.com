#!/usr/bin/env node
// Validates cross-file invariants that node --check and vnu cannot see.
// Every check below is a regression that actually shipped or nearly did:
// - the _headers CSP and its index.html meta mirror drifting apart
// - the CSP missing a host the page really loads from (talk embeds were
//   blocked in production for a month this way)
// - the CSP missing an origin Cloudflare injects at the edge rather than one
//   the markup loads, which blocked the Web Analytics beacon (September 2026)
// - home.js targeting an id index.html no longer has (emptied the live
//   Presentations section in July 2026)
// - an embed iframe built without an explicit referrerpolicy, which broke
//   both YouTube talks with Error 153 in September 2026
// - a page or _headers preload referencing a local file that doesn't exist
// - /auth.md losing the H1 that agent discovery matches on
// - two _headers rules setting the same header on overlapping paths
//   (values from all matching rules comma-join into one broken header)
// - a _redirects source whose directory has no stub for the GitHub Pages
//   mirror, which ignores _redirects
// Usage: node .github/validate-site.js [site root]
'use strict';

const fs = require('fs');
const path = require('path');

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
for (const [file, html] of [['index.html', indexHtml], ['404.html', notFoundHtml]]) {
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|#|data:)/.test(reference) || reference === '/') continue;
    checkLocal(file, reference);
  }
}
for (const [, reference] of headers.matchAll(/Link:\s*<([^>]+)>/g)) {
  checkLocal('_headers Link preload', reference);
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

// --- _redirects: well-formed lines, and every source keeps a stub for the
// GitHub Pages mirror (which serves the files raw and ignores _redirects).
for (const line of redirects.split('\n')) {
  if (/^\s*(#|$)/.test(line)) continue;
  const [source, target, status, extra] = line.trim().split(/\s+/);
  if (!source?.startsWith('/') || !target || extra !== undefined
      || (status !== undefined && !['301', '302', '307', '308'].includes(status))) {
    bad(`_redirects: malformed line "${line.trim()}"`);
    continue;
  }
  const stub = path.join(root, source.replace(/\/$/, ''), 'index.html');
  if (!fs.existsSync(stub)) {
    bad(`_redirects: ${source} has no ${path.relative(root, stub)} stub for the GitHub Pages mirror`);
  }
}

if (errors.length > 0) {
  console.error(`✗ ${root}:`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('✓ site invariants hold (CSP parity + coverage, embed referer, id contract, file references, auth.md discovery, _headers overlap, _redirects stubs)');
