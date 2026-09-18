# MCP Server and Server Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a real Model Context Protocol server at `POST /mcp` over the three conference talks, and publish a truthful server card that advertises it.

**Architecture:** A new `src/mcp.mts` holds the whole protocol, exporting pure helpers plus one `handleMcp(request, env)` entry point; `src/worker.mts` routes `/mcp` to it and is otherwise untouched. The card is three byte-identical static files — no Worker involvement — discovered through the ARD/AI-Catalog manifest the site already publishes. Six CI invariants in `.github/validate-site.js` pin the card to the server so neither can drift.

**Tech Stack:** TypeScript ES modules (`.mts`, type-checked by `tsc --noEmit` under `strict`; Node strips types in place and Wrangler bundles with esbuild — there is still no build step and nothing is emitted), Cloudflare Workers Assets, `node:test` for unit tests, Wrangler 4.x.

**Spec:** `docs/superpowers/specs/2026-09-17-mcp-agent-discovery-design.md`

**Verified:** the TypeScript in Tasks 1–4 was extracted from this document verbatim, assembled into `src/mcp.mts` and `src/mcp.test.mts`, and run before this plan was committed: `tsc -p tsconfig.json --noEmit` is clean under `strict`, and `node --test` reports **42 passing, 0 failing**. The probe files were then deleted, so the tasks below still build them the TDD way — but the code in them is known to compile and pass, not merely believed to. If a step fails as written, suspect the surrounding repo changed rather than the snippet.

## Global Constraints

- **Protocol revision: `2026-07-28` only.** It is the only value the card claims and the only one the server accepts.
- **Endpoint:** `https://jaredsburrows.com/mcp`. Canonical card: `https://jaredsburrows.com/mcp/server-card`.
- **Server identity:** name `jaredsburrows.com/talks`, version `1.0.0`. The name must match `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`.
- **Card `$schema`** must be exactly `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`.
- **Card media type:** `application/mcp-server-card+json`.
- **MCP error codes:** `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, `-32020` HeaderMismatch, `-32022` UnsupportedProtocolVersion. Never emit an undefined code in `-32020`..`-32099`.
- **Every result MUST carry `resultType: "complete"`** and SHOULD carry `_meta["io.modelcontextprotocol/serverInfo"]`.
- **Every client request MUST carry** `_meta["io.modelcontextprotocol/protocolVersion"]` *and* `_meta["io.modelcontextprotocol/clientCapabilities"]`. Either missing is `-32602` with HTTP `400`.
- **Style:** match the existing repo voice — comments that explain *why* a rule exists and what breaks without it, not what the line does. Error strings name the consequence. Types carry the shapes; a doc comment says the reasoning, not the signature.
- **TypeScript, `strict`, `noEmit`.** `tsconfig.json` includes `src/**/*` *and* `.github/**/*.js` with `checkJs`, so the validator code added in Task 8 must type-check too, not merely run. `npm run typecheck` is a CI gate.
- **Extensions are `.mts`, not `.ts`.** `package.json` declares `"type": "commonjs"` (it must — the `.github` validators use `require()`), and under that Node reads a `.ts` file as CommonJS, where `export default` throws on load. Imports name the real filename (`./mcp.mts`) because `allowImportingTsExtensions` is set and Node opens the literal path.
- **A global `Talk` interface already exists** in `types/talks.d.ts` — use it rather than declaring a second shape for the same data.
- **Commits:** no "Generated with Claude Code" trailer, no Claude co-author. Signing stays on; never pass `-c commit.gpgsign=false`.
- **Link formats** (must match `static/js/home.js` and `index.md` exactly): slides `https://speakerdeck.com/player/{id}`, video `https://www.youtube.com/watch?v={id}`.

---

### Task 1: Talk identity and dataset loading

Two talks share the title "The Road to Single Dex", so `title` cannot key a lookup. Every talk gets `{date}-{slug(title)}`.

**Files:**
- Create: `src/mcp.mts`
- Create: `src/mcp.test.mts`

**Interfaces:**
- Consumes: nothing.
- Produces: `talkId(talk) -> string`, `loadTalks(env) -> Promise<object[]>`, constants `PROTOCOL_VERSION`, `SERVER_NAME`, `SERVER_VERSION`.

- [ ] **Step 1: Write the failing test**

Create `src/mcp.test.mts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/mcp.test.mts`
Expected: FAIL — `Cannot find module './mcp.mts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp.mts`:

```ts
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
```

`Talk` is a global from `types/talks.d.ts`, already in the `tsconfig.json` `include` — no import needed, and no second declaration of the same shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/mcp.test.mts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.mts src/mcp.test.mts
git commit -m "feat(mcp): stable talk ids and dataset loading"
```

---

### Task 2: Tool definitions and execution

**Files:**
- Modify: `src/mcp.mts`
- Modify: `src/mcp.test.mts`

**Interfaces:**
- Consumes: `talkId`, `loadTalks` from Task 1.
- Produces: `TOOLS` (array of `{name, description, inputSchema}`), `talkSummary(talk)`, `talkDetail(talk)`, `callTool(name, args, env) -> Promise<{content, structuredContent, isError?}>`.

- [ ] **Step 1: Write the failing test**

Append to `src/mcp.test.mts`, adding `TOOLS`, `callTool`, `talkSummary` to the existing value import from `./mcp.mts` and a type import beside it:

```ts
import type { ToolResult, TalkSummary, TalkDetail } from './mcp.mts';
```

```ts
// `structuredContent` is typed Record<string, unknown> — the honest type for a
// payload whose shape depends on which tool ran — so reading a member off it is
// a type error until something narrows it. These two say which tool's answer a
// given assertion expects, and a wrong guess fails the type check rather than
// the assertion, which is the earlier and clearer failure.
// `as unknown as` is required for the second: TypeScript refuses a direct cast
// from Record<string, unknown> to an interface it shares no members with.
const listed = (result: ToolResult) => result.structuredContent as { talks: TalkSummary[] };
const detailed = (result: ToolResult) => result.structuredContent as unknown as TalkDetail;

