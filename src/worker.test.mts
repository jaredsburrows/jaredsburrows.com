// Unit tests for src/worker.mts — the content negotiation that decides whether
// `/` is HTML or Markdown. This is the half of the feature a deploy cannot tell
// you about: the wrong answer here is invisible in a browser (it looks like the
// site always worked) and wrong for every agent, or — far worse — right for
// agents and wrong for browsers, which would serve Googlebot a page with no
// HTML in it. The truth table below is the contract; `npx wrangler dev` then
// proves the same answers end to end against the real asset router.
//
// Run: node --test src/worker.test.mts
//
// The Worker is imported directly, stub `env.ASSETS` and all: nothing in it
// imports a `cloudflare:` module or touches global state at load time, so Node
// can execute the same code Cloudflare runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker, { wantsMarkdown, varyWithAccept } from './worker.mts';

// Each row is [Accept header, expected answer, why this row exists].
const TRUTH_TABLE: ReadonlyArray<readonly [string | null | undefined, boolean, string]> = [
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

  // B2: one media type, two q-values, no answer. Both orders must give the same
  // one, and the only order-independent answer that is never unsafe is HTML.
  ['text/markdown,text/markdown;q=0', false, 'named twice with disagreeing q — ambiguous, so HTML'],
  ['text/markdown;q=0,text/markdown', false, 'the same header reordered must not flip the answer'],
  ['text/markdown;q=0.9,text/markdown;q=0.1', false, 'ambiguous even when both q-values are non-zero'],
  ['text/markdown,text/html;q=0.9,text/html', false, 'the ambiguity may be on the HTML side instead'],
  ['text/markdown,*/*;q=0.8,*/*', false, 'or on the catch-all a browser sends'],
  ['text/markdown,text/markdown', true, 'a repeat that agrees states one value, not two'],
  ['text/markdown;q=0.5,text/markdown;q=0.5', true, 'the same, spelled out on both copies'],
  ['text/markdown;q=0,text/markdown;q=0.0', false, 'agreeing on a refusal is still a refusal'],
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
 * @param files Response per site-absolute path.
 */
const stubAssets = (files: Record<string, Response>): {
  // The `fetch` signature is the binding's, not the narrower one this stub
  // happens to be called with -- a stub that accepted less than the real thing
  // would typecheck the Worker against a binding that does not exist.
  ASSETS: { fetch: (input: Request | URL | string) => Promise<Response> };
  requests: Request[];
} => {
  const requests: Request[] = [];
  return {
    requests,
    ASSETS: {
      async fetch(input: Request | URL | string) {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        const response = files[new URL(request.url).pathname];
        if (!response) return new Response('not found', { status: 404 });
        // The real asset router revalidates, which is the whole point of
        // forwarding the conditional headers: a matching If-None-Match comes
        // back as a bodyless 304 carrying the validators and nothing else.
        const etag = response.headers.get('etag');
        const conditional = (request.headers.get('if-none-match') ?? '')
          .split(',').map((candidate) => candidate.trim()).filter(Boolean);
        if (etag && conditional.includes(etag)) {
          const headers = new Headers(response.headers);
          for (const name of ['content-type', 'content-length']) headers.delete(name);
          return new Response(null, { status: 304, headers });
        }
        return response.clone();
      },
    },
  };
};

// Distinct validators, because the two representations are different documents:
// an ETag handed out for one must never satisfy a conditional request for the
// other, or a cache would be told its HTML is current when it asked for markdown.
const HTML_ETAG = '"index-html"';
const MARKDOWN_ETAG = '"index-md"';

const HTML = new Response('<!DOCTYPE html>', {
  headers: {
    'content-type': 'text/html; charset=utf-8',
    etag: HTML_ETAG,
    link: '</static/css/home.css>; rel=preload; as=style',
    'cache-control': 'public, max-age=0, must-revalidate',
  },
});
// The twin carries a TTL of its own here, because in production it can: the
// markdown response is /index.md's headers republished under /, so every
// _headers rule matching /index.md lands on the negotiated URL (SECURITY.md S6).
// Nothing in _headers gives it one today; these tests are what stops it
// mattering if one is ever added.
const MARKDOWN = new Response('# Jared Burrows\n', {
  headers: {
    'content-type': 'text/markdown; charset=utf-8',
    etag: MARKDOWN_ETAG,
    'cache-control': 'public, max-age=3600',
  },
});

/** The Workers Assets default, and the only Cache-Control / may answer with. */
const UNCACHEABLE = 'public, max-age=0, must-revalidate';

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
  assert.equal(response.headers.get('cache-control'), UNCACHEABLE,
    'a TTL on /index.md must not follow the twin onto /, where two representations share one URL');
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

test('a markdown revalidation with a matching ETag is answered 304, not re-sent', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/markdown', 'if-none-match': MARKDOWN_ETAG },
  }), env);

  assert.equal(response.status, 304);
  assert.equal(response.body, null, 'a 304 carries no body — constructing one with a body throws');
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8',
    'the client is being told its markdown copy is current, so the 304 must not claim to be HTML');
  assert.equal(response.headers.get('vary'), 'Accept',
    'the twin subrequest never matches the _headers "/" rule, so this one is on the Worker');
  assert.equal(response.headers.get('cache-control'), UNCACHEABLE,
    'a 304 refreshes the stored headers, so an unpinned TTL would poison / on revalidation too');
  assert.equal(response.headers.get('etag'), MARKDOWN_ETAG);

  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ['/index.md'],
    'a 304 is not `ok`, and must still not fall through to the HTML page');
  assert.equal(env.requests[0].headers.get('if-none-match'), MARKDOWN_ETAG,
    'the conditional has to reach the asset router or the twin can never answer 304');
});

