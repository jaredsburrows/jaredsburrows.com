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
// - /index.md, the markdown twin of the homepage, drifting away from the talks
//   index.html publishes (no page renders it, so only an agent would notice)
// - two _headers rules setting the same header on overlapping paths
//   (values from all matching rules comma-join into one broken header)
// - a cache TTL on /, which is content-negotiated: Cloudflare's cache ignores
//   Vary, so a stored copy would be served to every client whatever it asked
//   for (this one has not shipped — it is the one _headers edit that would
//   hand the markdown homepage to browsers, and nothing else would go red)
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
/** @param {string} name Site-relative path, e.g. 'static/js/home.js'. */
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
/** @type {string[]} */
const errors = [];
/** @param {string} message */
const bad = (message) => errors.push(message);
// `catch (error)` binds `unknown` under checkJs. This returns exactly what
// `error.message` returned before -- including `undefined` for a non-Error
// throw -- so every message below reads the same; it only moves the assertion
// out of five template literals that were unreadable with a cast inline.
/** @param {unknown} error @returns {string} */
const messageOf = (error) => /** @type {Error} */ (error).message;

const indexHtml = read('index.html');
const notFoundHtml = read('404.html');
const headers = read('_headers');
const redirects = read('_redirects');
const robotsTxt = read('robots.txt');
const homeJs = read('static/js/home.js');

// --- CSP parity: _headers is production, the meta tag is the GH Pages mirror.
// frame-ancestors is header-only by spec, so it may exist only in _headers.
/**
 * @param {string} csp
 * @returns {Map<string, string[]>} Directive name to its sorted source list.
 */
