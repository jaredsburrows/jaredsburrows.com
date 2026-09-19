// The Model Context Protocol server at POST /mcp — the second route this site
// runs code on, after the markdown negotiation in worker.mts.
//
// It implements protocol revision 2026-07-28 and only that revision. That is a
// deliberate narrowing, not an omission: clients speaking the handshake-based
// revisions (2025-11-25 and earlier) get a correct UnsupportedProtocolVersion
// error rather than a second code path to maintain. The card says the same
// thing in `supportedProtocolVersions`, and validate-site.js pins the two
// together so the claim cannot drift from the code.
//
// This revision is stateless by design: no `initialize` handshake, no sessions,
// no GET stream. Every request carries its own protocol version and client
// capabilities in `params._meta`, which is exactly what a Worker wants — there
// is nothing to keep between invocations.
//
// The extension is .mts, not .ts, for the same reason worker.mts gives:
// package.json says "type": "commonjs" (it must — the .github validators are
// CommonJS), and under that Node reads a .ts file as CommonJS, where the
// exports below would not load as ESM. Nothing is compiled: tsconfig.json is
// noEmit, Wrangler bundles this with esbuild, and Node runs the test beside it
// by stripping the types. Nothing here imports a `cloudflare:` module or
// touches global state at load time, so running it outside workerd is safe.

/** The only protocol revision this server implements. */
export const PROTOCOL_VERSION = '2026-07-28';

/** Reverse-DNS server name, one slash, as the SEP-2127 card schema requires. */
export const SERVER_NAME = 'jaredsburrows.com/talks';

/** Card and server report the same version; validate-site.js checks that. */
export const SERVER_VERSION = '1.0.0';

/** The dataset, read through the asset binding so there is only ever one copy. */
const TALKS_ASSET = '/api/talks.json';

/** What identifying a talk needs: `Talk` satisfies it, and so does a test fixture. */
type Identifiable = Pick<Talk, 'date' | 'title'>;

/**
 * A talk's stable identifier: its date, then a slug of its title.
 *
 * The date is not decoration. Two of the three talks are both called "The Road
 * to Single Dex" — the same talk given at two events — so a title-keyed id
 * would collide and `get_talk` would be unable to return the second one at all.
 */
export function talkId(talk: Identifiable): string {
  const slug = talk.title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${talk.date}-${slug}`;
}

/**
 * The asset binding, in the shape worker.mts already declares it.
 *
 * Declared here rather than imported so this module stays independent of the
 * negotiation code next door: the two share an environment, not a dependency.
 */
export interface Env {
  ASSETS: { fetch: (input: Request | URL | string) => Promise<Response> };
}

/**
 * The talks, read from the asset router rather than duplicated here.
 *
 * api/talks.json is already the copy the REST API serves and is already pinned
 * to static/js/talks.js by validate-site.js. Reading it means the MCP server
 * cannot disagree with the homepage about what talks exist.
 */
export async function loadTalks(env: Env): Promise<Talk[]> {
  const response = await env.ASSETS.fetch(new URL(TALKS_ASSET, 'https://jaredsburrows.com'));
  if (!response.ok) throw new Error(`${TALKS_ASSET} is unavailable (${response.status})`);
  // `json()` is typed `Promise<unknown>`, so the shape is asserted once, here,
  // rather than re-asserted at every use. validate-talks.js is what actually
  // holds api/talks.json to this shape at CI time.
  const data = (await response.json()) as { talks?: Talk[] };
  return Array.isArray(data.talks) ? data.talks : [];
}