test('exactly two tools are exposed, and both are well-formed', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['list_talks', 'get_talk']);
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false,
      `${tool.name} must reject unknown arguments rather than ignore them`);
  }
  assert.deepEqual(TOOLS[1].inputSchema.required, ['id']);
});

test('talkSummary carries the links in the same shape the site uses', () => {
  const summary = talkSummary(TALKS[1]);
  assert.equal(summary.id, '2017-11-05-make-your-build-great-again');
  assert.equal(summary.slides, 'https://speakerdeck.com/player/4206b3835eb141ba84cb91cb95cef7f6');
  assert.equal(summary.video, 'https://www.youtube.com/watch?v=rvwAlbtbtmM');
  assert.equal('description' in summary, false, 'the summary is the compact form');
});

test('talkSummary omits links a talk does not have', () => {
  const summary = talkSummary(TALKS[0]);
  assert.equal('video' in summary, false, 'the GDG talk has no youtube id — omit, never null');
});

test('list_talks returns every talk, newest first', async () => {
  const result = await callTool('list_talks', {}, stubAssets());
  assert.equal(result.isError, undefined);
  assert.equal(listed(result).talks.length, 3);
  assert.equal(listed(result).talks[0].date, '2017-11-08');
});

test('list_talks filters by year', async () => {
  const result = await callTool('list_talks', { year: 2016 }, stubAssets());
  assert.deepEqual(listed(result).talks, []);
  const all = await callTool('list_talks', { year: 2017 }, stubAssets());
  assert.equal(listed(all).talks.length, 3);
});

test('get_talk returns the full record including the abstract', async () => {
  const result = await callTool('get_talk',
    { id: '2017-06-22-the-road-to-single-dex' }, stubAssets());
  assert.equal(result.isError, undefined);
  assert.equal(detailed(result).where, 'Gradle Summit');
  assert.deepEqual(detailed(result).description, ['Four.']);
});

test('get_talk distinguishes the two talks that share a title', async () => {
  const sf = await callTool('get_talk', { id: '2017-11-08-the-road-to-single-dex' }, stubAssets());
  const summit = await callTool('get_talk', { id: '2017-06-22-the-road-to-single-dex' }, stubAssets());
  assert.equal(detailed(sf).where, 'GDG SF Meetup');
  assert.equal(detailed(summit).where, 'Gradle Summit');
});

test('get_talk with an unknown id is a tool error, not a protocol error', async () => {
  const result = await callTool('get_talk', { id: 'nope' }, stubAssets());
  assert.equal(result.isError, true, 'the call was well-formed; the answer is "no such talk"');
  assert.match(result.content[0].text, /2017-11-08-the-road-to-single-dex/,
    'an unknown id should list the valid ones rather than just refusing');
});

