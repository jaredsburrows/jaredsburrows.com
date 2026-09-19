// Markdown content negotiation for the homepage, and the front door for the MCP
// server in mcp.mts — the two paths this site runs code on.
//
// `assets.run_worker_first: ["/", "/mcp"]` in wrangler.jsonc scopes it to those
// two: every other path (CSS, JS, images, /index.md itself, /api/*, the card at
// /mcp/server-card, the 404 page) is served by Cloudflare's asset router without
// ever invoking this script, which is both faster and unbilled. Both patterns
// are exact matches — "/mcp" does not capture "/mcp/server-card". On `/` the
// script asks one question — did the client name `text/markdown` in `Accept`? —
// and answers it with either the hand-written markdown twin or the ordinary HTML
// page. On `/mcp` it hands the request to mcp.mts and does nothing else.
//
// `parseAccept`, `exactQuality`, `effectiveQuality`, `wantsMarkdown` and
// `varyWithAccept` are ported from jaredsburrows/burrows.tools#279
// (`src/lib/markdown-negotiation.ts`), keeping its semantics and its reasoning
// — with one deliberate divergence: `exactQuality` refuses a media type named
// twice with disagreeing q-values instead of taking whichever came first, which
// made the answer depend on header order (BUGS.md B2). #279 still has the
// `find()` version and wants the same fix.
// This file was JSDoc-annotated JavaScript until the repo grew a package.json,
// a tsconfig.json and a lockfile (#149); it is TypeScript now that there is
// something to check it. Nothing about the build changed: tsconfig.json is
// noEmit, Wrangler bundles this with esbuild the way it bundled the .mjs, and
// Node runs the test beside it by stripping the types — no compile step, no
// emitted file, no dist directory.
//
// The extension is .mts, not .ts, for the same reason it was .mjs and not .js:
// package.json says "type": "commonjs" (it must -- the .github validators are
// CommonJS), and under that Node reads a .ts file as CommonJS, where the
// `export default` below throws on load. .mts is the ESM counterpart, and it is
// what lets src/worker.test.mts import these functions directly. Nothing here
// imports a `cloudflare:` module or touches global state at load time, so
// importing it outside workerd is safe.

// The extension is written out because `allowImportingTsExtensions` is set and
// Node opens the literal path: it does no extension rewriting, and nothing is
// emitted for it to rewrite to.
import { handleMcp } from './mcp.mts';

/** The media type an agent must name exactly to be served markdown. */
const MARKDOWN_MEDIA_TYPE = 'text/markdown';

/** The hand-written markdown twin of the homepage, served from `/` when negotiated. */
const MARKDOWN_ASSET = '/index.md';

/**
 * What `/` is allowed to say about caching, pinned on the markdown branch below.
 *
 * Two representations share one URL here, and Cloudflare's cache keys on the URL
 * and `Accept-Encoding` only — it ignores `Vary` for every other request header —
 * so a single stored copy would be handed to every client whatever its `Accept`
 * said: one agent request and the markdown homepage is what browsers and
 * Googlebot get. The only thing that keeps the two apart is that `/` is never
 * stored, which is what this value says. It is the Workers Assets default, so
 * pinning it states what already happens rather than changing it.
 *
 * It is pinned in code because the markdown branch republishes another asset's
 * headers: the response below is `/index.md`'s, returned under the URL `/`, so
 * any `_headers` rule matching `/index.md` — a TTL there looks exactly as
 * reasonable as the one on `/static/js/*` — would otherwise land its
 * `Cache-Control` on `/` (SECURITY.md S6). `validate-site.js` independently
 * refuses a TTL on `/` itself; neither control covers the other's route.
 */
const UNCACHEABLE = 'public, max-age=0, must-revalidate';

/**
 * Statuses whose responses carry no body. `new Response()` throws when given one
 * of these together with a body, so a blind re-wrap would turn a revalidation
 * into a 500, and both paths below say what they do about it: the HTML path
 * hands the asset router's response straight back (safe — `_headers` has already
 * put `Vary: Accept` on `/`), while the markdown path must re-wrap, because the
 * media type it claims is not the one the asset was served as, and so passes a
 * null body explicitly.
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Request headers forwarded onto the subrequest for the twin.
 *
 * Only the two revalidation conditionals, and only because the `ETag` the client
 * is holding came from `/index.md` in the first place: the markdown 200 below
 * passes the asset's own validators through, so the client echoes them back at a
 * URL (`/`) that would otherwise never see them. Without this the twin can never
 * answer 304 and re-sends the whole document on every poll while advertising an
 * `ETag` and `must-revalidate` that invite the revalidation. Everything else the
 * client sent is deliberately dropped: the subrequest is for a different URL and
 * a different representation, so `Accept` stays neutral (see below), and a
 * `Range` or `If-Match` written against `/` has no meaning for `/index.md`.
 */
