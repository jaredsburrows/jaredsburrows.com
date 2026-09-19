// Unit tests for src/mcp.mts — the MCP server at POST /mcp. A deploy cannot tell
// you any of this is right: the endpoint answers only machines, and a protocol
// mistake looks exactly like a working site. The cases below are the contract.
//
// Run: node --test src/mcp.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { talkId, loadTalks, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './mcp.mts';

/**
 * A protocol payload, as a test reads one.
 *
 * The server types these precisely — `Dispatched`, `ToolResult`, `unknown` off
 * the wire — because it must not assume what it was handed. A test is the other
 * side of that: it knows exactly which message it just sent and what should come
 * back, so every member read is deliberate. This alias holds the one `any` that
 * buys it, in one named place, rather than scattering thirty casts through the
 * assertions and burying what each one is actually checking.
 */
type Payload = Record<string, any>;

const TALKS = [
  { date: '2017-11-08', title: 'The Road to Single Dex', where: 'GDG SF Meetup',
    location: 'San Francisco, CA, USA', link: 'https://example.invalid/a',
    speakerdeck: 'f87003a516e24a9fb11fcc119e535450', description: ['One.', 'Two.'] },
  { date: '2017-11-05', title: 'Make Your Build Great Again', where: 'Droidcon',
    location: 'New York, NY, USA', link: 'https://example.invalid/b',
    speakerdeck: '4206b3835eb141ba84cb91cb95cef7f6', youtube: 'rvwAlbtbtmM',
    description: ['Three.'] },
  { date: '2017-06-22', title: 'The Road to Single Dex', where: 'Gradle Summit',
    location: 'Palo Alto, CA, USA', link: 'https://example.invalid/c',
    speakerdeck: 'f87003a516e24a9fb11fcc119e535450', youtube: 'ZmI-NZ1akow',
    description: ['Four.'] },
];

/** A stand-in for the `assets` binding, serving only /api/talks.json. */
const stubAssets = (talks = TALKS) => ({
  ASSETS: {
    async fetch() {
      return new Response(JSON.stringify({ talks }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  },
});

test('the server identity is the one the card claims', () => {
  assert.equal(PROTOCOL_VERSION, '2026-07-28');
  assert.equal(SERVER_NAME, 'jaredsburrows.com/talks');
  assert.equal(SERVER_VERSION, '1.0.0');
  assert.match(SERVER_NAME, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/,
    'the SEP-2127 schema requires reverse-DNS with exactly one slash');
});

test('talkId is unique even when two talks share a title', () => {
  const ids = TALKS.map(talkId);
  assert.deepEqual(ids, [
    '2017-11-08-the-road-to-single-dex',
    '2017-11-05-make-your-build-great-again',
    '2017-06-22-the-road-to-single-dex',
  ]);
  assert.equal(new Set(ids).size, ids.length,
    'two talks share the title "The Road to Single Dex" — the date is what separates them');
});

test('talkId slugs punctuation and case away', () => {
  assert.equal(talkId({ date: '2020-01-02', title: "Gradle: What's New?!" }),
    '2020-01-02-gradle-what-s-new');
});

test('loadTalks returns the talks array from the asset', async () => {
  const talks = await loadTalks(stubAssets());
  assert.equal(talks.length, 3);
  assert.equal(talks[0].title, 'The Road to Single Dex');
});
