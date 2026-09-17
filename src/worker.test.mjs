// Unit tests for src/worker.mjs — the content negotiation that decides whether
// `/` is HTML or Markdown. This is the half of the feature a deploy cannot tell
// you about: the wrong answer here is invisible in a browser (it looks like the
// site always worked) and wrong for every agent, or — far worse — right for
// agents and wrong for browsers, which would serve Googlebot a page with no
// HTML in it. The truth table below is the contract; `npx wrangler dev` then
// proves the same answers end to end against the real asset router.
//
// Run: node --test src/worker.test.mjs
//
// The Worker is imported directly, stub `env.ASSETS` and all: nothing in it
// imports a `cloudflare:` module or touches global state at load time, so Node
// can execute the same code Cloudflare runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker, { wantsMarkdown, varyWithAccept } from './worker.mjs';

// Each row is [Accept header, expected answer, why this row exists].
const TRUTH_TABLE = [
  ['text/markdown', true, 'the scanner probe, and the simplest thing an agent can send'],
  ['text/markdown, text/html', true, 'equally preferred is preferred enough — markdown wins ties'],
  ['text/markdown;q=0.9, text/html;q=0.8', true, 'markdown ranked above HTML'],
  ['application/json, text/markdown', true, 'a type we do not serve does not change the answer'],
  ['TEXT/MARKDOWN', true, 'media types are case-insensitive (RFC 9110 8.3.1)'],
  ['text/markdown; charset=utf-8', true, 'parameters other than q are ignored, not parse errors'],
  ['  text/markdown  ', true, 'optional whitespace around the media type'],
  ['text/markdown;q=bogus', true, 'a malformed q is ignored and defaults to 1, not treated as a refusal'],

  ['text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    false, 'a real browser — the row that matters most'],
  ['*/*', false, 'bare curl, and every HTTP client that states no preference'],
  ['text/*', false, 'a group wildcard is not naming markdown either'],
  ['text/markdown;q=0', false, 'q=0 means "not acceptable", the opposite of asking for it'],
  ['text/markdown;q=0.0', false, 'the same refusal spelled with a decimal'],
  ['text/markdown;q=0.5, text/html;q=0.9', false, 'named, but HTML is preferred — so HTML it is'],
  ['text/markdown;q=0.8, */*', false, 'an implicit q=1 catch-all outranks a downweighted markdown'],
  ['application/json', false, 'a type we do not serve, on its own'],
  ['', false, 'an empty header states nothing'],
  [null, false, 'no Accept header at all'],
  [undefined, false, 'the same, as the Headers API can report it'],
];

test('wantsMarkdown truth table', () => {
  for (const [accept, expected, why] of TRUTH_TABLE) {
    assert.equal(wantsMarkdown(accept), expected, `${JSON.stringify(accept)} should be ${expected}: ${why}`);
  }
});

test('varyWithAccept preserves what is already there', () => {
  assert.equal(varyWithAccept(null), 'Accept', 'no existing Vary');
  assert.equal(varyWithAccept(''), 'Accept', 'an empty Vary is no Vary');
  assert.equal(varyWithAccept('   '), 'Accept', 'whitespace is no Vary either');
  assert.equal(varyWithAccept('Accept-Encoding'), 'Accept-Encoding, Accept', 'append, never replace');
  assert.equal(varyWithAccept('Accept'), 'Accept', 'already varying on Accept');
  assert.equal(varyWithAccept('accept-encoding, accept'), 'accept-encoding, accept',
    'field names are case-insensitive, so this must not become "..., accept, Accept"');
  assert.equal(varyWithAccept('*'), '*', 'Vary: * already says "never reuse this" — do not weaken it');
});

/**
 * A stand-in for the `assets` binding.
 *
 * @param {Record<string, Response>} files Response per site-absolute path.
 * @returns {{ ASSETS: { fetch: (input: Request) => Promise<Response> }, requests: Request[] }}
 */
const stubAssets = (files) => {
  const requests = [];
  return {
    requests,
    ASSETS: {
      async fetch(input) {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        const response = files[new URL(request.url).pathname];
        return response ? response.clone() : new Response('not found', { status: 404 });
      },
    },
  };
};

const HTML = new Response('<!DOCTYPE html>', {
  headers: { 'content-type': 'text/html; charset=utf-8', link: '</static/css/home.css>; rel=preload; as=style' },
});
const MARKDOWN = new Response('# Jared Burrows\n', { headers: { 'content-type': 'text/markdown; charset=utf-8' } });

const homepage = () => stubAssets({ '/': HTML, '/index.md': MARKDOWN });

test('/ with Accept: text/markdown is answered with the twin', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/markdown' },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), '# Jared Burrows\n');

  // One subrequest, for the twin, with a neutral Accept: this fetch names an
  // exact file, so nothing downstream should negotiate it a second time.
  assert.equal(env.requests.length, 1);
  assert.equal(new URL(env.requests[0].url).pathname, '/index.md');
  assert.equal(env.requests[0].headers.get('accept'), '*/*');
});

test('/ from a browser is answered with HTML, and told to vary', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  }), env);

  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.equal(response.headers.get('link'), '</static/css/home.css>; rel=preload; as=style',
    '_headers still reaches the client through the binding');
  assert.equal(await response.text(), '<!DOCTYPE html>');
  assert.equal(new URL(env.requests[0].url).pathname, '/');
});

test('a missing twin falls through to HTML rather than failing the homepage', async () => {
  const env = stubAssets({ '/': HTML });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/markdown' },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), '<!DOCTYPE html>');
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ['/index.md', '/'],
    'the twin is tried first, and the HTML is the fallback');
});

test('a null-body status is handed back untouched instead of re-wrapped', async () => {
  const env = stubAssets({
    '/': new Response(null, { status: 304, headers: { etag: '"abc"', vary: 'Accept' } }),
  });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/'), env);

  // Re-wrapping a 304 throws, which would turn every revalidation into a 500.
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('etag'), '"abc"');
  assert.equal(response.headers.get('vary'), 'Accept', '_headers is what puts Vary on this one');
});

test('an existing Vary is appended to, not overwritten', async () => {
  const env = stubAssets({
    '/': new Response('<!DOCTYPE html>', { headers: { vary: 'Accept-Encoding' } }),
  });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/'), env);

  assert.equal(response.headers.get('vary'), 'Accept-Encoding, Accept');
});

test('only GET and HEAD negotiate', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    method: 'POST',
    headers: { accept: 'text/markdown' },
  }), env);

  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8',
    'a request that is not retrieving a representation does not negotiate one');
  assert.deepEqual(env.requests.map((request) => request.method), ['POST']);
});

test('a HEAD request negotiates and keeps its method', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    method: 'HEAD',
    headers: { accept: 'text/markdown' },
  }), env);

  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.deepEqual(env.requests.map((request) => request.method), ['HEAD'],
    'the subrequest must not turn a HEAD into a GET');
});

test('paths other than / are passed straight through', async () => {
  const env = stubAssets({ '/static/css/home.css': new Response('body{}', { headers: { 'content-type': 'text/css' } }) });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/static/css/home.css', {
    headers: { accept: 'text/markdown' },
  }), env);

  // In production run_worker_first: ["/"] means this request never reaches the
  // Worker at all; if it ever does, it must still be an ordinary asset serve.
  assert.equal(response.headers.get('content-type'), 'text/css');
  assert.equal(await response.text(), 'body{}');
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ['/static/css/home.css']);
});