const CONDITIONAL_HEADERS = ['if-none-match', 'if-modified-since'];

/** One entry of a parsed `Accept` header. */
interface AcceptEntry {
  /** Media type or wildcard, lower-cased. */
  type: string;
  /** Its q-value; 1 when the header does not give one. */
  quality: number;
}

/**
 * Parses `Accept` into media types with their q-values, lower-cased, ignoring
 * other parameters.
 *
 * A malformed q is treated as 1 rather than as a parse failure: RFC 9110 says a
 * recipient that cannot parse a parameter should ignore it, and refusing to
 * serve a page over a bad `;q=` would turn a cosmetic client bug into a broken
 * request.
 *
 * @param header Raw `Accept` header value.
 */
function parseAccept(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  for (const part of header.split(',')) {
    const [rawType, ...parameters] = part.split(';');
    const type = rawType.trim().toLowerCase();
    if (type === '') continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(parameter);
      if (match) {
        const parsed = Number.parseFloat(match[1]);
        quality = Number.isFinite(parsed) ? parsed : 1;
      }
    }
    entries.push({ type, quality });
  }
  return entries;
}

/**
 * The q-value the header gives `type` exactly, 0 when it never names it, or
 * `null` when it names it more than once with disagreeing q-values.
 *
 * That last case is refused rather than resolved, and the caller turns it into
 * "HTML". `text/markdown,text/markdown;q=0` and `text/markdown;q=0,text/markdown`
 * are the same two tokens in the other order, and RFC 9110 does not say which
 * one wins; the ported `find()` answered by header order, so the same header
 * flipped its meaning when reordered (BUGS.md B2). Highest-wins and last-wins
 * are both inventions, and one of them has to guess in the direction of serving
 * markdown. Refusing cannot guess wrong: the fallback is HTML, which is the
 * representation every client can read. Duplicates that agree state one value,
 * not two, so they are not ambiguous and go through normally.
 *
 */
function exactQuality(entries: readonly AcceptEntry[], type: string): number | null {
  const named = entries.filter((entry) => entry.type === type);
  if (named.length === 0) return 0;
  const [{ quality }] = named;
  return named.every((entry) => entry.quality === quality) ? quality : null;
}

/**
 * The q-value `type` gets including the `text/` and catch-all wildcards a
 * browser sends, or `null` if any of the three is ambiguous.
 *
 */
function effectiveQuality(entries: readonly AcceptEntry[], type: string): number | null {
  const group = `${type.split('/')[0]}/*`;
  const qualities = [
    exactQuality(entries, type),
    exactQuality(entries, group),
    exactQuality(entries, '*/*'),
  ];
  // Math.max would read a refusal as 0, which is the unsafe direction here: an
  // ambiguous text/html must not lower the bar markdown has to clear.
  if (qualities.includes(null)) return null;
  // `includes` is not a narrowing form, so the assertion is what carries the
  // fact the line above just established -- that no null survives here -- to
  // the type checker. It erases to nothing; `qualities` is untouched at runtime.
  return Math.max(...(qualities as number[]));
}

/**
 * Whether this request asked for markdown instead of HTML.
 *
 * The rule is deliberately narrow: `text/markdown` has to be named *exactly*,
 * with a non-zero q, and be at least as preferred as HTML. Wildcards never
 * select markdown, which is the whole safety property here — every browser on
 * earth ends its `Accept` with a catch-all at `q=0.8`, and `curl` sends nothing
 * but a catch-all, so matching one would serve markdown to ordinary visitors and
 * hand Googlebot a page with no HTML in it. HTML stays the default for
 * everything that does not ask for markdown by name — and for everything that
 * asks ambiguously (see `exactQuality`).
 *
 * @param accept Raw `Accept` header value, if any.
 */
export function wantsMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const entries = parseAccept(accept);
  const markdown = exactQuality(entries, MARKDOWN_MEDIA_TYPE);
  const html = effectiveQuality(entries, 'text/html');
  if (markdown === null || html === null) return false;
  if (markdown <= 0) return false;
  return markdown >= html;
}

