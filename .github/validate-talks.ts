#!/usr/bin/env node
// Validates static/js/talks.js so every entry renders correctly in home.js:
// the newest-first sort compares date strings and Intl formats them, so dates
// must be real zero-padded YYYY-MM-DD; embed ids must look right; key typos
// and copy-paste leftovers are rejected. node --check only catches syntax.
// Usage: node .github/validate-talks.ts [path/to/talks.js]
'use strict';

// Node's built-ins are required, not imported: these files are CommonJS and stay
// that way (package.json pins "type": "commonjs"). The `typeof import(...)`
// annotations are types, not imports -- they erase completely, so the runtime is
// the same `require` it has always been. They are needed because TypeScript
// resolves a bare `require()` to `any` in a .ts file, where it special-cased and
// typed it in .js: without them `fs.readFileSync` returns `any` and every string
// derived from a file silently stops being checked.
const path: typeof import('path') = require('path');

const file = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'static', 'js', 'talks.js'));
const errors: string[] = [];

// talks.js is a classic browser script that assigns to `window`, so loading it
// under Node means giving it one. The cast is how you say that to the checker:
// `window` is not a Node global and is not supposed to be.
(global as any).window = {};
try {
  require(file);
} catch (error) {
  console.error(`✗ ${file} failed to load: ${(error as Error).message}`);
  process.exit(1);
}

// `any` is deliberate here and nowhere else in this file: every line below is
// checking data that has not been validated yet, so a type asserting the shape
// would assert away the very thing under test. types/talks.d.ts describes what
// a *valid* entry looks like; this is what proves one is.
const talks: any[] = (global as any).window.TALKS;
if (!Array.isArray(talks) || talks.length === 0) {
  console.error('✗ talks.js must set window.TALKS to a non-empty array');
  process.exit(1);
}

const KNOWN_KEYS = new Set(['date', 'title', 'where', 'location', 'link', 'speakerdeck', 'youtube', 'description']);
const seenEmbeds = new Map();
const isFilled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

talks.forEach((talk, index) => {
  const name = isFilled(talk.title) ? `"${talk.title}"` : `entry ${index + 1}`;
  const bad = (message: string) => errors.push(`${name}: ${message}`);

  for (const key of Object.keys(talk)) {
    if (!KNOWN_KEYS.has(key)) bad(`unknown key "${key}" (typo?)`);
  }

  if (!isFilled(talk.date) || !/^\d{4}-\d{2}-\d{2}$/.test(talk.date)) {
    bad(`date must be zero-padded YYYY-MM-DD, got ${JSON.stringify(talk.date)}`);
  } else {
    const parsed = new Date(`${talk.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== talk.date) {
      bad(`date ${JSON.stringify(talk.date)} is not a real calendar date`);
    }
  }

  if (!isFilled(talk.title)) bad('missing title');
  if (!isFilled(talk.where)) bad('missing where (venue)');
  if ('location' in talk && !isFilled(talk.location)) bad('location must be a non-empty string when present');
  if ('link' in talk && !(isFilled(talk.link) && talk.link.startsWith('https://'))) {
    bad(`link must be an https:// URL, got ${JSON.stringify(talk.link)}`);
  }

  if (!('speakerdeck' in talk) && !('youtube' in talk)) {
    bad('needs a speakerdeck and/or youtube id, otherwise expanding shows no slides or video');
  }
  if ('speakerdeck' in talk && !/^[0-9a-f]{32}$/.test(String(talk.speakerdeck))) {
    bad(`speakerdeck id must be 32 hex chars, got ${JSON.stringify(talk.speakerdeck)}`);
  }
  if ('youtube' in talk && !/^[\w-]{11}$/.test(String(talk.youtube))) {
    bad(`youtube id must be 11 chars, got ${JSON.stringify(talk.youtube)}`);
  }
  // The same talk given at several venues legitimately reuses its deck/video,
  // so a shared id is only an error when the titles differ.
  for (const key of ['speakerdeck', 'youtube']) {
    if (!(key in talk)) continue;
    const id = `${key}:${talk[key]}`;
    if (seenEmbeds.has(id) && seenEmbeds.get(id) !== name) {
      bad(`duplicate ${key} id also used by ${seenEmbeds.get(id)} (copy-paste leftover?)`);
    } else {
      seenEmbeds.set(id, name);
    }
  }

  if ('description' in talk
      && (!Array.isArray(talk.description) || talk.description.length === 0 || !talk.description.every(isFilled))) {
    bad('description must be an array of non-empty strings when present');
  }
});

if (errors.length > 0) {
  console.error(`✗ ${file}:`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`✓ ${talks.length} talks valid`);
