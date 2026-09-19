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
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

// JSON-RPC's own codes, then the two MCP codes this server can emit. The
// -32020..-32099 sub-range belongs to the specification: a code invented in it
// would collide with a future one, so only defined codes appear here.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** What every result carries, so a client can tell a final answer from a retry. */
const COMPLETE = {
  resultType: 'complete',
  _meta: { [META_SERVER_INFO]: { name: SERVER_NAME, version: SERVER_VERSION } },
};

/**
 * Decodes the `=?base64?...?=` sentinel the transport uses for header values
 * that are not plain ASCII, or returns the value unchanged when it is plain.
 *
 * An undecodable sentinel returns null rather than the raw string. The caller
 * compares this against the request body, and a value that cannot be decoded
 * must never compare equal to anything — returning the raw text would let a
 * malformed header satisfy the check it exists to enforce. An absent header is
 * null for the same reason.
 */
export function decodeHeaderValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /^=\?base64\?(.*)\?=$/s.exec(value);
  if (!match) return value;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A JSON-RPC error object, as this server emits them. */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** What dispatch answers with: exactly one of the two, never both. */
export type Dispatched =
  | { result: Record<string, unknown>; error?: undefined }
  | { error: RpcError; result?: undefined };

const errorResponse = (code: number, message: string, data?: unknown): Dispatched => ({
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/**
 * Answers one JSON-RPC message.
 *
 * Transport concerns — headers, status codes, CORS — belong to handleMcp; this
 * function sees only the body, which is what makes every rule below testable
 * without constructing an HTTP request.
 *
 * `message` is `unknown` because it is whatever JSON.parse returned: the checks
 * below are what turn it into something with a shape, and typing it as a
 * request up front would assume the very thing they verify.
 */
export async function dispatch(message: unknown, env: Env): Promise<Dispatched> {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    // Arrays land here too: this revision has no JSON-RPC batching, so a batch
    // is not a request the server can partially honour.
    return errorResponse(INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 request object.');
  }
  // Past the guard above this is an object, but every member is still whatever
  // arrived. Naming that once keeps each check below about the protocol rule it
  // enforces rather than about re-proving the value has members at all.
  const request = message as Record<string, unknown>;

  if (request.jsonrpc !== '2.0') {
    return errorResponse(INVALID_REQUEST, 'The jsonrpc field must be exactly "2.0".');
  }
  if (typeof request.method !== 'string') {
    return errorResponse(INVALID_REQUEST, 'The method field must be a string.');
  }
  // MCP tightens base JSON-RPC here: an id may be a string or a number, never
  // null. A notification has no id at all and never reaches this branch.
  if ('id' in request && request.id === null) {
    return errorResponse(INVALID_REQUEST, 'A request id must not be null.');
  }

  const params = (request.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const version = meta[META_PROTOCOL_VERSION];
  if (typeof version !== 'string') {
    return errorResponse(INVALID_PARAMS,
      `Every request must carry params._meta["${META_PROTOCOL_VERSION}"].`);
  }
  if (meta[META_CLIENT_CAPABILITIES] === undefined) {
    return errorResponse(INVALID_PARAMS,
      `Every request must carry params._meta["${META_CLIENT_CAPABILITIES}"].`);
  }
  if (version !== PROTOCOL_VERSION) {
    return errorResponse(UNSUPPORTED_PROTOCOL_VERSION,
      `This server implements MCP ${PROTOCOL_VERSION} only.`,
      { supported: [PROTOCOL_VERSION] });
  }

  switch (request.method) {
    case 'server/discover':
      return {
        result: {
          ...COMPLETE,
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions: "Read-only access to Jared Burrows' conference talks. Call list_talks for the catalogue, then get_talk with an id for one talk in full.",
        },
      };
    case 'tools/list':
      return { result: { ...COMPLETE, tools: TOOLS } };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        return errorResponse(INVALID_PARAMS, 'tools/call requires a string params.name.');
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return { result: { ...COMPLETE, ...(await callTool(name, args, env)) } };
    }
    default:
      return errorResponse(METHOD_NOT_FOUND, `This server does not implement ${request.method}.`);
  }
}
const PARSE_ERROR = -32700;

/** Bounds the work one anonymous POST can cause on a metered account. */
const MAX_BODY_BYTES = 65536;

/**
 * CORS for every response this endpoint makes.
 *
 * The transport spec makes validating `Origin` a MUST, to stop DNS rebinding
 * from reaching a local server that holds ambient authority. This server is
 * public, read-only, holds no credential and no session, and returns data
 * already served at /api/talks.json — so every origin is genuinely valid, and
 * saying so plainly is more honest than an allowlist that would protect
 * nothing. Browser-based agents are a reason this endpoint exists at all.
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
  'access-control-max-age': '86400',
};

/** A JSON-RPC id: string or number, or absent when the id could not be read. */
type RpcId = string | number | undefined;

const json = (body: object, status: number): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...CORS_HEADERS },
});