test('an unknown tool name is a tool error naming the real tools', async () => {
  const result = await callTool('search_talks', {}, stubAssets());
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /list_talks/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/mcp.test.mts`
Expected: FAIL — `TOOLS` / `callTool` / `talkSummary` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/mcp.mts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/mcp.test.mts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.mts src/mcp.test.mts
git commit -m "feat(mcp): list_talks and get_talk over the talks dataset"
```

---

### Task 3: Protocol layer — header validation, version, dispatch

**Files:**
- Modify: `src/mcp.mts`
- Modify: `src/mcp.test.mts`

**Interfaces:**
- Consumes: `TOOLS`, `callTool` from Task 2.
- Produces: `decodeHeaderValue(value) -> string | null`, `dispatch(message, env) -> Promise<{result} | {error}>`.

- [ ] **Step 1: Write the failing test**

Append to `src/mcp.test.mts`, adding `decodeHeaderValue` and `dispatch` to the value import and widening the type import — `Env` came from Task 1, `RpcError` is new in this task:

```ts
import type { ToolResult, TalkSummary, TalkDetail, Env, RpcError } from './mcp.mts';
```

```ts
test('decodeHeaderValue passes plain ASCII through untouched', () => {
  assert.equal(decodeHeaderValue('get_talk'), 'get_talk');
  assert.equal(decodeHeaderValue('tools/call'), 'tools/call');
});

test('decodeHeaderValue decodes the base64 sentinel', () => {
  assert.equal(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?='), 'Hello, 世界');
});

test('decodeHeaderValue refuses undecodable sentinel values', () => {
  assert.equal(decodeHeaderValue('=?base64?not valid base64!?='), null,
    'returning the raw string would let a broken header match the body by accident');
});

/**
 * `dispatch` returns one arm of a union, so `const { result } = ...` is
 * `Record<string, unknown> | undefined` and every read off it is an error.
 * These assert which arm came back — and a wrong arm fails with the *other*
 * arm's contents in the message, which is the thing you want to see when a test
 * that expected a result got an error instead.
 */
const resultOf = async (message: unknown, env: Env): Promise<Payload> => {
  const answer = await dispatch(message, env);
  assert.ok(answer.result, `expected a result, got error ${JSON.stringify(answer.error)}`);
  return answer.result;
};

const errorOf = async (message: unknown, env: Env): Promise<RpcError> => {
  const answer = await dispatch(message, env);
  assert.ok(answer.error, `expected an error, got result ${JSON.stringify(answer.result)}`);
  return answer.error;
};

/** A well-formed request body for the modern revision. */
const rpc = (method: string, params: Payload = {}): Payload => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
});

test('server/discover reports the version, capabilities and identity', async () => {
  const result = await resultOf(rpc('server/discover'), stubAssets());
  assert.equal(result.resultType, 'complete', 'every result must carry a resultType');
  assert.deepEqual(result.supportedVersions, [PROTOCOL_VERSION]);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.deepEqual(result._meta['io.modelcontextprotocol/serverInfo'],
    { name: SERVER_NAME, version: SERVER_VERSION });
  assert.ok(result.instructions.length > 0);
});

test('tools/list returns exactly the two tools', async () => {
  const result = await resultOf(rpc('tools/list'), stubAssets());
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.tools.map((tool: Payload) => tool.name), ['list_talks', 'get_talk']);
});

test('tools/call runs the tool', async () => {
  const result = await resultOf(
    rpc('tools/call', { name: 'list_talks', arguments: {} }), stubAssets());
  assert.equal(result.resultType, 'complete');
  // The tool result is spread into the RPC result, so structuredContent is here.
  assert.equal(result.structuredContent.talks.length, 3);
});

test('a missing protocolVersion in _meta is invalid params', async () => {
  const error = await errorOf({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
  }, stubAssets());
  assert.equal(error.code, -32602);
});

test('a missing clientCapabilities in _meta is invalid params', async () => {
  const error = await errorOf({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION } },
  }, stubAssets());
  assert.equal(error.code, -32602,
    'clientCapabilities is required on every request in this revision, not optional');
});

test('an unsupported protocol version lists what is supported', async () => {
  const message = rpc('tools/list');
  message.params._meta['io.modelcontextprotocol/protocolVersion'] = '2025-06-18';
  const error = await errorOf(message, stubAssets());
  assert.equal(error.code, -32022);
  assert.deepEqual((error.data as Payload).supported, [PROTOCOL_VERSION]);
});

test('an unknown method is method not found', async () => {
  const error = await errorOf(rpc('prompts/list'), stubAssets());
  assert.equal(error.code, -32601);
});

test('a legacy initialize is rejected as an unknown method, not honoured', async () => {
  const error = await errorOf(rpc('initialize'), stubAssets());
  assert.equal(error.code, -32601,
    'this server implements 2026-07-28 only — there is no handshake to answer');
});

test('a non-2.0 jsonrpc field is an invalid request', async () => {
  const message = rpc('tools/list');
  message.jsonrpc = '1.0';
  const error = await errorOf(message, stubAssets());
  assert.equal(error.code, -32600);
});

test('a null id is an invalid request', async () => {
  const message = rpc('tools/list');
  message.id = null;
  const error = await errorOf(message, stubAssets());
  assert.equal(error.code, -32600, 'MCP forbids a null id, unlike base JSON-RPC');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/mcp.test.mts`
Expected: FAIL — `decodeHeaderValue` / `dispatch` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/mcp.mts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/mcp.test.mts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.mts src/mcp.test.mts
git commit -m "feat(mcp): JSON-RPC dispatch, version negotiation and discovery"
```

---

### Task 4: HTTP handler — guards, header validation, CORS, status codes

The status codes are the part a client depends on most: `404` for an unknown method is how it tells a modern server from a legacy one.

**Files:**
- Modify: `src/mcp.mts`
- Modify: `src/mcp.test.mts`

**Interfaces:**
- Consumes: `dispatch`, `decodeHeaderValue` from Task 3.
- Produces: `handleMcp(request, env) -> Promise<Response>`.

- [ ] **Step 1: Write the failing test**

Append to `src/mcp.test.mts` (add `handleMcp` to the import):

```ts
/** Overrides a case needs: extra or replacement headers, or a raw unparsed body. */
interface PostOptions {
  headers?: Record<string, string>;
  /** Sent verbatim instead of JSON.stringify(body) — for malformed-body cases. */
  raw?: string;
}

/** POSTs a body with the headers this revision requires. */
const post = (body: Payload | null, { headers = {}, raw }: PostOptions = {}): Request =>
  new Request('https://jaredsburrows.com/mcp', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': body?.method ?? 'tools/list',
    ...(body?.method === 'tools/call' ? { 'mcp-name': body.params.name } : {}),
    ...headers,
  },
  body: raw ?? JSON.stringify(body),
});

test('a well-formed tools/list is 200 application/json', async () => {
  const response = await handleMcp(post(rpc('tools/list')), stubAssets());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = (await response.json()) as Payload;
  assert.equal(body.id, 1);
  assert.equal(body.result.tools.length, 2);
});

test('an unknown method is 404, which is how a client spots a modern server', async () => {
  const response = await handleMcp(post(rpc('prompts/list')), stubAssets());
  assert.equal(response.status, 404);
  assert.equal(((await response.json()) as Payload).error.code, -32601);
});

test('an unsupported version is 400 and lists what is supported', async () => {
  const message = rpc('tools/list');
  message.params._meta['io.modelcontextprotocol/protocolVersion'] = '2025-06-18';
  const response = await handleMcp(
    post(message, { headers: { 'mcp-protocol-version': '2025-06-18' } }), stubAssets());
  assert.equal(response.status, 400);
  const body = (await response.json()) as Payload;
  assert.equal(body.error.code, -32022);
  assert.deepEqual(body.error.data.supported, [PROTOCOL_VERSION]);
});

test('a MCP-Protocol-Version header that disagrees with the body is a header mismatch', async () => {
  const response = await handleMcp(
    post(rpc('tools/list'), { headers: { 'mcp-protocol-version': '2025-11-25' } }), stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32020);
});

test('a missing MCP-Protocol-Version header is a header mismatch', async () => {
  const request = post(rpc('tools/list'));
  request.headers.delete('mcp-protocol-version');
  const response = await handleMcp(request, stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32020);
});

test('an Mcp-Method header that disagrees with the body is a header mismatch', async () => {
  const response = await handleMcp(
    post(rpc('tools/list'), { headers: { 'mcp-method': 'tools/call' } }), stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32020);
});

test('tools/call requires an Mcp-Name header matching params.name', async () => {
  const body = rpc('tools/call', { name: 'list_talks', arguments: {} });
  const response = await handleMcp(
    post(body, { headers: { 'mcp-name': 'get_talk' } }), stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32020);
});

