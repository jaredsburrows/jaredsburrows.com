// The A2A (Agent2Agent) endpoint at POST /a2a — the service URL that
// /.well-known/agent-card.json names in `supportedInterfaces`.
//
// A card is a claim about a URL. Publishing one that points at the 404 page
// would pass a scanner and fail every agent that believed it, so the card ships
// with the smallest server that makes it true: A2A 1.0 over the JSON-RPC
// binding, answering `SendMessage` with the same talks the MCP server returns.
// validate-site.ts pins the card's URL, binding, protocol version, agent
// version and skill ids to the constants below.
//
// Everything is answered in one synchronous Message. Nothing here creates a
// Task, so there is nothing to get, list, cancel, stream or push: those methods
// get the error the spec defines for them rather than METHOD_NOT_FOUND, which
// would read as "this is not an A2A server". The card says the same in
// `capabilities` (no streaming, no push notifications, no extended card).
//
// The answer is the MCP server's answer. `callTool` from mcp.mts does the work,
// so the two protocols cannot disagree about what a talk is or which ids exist.
//
// The extension is .mts for the reason worker.mts gives. Nothing here imports a
// `cloudflare:` module, so the test beside it runs this same code under Node.

import { callTool, loadTalks, talkId } from './mcp.mts';
import type { Env } from './mcp.mts';

/** The path the card's `supportedInterfaces[0].url` names. */
export const A2A_PATH = '/a2a';

/** The only A2A revision implemented, Major.Minor as the spec requires. */
export const PROTOCOL_VERSION = '1.0';

/** The card's `version`; validate-site.ts holds the two together. */
export const AGENT_VERSION = '1.0.0';

/** The card's skill ids, in the card's order. */
export const SKILL_IDS = ['list-talks', 'get-talk'] as const;

/** Media types this agent reads in a request and writes in a response. */
export const MEDIA_TYPES = ['text/plain', 'application/json'];

// JSON-RPC's own codes, then the A2A codes this server can emit (spec §5.4).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TASK_NOT_FOUND = -32001;
const PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
const UNSUPPORTED_OPERATION = -32004;
const CONTENT_TYPE_NOT_SUPPORTED = -32005;
const EXTENDED_CARD_NOT_CONFIGURED = -32007;
const VERSION_NOT_SUPPORTED = -32009;

/** The `google.rpc.ErrorInfo` reason the spec pairs with each A2A code. */
const REASON: Record<number, string> = {
  [TASK_NOT_FOUND]: 'TASK_NOT_FOUND',
  [PUSH_NOTIFICATION_NOT_SUPPORTED]: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
  [UNSUPPORTED_OPERATION]: 'UNSUPPORTED_OPERATION',
  [CONTENT_TYPE_NOT_SUPPORTED]: 'CONTENT_TYPE_NOT_SUPPORTED',
  [EXTENDED_CARD_NOT_CONFIGURED]: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
  [VERSION_NOT_SUPPORTED]: 'VERSION_NOT_SUPPORTED',
};

/** Bounds the work one anonymous POST can cause on a metered account. */
const MAX_BODY_BYTES = 65536;

/** The 4-digit year a text message may name, for list-talks. */
const YEAR = /\b(19|20)\d{2}\b/;

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

/**
 * An error, with the ErrorInfo detail the spec asks A2A errors to carry. The
 * plain JSON-RPC codes get none: they are not A2A's to describe.
 */
const rpcErrorOf = (code: number, message: string): RpcError => {
  const reason = REASON[code];
  return {
    code,
    message,
    ...(reason ? { data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }] } : {}),
  };
};

const failure = (code: number, message: string): Dispatched => ({ error: rpcErrorOf(code, message) });

/** One Part of a Message: exactly one of text, raw, url or data (spec §4.1.6). */
type Part = Record<string, unknown>;

/**
 * Which skill a message asks for, and with what argument.
 *
 * A2A routes by message, not by skill id, so the request is read the way the
 * card's examples are written. A data part may say it outright
 * (`{"id": "..."}` or `{"year": 2017}`); otherwise the text is searched for a
 * talk id, then for a year. Anything else is the whole list, which is the
 * useful answer to "what talks are there?" and to a message this agent does
 * not understand — it never guesses a single talk.
 */
