// Behavioral invariant: every cross-origin iframe the homepage actually mounts
// carries an explicit, referer-preserving `referrerpolicy`.
//
// Why a DOM and not a text scan: YouTube's player refuses to configure without
// a referer, and a document Referrer-Policy of same-origin sends none
// cross-origin — a Cloudflare zone rule applied exactly that for a month
// (B1/B2), so the frames pin the policy themselves. Three rounds of regex
// hardening in validate-site.js tried to assert that from home.js's source
// text and lost eleven times (B3, B4, B5, B7-B12, S23-S26): every defeat was a
// data-flow or reachability question — a decoy element, a call after `return`,
// an early conditional return, a reassigned local, a later
// removeAttribute, a ternary handing back the other frame, an unused
// textually-earlier builder, a call in a callback that never runs. Regex
// cannot answer any of those, and two of its answers (B12, S28) were wrong
// about correct code. So this file stops reading the source and reads the DOM:
// load the real page, drive the accordion so the lazily-built embeds mount,
// and look at the iframes that exist. Anything that leaves a real frame
// unprotected fails here by construction, whatever the source looks like.

//
// jsdom, not a browser: no binary to download in CI, and mounting elements and
// reading attributes is all this needs. It is an exact-pinned devDependency in
// package.json, so `npm ci` brings it and Renovate and OSV can both see it —
// not a `--no-save` line like vnu-jar, because a second `--no-save` install
// prunes whatever the first one added, even with a manifest present.
//
// Run: npm ci && node --test .github/embed-referrerpolicy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// jsdom is CommonJS and exposes no ESM named exports.
import jsdom from 'jsdom';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} name Path relative to the repo root. */
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const SITE_ORIGIN = 'https://jaredsburrows.com';

// Equal-or-tighter than the _headers Referrer-Policy and still referer enough
// for YouTube. no-referrer and same-origin send nothing cross-origin (Error
// 153 again); unsafe-url, origin and the two *-when-downgrade values leak more.
// Matched as the HTML parser matches an enumerated attribute: ASCII
// case-insensitive against the whole value, with no whitespace stripping — a
// padded ' strict-origin ' hits the invalid-value default, so the frame falls
// back to the document policy and must read red here.
const ALLOWED_REFERRER_POLICIES = ['strict-origin-when-cross-origin', 'strict-origin'];

const CONTENT_TYPES = new Map([
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.json', 'application/json'],
]);

// --- the production CSP's frame-src, so a new embed provider is covered the
// day it is added instead of when someone remembers to update a list here.
const cspFrameSources = () => {
  const csp = read('_headers').match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  assert.ok(csp, '_headers: Content-Security-Policy line not found');
  const frameSrc = csp[1].split(';').map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'frame-src');
  assert.ok(frameSrc, '_headers: the CSP has no frame-src directive');
  return frameSrc.slice(1);
};

// CSP host-source matching, cut down to what frame-src uses here: an exact
// origin or a single leading `*.` label wildcard, which does NOT match the
// apex it is a wildcard of.
/**
 * @param {string} origin
 * @param {string[]} sources The tokens after the directive name.
 */
const allowedBy = (origin, sources) => sources.some((source) =>
  source === origin
  || (source.startsWith('https://*.') && origin.startsWith('https://')
      && origin.slice('https://'.length).endsWith(`.${source.slice('https://*.'.length)}`)));

// --- mount the page the way a browser does: index.html parsed at the site
// origin, its own deferred scripts fetched from disk and executed in order.
// Every request is answered here, so the run is offline and deterministic:
// same-origin URLs come from the working tree, everything third-party gets an
// empty 200 (a failed load would only add console noise — no invariant below
// depends on gtag.js, GTM or the embed documents themselves).
const mount = async () => {
  /** @type {string[]} Same-origin pathnames the page actually asked for. */
  const served = [];
  const intercept = requestInterceptor((request) => {
    if (request.url.startsWith(`${SITE_ORIGIN}/`)) {
      const file = path.join(root, new URL(request.url).pathname.replace(/^\/+/, ''));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        served.push(new URL(request.url).pathname);
        return new Response(fs.readFileSync(file), {
          headers: { 'Content-Type': CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream' },
        });
      }
    }
    return new Response('', { headers: { 'Content-Type': 'text/plain' } });
  });

  /** @type {string[]} */
  const failures = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => failures.push(error.message));

  const dom = new JSDOM(read('index.html'), {
    url: `${SITE_ORIGIN}/`,
    runScripts: 'dangerously',
    resources: { interceptors: [intercept] },
    virtualConsole,
    beforeParse(window) {
      // jsdom 30 does not implement HTMLIFrameElement.referrerPolicy, so the
      // property spelling of the assignment would land on an expando and set
      // no attribute — red on code that works in every browser. Reflect it the
      // way the IDL says (the "limited to only known values" filtering on the
      // getter is left out: nothing on the page reads it back, and the
      // assertions match the keyword themselves). Guarded, so jsdom
      // implementing it for real takes this over.
      const proto = window.HTMLIFrameElement.prototype;
      if (!('referrerPolicy' in proto)) {
        Object.defineProperty(proto, 'referrerPolicy', {
          configurable: true,
          enumerable: true,
          get() { return this.getAttribute('referrerpolicy') ?? ''; },
          set(value) { this.setAttribute('referrerpolicy', value); },
        });
      }
    },
  });

  await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));

  // The embeds are built on first expand, so nothing is in the DOM until the
  // accordion is driven. Every row, because a per-talk difference (only one
  // provider protected, or only the first talk) must not hide behind a
  // spot check. Rows stay expanded-or-not; the embeds they built stay mounted.
  const rows = [...(/** @type {NodeListOf<HTMLElement>} */ (dom.window.document.querySelectorAll('.talk-row')))];
  for (const row of rows) row.click();

  return { window: dom.window, document: dom.window.document, rows, served, failures };
};