test('a base64-encoded Mcp-Name is decoded before it is compared', async () => {
  const body = rpc('tools/call', { name: 'list_talks', arguments: {} });
  const encoded = `=?base64?${Buffer.from('list_talks', 'utf8').toString('base64')}?=`;
  const response = await handleMcp(post(body, { headers: { 'mcp-name': encoded } }), stubAssets());
  assert.equal(response.status, 200, 'the sentinel form is legal and must not be compared raw');
});

test('a notification is 202 with no body', async () => {
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const response = await handleMcp(
    post(notification, { headers: { 'mcp-method': 'notifications/progress' } }), stubAssets());
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
});

test('GET and DELETE are 405 — this revision has no GET stream and no sessions', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await handleMcp(
      new Request('https://jaredsburrows.com/mcp', { method }), stubAssets());
    assert.equal(response.status, 405, `${method} should not be allowed`);
    assert.match(response.headers.get('allow') ?? '', /POST/);
  }
});

test('OPTIONS is a CORS preflight a browser agent can use', async () => {
  const response = await handleMcp(
    new Request('https://jaredsburrows.com/mcp', { method: 'OPTIONS' }), stubAssets());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /mcp-protocol-version/i);
});

test('Mcp-Session-Id and Last-Event-ID are ignored, and no session is minted', async () => {
  const response = await handleMcp(post(rpc('tools/list'), {
    headers: { 'mcp-session-id': 'abc', 'last-event-id': '7' },
  }), stubAssets());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null,
    'echoing a session id would tell a legacy client this server keeps state');
});

test('a non-JSON content type is refused before the body is parsed', async () => {
  const response = await handleMcp(
    post(rpc('tools/list'), { headers: { 'content-type': 'text/plain' } }), stubAssets());
  assert.equal(response.status, 415);
});

test('an oversized body is refused before it is parsed', async () => {
  const response = await handleMcp(post(null, {
    raw: JSON.stringify({ padding: 'x'.repeat(70000) }),
    headers: { 'mcp-method': 'tools/list' },
  }), stubAssets());
  assert.equal(response.status, 413);
});

test('a malformed body is a parse error', async () => {
  const response = await handleMcp(
    post(null, { raw: '{not json', headers: { 'mcp-method': 'tools/list' } }), stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32700);
});

test('a JSON-RPC batch is refused — this revision has no batching', async () => {
  const response = await handleMcp(
    post(null, { raw: JSON.stringify([rpc('tools/list')]), headers: { 'mcp-method': 'tools/list' } }),
    stubAssets());
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as Payload).error.code, -32600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/mcp.test.mts`
Expected: FAIL — `handleMcp` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/mcp.mts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/mcp.test.mts`
Expected: PASS, 42 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.mts src/mcp.test.mts
git commit -m "feat(mcp): streamable HTTP handler with header validation and CORS"
```

---

### Task 5: Route `/mcp` in the Worker

Routing was measured under `wrangler dev` before this plan was written (see the spec's "Routing, measured"): `run_worker_first` is exact-match, and a `mcp/` directory causes no trailing-slash redirect.

**Files:**
- Modify: `src/worker.mts` (the `fetch` handler, and the header comment)
- Modify: `wrangler.jsonc:22`
- Modify: `.github/workflows/build.yml:67-68`
- Modify: `src/worker.test.mts`

**Interfaces:**
- Consumes: `handleMcp` from Task 4.
- Produces: `/mcp` routed to the MCP handler; `/` unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/worker.test.mts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/worker.test.mts`
Expected: FAIL — `/mcp` falls through to the asset stub and returns 404.

- [ ] **Step 3: Write minimal implementation**

In `src/worker.mts`, add the import at the top of the imports (the file currently has none, so place it directly after the header comment block):

```ts
import { handleMcp } from './mcp.mts';
```

The extension is written out because `allowImportingTsExtensions` is set and Node opens the literal path — it does no extension rewriting, and nothing is emitted for it to rewrite to.

`worker.mts` declares its own `interface Env` and `mcp.mts` exports one. Leave both: they are structurally identical, so TypeScript accepts the value across the call, and neither file has to import the other's environment type to describe its own. If they ever diverge, the call site is where it will surface.

Then, inside `fetch`, immediately after `const url = new URL(request.url);`:

```ts
    // The second billed route. `run_worker_first` lists "/mcp" as an exact
    // pattern, so /mcp/server-card — the card this endpoint is advertised by —
    // is still served by the asset router and stays unbilled. Verified under
    // `wrangler dev`, not assumed.
    if (url.pathname === '/mcp') return handleMcp(request, env);
```

Update the file's opening comment. It currently opens:

```ts
// Markdown content negotiation for the homepage — the only code this site runs.
//
// `assets.run_worker_first: ["/"]` in wrangler.jsonc scopes it to `/`: every
// other path (CSS, JS, images, /index.md itself, /api/*, the 404 page) is
// served by Cloudflare's asset router without ever invoking this script, which
// is both faster and unbilled. On `/` the script asks one question — did the
// client name `text/markdown` in `Accept`? — and answers it with either the
// hand-written markdown twin or the ordinary HTML page.
```

Both statements are now false — this is no longer the only code, and `/` is no longer the only route. Replace those two paragraphs with:

```ts
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
```

In `wrangler.jsonc`, change line 22 and the comment above it:

```jsonc
    // Exactly two route-first patterns, both exact matches. Broadening either
    // (or setting this to true) would put every request for every asset through
    // a billed invocation. "/mcp" does not capture "/mcp/server-card": the card
    // is a static asset, checked under `wrangler dev`.
    "run_worker_first": ["/", "/mcp"]
```

In `.github/workflows/build.yml`, change the Worker test step so new suites are picked up automatically:

```yaml
      - name: Test the Worker
        run: node --test src/*.test.mts
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/*.test.mts`
Expected: PASS — both suites green.

Run: `npx --yes wrangler deploy --dry-run`
Expected: succeeds, and reports the bundled Worker including `src/mcp.mts`.

- [ ] **Step 5: Commit**

```bash
git add src/worker.mts src/worker.test.mts wrangler.jsonc .github/workflows/build.yml
git commit -m "feat(mcp): route /mcp to the MCP server"
```

---

### Task 6: The three card documents and their headers

**Files:**
- Create: `mcp/server-card`
- Create: `.well-known/mcp/server-card.json`
- Create: `.well-known/mcp.json`
- Modify: `_headers`

**Interfaces:**
- Consumes: `SERVER_NAME`, `SERVER_VERSION`, `PROTOCOL_VERSION`, tool names from Tasks 1–3.
- Produces: three byte-identical card documents at the paths above.

- [ ] **Step 1: Write the canonical card**

Create `mcp/server-card` with exactly this content (it is copied verbatim to the other two paths in Step 2, so the bytes must match):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "jaredsburrows.com/talks",
  "title": "Jared Burrows — Talks",
  "version": "1.0.0",
  "description": "Read-only MCP server over Jared Burrows' conference talks. Lists the talks and returns any one of them in full, including its abstract, slides and video.",
  "websiteUrl": "https://jaredsburrows.com",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://jaredsburrows.com/mcp",
      "supportedProtocolVersions": ["2026-07-28"]
    }
  ],
  "serverInfo": {
    "name": "jaredsburrows.com/talks",
    "version": "1.0.0"
  },
  "endpoint": "https://jaredsburrows.com/mcp",
  "capabilities": {
    "tools": ["list_talks", "get_talk"]
  }
}
```

The `serverInfo`, `endpoint` and `capabilities` members are the superseded SEP-1649 shape, kept because that is what today's scanners read. The SEP-2127 schema leaves `additionalProperties` unset, so they are legal, and each one restates something the `remotes` block above already says truthfully.

- [ ] **Step 2: Copy it to both compatibility paths**

```bash
mkdir -p .well-known/mcp
cp mcp/server-card .well-known/mcp/server-card.json
cp mcp/server-card .well-known/mcp.json
```

- [ ] **Step 3: Verify the three are byte-identical**

```bash
cmp mcp/server-card .well-known/mcp/server-card.json
cmp mcp/server-card .well-known/mcp.json
```

Expected: no output from either (identical). Task 8 turns this into a CI invariant.

- [ ] **Step 4: Add the header rules**

Append to `_headers`, after the existing `.well-known/ard.json` rule:

```
# MCP server card, published at three paths. /mcp/server-card is the location
# SEP-2127 reserves (<streamable-http-url>/server-card); the two .well-known
# copies are what today's scanners probe, and SEP-2127 explicitly declined to
# put the card there. Byte-identical, with validate-site.js keeping them so.
#
# The canonical path has no extension, so Cloudflare infers no type at all —
# measured under `wrangler dev`, the response arrives with no Content-Type
# whatsoever. That makes this rule load-bearing rather than cosmetic, and it
# fails open (no type) rather than closed. Access-Control-Allow-Origin is a
# MUST for hosted card endpoints, so browser agents can read them cross-origin.
# Exact paths, no globs: /* also matches these, so these rules may only add
# headers /* does not already set, or the two values would comma-join.
/mcp/server-card
  Content-Type: application/mcp-server-card+json
  Access-Control-Allow-Origin: *

