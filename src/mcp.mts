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
/**
 * What a tool returns about a talk.
 *
 * Optional members are optional on purpose and never null: a talk with no video
 * omits `video` entirely, so a consumer tests presence rather than emptiness.
 * `link` is optional in `Talk` too, so it is optional here.
 */
export interface TalkSummary {
  id: string;
  date: string;
  title: string;
  where: string;
  location?: string;
  link?: string;
  /** Speaker Deck player URL, built from the id. */
  slides?: string;
  /** YouTube watch URL, built from the id. */
  video?: string;
}

/** A summary plus the abstract paragraphs; what `get_talk` returns. */
export interface TalkDetail extends TalkSummary {
  description: string[];
}

/**
 * The compact form of a talk: everything but the abstract.
 *
 * Links are rebuilt in the same shape static/js/home.js and index.md use, so an
 * agent and a reader following the site get the identical URL. Absent ids are
 * omitted rather than set to null — an agent should not have to distinguish
 * "no video" from "video: null".
 */
export function talkSummary(talk: Talk): TalkSummary {
  return {
    id: talkId(talk),
    date: talk.date,
    title: talk.title,
    where: talk.where,
    location: talk.location,
    ...(talk.link ? { link: talk.link } : {}),
    ...(talk.speakerdeck ? { slides: `https://speakerdeck.com/player/${talk.speakerdeck}` } : {}),
    ...(talk.youtube ? { video: `https://www.youtube.com/watch?v=${talk.youtube}` } : {}),
  };
}

/** The full form: the summary plus the abstract paragraphs. */
export function talkDetail(talk: Talk): TalkDetail {
  return { ...talkSummary(talk), description: talk.description ?? [] };
}

/**
 * The tools this server exposes, and the list the card must agree with.
 *
 * Two, not three. A `search_talks` over three records is `list_talks` plus a
 * filter the caller already has, and this site's whole agent-readiness effort
 * has treated duplication as a cost rather than a feature.
 *
 * `additionalProperties: false` on both schemas is deliberate: a typo'd
 * argument should be refused loudly, not silently ignored on a surface whose
 * only callers are machines.
 */
export const TOOLS = [
  {
    name: 'list_talks',
    description: "List Jared Burrows' conference talks, newest first. Returns each talk's id, date, title, venue, location and links; call get_talk for the abstract.",
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Only talks given in this calendar year.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_talk',
    description: 'Get one talk in full, including its abstract, by the id that list_talks returns.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A talk id, for example 2017-11-08-the-road-to-single-dex.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

/** What a tool call hands back, in the shape MCP defines for a tool result. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A tool result. `content` is what a model reads; `structuredContent` is the
 * same answer as data for a client that would rather parse than scrape.
 */
const toolResult = (structured: object): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
  // An interface has no index signature, so `TalkDetail` is not assignable to
  // `Record<string, unknown>` without this. The cast is here, once, rather than
  // at each call site — and `object` above still refuses a string or a number.
  structuredContent: structured as Record<string, unknown>,
});

/**
 * A failure of the *answer*, not of the call.
 *
 * An unknown id is not a malformed request — it is a well-formed question with
 * the answer "there is no such talk", so it comes back as a tool result with
 * `isError`, not as a JSON-RPC error. Confusing the two teaches a client to
 * retry a request that will never succeed.
 */
const toolError = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  structuredContent: { error: message },
  isError: true,
});

/**
 * Runs one tool.
 *
 * `args` is `unknown`-ish on purpose: it arrives straight off the wire, and the
 * narrowing below is the only thing standing between a hostile body and the
 * dataset. Typing it as the tool's declared schema would be a lie about what
 * was actually received.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<ToolResult> {
  const known = TOOLS.map((tool) => tool.name);
  if (!known.includes(name)) {
    return toolError(`No tool named ${JSON.stringify(name)}. This server exposes: ${known.join(', ')}.`);
  }

  const talks = await loadTalks(env);

  if (name === 'list_talks') {
    const year = args.year;
    const matching = year === undefined
      ? talks
      : talks.filter((talk) => Number(talk.date.slice(0, 4)) === Number(year));
    return toolResult({ talks: matching.map(talkSummary) });
  }

  const wanted = String(args.id ?? '');
  const talk = talks.find((candidate) => talkId(candidate) === wanted);
  if (!talk) {
    return toolError(`No talk with id ${JSON.stringify(wanted)}. Valid ids: ${talks.map(talkId).join(', ')}.`);
  }
  return toolResult(talkDetail(talk));
}
