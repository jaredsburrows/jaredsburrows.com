// Unit tests for src/a2a.mts — the A2A endpoint at POST /a2a that
// /.well-known/agent-card.json names. Like /mcp, it answers only machines, so a
// protocol mistake looks exactly like a working site; these cases are the
// contract.
//
// Run: node --test src/a2a.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { A2A_PATH, AGENT_VERSION, PROTOCOL_VERSION, SKILL_IDS, dispatch, handleA2a, requestedVersion, route } from './a2a.mts';

/** A protocol payload, as a test reads one; see mcp.test.mts for why. */
type Payload = Record<string, any>;

const TALKS = [
  { date: '2017-11-08', title: 'The Road to Single Dex', where: 'GDG SF Meetup',
    location: 'San Francisco, CA, USA', description: ['One.', 'Two.'] },
  { date: '2017-11-05', title: 'Make Your Build Great Again', where: 'Droidcon',
    location: 'New York, NY, USA', youtube: 'rvwAlbtbtmM', description: ['Three.'] },
  { date: '2016-06-22', title: 'The Road to Single Dex', where: 'Gradle Summit',
    location: 'Palo Alto, CA, USA', description: ['Four.'] },
];
const IDS = ['2017-11-08-the-road-to-single-dex', '2017-11-05-make-your-build-great-again', '2016-06-22-the-road-to-single-dex'];

/** A stand-in for the `assets` binding, serving only /api/talks.json. */
const env = {
  ASSETS: {
    async fetch() {
      return new Response(JSON.stringify({ talks: TALKS }), { headers: { 'content-type': 'application/json' } });
    },
  },
};

const userMessage = (parts: object[], extra: object = {}) => ({
  messageId: 'm-1', role: 'ROLE_USER', parts, ...extra,
});

const rpc = (method: string, params: object = {}, id: string | number = 1) => ({ jsonrpc: '2.0', id, method, params });

const post = (body: unknown, headers: Record<string, string> = {}, url = `https://jaredsburrows.com${A2A_PATH}`) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': PROTOCOL_VERSION, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const call = async (request: Request): Promise<{ status: number; body: Payload; response: Response }> => {
  const response = (await handleA2a(request, env))!;
  return { status: response.status, body: await response.json() as Payload, response };
};

test('the card and the module agree', () => {
  const card = JSON.parse(readFileSync(new URL('../.well-known/agent-card.json', import.meta.url), 'utf8'));
  assert.equal(card.supportedInterfaces[0].url, `https://jaredsburrows.com${A2A_PATH}`);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, PROTOCOL_VERSION);
  assert.equal(card.version, AGENT_VERSION);
  assert.deepEqual(card.skills.map((skill: Payload) => skill.id), [...SKILL_IDS]);
});

test('route reads a talk id, then a year, then falls back to the whole list', () => {
  assert.deepEqual(route([{ text: `Tell me about ${IDS[1]}` }], IDS), { skill: 'get-talk', args: { id: IDS[1] } });
  assert.deepEqual(route([{ text: 'What did he give in 2016?' }], IDS), { skill: 'list-talks', args: { year: 2016 } });
  assert.deepEqual(route([{ text: 'What talks are there?' }], IDS), { skill: 'list-talks', args: {} });
  assert.deepEqual(route([{ data: { id: 'nope' } }], IDS), { skill: 'get-talk', args: { id: 'nope' } });
  assert.deepEqual(route([{ data: { year: 2017 } }], IDS), { skill: 'list-talks', args: { year: 2017 } });
  // A year inside a talk id is the id, not a year filter.
  assert.equal(route([{ text: IDS[0] }], IDS).skill, 'get-talk');
});

test('SendMessage with no filter replies with every talk as text and data', async () => {
  const { status, body } = await call(post(rpc('SendMessage', { message: userMessage([{ text: 'What talks has he given?' }]) })));
  assert.equal(status, 200);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  const message = body.result.message;
  assert.equal(message.role, 'ROLE_AGENT');
  assert.equal(typeof message.messageId, 'string');
  assert.equal(typeof message.contextId, 'string');
  assert.equal(message.kind, undefined, 'A2A 1.0 removed the kind discriminator');
  assert.equal(message.parts[0].text, '3 talks, newest first.');
  assert.deepEqual(message.parts[1].data.talks.map((talk: Payload) => talk.id), IDS);
  assert.equal(message.parts[1].mediaType, 'application/json');
  assert.equal(message.metadata.skill, 'list-talks');
  assert.equal(body.result.task, undefined, 'exactly one of message or task');
});

test('SendMessage naming a year lists only that year', async () => {
  const { body } = await call(post(rpc('SendMessage', { message: userMessage([{ text: 'Talks from 2016?' }]) })));
  assert.equal(body.result.message.parts[0].text, '1 talk in 2016, newest first.');
  assert.deepEqual(body.result.message.parts[1].data.talks.map((talk: Payload) => talk.id), [IDS[2]]);
});