/.well-known/mcp/server-card.json
  Content-Type: application/mcp-server-card+json
  Access-Control-Allow-Origin: *

/.well-known/mcp.json
  Content-Type: application/mcp-server-card+json
  Access-Control-Allow-Origin: *
```

- [ ] **Step 5: Verify end to end**

```bash
npx wrangler dev --port 8788 --local
```

In another shell:

```bash
curl -s -i http://127.0.0.1:8788/mcp/server-card | grep -i '^content-type\|^access-control'
curl -s -i http://127.0.0.1:8788/.well-known/mcp.json | grep -i '^content-type'
curl -s -X POST http://127.0.0.1:8788/mcp \
  -H 'content-type: application/json' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: server/discover' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Expected: `application/mcp-server-card+json` and `access-control-allow-origin: *` on the card paths, and a `server/discover` result naming `2026-07-28` and both tools. Stop `wrangler dev` afterwards.

- [ ] **Step 6: Commit**

```bash
git add mcp/server-card .well-known/mcp .well-known/mcp.json _headers
git commit -m "feat(mcp): publish the server card at the canonical and probed paths"
```

---

### Task 7: Advertise the card in the capability manifest

SEP-2127's specified domain-level discovery is the AI Catalog at `/.well-known/ai-catalog.json` — the file this site already publishes. Both copies must stay byte-identical.

**Files:**
- Modify: `.well-known/ai-catalog.json`
- Modify: `.well-known/ard.json`

**Interfaces:**
- Consumes: the card URL from Task 6.
- Produces: a fourth manifest entry, `urn:air:jaredsburrows.com:mcp:talks`.

- [ ] **Step 1: Add the entry to `.well-known/ai-catalog.json`**

Append this object to the `entries` array, after the existing `urn:air:jaredsburrows.com:content:homepage` entry:

```json
    {
      "identifier": "urn:air:jaredsburrows.com:mcp:talks",
      "type": "application/mcp-server-card+json",
      "url": "https://jaredsburrows.com/mcp/server-card"
    }
```

It carries no `displayName`, `description` or `representativeQueries`, unlike its three neighbours. That is deliberate and specified: SEP-2127 says an entry "does not need to repeat the Server Card's human-readable fields… avoiding duplicated values that could drift out of sync", and a transport is not a document a representative query would retrieve.

- [ ] **Step 2: Copy to the twin path**

```bash
cp .well-known/ai-catalog.json .well-known/ard.json
```

- [ ] **Step 3: Verify both parse and are identical**

```bash
cmp .well-known/ai-catalog.json .well-known/ard.json
node -e "const m=require('./.well-known/ard.json');console.log(m.entries.length, m.entries.at(-1).identifier)"
```