const page = await mount();

const iframes = () => [...page.document.querySelectorAll('iframe')]
  // A <noscript> iframe is markup for the no-JS rendering, where home.js never
  // runs and none of the embeds below exist; jsdom keeps it unparsed while
  // scripting is on, and it must not be held to a policy its own page can't set.
  .filter((frame) => !frame.closest('noscript'));

const crossOriginIframes = () => iframes().flatMap((frame) => {
  const src = frame.getAttribute('src') ?? '';
  let origin;
  try {
    origin = new URL(src, `${SITE_ORIGIN}/`).origin;
  } catch {
    // An unparseable src frames nothing cross-origin, so there is no referer
    // to protect and nothing for the CSP to allow.
    return [];
  }
  return origin === SITE_ORIGIN ? [] : [{ frame, src, origin }];
});

// --- The page has to have actually run, or every assertion below is vacuously
// true over an empty DOM. These are the preconditions, asserted, not assumed.
test('the homepage mounts: its own scripts run and every talk renders a row', () => {
  assert.deepEqual(page.failures, [], 'jsdom reported page errors');
  for (const script of ['/static/js/talks.js', '/static/js/home.js']) {
    assert.ok(page.served.includes(script), `${script} was never fetched by the page`);
  }
  const talks = page.window.TALKS;
  assert.ok(Array.isArray(talks) && talks.length > 0, 'talks.js defined no window.TALKS');
  assert.equal(page.rows.length, talks.length, 'index.html rendered a different number of talk rows than talks.js has talks');
  const errorRow = page.document.getElementById('talks-error');
  assert.ok(errorRow, 'index.html has no #talks-error element');
  assert.equal(errorRow.hidden, true, 'the page fell back to its talks-error state');
});

test('expanding the accordion mounts an embed for every talk that has one', () => {
  const sources = crossOriginIframes().map(({ src }) => src);
  const expected = (page.window.TALKS ?? []).flatMap((talk) =>
    [talk.youtube, talk.speakerdeck].filter((id) => id !== undefined)
      .map((id) => /** @type {[string, string]} */ ([talk.title, id])));
  assert.ok(expected.length > 0, 'no talk in talks.js has a video or slide deck to embed');
  for (const [title, id] of expected) {
    assert.ok(sources.some((src) => src.includes(id)),
      `no cross-origin iframe carries ${id} (${title}) — the embeds did not mount, so this file proves nothing`);
  }
});

// --- The invariant itself.
test('every cross-origin iframe in the mounted page carries a referer-preserving referrerpolicy', () => {
  const frames = crossOriginIframes();
  assert.ok(frames.length > 0, 'the mounted page has no cross-origin iframes to check');
  for (const { frame, src, origin } of frames) {
    const policy = frame.getAttribute('referrerpolicy');
    assert.ok(policy !== null,
      `iframe ${src} has no referrerpolicy attribute — it inherits the document policy, and a same-origin one strips the referer cross-origin (YouTube Error 153)`);
    assert.ok(ALLOWED_REFERRER_POLICIES.includes(policy.toLowerCase()),
      `iframe ${src} (${origin}) has referrerpolicy '${policy}' — only ${ALLOWED_REFERRER_POLICIES.join(' or ')} may be used (weaker values leak more than the origin; no-referrer/same-origin bring back Error 153, and a padded or misspelled value is the invalid-value default, i.e. no attribute at all)`);
  }
});

test('every cross-origin iframe the page mounts is allowed by the production frame-src', () => {
  const sources = cspFrameSources();
  for (const { src, origin } of crossOriginIframes()) {
    assert.ok(allowedBy(origin, sources),
      `iframe ${src} is framed from ${origin}, which the _headers CSP frame-src does not allow [${sources.join(' ')}] — in production the frame is blocked`);
  }
});