const rpcError = (
  id: RpcId,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response => json({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  error: { code, message, ...(data === undefined ? {} : { data }) },
}, status);

/**
 * The HTTP status an error code is delivered with.
 *
 * These are not decoration. A client distinguishes a modern MCP server from a
 * legacy one by the status: 404 with a JSON-RPC body means "this server speaks
 * MCP and has no such method", while a bare 404 means "no MCP endpoint here".
 * Returning 200 for an unknown method would make this server undetectable.
 */
const STATUS_FOR: Record<number, number> = {
  [METHOD_NOT_FOUND]: 404,
  [INVALID_REQUEST]: 400,
  [INVALID_PARAMS]: 400,
  [HEADER_MISMATCH]: 400,
  [UNSUPPORTED_PROTOCOL_VERSION]: 400,
  [PARSE_ERROR]: 400,
};

/** Serves `POST /mcp`. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
  }
  // GET and DELETE were the legacy standalone SSE stream and session teardown.
  // Neither exists in this revision, and 405 is what the spec says to answer an
  // older client that still tries.
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) {
    return rpcError(undefined, INVALID_REQUEST, 'The MCP endpoint accepts application/json only.', 415);
  }

  const body = await request.text();
  // Measured in bytes, not characters: a body of multi-byte characters is
  // larger than its length suggests, and the cap exists to bound bytes.
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return rpcError(undefined, INVALID_REQUEST, `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`, 413);
  }

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch (error) {
    // `catch` binds `unknown` under strict, and a thrown non-Error has no
    // .message — so the reason is read defensively rather than assumed.
    const reason = error instanceof Error ? error.message : String(error);
    return rpcError(undefined, PARSE_ERROR, `The request body is not valid JSON: ${reason}`, 400);
  }

  // The id is echoed on the error response, so it is read before the body has
  // been shown to be a valid request at all — and only when it is the type MCP
  // allows. Anything else (including null) is left off the response entirely.
  const rawId = message !== null && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>).id
    : undefined;
  const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;

  // Header/body agreement, before anything reads the body's meaning. An
  // intermediary may route on the header while this server acts on the body, so
  // the two disagreeing is a security problem rather than a cosmetic one.
  const mismatch = headerMismatch(request, message);
  if (mismatch) return rpcError(id, HEADER_MISMATCH, mismatch, 400);

  // A notification has no id and gets no response body — only an acknowledgement.
  const isNotification = message !== null && typeof message === 'object'
    && !Array.isArray(message) && !('id' in message);
  if (isNotification) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  const answer = await dispatch(message, env);
  if (answer.error) {
    return rpcError(id, answer.error.code, answer.error.message,
      STATUS_FOR[answer.error.code] ?? 400, answer.error.data);
  }
  return json({ jsonrpc: '2.0', id, result: answer.result }, 200);
}

/** The reason the mirrored headers disagree with the body, or null when they agree. */
function headerMismatch(request: Request, message: unknown): string | null {
  const body = (message !== null && typeof message === 'object' && !Array.isArray(message)
    ? message
    : {}) as Record<string, unknown>;
  const params = (body.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;

  const version = decodeHeaderValue(request.headers.get('mcp-protocol-version'));
  if (version === null) {
    return 'Every POST must carry an MCP-Protocol-Version header.';
  }
  const bodyVersion = meta[META_PROTOCOL_VERSION];
  if (typeof bodyVersion === 'string' && bodyVersion !== version) {
    return `MCP-Protocol-Version header ${JSON.stringify(version)} does not match the body's ${JSON.stringify(bodyVersion)}.`;
  }

  const method = decodeHeaderValue(request.headers.get('mcp-method'));
  if (method === null) return 'Every POST must carry an Mcp-Method header.';
  if (typeof body.method === 'string' && body.method !== method) {
    return `Mcp-Method header ${JSON.stringify(method)} does not match the body's ${JSON.stringify(body.method)}.`;
  }

  // Mcp-Name mirrors params.name, and is required for the calls that have one.
  if (body.method === 'tools/call') {
    const name = decodeHeaderValue(request.headers.get('mcp-name'));
    if (name === null) return 'tools/call must carry an Mcp-Name header.';
    if (typeof params.name === 'string' && params.name !== name) {
      return `Mcp-Name header ${JSON.stringify(name)} does not match the body's ${JSON.stringify(params.name)}.`;
    }
  }
  return null;
}