Expected: no output from `cmp`, then `4 urn:air:jaredsburrows.com:mcp:talks`.

- [ ] **Step 4: Run the existing validator**

Run: `node .github/validate-site.js`
Expected: exit 0. The existing ARD invariants already check byte equality, the url/data exclusivity, and that a same-origin url resolves to a real file — `mcp/server-card` exists from Task 6, so this passes.

- [ ] **Step 5: Commit**

```bash
git add .well-known/ai-catalog.json .well-known/ard.json
git commit -m "feat(mcp): advertise the server card in the capability manifest"
```

---

### Task 8: CI invariants, README, and the regression tests

Six invariants, all in the same file and reviewed together. These are what stop the card and the server drifting apart once nobody is looking.

**Files:**
- Modify: `.github/validate-site.js`
- Modify: `.github/validate-site.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: invariants 1–4, 6 and 7 from the spec, with mutation tests.

- [ ] **Step 1: Write the failing regression test**

Append to `.github/validate-site.test.js`, using the file's existing `testFiles(name, overrides, expectCode, expectStderrIncludes)` helper (defined around line 223). `overrides` maps a repo-relative path to its replacement content; `expectStderrIncludes` takes one substring or a list.

```js
// --- MCP server card invariants. The card is three copies of one document
// advertising a server in another file, reached through a manifest entry in a
// fourth. Nothing at runtime notices when any of those stop agreeing: an agent
// reading a stale card connects to the wrong endpoint, or calls a tool that no
// longer exists. Every case below mutates one file and expects a non-zero exit.
const CARD_PATHS = [
  'mcp/server-card',
  '.well-known/mcp/server-card.json',
  '.well-known/mcp.json',
];
const originalCard = fs.readFileSync(path.join(repoRoot, 'mcp/server-card'), 'utf8');
const originalMcpSource = fs.readFileSync(path.join(repoRoot, 'src/mcp.mts'), 'utf8');
const originalRedirects = fs.readFileSync(path.join(repoRoot, '_redirects'), 'utf8');

/** The same mutated card written to all three paths, so byte equality still holds. */
const allCards = (transform) => {
  const card = JSON.parse(originalCard);
  transform(card);
  const text = `${JSON.stringify(card, null, 2)}\n`;
  return Object.fromEntries(CARD_PATHS.map((name) => [name, text]));
};

testFiles('a card copy that drifts from the canonical one fails the build',
  { '.well-known/mcp.json': originalCard.replace('"1.0.0"', '"9.9.9"') },
  1, 'byte-identical');

testFiles('a missing card copy fails the build',
  { '.well-known/mcp.json': null },
  1, '.well-known/mcp.json is missing');

testFiles('an endpoint that disagrees with remotes[0].url fails the build',
  allCards((card) => { card.endpoint = 'https://jaredsburrows.com/mcp-v2'; }),
  1, 'disagrees with remotes[0].url');

testFiles('a remotes url that is not the route the Worker serves fails the build',
  allCards((card) => { card.remotes[0].url = 'https://jaredsburrows.com/api/mcp'; }),
  1, 'but the Worker serves');

testFiles('a card advertising a tool the server does not export fails the build',
  allCards((card) => { card.capabilities.tools = ['list_talks', 'get_talk', 'search_talks']; }),
  1, '"search_talks" that src/mcp.mts does not export');

testFiles('a card that drops a tool the server exports fails the build',
  allCards((card) => { card.capabilities.tools = ['list_talks']; }),
  1, 'does not advertise');

testFiles('a card version that disagrees with SERVER_VERSION fails the build',
  allCards((card) => { card.version = '2.0.0'; card.serverInfo.version = '2.0.0'; }),
  1, 'disagrees with SERVER_VERSION');

testFiles('a card claiming a protocol revision the server does not implement fails the build',
  allCards((card) => { card.remotes[0].supportedProtocolVersions = ['2025-06-18']; }),
  1, 'the only revision src/mcp.mts implements');

testFiles('a wrong $schema fails the build',
  allCards((card) => { card.$schema = 'https://example.invalid/card.json'; }),
  1, 'SEP-2127 schema pins it to');

testFiles('a name that is not reverse-DNS with one slash fails the build',
  allCards((card) => { card.name = 'talks'; card.serverInfo.name = 'talks'; }),
  1, 'reverse-DNS with exactly one slash');

testFiles('renaming a tool in the server without updating the card fails the build',
  { 'src/mcp.mts': originalMcpSource.replace("name: 'get_talk',", "name: 'fetch_talk',") },
  1, 'does not advertise');

testFiles('dropping the Content-Type rule on the extensionless card fails the build',
  { '_headers': originalHeaders.replace(
      '/mcp/server-card\n  Content-Type: application/mcp-server-card+json\n',
      '/mcp/server-card\n') },
  1, 'Content-Type: application/mcp-server-card+json on /mcp/server-card');

testFiles('dropping CORS from a card path fails the build',
  { '_headers': originalHeaders.replace(
      '/.well-known/mcp.json\n  Content-Type: application/mcp-server-card+json\n  Access-Control-Allow-Origin: *',
      '/.well-known/mcp.json\n  Content-Type: application/mcp-server-card+json') },
  1, 'Access-Control-Allow-Origin');

testFiles('a _redirects rule shadowing /mcp fails the build',
  { '_redirects': `${originalRedirects}/mcp /api/talks.json 302\n` },
  1, 'would shadow the MCP endpoint');

testFiles('a manifest entry with the wrong media type fails the build',
  (() => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, '.well-known/ard.json'), 'utf8'));
    const entry = manifest.entries.find((candidate) => candidate.identifier.includes(':mcp:'));
    entry.type = 'application/json';
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    return { '.well-known/ard.json': text, '.well-known/ai-catalog.json': text };
  })(),
  1, 'application/mcp-server-card+json');