export function route(parts: readonly Part[], ids: readonly string[]): { skill: typeof SKILL_IDS[number]; args: Record<string, unknown> } {
  for (const part of parts) {
    const data = part.data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const fields = data as Record<string, unknown>;
      if (typeof fields.id === 'string') return { skill: 'get-talk', args: { id: fields.id } };
      if (Number.isInteger(fields.year)) return { skill: 'list-talks', args: { year: fields.year } };
    }
  }
  const text = parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  const named = ids.find((id) => text.includes(id));
  if (named) return { skill: 'get-talk', args: { id: named } };
  const year = YEAR.exec(text);
  if (year) return { skill: 'list-talks', args: { year: Number(year[0]) } };
  return { skill: 'list-talks', args: {} };
}

/** A fresh id. `crypto.randomUUID` is global in both workerd and Node 24. */
const newId = (): string => crypto.randomUUID();

/**
 * Answers `SendMessage`.
 *
 * The reply is a Message with two parts: a sentence a model can read, and the
 * same answer as JSON for a client that would rather parse. An unknown talk id
 * is a well-formed question whose answer is "no such talk", so it is a reply,
 * not a JSON-RPC error — the same line mcp.mts draws for `isError`.
 */
async function sendMessage(params: Record<string, unknown>, env: Env): Promise<Dispatched> {
  const message = params.message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return failure(INVALID_PARAMS, 'SendMessage requires params.message, a Message object.');
  }
  const { messageId, role, parts, contextId } = message as Record<string, unknown>;
  if (typeof messageId !== 'string' || messageId === '') {
    return failure(INVALID_PARAMS, 'params.message.messageId must be a non-empty string.');
  }
  if (role !== 'ROLE_USER') {
    return failure(INVALID_PARAMS, 'params.message.role must be "ROLE_USER".');
  }
  if (!Array.isArray(parts) || parts.length === 0
    || !parts.every((part) => part !== null && typeof part === 'object' && !Array.isArray(part))) {
    return failure(INVALID_PARAMS, 'params.message.parts must be a non-empty array of Part objects.');
  }

  // A client that will accept none of what this agent writes is told so up
  // front rather than handed a reply it said it cannot read.
  const configuration = (params.configuration ?? {}) as Record<string, unknown>;
  const accepted = configuration.acceptedOutputModes;
  if (Array.isArray(accepted) && accepted.length > 0
    && !accepted.some((mode) => mode === '*/*' || MEDIA_TYPES.includes(String(mode)))) {
    return failure(CONTENT_TYPE_NOT_SUPPORTED,
      `This agent replies in ${MEDIA_TYPES.join(' and ')} only.`);
  }

  const ids = (await loadTalks(env)).map(talkId);
  const { skill, args } = route(parts as Part[], ids);
  const answer = await callTool(skill === 'get-talk' ? 'get_talk' : 'list_talks', args, env);
  const structured = answer.structuredContent;

  let summary: string;
  if (answer.isError) {
    summary = String(structured.error);
  } else if (skill === 'get-talk') {
    summary = `${String(structured.title)}, ${String(structured.where)}, ${String(structured.date)}.`;
  } else {
    const count = (structured.talks as unknown[]).length;
    const scope = args.year === undefined ? '' : ` in ${String(args.year)}`;
    summary = `${count} talk${count === 1 ? '' : 's'}${scope}, newest first.`;
  }

  return {
    result: {
      message: {
        messageId: newId(),
        // The spec's prose makes contextId mandatory on a server message and
        // says a generated one must be returned; echoing the client's keeps a
        // conversation it is tracking intact.
        contextId: typeof contextId === 'string' && contextId !== '' ? contextId : newId(),
        role: 'ROLE_AGENT',
        parts: [
          { text: summary, mediaType: 'text/plain' },
          { data: structured, mediaType: 'application/json' },
        ],
        metadata: { skill },
      },
    },
  };
}

