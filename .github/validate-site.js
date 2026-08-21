#!/usr/bin/env node
// Validates cross-file invariants that node --check and vnu cannot see.
// Every check below is a regression that actually shipped or nearly did:
// - the _headers CSP and its index.html meta mirror drifting apart
// - the CSP missing a host the page really loads from (talk embeds were
//   blocked in production for a month this way)
// - home.js targeting an id index.html no longer has (emptied the live
//   Presentations section in July 2026)
// - a page or _headers preload referencing a local file that doesn't exist
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
console.log('✓ site invariants hold (CSP parity + coverage, id contract, file references, _headers overlap, _redirects stubs)');