```

Note that `allCards` and the manifest case write `JSON.stringify(..., null, 2)` plus a trailing newline. Confirm that matches how `mcp/server-card` and the manifests are actually formatted on disk — if the real files differ, the byte-equality invariant will fire on unrelated cases and mask the one under test. Adjust the serialisation to match the files rather than reformatting the files.

- [ ] **Step 2: Run test to verify it fails**

Run: `node .github/validate-site.test.js`
Expected: FAIL — the validator exits 0 for every mutation, because none of these invariants exist yet.

- [ ] **Step 3: Write the invariants**

Append to `.github/validate-site.js`, after the ARD section:

```js
// --- MCP server card. One document published at three paths, advertising a
// server that lives in src/mcp.mts, discovered through a manifest entry in a
// fourth file. Four things that must agree and nothing at runtime that
// notices when they stop: a card naming a tool the server dropped sends an
// agent to call something that errors, and a stale endpoint sends it nowhere
// at all. Worse than publishing no card, because a card invites the attempt.
const CARD_PATHS = [
  'mcp/server-card',
  '.well-known/mcp/server-card.json',
  '.well-known/mcp.json',
];
const CARD_MEDIA_TYPE = 'application/mcp-server-card+json';
const CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
const MCP_ENDPOINT = 'https://jaredsburrows.com/mcp';

const cardText = new Map();
for (const name of CARD_PATHS) {
  try {
    cardText.set(name, read(name));
  } catch (error) {
    bad(`${name} is missing — the server card is published at all three paths (${error.message})`);
  }
}

// Byte equality, like the ARD pair above and for the same reason: the copies
// exist so an agent gets the same bytes whichever path its spec revision
// tells it to try.
const [canonicalCard] = CARD_PATHS;
for (const name of CARD_PATHS.slice(1)) {
  if (cardText.has(name) && cardText.has(canonicalCard) && cardText.get(name) !== cardText.get(canonicalCard)) {
    bad(`${name} and ${canonicalCard} are not byte-identical — edit ${canonicalCard} and copy it to the other paths in the same commit`);
  }
}

// The server is the source of truth for its own identity and tool list; the
// card only restates it. Read the module's text rather than importing it:
// validate-site.js is CommonJS and mcp.mts is TypeScript ESM — require() cannot
// load it, and this file is checked by tsc but never compiled. A regex over
// the exported constants is enough to catch the drift this guards against.
const mcpSource = (() => {
  try {
    return read('src/mcp.mts');
  } catch (error) {
    bad(`src/mcp.mts is missing, but the server card advertises it (${error.message})`);
    return '';
  }
})();
const constantIn = (name) => new RegExp(`export const ${name} = '([^']+)'`).exec(mcpSource)?.[1];
const serverVersion = constantIn('SERVER_VERSION');
const serverName = constantIn('SERVER_NAME');
const protocolVersion = constantIn('PROTOCOL_VERSION');
const exportedTools = [...mcpSource.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((match) => match[1]);

if (cardText.has(canonicalCard)) {
  const card = parseJson(canonicalCard);
  if (card) {
    if (card.$schema !== CARD_SCHEMA) {
      bad(`${canonicalCard} has $schema ${JSON.stringify(card.$schema)}, but the SEP-2127 schema pins it to ${CARD_SCHEMA}`);
    }
    if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(card.name ?? '')) {
      bad(`${canonicalCard} name ${JSON.stringify(card.name)} is not reverse-DNS with exactly one slash, which the card schema requires`);
    }
    const remote = card.remotes?.[0];
    if (remote?.url !== MCP_ENDPOINT) {
      bad(`${canonicalCard} remotes[0].url is ${JSON.stringify(remote?.url)} but the Worker serves ${MCP_ENDPOINT}`);
    }
    if (card.endpoint !== remote?.url) {
      bad(`${canonicalCard} endpoint ${JSON.stringify(card.endpoint)} disagrees with remotes[0].url ${JSON.stringify(remote?.url)} — the two shapes must state the same endpoint`);
    }
    if (protocolVersion && !remote?.supportedProtocolVersions?.includes(protocolVersion)) {
      bad(`${canonicalCard} does not list ${protocolVersion}, the only revision src/mcp.mts implements`);
    }
    if (serverName && card.name !== serverName) {
      bad(`${canonicalCard} name ${JSON.stringify(card.name)} disagrees with SERVER_NAME in src/mcp.mts`);
    }
    if (serverVersion && card.version !== serverVersion) {
      bad(`${canonicalCard} version ${JSON.stringify(card.version)} disagrees with SERVER_VERSION in src/mcp.mts`);
    }
    if (serverVersion && card.serverInfo?.version !== card.version) {
      bad(`${canonicalCard} serverInfo.version disagrees with its own version field`);
    }
    // The tool list is the claim most likely to rot: tools get added and
    // renamed in mcp.mts, and nothing but this line notices the card did not
    // follow.
    const claimed = card.capabilities?.tools ?? [];
    if (exportedTools.length > 0) {
      for (const tool of claimed) {
        if (!exportedTools.includes(tool)) {
          bad(`${canonicalCard} advertises a tool ${JSON.stringify(tool)} that src/mcp.mts does not export`);
        }
      }
      for (const tool of exportedTools) {
        if (!claimed.includes(tool)) {
          bad(`src/mcp.mts exports a tool ${JSON.stringify(tool)} that ${canonicalCard} does not advertise`);
        }
      }
    }
  }
}