/**
 * Answers one JSON-RPC request body. Transport concerns — headers, status,
 * CORS — belong to handleA2a; this sees only the parsed body, which is what
 * makes every rule below testable without building an HTTP request.
 */
export async function dispatch(body: unknown, env: Env): Promise<Dispatched> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return failure(INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 request object.');
  }
  const request = body as Record<string, unknown>;
  if (request.jsonrpc !== '2.0') {
    return failure(INVALID_REQUEST, 'The jsonrpc field must be exactly "2.0".');
  }
  if (typeof request.method !== 'string') {
    return failure(INVALID_REQUEST, 'The method field must be a string.');
  }
  const params = request.params ?? {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return failure(INVALID_PARAMS, 'params must be an object.');
  }

  switch (request.method) {
    case 'SendMessage':
      return sendMessage(params as Record<string, unknown>, env);
    case 'SendStreamingMessage':
    case 'SubscribeToTask':
      return failure(UNSUPPORTED_OPERATION, 'This agent does not stream; call SendMessage.');
    case 'GetTask':
    case 'CancelTask':
      return failure(TASK_NOT_FOUND, 'This agent answers every message directly and never creates a task.');
    case 'ListTasks':
      return { result: { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 } };
    case 'CreateTaskPushNotificationConfig':
    case 'GetTaskPushNotificationConfig':
    case 'ListTaskPushNotificationConfigs':
    case 'DeleteTaskPushNotificationConfig':
      return failure(PUSH_NOTIFICATION_NOT_SUPPORTED, 'This agent does not send push notifications.');
    case 'GetExtendedAgentCard':
      return failure(EXTENDED_CARD_NOT_CONFIGURED, 'There is no extended card; /.well-known/agent-card.json is the whole description.');
    default:
      return failure(METHOD_NOT_FOUND, `This agent does not implement ${request.method}.`);
  }
}

/** CORS for every response: the endpoint is public, read-only and credential-free. */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, A2A-Version, A2A-Extensions',
  'access-control-max-age': '86400',
};

type RpcId = string | number | null;

const json = (body: object, status: number): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
});

/**
 * A JSON-RPC error. Sent as HTTP 200 unless the request never became JSON-RPC
 * (wrong media type, oversized body): the A2A spec maps codes to HTTP statuses
 * only for the HTTP+JSON binding; on JSON-RPC the error object is the answer.
 */
const rpcError = (id: RpcId, error: RpcError, status = 200): Response =>
  json({ jsonrpc: '2.0', id, error }, status);

/**
 * The version a request asked for. The header wins; the spec also allows a
 * query parameter. An absent or empty value means 0.3 (spec §3.6.2), which is
 * a different wire format from 1.0 and so is refused, not assumed.
 */
export function requestedVersion(request: Request): string {
  const header = request.headers.get('a2a-version');
  const value = (header ?? new URL(request.url).searchParams.get('A2A-Version') ?? '').trim();
  return value === '' ? '0.3' : value;
}

/** Serves `POST /a2a`, or returns null for any other path. */
export async function handleA2a(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== A2A_PATH) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
  }
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    return rpcError(null, { code: INVALID_REQUEST, message: 'The A2A endpoint accepts application/json only.' }, 415);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return rpcError(null, { code: INVALID_REQUEST, message: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.` }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return rpcError(null, { code: PARSE_ERROR, message: `The request body is not valid JSON: ${reason}` });
  }

  const rawId = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).id
    : undefined;
  const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

  const version = requestedVersion(request);
  if (version !== PROTOCOL_VERSION) {
    return rpcError(id, rpcErrorOf(VERSION_NOT_SUPPORTED,
      `This agent implements A2A ${PROTOCOL_VERSION} only; send A2A-Version: ${PROTOCOL_VERSION}.`));
  }

  const answer = await dispatch(body, env);
  if (answer.error) return rpcError(id, answer.error);
  return json({ jsonrpc: '2.0', id, result: answer.result }, 200);
}