const parseCsp = (csp) => {
  /** @type {Map<string, string[]>} */
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

/** @type {Map<string, string[]>} */
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
/**
 * @param {string} origin
 * @param {string} source One CSP source expression, possibly a `*.` wildcard.
 */
const matchesSource = (origin, source) =>
  source === origin
  || (source.startsWith('https://*.') && origin.startsWith('https://')
      && origin.slice('https://'.length).endsWith(`.${source.slice('https://*.'.length)}`));

/**
 * @param {string} directive
 * @param {string} origin
 * @param {string} why Reported to the developer when the check fails.
 */
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
/** @param {string} source @returns {string} The same source, comments blanked. */
const stripComments = (source) => source.replace(
  /`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"|\/\*[\s\S]*?\*\/|\/\/.*/g,
  (/** @type {string} */ match) => (match.startsWith('/') ? ' ' : match));
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
  // Both patterns above define a `value` group, so a match always has one.
  .map((match) => /** @type {{ value: string }} */ (match.groups).value.trim().toLowerCase()));

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

// Declared here rather than beside sameOriginPath below because checkLocal
// resolves against it too, and everything under it is a caller.
const SITE_ORIGIN = 'https://jaredsburrows.com';

// --- Referenced local files must exist (pages plus _headers preloads).
// Each reference is resolved the way a client resolves it — through the URL
// parser, against the site origin — so `..` segments collapse before the path
// is used, and the normalized path must then land inside this tree. Both steps
// are load-bearing (S12): slicing the origin off and stripping one leading
// slash let a `..` walk out of the repo, and `fs.existsSync` happily confirmed
// a file the site does not serve. Every real client normalizes
// https://jaredsburrows.com/../../etc/hosts to /etc/hosts on this origin and
// gets a 404, so a check that passes it is a gate that fails open.
/**
 * @param {string} source File the reference was found in, for the message.
 * @param {string} reference The href/src as written.
 */
const checkLocal = (source, reference) => {
  let url;
  try {
    url = new URL(reference, `${SITE_ORIGIN}/`);
  } catch {
    bad(`${source} references ${reference}, which is not a URL any client can resolve`);
    return;
  }
  if (url.origin !== SITE_ORIGIN) {
    bad(`${source} references ${reference}, which resolves to ${url.origin} — this site can only serve its own origin`);
    return;
  }
  // Decode before the containment check, not after: `%2e%2e%2f` is one opaque
  // segment to the URL parser and only becomes `../` here.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    bad(`${source} references ${reference}, whose path is not valid percent-encoding`);
    return;
  }
  const target = path.resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    bad(`${source} references ${reference}, which escapes the site root — no client can fetch a path outside this origin`);
    return;
  }
  if (!fs.existsSync(target)) {
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
//
// Which references are ours is decided by the PARSED host, never by a string
// prefix (S18). `https://jaredsburrows.com/…` is only one of the forms every
// client resolves to this origin: `//jaredsburrows.com/…` (protocol-relative,
// and an ordinary thing to write in an og:image), `http://…`,
// `HTTPS://JaredsBurrows.COM/…` and the default-port `…:443/…` all land here
// too, and a prefix test skips every one of them as "off-origin" — so the S11
// rename invariant could be switched back off by REWRITING a reference rather
// than deleting it. Host equality keeps out the lookalikes the trailing slash
// used to handle: jaredsburrows.com.evil.test and notjaredsburrows.com are
// different hosts and stay off-origin, and so does blog.jaredsburrows.com,
// a real subdomain this repo does not serve. Only the one host this tree is
// deployed to belongs in the set; adding another has to be a deliberate edit.
const SITE_HOSTS = new Set([new URL(SITE_ORIGIN).host]);
// Only a value carrying an authority (`scheme://host` or `//host`) can be a
// same-origin ABSOLUTE reference. Relative values are the callers' business,
// and resolving them here would turn prose like
// content="width=device-width, initial-scale=1" into a file reference.
// Backslashes count as separators because the URL parser treats them as such
// for http(s): `https:/\jaredsburrows.com/x` loads this origin in a browser.
const AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\\/?#]*/i;
/**
 * @param {string} reference
 * @returns {string | undefined} The path as written, or undefined when the
 *   reference is not a same-origin absolute URL. Callers test `!== undefined`.
 */
const sameOriginPath = (reference) => {
  const authority = reference.match(AUTHORITY);
  if (!authority) return undefined;
  let url;
  try {
    url = new URL(reference, `${SITE_ORIGIN}/`);
  } catch {
    return undefined;
  }
  if (!SITE_HOSTS.has(url.host) || !['http:', 'https:'].includes(url.protocol)) return undefined;
  // What follows the authority is handed on AS WRITTEN, not as the parser
  // normalized it, so checkLocal reports the reference the author typed and
  // still runs its own resolution and containment check over it (S12).
  const rest = reference.slice(authority[0].length);
  // A remainder starting with two separators would re-parse as another
  // authority instead of a path, so that one shape passes the whole reference
  // on and checkLocal resolves it as the absolute URL it already is.
  return /^[\\/]{2}/.test(rest) ? reference : (rest || '/');
};
// Walks parsed data (JSON-LD, any object or array) for the same absolute URLs.
//
// Iterative and depth-capped (S20). The recursive version was called from
// OUTSIDE the try that guards JSON.parse, so a deeply nested block threw an
// uncaught RangeError: a raw stack trace with no bad() message and no file
// name, and every invariant declared after the JSON-LD loop (API catalog,
// auth.md discovery, _headers overlap, _redirects syntax) never ran at all —
// one malformed block silently disabling four unrelated checks. Cycles are
// impossible because JSON.parse always returns a tree, so depth was the only
// hazard, and V8's parser is itself iterative: it hands back a 20000-deep
// object quite happily for the walk to overflow on.
const MAX_JSON_LD_DEPTH = 64;
/**
 * @param {string} source File the JSON-LD block came from.
 * @param {unknown} value Any node of the parsed tree; walked breadth-first.
 */
const checkSameOriginUrls = (source, value) => {
  /** @type {Array<[unknown, number]>} */
  const queue = [[value, 0]];
  for (let i = 0; i < queue.length; i += 1) {
    const [node, depth] = queue[i];
    if (typeof node === 'string') {
      const reference = sameOriginPath(node);
      if (reference !== undefined && reference !== '/') checkLocal(source, reference);
    } else if (node !== null && typeof node === 'object') {
      if (depth >= MAX_JSON_LD_DEPTH) {
        bad(`${source} nests more than ${MAX_JSON_LD_DEPTH} levels deep — no consumer reads structured data that deep and nothing hand-written comes near it, so the block is malformed and the rest of it was not walked`);
        return;
      }
      for (const item of Object.values(node)) queue.push([item, depth + 1]);
    }
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
// Every block is parsed and reported on its own: a page may carry more than
// one (the Person entity, plus a WebSite block for the site name beside it),
// and a check that stopped at the first match would cover the second never at
// all. Everything below reads the PARSED object, never the file text — the
// blocks sit next to HTML comments documenting what was deliberately left out,
// so `grep SearchAction index.html` prints 1 on a page whose JSON-LD contains
// no such thing, and an invariant written as a text search would fire on the
// comment.
//
// @context is matched by URL host, not by substring: 'https://schema.org.org'
// and 'https://schema.org.example.com' both contain the string and both mean
// nothing to a consumer, so both have to fail here.
/** @param {unknown} context The @context value, string or array. */
const namesSchemaOrg = (context) => [context].flat().some((value) => {
  if (typeof value !== 'string') return false;
  try {
    return ['schema.org', 'www.schema.org'].includes(new URL(value).host);
  } catch {
    return false;
  }
});
// The block match below stops at a literal `</script>`, but the HTML tokenizer
// ends script data at `</script` followed by a space, tab, LF, FF, `/` or `>`
// — so a JSON string containing `</script  >` closes the element in every
// browser and scraper while this file reads straight past it, parses the whole
// body as valid JSON and reports nothing (S19). What follows the breakout
// lands where `script-src 'self' 'unsafe-inline'` lets inline script run.
// Rejecting the sequence is also what makes the simpler match EXACT rather
// than merely tolerable: a body containing no `</script` + terminator ends
// where the browser ends it, so the bytes validated here are the bytes
// consumed there, and widening the regex instead would only have turned a
// breakout into a confusing "not valid JSON" on a truncated body.
//
// The comment markers are rejected for related reasons, and each is a distinct
// tokenizer state rather than one rule repeated:
// - `<!--` is the only entry into script-data-escaped state, and from there a
//   nested `<script` reaches script-data-DOUBLE-escaped state, where
//   `</script>` stops ending the element at all. Rejecting the entry closes
//   that whole family, including the abrupt-close forms `<!-->` and `<!--->`,
//   which contain it.
// - `-->` leaves script-data-escaped state again (escaped-dash-dash, then
//   `>`), and ends an HTML comment.
// - `--!>` does NOT leave script data escaped state — `!` is "anything else"
//   there — but the comment-end-BANG state makes it a comment terminator just
//   like `-->`, and these blocks are written BETWEEN HTML comments. A filter
//   that knows only `-->` is incomplete about the comment family in precisely
//   the way this guard exists to stop being incomplete about the script family
//   (CodeQL js/bad-tag-filter, alert 8 on PR #147).
// Hand-written JSON-LD needs none of them: `<\/script` is the same string
// after JSON unescaping and no tokenizer can see it.
const SCRIPT_BREAKOUT = /<\/script[\s/>]|<!--|--!?>/i;
for (const [file, html] of [['index.html', indexHtml], ['404.html', notFoundHtml]]) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach(([, body], index) => {
    const name = `${file} JSON-LD block ${index + 1}`;
    if (SCRIPT_BREAKOUT.test(body)) {
      bad(`${name} contains a sequence that ends the script element early — \`</script\` followed by whitespace, \`/\` or \`>\`, or an HTML comment marker — so a browser stops reading JSON there and parses the rest as markup; write \`<\\/script\` inside the JSON string instead, which unescapes to the same text`);
      return;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch (error) {
      bad(`${name} is not valid JSON: ${messageOf(error)} — search engines drop the whole block, and the page still looks perfect`);
      return;
    }
    // Everything past the parse runs inside a try as well: four more
    // invariants are declared after this loop (API catalog, auth.md discovery,
    // _headers overlap, _redirects syntax) and a throw here would skip every
    // one of them, with a stack trace instead of a message naming the file
    // (S20). The walk is bounded now, so this is the backstop that keeps that
    // class of failure per-block rather than fatal, not a live path.
    try {
      for (const node of Array.isArray(data) ? data : [data]) {
        if (!namesSchemaOrg(node?.['@context'])) {
          bad(`${name} has @context ${JSON.stringify(node?.['@context'] ?? null)} — it must resolve to the schema.org host (a lookalike like schema.org.org parses fine and means nothing) or every field in the block is unrecognized vocabulary`);
        }
      }
      checkSameOriginUrls(name, data);
    } catch (error) {
      bad(`${name} could not be validated: ${messageOf(error)}`);
    }
  });
}

// --- RFC 9727 API catalog. The catalog, api/openapi.json and api/talks.json
// restate facts that live elsewhere, and nothing at runtime notices when one
// drifts: a stale talks.json serves last year's talks forever, and a catalog
// href to a renamed file is a 404 that an agent hits before any human does.
/** @param {string} name @returns {any} Parsed tree, or null when unreadable. */
const parseJson = (name) => {
  try {
    return JSON.parse(read(name));
  } catch (error) {
    bad(`${name} is not valid JSON: ${messageOf(error)}`);
    return undefined;
  }
};

// talks.js is the file a contributor edits (README: "add one entry to
// talks.js"); api/talks.json is the copy the API serves. talks.js assigns to
// window and loads under Node, which is how validate-talks.js reads it too, so
// this compares parsed data rather than text — reformatting is not drift.
/** @type {any} */
let talksFromJs;
try {
  // Same trick validate-talks.js uses: talks.js is a browser script that
  // assigns to `window`, so running it under Node means providing one.
  /** @type {any} */ (global).window = {};
  require(path.join(root, 'static/js/talks.js'));
  talksFromJs = /** @type {any} */ (global).window.TALKS;
} catch (error) {
  bad(`static/js/talks.js failed to load: ${messageOf(error)}`);
}
const talksJson = parseJson('api/talks.json');
if (talksFromJs && talksJson && !isDeepStrictEqual(talksJson.talks, talksFromJs)) {
  bad('api/talks.json is out of sync with static/js/talks.js — the homepage and the API would disagree about the talks');
}

const catalog = parseJson('.well-known/api-catalog');
if (catalog && !Array.isArray(catalog.linkset)) {
  bad('.well-known/api-catalog has no linkset array (RFC 9727 Section 4.2)');
} else if (catalog) {
  catalog.linkset.forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
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
        } else {
          const reference = sameOriginPath(link.href);
          if (reference !== undefined) checkLocal(name, reference);
        }
      }
    }
  });
}