// The canonical path has no extension, so Cloudflare infers no type for it at
// all — the rule is the only thing between the card and a typeless response.
// The two .json copies would be served as application/json without a rule,
// which is wrong but not silent, so all three are checked the same way.
for (const name of CARD_PATHS) {
  const rule = headerRuleValues(`/${name}`);
  if (!rule) {
    bad(`_headers has no /${name} rule, so the card is not served as ${CARD_MEDIA_TYPE}`);
    continue;
  }
  if (!rule.some((line) => new RegExp(`^Content-Type:\\s*${CARD_MEDIA_TYPE.replace('+', '\\+')}\\b`, 'i').test(line))) {
    bad(`_headers does not set Content-Type: ${CARD_MEDIA_TYPE} on /${name}`);
  }
  if (!rule.some((line) => /^Access-Control-Allow-Origin:\s*\*/i.test(line))) {
    bad(`_headers does not set Access-Control-Allow-Origin on /${name}, which hosted card endpoints MUST do so browser agents can read them`);
  }
}

// The manifest entry is how SEP-2127 says a client finds the card at all. The
// ARD loop above already checks that its url resolves to a file in this tree;
// what it cannot know is that this particular entry must be typed as a server
// card. A wrong media type here means a client scanning the manifest for cards
// skips the entry entirely, and the card may as well not be published.
for (const name of ARD_PATHS) {
  const manifest = ardText.has(name) ? parseJson(name) : undefined;
  const entry = manifest?.entries?.find((candidate) => candidate.identifier === MCP_CATALOG_ID);
  if (!entry) {
    bad(`${name} has no ${MCP_CATALOG_ID} entry, so nothing points a client at the server card`);
    continue;
  }
  if (entry.type !== CARD_MEDIA_TYPE) {
    bad(`${name} types ${MCP_CATALOG_ID} as ${JSON.stringify(entry.type)}; SEP-2127 requires ${CARD_MEDIA_TYPE}`);
  }
  if (entry.url !== `${MCP_ENDPOINT}/server-card`) {
    bad(`${name} points ${MCP_CATALOG_ID} at ${JSON.stringify(entry.url)} rather than the canonical card at ${MCP_ENDPOINT}/server-card`);
  }
}

// Redirects fire ahead of the Worker, so a rule matching /mcp would shadow the
// endpoint entirely and the card would advertise a 302. `redirects` is already
// read at the top of this file (line 49) for the _redirects syntax check.
for (const line of redirects.split('\n')) {
  const [from] = line.trim().split(/\s+/);
  if (from === '/mcp' || from === '/mcp/') {
    bad(`_redirects sends ${from} elsewhere, which would shadow the MCP endpoint the server card advertises`);
  }
}
```

Add the identifier constant alongside the other card constants at the top of this section:

```js
const MCP_CATALOG_ID = 'urn:air:jaredsburrows.com:mcp:talks';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node .github/validate-site.js`
Expected: exit 0 against the real tree.

Run: `node .github/validate-site.test.js`
Expected: PASS — every mutation is now caught.

- [ ] **Step 5: Update the README**

In `README.md`, insert a new `### MCP server` section between the existing `### Markdown twin of the homepage` (line 56) and `### The Worker` (line 68) headings — the twin and the MCP server are both agent-facing surfaces, and the Worker section that follows describes the code serving both. Also update the `### The Worker` section, which currently describes a Worker that only negotiates `/`, so it names both routes.

```markdown
### MCP server

`POST /mcp` is a Model Context Protocol server over the talks, implementing
protocol revision `2026-07-28` and only that revision. It exposes two tools,
`list_talks` and `get_talk`, and keeps no session — every request carries its
own protocol version and client capabilities.

Its server card is published three times from one source: `mcp/server-card` is
the location SEP-2127 reserves, and `.well-known/mcp/server-card.json` and
`.well-known/mcp.json` are the paths today's scanners probe. Edit
`mcp/server-card` and copy it to both; `validate-site.js` fails the build if
the three ever differ, if the card's endpoint stops matching the Worker, or if
its tool list stops matching `src/mcp.mts`.
```

- [ ] **Step 6: Run the full check suite**

```bash
npm ci
npm run typecheck
node .github/validate-talks.js
node .github/validate-site.js
node .github/validate-site.test.js
node --test src/*.test.mts
npx --yes wrangler deploy --dry-run
git ls-files '*.html' | xargs java -jar node_modules/vnu-jar/build/dist/vnu.jar
```

Expected: all green. This is exactly what CI runs, in CI's order.

`npm run typecheck` is the step most likely to fail first here, and it covers more than `src/`: `tsconfig.json` includes `.github/**/*.js` with `checkJs` and `strict`, so the validator code added in Step 3 is type-checked as well as executed. A `bad(...)` call is fine; an unguarded `card.remotes[0].url` on a `JSON.parse` result may not be.

- [ ] **Step 7: Commit**

```bash
git add .github/validate-site.js .github/validate-site.test.js README.md
git commit -m "test: pin the server card to the server it advertises"
```

---

## Before opening the PR

- [ ] `git fetch origin gh-pages && git rebase origin/gh-pages` — a conflicting PR skips CI entirely while CodeQL still reports green, so rebase before pushing, never after.
- [ ] Re-run the full check suite from Task 8 Step 6 **on the rebased tree**. Green on a stale base is not verification.
- [ ] Confirm every commit is signed (`git log --format='%G? %s' origin/gh-pages..HEAD` shows `G` on each).
- [ ] After merge and deploy, re-run the production scan and confirm `checks.discovery.mcpServerCard.status` is `"pass"`:

```bash
curl -s -X POST https://isitagentready.com/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://jaredsburrows.com"}' \
  | jq '.checks.discovery.mcpServerCard'
```

A local change never counts as passing — the scan reads production.

## Follow-ups, not in this PR

- **WAF rate-limiting rule on `/mcp`.** A public unauthenticated POST endpoint on a free-tier account (100k requests/day). The in-code guards bound per-request work; the rule is the real control and is dashboard-only, so it cannot live in this repository.
- **PR 2 (`agentSkills`)** and **PR 3 (`webMcp`)** — see the spec's Delivery section. PR 2 depends on this one, because its SKILL.md documents this server.
- **`_mcp` DNS SVCB record** — now that an endpoint exists the honesty objection is gone, but it is a separate decision on its own merits, and dashboard-only.