/**
 * `Vary` with `Accept` added, preserving whatever was already there.
 *
 * `/` has two representations now, so a cache that was never told the request
 * headers matter is free to hand the markdown to a browser — and `Vary` on the
 * markdown response alone would not help, because the copy a cache is most
 * likely to have stored first is the HTML one. A `Vary: *` is left alone: it
 * already means "never reuse this", which is strictly stronger than anything
 * adding a field name could say.
 *
 * @param existing Current `Vary` value, if any.
 */
export function varyWithAccept(existing: string | null | undefined): string {
  if (!existing || existing.trim() === '') return 'Accept';
  const fields = existing.split(',').map((field) => field.trim());
  if (fields.some((field) => field === '*')) return existing;
  if (fields.some((field) => field.toLowerCase() === 'accept')) return existing;
  return `${existing}, Accept`;
}

/**
 * `assets.binding` from wrangler.jsonc: the static asset router, as a binding.
 *
 * Declared here rather than pulled from `@cloudflare/workers-types`, which
 * declares 206 globals and cannot share a program with `@types/node` -- and the
 * test beside this file runs under `node --test` and imports this module, so the
 * two are necessarily one program. Everything this Worker touches (`Request`,
 * `Response`, `Headers`, `URL`) is standard in both runtimes; `ASSETS` was the
 * only Workers-specific name, and this is it.
 */
interface Env {
  ASSETS: { fetch: (input: Request | URL | string) => Promise<Response> };
}

export default {
  /**
   * @param request Incoming request; only `/` reaches this handler.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The second billed route. `run_worker_first` lists "/mcp" as an exact
    // pattern, so /mcp/server-card — the card this endpoint is advertised by —
    // is still served by the asset router and stays unbilled. Verified under
    // `wrangler dev`, not assumed.
    if (url.pathname === '/mcp') return handleMcp(request, env);
    // Retrieval only: negotiating a representation is meaningless for a request
    // that is not asking for one. `/index.html` is absent on purpose — the asset
    // router redirects it to `/` (html_handling: auto-trailing-slash) before this
    // script is ever invoked, so a branch for it would be unreachable code.
    const negotiable = (request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/';

    if (negotiable && wantsMarkdown(request.headers.get('accept'))) {
      // A neutral `Accept` on the subrequest: this fetch names one exact file, so
      // nothing downstream should try to negotiate it a second time. The client's
      // revalidation conditionals ride along, which is the only way this branch
      // can answer anything but a full body.
      const subrequestHeaders = new Headers({ accept: '*/*' });
      for (const name of CONDITIONAL_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) subrequestHeaders.set(name, value);
      }
      const markdown = await env.ASSETS.fetch(new Request(new URL(MARKDOWN_ASSET, url), {
        method: request.method,
        headers: subrequestHeaders,
      }));
      // A missing or broken twin is a bug; serving no homepage at all is an
      // outage. So anything other than a healthy asset falls through to the HTML
      // below, where CI (validate-site.js) is what keeps the twin honest. A 304
      // is healthy and is NOT `ok` — `Response.ok` is 200–299 — so it is named
      // here: without it a correct revalidation would fall through and hand the
      // HTML page to a client that asked for markdown and already holds it.
      if (markdown.ok || markdown.status === 304) {
        const headers = new Headers(markdown.headers);
        // The asset is served as text/markdown already, but this response stands
        // in for `/`, so the type it claims is stated here rather than inherited.
        headers.set('content-type', `${MARKDOWN_MEDIA_TYPE}; charset=utf-8`);
        headers.set('vary', varyWithAccept(headers.get('vary')));
        headers.set('x-content-type-options', 'nosniff');
        // Stated here for the same reason as the content type: these are
        // `/index.md`'s headers being published under `/`, and `/` is the URL
        // with two representations on it. See UNCACHEABLE.
        headers.set('cache-control', UNCACHEABLE);
        return new Response(NULL_BODY_STATUSES.has(markdown.status) ? null : markdown.body, {
          status: markdown.status,
          statusText: markdown.statusText,
          headers,
        });
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (NULL_BODY_STATUSES.has(response.status)) return response;
    const headers = new Headers(response.headers);
    headers.set('vary', varyWithAccept(headers.get('vary')));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