// RFC 9727 Section 6.2 makes application/linkset+json a MUST, and the
// well-known URI has no extension for Cloudflare to infer a type from — the
// _headers rule is the only thing standing between it and the wrong type.
/** @param {string} pattern */
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

// --- ARD capability manifest. Published at two well-known paths because the
// spec renamed the file between revisions: /.well-known/ard.json is the v0.91
// primary and /.well-known/ai-catalog.json the predecessor that today's
// scanners still probe. Same blind spot as the API catalog above, one step
// worse: no page renders a manifest, nothing at runtime reads one, and the two
// copies are kept in step by hand — so drift and dead URLs are invisible until
// an agent fetches a capability this site does not actually serve, which is a
// worse outcome than publishing no manifest at all.
const ARD_PATHS = ['.well-known/ai-catalog.json', '.well-known/ard.json'];
const ardText = new Map();
for (const name of ARD_PATHS) {
  try {
    ardText.set(name, read(name));
  } catch (error) {
    bad(`${name} is missing — the ARD manifest is published at both well-known paths (${messageOf(error)})`);
  }
}

// Byte equality, not deep equality: the two files are a copy, and the whole
// point of the pair is that an agent gets the same bytes whichever path its
// spec revision tells it to try.
const [aiCatalogPath, ardPath] = ARD_PATHS;
if (ardText.size === ARD_PATHS.length && ardText.get(aiCatalogPath) !== ardText.get(ardPath)) {
  bad(`${aiCatalogPath} and ${ardPath} are not byte-identical — edit ${aiCatalogPath} and copy it to ${ardPath} in the same commit`);
}