test('SendMessage naming an id returns that talk with its abstract', async () => {
  const { body } = await call(post(rpc('SendMessage', { message: userMessage([{ data: { id: IDS[2] } }]) })));
  const [text, data] = body.result.message.parts;
  assert.equal(text.text, 'The Road to Single Dex, Gradle Summit, 2016-06-22.');
  assert.deepEqual(data.data.description, ['Four.']);
  assert.equal(body.result.message.metadata.skill, 'get-talk');
});

test('an unknown id is an answer, not an error', async () => {
  const { body } = await call(post(rpc('SendMessage', { message: userMessage([{ data: { id: 'nope' } }]) })));
  assert.equal(body.error, undefined);
  assert.match(body.result.message.parts[0].text, /No talk with id "nope"/);
});

test('the client contextId is echoed', async () => {
  const { body } = await call(post(rpc('SendMessage', { message: userMessage([{ text: 'hi' }], { contextId: 'ctx-7' }) })));
  assert.equal(body.result.message.contextId, 'ctx-7');
});

test('a malformed message is InvalidParams', async () => {
  for (const message of [undefined, userMessage([]), userMessage([{ text: 'x' }], { role: 'ROLE_AGENT' }),
    userMessage([{ text: 'x' }], { messageId: '' }), userMessage(['x'] as unknown as object[])]) {
    const answer = await dispatch(rpc('SendMessage', { message }), env);
    assert.equal(answer.error?.code, -32602, JSON.stringify(message));
  }
});

test('an output mode this agent cannot write is ContentTypeNotSupported', async () => {
  const params = { message: userMessage([{ text: 'x' }]), configuration: { acceptedOutputModes: ['image/png'] } };
  const answer = await dispatch(rpc('SendMessage', params), env);
  assert.equal(answer.error?.code, -32005);
  assert.equal((answer.error?.data as Payload[])[0].reason, 'CONTENT_TYPE_NOT_SUPPORTED');
  const ok = await dispatch(rpc('SendMessage', { ...params, configuration: { acceptedOutputModes: ['text/plain'] } }), env);
  assert.ok(ok.result);
});

test('methods for features the card disclaims return the errors A2A defines', async () => {
  const expected: Record<string, number> = {
    SendStreamingMessage: -32004,
    SubscribeToTask: -32004,
    GetTask: -32001,
    CancelTask: -32001,
    CreateTaskPushNotificationConfig: -32003,
    GetTaskPushNotificationConfig: -32003,
    ListTaskPushNotificationConfigs: -32003,
    DeleteTaskPushNotificationConfig: -32003,
    GetExtendedAgentCard: -32007,
    'message/send': -32601,
  };
  for (const [method, code] of Object.entries(expected)) {
    const answer = await dispatch(rpc(method), env);
    assert.equal(answer.error?.code, code, method);
  }
  const tasks = await dispatch(rpc('ListTasks'), env);
  assert.deepEqual(tasks.result?.tasks, []);
});

test('a request that is not JSON-RPC 2.0 is InvalidRequest', async () => {
  for (const body of [[], null, 'x', { jsonrpc: '1.0', method: 'SendMessage' }, { jsonrpc: '2.0', method: 7 }]) {
    const answer = await dispatch(body, env);
    assert.equal(answer.error?.code, -32600, JSON.stringify(body));
  }
});

test('A2A-Version is required: absent means 0.3, which is refused', async () => {
  const headerless = post(rpc('SendMessage', { message: userMessage([{ text: 'x' }]) }), { 'a2a-version': '' });
  assert.equal(requestedVersion(headerless), '0.3');
  const { status, body } = await call(headerless);
  assert.equal(status, 200);
  assert.equal(body.error.code, -32009);
  assert.equal(body.id, 1);

  const query = new Request(`https://jaredsburrows.com${A2A_PATH}?A2A-Version=1.0`, { method: 'POST' });
  assert.equal(requestedVersion(query), '1.0', 'the spec allows the version as a query parameter');
});

test('transport: preflight, method, media type, size and parse errors', async () => {
  const preflight = (await handleA2a(new Request(`https://jaredsburrows.com${A2A_PATH}`, { method: 'OPTIONS' }), env))!;
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers')!, /A2A-Version/);

  const get = (await handleA2a(new Request(`https://jaredsburrows.com${A2A_PATH}`), env))!;
  assert.equal(get.status, 405);

  assert.equal((await call(post('{}', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await call(post(JSON.stringify({ pad: 'x'.repeat(70000) })))).status, 413);

  const parse = await call(post('{'));
  assert.equal(parse.body.error.code, -32700);
  assert.equal(parse.body.id, null);
  assert.equal(parse.response.headers.get('cache-control'), 'no-store');
});

test('any other path is not this module', async () => {
  assert.equal(await handleA2a(new Request('https://jaredsburrows.com/a2a/v1', { method: 'POST' }), env), null);
  assert.equal(await handleA2a(new Request('https://jaredsburrows.com/.well-known/agent-card.json'), env), null);
});