test('a markdown revalidation with a stale ETag gets the whole twin', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/markdown', 'if-none-match': '"stale"' },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('vary'), 'Accept');
  assert.equal(await response.text(), '# Jared Burrows\n');
});

test('the HTML ETag does not satisfy a conditional markdown request', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/markdown', 'if-none-match': HTML_ETAG },
  }), env);

  // The two representations share a URL but not a validator. Answering 304 here
  // would leave the client serving HTML it believes is the markdown homepage.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), MARKDOWN_ETAG);
  assert.equal(await response.text(), '# Jared Burrows\n');
});

test('If-Modified-Since rides along, and nothing else does', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: {
      accept: 'text/markdown',
      'if-modified-since': 'Wed, 17 Sep 2026 00:00:00 GMT',
      'if-none-match': MARKDOWN_ETAG,
      cookie: 'session=secret',
      range: 'bytes=0-9',
    },
  }), env);

  const [subrequest] = env.requests;
  assert.equal(subrequest.headers.get('if-modified-since'), 'Wed, 17 Sep 2026 00:00:00 GMT');
  assert.equal(subrequest.headers.get('if-none-match'), MARKDOWN_ETAG);
  assert.equal(subrequest.headers.get('accept'), '*/*',
    'the subrequest names one exact file, so it must not be negotiated again');
  assert.equal(subrequest.headers.get('cookie'), null,
    'the twin is a static file: forwarding credentials to it buys nothing');
  assert.equal(subrequest.headers.get('range'), null,
    'a byte range written against / does not describe /index.md');
  assert.equal(response.status, 304);
});

test('a conditional request from a browser still revalidates the HTML', async () => {
  const env = homepage();
  const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: browserAccept, 'if-none-match': HTML_ETAG },
  }), env);

  assert.equal(response.status, 304);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('etag'), HTML_ETAG);
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ['/'],
    'the HTML path forwards the original request, untouched, as it always did');
  assert.equal(env.requests[0].headers.get('accept'), browserAccept);
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
  const env = stubAssets({
    '/static/css/home.css': new Response('body{}', {
      headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=3600' },
    }),
  });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/static/css/home.css', {
    headers: { accept: 'text/markdown' },
  }), env);

  // In production run_worker_first: ["/"] means this request never reaches the
  // Worker at all; if it ever does, it must still be an ordinary asset serve.
  assert.equal(response.headers.get('content-type'), 'text/css');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600',
    'only / has two representations, so the uncacheable pin must not reach the TTLs _headers sets');
  assert.equal(await response.text(), 'body{}');
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ['/static/css/home.css']);
});

test('the HTML branch keeps the cache headers the asset router gave it', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/', {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  }), env);

  // Nothing is pinned here: this response is / answering as itself, so its
  // Cache-Control arrives from the asset router and _headers, and a TTL wrongly
  // added there is validate-site.js's half of the same invariant.
  assert.equal(response.headers.get('cache-control'), UNCACHEABLE);
});
test('/mcp is handed to the MCP server, not the asset router', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/mcp', {
    method: 'OPTIONS',
  }), env);
  assert.equal(response.status, 204, 'the MCP preflight, not a 404 from the assets stub');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(env.requests.length, 0, '/mcp must never reach the asset router');
});

test('/mcp/server-card is not captured by the /mcp route', async () => {
  const env = stubAssets({ '/mcp/server-card': new Response('{}', {
    headers: { 'content-type': 'application/mcp-server-card+json' },
  }) });
  const response = await worker.fetch(new Request('https://jaredsburrows.com/mcp/server-card'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/mcp-server-card+json',
    'the card is a static asset — run_worker_first is exact-match on /mcp');
});

test('/ is unaffected by the second route', async () => {
  const env = homepage();
  const response = await worker.fetch(new Request('https://jaredsburrows.com/'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});