// Both files are parsed, not just one. Byte equality alone would happily pass a
// pair that is identically broken.
for (const name of ARD_PATHS) {
  if (!ardText.has(name)) continue;
  const manifest = parseJson(name);
  if (!manifest) continue;
  if (!Array.isArray(manifest.entries)) {
    bad(`${name} has no entries array, so it advertises no capability at all`);
    continue;
  }
  manifest.entries.forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
    const label = `${name} entry ${index + 1}`;
    // ARD Section 4.3: an entry either points at a resource or inlines it —
    // never both (which one is authoritative?) and never neither (an entry
    // that resolves to nothing).
    const hasUrl = typeof entry.url === 'string';
    const hasData = entry.data !== undefined;
    if (hasUrl === hasData) {
      bad(`${label} must have exactly one of url or data (ARD Section 4.3) but has ${hasUrl ? 'both' : 'neither'}`);
    }
    // Same rule as the catalog hrefs: only same-origin URLs can be checked
    // against this tree, and only they are ours to keep honest.
    const reference = hasUrl ? sameOriginPath(entry.url) : undefined;
    if (reference !== undefined) checkLocal(label, reference);
  });
}

// robots.txt Agentmap: the third route to the same manifest, and the one with
// no safety net anywhere else. Conforming robots parsers ignore directives they
// do not recognise, so a typo here costs nothing a crawler would ever report.
for (const [, declared] of robotsTxt.matchAll(/^[ \t]*Agentmap:[ \t]*(\S+)[ \t]*$/gim)) {
  const reference = sameOriginPath(declared);
  if (reference !== undefined) checkLocal('robots.txt Agentmap', reference);
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

// --- /index.md, the markdown twin of the homepage. src/worker.mjs serves it
// from / when the request names `text/markdown` in `Accept`, so for an agent
// asking for markdown this file IS the homepage — and no browser ever renders
// it, which makes every failure here invisible outside CI. The twin is
// hand-written on purpose (generating it would be the build step this site has
// never had), so it can only be kept honest by checking it against the files it
// restates: it must exist, it must open with the H1 a markdown reader shows as
// the title, the blockquote under that H1 must be index.html's meta description
// verbatim, and its talks list must agree with `static/js/talks.js` in both
// directions. The talks one is the drift that will actually happen: a talk gets
// added to talks.js and api/talks.json (README tells you to do both) and the
// twin quietly keeps serving the old list to every agent that prefers markdown.
const MARKDOWN_TWIN = 'index.md';
const twinPath = path.join(root, MARKDOWN_TWIN);
if (!fs.existsSync(twinPath)) {
  bad(`${MARKDOWN_TWIN} is missing — / would fall back to HTML for every agent that asks for markdown`);
} else {
  const twin = fs.readFileSync(twinPath, 'utf8');
  // Anchored at the start of the file, not at any line: the first thing in a
  // markdown document is its title, and front matter or a stray preamble ahead
  // of it is exactly the kind of "generator crept in" change to reject.
  if (!/^#[ \t]+\S/.test(twin)) {
    bad(`${MARKDOWN_TWIN} does not start with an ATX H1 ("# Jared Burrows") — the markdown homepage has no title`);
  }

  // The summary has exactly one source. index.html's <meta name="description">
  // is the sentence search engines and link unfurls quote; the twin quotes it
  // back, as the blockquote directly under the H1, so an agent gets the same
  // sentence a search result would. It is a blockquote and not a paragraph
  // precisely so the prose beneath it can carry only what the summary does not
  // already say — the two used to restate each other (BUGS.md B3). Two
  // hand-written copies of one sentence drift silently — nothing renders both —
  // so they are compared here. The normalisation is Markdown's own: the `> `
  // marker comes off each line and a single newline inside the quote renders as
  // a space, so what is compared is the rendered text, byte for byte. Both sides
  // stay plain text: an HTML entity on one side and its character on the other
  // fails this check, and the fix is to keep both plain rather than to teach it
  // to decode.
  const descriptionMatch = indexHtml.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!descriptionMatch) {
    bad('index.html: <meta name="description"> not found, so the markdown twin has nothing to match its summary blockquote against');
  } else if (/^#[ \t]+\S/.test(twin)) {
    const lines = twin.split('\n');
    const summary = [];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') {
        if (summary.length > 0) break;
        continue;
      }
      if (!line.startsWith('>')) break;
      summary.push(line.replace(/^>[ \t]?/, ''));
    }
    if (summary.length === 0) {
      bad(`${MARKDOWN_TWIN} has no summary blockquote under its H1 — the first thing after the title must be index.html's meta description, quoted`);
    } else if (summary.join(' ') !== descriptionMatch[1]) {
      bad(`${MARKDOWN_TWIN} summary blockquote is not index.html's meta description verbatim — the same sentence is written twice and one copy has drifted\n      ${MARKDOWN_TWIN}:   ${summary.join(' ')}\n      index.html: ${descriptionMatch[1]}`);
    }
  }

  // The talks list, in both directions. The forward half (every published talk
  // is in the twin) catches the add that forgets the twin; the reverse half
  // catches the delete that forgets it, which is the one nothing else can see —
  // a talk dropped from talks.js and api/talks.json keeps being served to every
  // agent that reads markdown. Counted, not set-compared, because two talks
  // share the title "The Road to Single Dex", so losing one of them is invisible
  // to a containment test. Only `### ` headings inside the `## Talks` section
  // count: prose elsewhere in the file that mentions a title must not satisfy
  // the requirement, and a heading outside that section is not part of the
  // twin's talks list. Order is not checked — the HTML page sorts itself.
  const twinLines = twin.split('\n');
  const talksHeading = twinLines.findIndex((line) => /^##[ \t]+Talks[ \t]*$/.test(line));
  if (talksHeading === -1) {
    bad(`${MARKDOWN_TWIN} has no "## Talks" section — the markdown homepage publishes no talks at all`);
  } else {
    const listed = [];
    for (let i = talksHeading + 1; i < twinLines.length && !/^##[ \t]/.test(twinLines[i]); i += 1) {
      const heading = twinLines[i].match(/^###[ \t]+(.*?)[ \t]*$/);
      if (heading) listed.push(heading[1]);
    }
    /** @param {string[]} titles @returns {Map<string, number>} */
    const tally = (titles) => titles.reduce(
      (counts, title) => counts.set(title, (counts.get(title) ?? 0) + 1),
      /** @type {Map<string, number>} */ (new Map()));
    const published = tally((talksFromJs ?? []).map((/** @type {Talk} */ talk) => talk.title));
    const twinned = tally(listed);
    for (const title of new Set([...published.keys(), ...twinned.keys()])) {
      const inJs = published.get(title) ?? 0;
      const inTwin = twinned.get(title) ?? 0;
      if (inTwin === 0) {
        bad(`${MARKDOWN_TWIN} does not list the talk "${title}" from static/js/talks.js — the HTML and markdown homepages would disagree about the talks`);
      } else if (inJs === 0) {
        bad(`${MARKDOWN_TWIN} lists a talk "${title}" that static/js/talks.js does not publish — the markdown homepage would keep serving a talk the site has dropped`);
      } else if (inJs !== inTwin) {
        bad(`${MARKDOWN_TWIN} lists the talk "${title}" ${inTwin} time(s) but static/js/talks.js publishes it ${inJs} time(s) — the HTML and markdown homepages would disagree about the talks`);
      }
    }
  }
}

// The markup half of the same contract: an agent that parses HTML rather than
// guessing URLs finds the twin through rel=alternate, and it is the only
// discovery path that survives the Worker being rolled back.
const headMatch = indexHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
if (!headMatch) {
  bad('index.html: no <head> element found');
} else {
  const alternateLink = [...headMatch[1].matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .find((tag) => /\srel="alternate"/i.test(tag) && /\stype="text\/markdown"/i.test(tag));
  if (!alternateLink) {
    bad(`index.html head has no <link rel="alternate" type="text/markdown"> pointing at /${MARKDOWN_TWIN}`);
  } else if (!new RegExp(`\\shref="/${MARKDOWN_TWIN.replace('.', '\\.')}"`).test(alternateLink)) {
    bad(`index.html rel=alternate markdown link does not point at /${MARKDOWN_TWIN}: ${alternateLink}`);
  }
}

// And the cache half: / has two representations now, so a downstream cache that
// never sees the Accept header would be free to hand the markdown to a browser.
// src/worker.mjs sets Vary on the responses it builds, but the ones it hands
// back untouched (a 304 has no body to re-wrap) get it only from here — and
// this is also what keeps / varying if the Worker is ever rolled back. Vary is
// only half the protection; the TTL half is checked with the other _headers
// rules below, because Cloudflare's own cache does not honour Vary.
const homepageRule = headerRuleValues('/');
if (!homepageRule) {
  bad('_headers has no "/" rule, so the homepage cannot carry Vary: Accept');
} else {
  const varyValues = homepageRule
    .filter((line) => /^Vary:/i.test(line))
    .flatMap((line) => line.slice(line.indexOf(':') + 1).split(',').map((value) => value.trim().toLowerCase()));
  if (!varyValues.includes('accept')) {
    bad('_headers "/" rule does not set Vary: Accept — / is content-negotiated between HTML and markdown, so caches must key on Accept');
  }
}

// --- _headers: the same header set by two rules that can match one path
// comma-joins into a single broken value. Overlap heuristic: a glob's
// "sample" is the glob with * removed; two patterns overlap when either
// pattern's regex matches the other's sample.
/**
 * One `_headers` block: the glob it matches, and the headers it sets under it.
 * @typedef {{ pattern: string, names: string[], set: Array<{ name: string, value: string }> }} HeaderRule
 */
/** @type {HeaderRule[]} */
const rules = [];
for (const line of headers.split('\n')) {
  if (/^\s*(#|$)/.test(line)) continue;
  if (/^\S/.test(line)) {
    if (!line.startsWith('/')) bad(`_headers: pattern "${line.trim()}" must start with /`);
    rules.push({ pattern: line.trim(), names: [], set: [] });
  } else {
    const match = line.trim().match(/^([A-Za-z-]+):\s/);
    if (!match) bad(`_headers: malformed header line "${line.trim()}"`);
    else if (rules.length === 0) bad(`_headers: header line "${line.trim()}" before any pattern`);
    else {
      const trimmed = line.trim();
      // The `rules.length === 0` branch above is what guarantees this exists.
      const rule = /** @type {HeaderRule} */ (rules.at(-1));
      rule.names.push(match[1]);
      rule.set.push({ name: match[1], value: trimmed.slice(trimmed.indexOf(':') + 1).trim() });
    }
  }
}
/** @param {string} pattern A `_headers` glob, e.g. `/static/*`. */
const globRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
/** @param {string} a @param {string} b */
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

// --- _headers: / is content-negotiated, so it must never be given a TTL.
// Two representations share one URL (src/worker.mjs answers Accept:
// text/markdown with index.md, everything else with the HTML), and Vary does
// not protect them from each other at the edge: Cloudflare's cache keys on the
// URL and Accept-Encoding, and ignores Vary for every other request header —
// production already returns cf-cache-status: HIT for /, so that cache is in
// scope. The only thing keeping the two apart today is that / is never stored:
// Workers Assets serves it max-age=0, must-revalidate, so every hit
// revalidates through the Worker. Give / a positive max-age or s-maxage — in
// its own rule or in any glob that matches it — and one agent request with
// Accept: text/markdown fills the shared entry that every browser and
// Googlebot behind it then reads. That is cache poisoning of the homepage with
// nothing else in the build going red, which is why it is an invariant here
// rather than a comment in _headers. A zero TTL is fine: pinning
// `Cache-Control: public, max-age=0, must-revalidate` on / states the default
// rather than changing it.
//
// The Worker pins the same value on the markdown response (src/worker.mjs,
// SECURITY.md S6), which covers the route this check cannot see — that response
// republishes /index.md's headers under / — and this check covers the route the
// pin cannot: a TTL on / itself, where the HTML branch hands the asset router's
// response straight back. Neither is a substitute for the other, and neither
// can see a zone-level Cache Rule (README says so).
const NEGOTIATED_PATH = '/';
// Every header name that decides how long a copy of / may be reused, not just
// the obvious one: Cloudflare reads CDN-Cache-Control for its own cache, and
// Cloudflare-CDN-Cache-Control in preference to both. Neither is forwarded to
// the client, so checking Cache-Control alone misses the two spellings a
// Cloudflare-specific "how do I cache this?" reaches for — and misses them
// invisibly, since a curl against production would not show them either
// (SECURITY.md S7).
const TTL_HEADERS = ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control'];
// Every directive that lets a shared cache answer from a stored copy instead of
// revalidating through the Worker. stale-while-revalidate and stale-if-error do
// it after max-age has run out, so `max-age=0, stale-while-revalidate=600` is
// the same poisoning window arriving by another route.
const TTL_DIRECTIVES = ['max-age', 's-maxage', 'stale-while-revalidate', 'stale-if-error'];
for (const rule of rules.filter((candidate) => globRegex(candidate.pattern).test(NEGOTIATED_PATH))) {
  /** @param {string} name @param {string} value */
  const poisons = (name, value) => bad(`_headers rule ${rule.pattern} sets ${name}: ${value} on ${NEGOTIATED_PATH} — ${NEGOTIATED_PATH} serves HTML or markdown depending on Accept, and Cloudflare's cache ignores Vary, so a stored copy is handed to every client whatever it asked for: one agent request would leave the markdown homepage in the edge cache for browsers and Googlebot. ${NEGOTIATED_PATH} must keep revalidating (max-age=0)`);
  for (const { name, value } of rule.set) {
    const header = name.toLowerCase();
    // Expires is the weakest of these — Workers Assets' own max-age=0 outranks
    // it unless the rule replaces Cache-Control too — but it is still a TTL
    // written for /, and the rule that does both is one line away. `Expires: 0`
    // is the conventional spelling of "already stale" and is not a TTL.
    if (header === 'expires' && value.trim() !== '0') poisons(name, value);
    if (!TTL_HEADERS.includes(header)) continue;
    for (const directive of value.split(',')) {
      // Quotes are legal around a directive value (RFC 9111 §5.2.6), so they
      // are stripped rather than allowed to hide the number. Then: any
      // delta-seconds that is not zero, however it is spelled. The check used
      // to require digits only, which let `max-age=60.0` through (BUGS.md B4) —
      // RFC 9111's grammar is 1*DIGIT, so a strict cache ignores that directive
      // entirely, but "strict" is not a property the edge guarantees and some
      // implementations read the leading 60. The same argument covers `+600`
      // and `6e2`, so the test is "is this zero?" rather than a list of
      // spellings: a value that no cache honours costs a build on a header that
      // had no business being on / anyway, while a value one cache honours is
      // the whole finding.
      const ttl = directive.trim().match(/^([a-z-]+)\s*=\s*"?([^"]*)"?$/i);
      if (ttl && TTL_DIRECTIVES.includes(ttl[1].toLowerCase()) && Number(ttl[2]) !== 0) {
        poisons(name, value);
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
console.log('✓ site invariants hold (CSP parity + coverage, embed referer, id contract, file references, JSON-LD, auth.md discovery, markdown twin, API catalog, ARD manifest, _headers overlap, / stays uncacheable, _redirects syntax)');
