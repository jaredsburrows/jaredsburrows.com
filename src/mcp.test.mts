// Unit tests for src/mcp.mts — the MCP server at POST /mcp. A deploy cannot tell
// you any of this is right: the endpoint answers only machines, and a protocol
// mistake looks exactly like a working site. The cases below are the contract.
//
// Run: node --test src/mcp.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { talkId, loadTalks, TOOLS, callTool, talkSummary, decodeHeaderValue, dispatch,
         PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './mcp.mts';
import type { ToolResult, TalkSummary, TalkDetail, Env, RpcError } from './mcp.mts';

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
