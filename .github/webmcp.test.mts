// Behavioral invariant: the homepage registers its WebMCP tools on load, and
// they are the MCP server's tools — same names, descriptions and schemas, and
// the same answer to the same question.
//
// static/js/webmcp.ts cannot import src/mcp.mts. One is a classic script the
// browser downloads, the other a module that runs on the edge, and nothing in
// this repo bundles — so the two tool definitions are written out twice, and a
// second copy only stays true if something compares it. A text diff of two
// files in two dialects would be the wrong something: validate-site.ts tried to
// read behavior out of home.js's source and lost eleven times (see
// embed-referrerpolicy.test.mts). So, like that file, this one stops reading
// source. It loads the real page in a DOM with a `document.modelContext` that
// records what is registered, then calls each registered tool and each server
// tool with the same arguments and requires the same result.
//
// That makes src/mcp.mts the one place a tool is designed. Change a name, a
// description, a schema or an answer there, and this file fails until
// static/js/webmcp.ts says the same thing.
//
// The mount is deliberately not shared with embed-referrerpolicy.test.mts: that
// harness has been hardened against a long list of specific defeats, and
// threading a second consumer's options through it would put all of them back
// in play to save thirty lines.
//
// Run: npm ci && npm run build && node --test .github/webmcp.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// jsdom is CommonJS and exposes no ESM named exports.
import jsdom from 'jsdom';

import { TOOLS, callTool } from '../src/mcp.mts';
import type { Env } from '../src/mcp.mts';

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://jaredsburrows.com';

/** What a fake `modelContext` does when the page calls `registerTool`. */
type Registrar = (tool: ModelContextTool) => Promise<void> | void;

interface MountOptions {
  /** Installed as `document.modelContext`, the specification's location. */
  onDocument?: Registrar;
  /** Installed as `navigator.modelContext`, where Chrome's earlier builds had it. */
  onNavigator?: Registrar;
  /** Same-origin pathnames to answer 404, to stand in for a script that failed to load. */
  missing?: string[];
}

// The same shape of mount as the embed test: index.html parsed at the site
// origin, its own deferred scripts served from the working tree and run in
// order, everything third-party answered with an empty 200. Offline and
// deterministic.
const mount = async ({ onDocument, onNavigator, missing = [] }: MountOptions = {}) => {
  const served: string[] = [];
  const intercept = requestInterceptor((request) => {
    if (request.url.startsWith(`${SITE_ORIGIN}/`)) {
      const { pathname } = new URL(request.url);
      if (missing.includes(pathname)) return new Response('', { status: 404 });
      let body = null;
      try {
        body = fs.readFileSync(path.join(root, pathname.replace(/^\/+/, '')));
      } catch {
        body = null;
      }
      if (body !== null) {
        served.push(pathname);
        return new Response(body, {
          headers: { 'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' },
        });
      }
    }
    return new Response('', { headers: { 'Content-Type': 'text/plain' } });
  });

  const failures: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => failures.push(error.message));

  // A rejection nobody handled surfaces on the process, not on the window:
  // jsdom runs page script in this isolate. Collected for the length of the
  // mount, so a registration the page fails to catch is attributable to it.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: `${SITE_ORIGIN}/`,
    runScripts: 'dangerously',
    resources: { interceptors: [intercept] },
    virtualConsole,
    beforeParse(window) {
      // jsdom implements no WebMCP, which is what lets each case below decide
      // exactly which object exists. Defined on the instances the page will
      // read, before any of its scripts run.
      if (onDocument) {
        Object.defineProperty(window.document, 'modelContext', { value: { registerTool: onDocument } });
      }
      if (onNavigator) {
        Object.defineProperty(window.navigator, 'modelContext', { value: { registerTool: onNavigator } });
      }
    },
  });

  await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  // Registration is awaited inside the page, so a rejection is only "unhandled"
  // once the microtasks behind it have drained and Node has had a turn to say so.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);

  return { window: dom.window, document: dom.window.document, served, failures, unhandled };
};

/** A registrar that records what it is handed, and the list it records into. */
const recorder = (): { tools: ModelContextTool[], register: Registrar } => {
  const tools: ModelContextTool[] = [];
  return { tools, register: async (tool) => { tools.push(tool); } };
};

// What crosses the boundary in both directions is JSON: the browser serializes
// a tool's result before an agent sees it, and the server's result arrives as a
// response body. Comparing the serialized form is comparing what an agent gets
// — and it also sets aside that jsdom's objects belong to another realm, which
// `deepStrictEqual` would otherwise report as a prototype mismatch on two
// identical values.
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** The asset binding the server reads talks through, backed by the real file. */
const env: Env = {
  ASSETS: {
    fetch: async (input) => {
      const { pathname } = new URL(input instanceof Request ? input.url : input);
      return new Response(fs.readFileSync(path.join(root, pathname.replace(/^\/+/, ''))));
    },
  },
};

const standard = recorder();
const page = await mount({ onDocument: standard.register });
// Through `wire` like everything else read out of the page: an array built in
// jsdom's realm is not `deepEqual` to the same array built in this one.
const talks = wire(page.window.TALKS ?? []) as Talk[];

/** The registered tool with this name; fails the calling test if there is none. */
const registered = (name: string): ModelContextTool => {
  const tool = standard.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `the page registered no tool named ${name}`);
  return tool;
};

// --- Preconditions, asserted rather than assumed: every comparison below is
// vacuously true over a page that never ran.
test('the homepage mounts and runs webmcp.js after talks.js', () => {
  assert.deepEqual(page.failures, [], 'jsdom reported page errors');
  assert.deepEqual(page.unhandled, [], 'the page left a promise rejection unhandled');
  for (const script of ['/static/js/talks.js', '/static/js/webmcp.js']) {
    assert.ok(page.served.includes(script), `${script} was never fetched by the page`);
  }
  assert.ok(page.served.indexOf('/static/js/talks.js') < page.served.indexOf('/static/js/webmcp.js'),
    'webmcp.js was fetched before talks.js — it reads window.TALKS, so index.html must list talks.js first');
  assert.ok(talks.length > 0, 'talks.js defined no window.TALKS');
});

test('on load, the page registers exactly the tools the MCP server exports', () => {
  assert.ok(TOOLS.length > 0, 'src/mcp.mts exports no tools, so this comparison proves nothing');
  assert.deepEqual(standard.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
});

test('each registered tool carries the name, description and input schema the server publishes', () => {
  for (const tool of TOOLS) {
    const { name, description, inputSchema } = registered(tool.name);
    assert.deepEqual(wire({ name, description, inputSchema }), wire(tool),
      `${tool.name} is described differently in static/js/webmcp.ts and src/mcp.mts — an agent would be told two different things about one tool`);
  }
});

test('each registered tool is callable and declares itself read-only', () => {
  for (const { name } of TOOLS) {
    const tool = registered(name);
    assert.equal(typeof tool.execute, 'function', `${name} has no execute callback`);
    assert.equal(tool.annotations?.readOnlyHint, true,
      `${name} does not set annotations.readOnlyHint — it only reads, and the hint is what lets an agent call it without asking`);
  }
});

// Every case is [tool, arguments, why it is here]. The ids are read from the
// data rather than written down, so a new talk is covered the day it is added.
const CALLS: Array<[string, Record<string, unknown>, string]> = [
  ['list_talks', {}, 'the whole catalog'],
  ['list_talks', { year: 2017 }, 'a year with talks in it'],
  ['list_talks', { year: '2017' }, 'the same year as a string, which a model will send'],
  ['list_talks', { year: 1999 }, 'a year with none'],
  ['list_talks', { year: null }, 'an explicit null is not "no filter"'],
  ['list_talks', { year: 'soon' }, 'not a year at all'],
  ['get_talk', { id: 'no-such-talk' }, 'an unknown id is an answer, not a thrown error'],
  ['get_talk', {}, 'the required argument left out'],
  ['get_talk', { id: 42 }, 'an id of the wrong type'],
];

test('every tool answers exactly as the MCP server does', async () => {
  const listed = wire(await registered('list_talks').execute({})) as { talks: Array<{ id: string }> };
  assert.equal(listed.talks.length, talks.length, 'list_talks did not return every talk in talks.js');
  const calls = [...CALLS, ...listed.talks.map(({ id }): [string, Record<string, unknown>, string] =>
    ['get_talk', { id }, 'a real talk'])];

  for (const [name, args, why] of calls) {
    const fromServer = await callTool(name, args, env);
    const fromPage = await registered(name).execute(args);
    assert.deepEqual(wire(fromPage), wire(fromServer.structuredContent),
      `${name}(${JSON.stringify(args)}) — ${why} — is answered differently by the page and by the server`);
  }
});

// The comparison above would pass if both sides were equally wrong, so the
// answers themselves are pinned to the data here.
test('the answers are the talks, not merely equal to each other', async () => {
  const { talks: listed } = wire(await registered('list_talks').execute({})) as { talks: Array<Record<string, unknown>> };
  assert.deepEqual(listed.map((talk) => talk.title), talks.map((talk) => talk.title));
  assert.equal(new Set(listed.map((talk) => talk.id)).size, talks.length,
    'two talks share an id — get_talk could never return the second one');

  const withAbstract = talks.find((talk) => (talk.description ?? []).length > 0);
  assert.ok(withAbstract, 'no talk in talks.js has a description, so the abstract is untested');
  const id = listed[talks.indexOf(withAbstract)].id;
  const detail = wire(await registered('get_talk').execute({ id })) as Record<string, unknown>;
  assert.deepEqual(detail.description, withAbstract.description, 'get_talk did not return the abstract');

  const missing = wire(await registered('get_talk').execute({ id: 'no-such-talk' })) as Record<string, unknown>;
  assert.equal(typeof missing.error, 'string', 'an unknown id did not come back as { error }');
  assert.ok((missing.error as string).includes(String(id)), 'the error for an unknown id does not list the ids that do exist');
});

// --- Where the API lives. The specification says `document`; Chrome's earlier
// builds said `navigator`, and returned nothing from registerTool where the
// specification returns a promise.
test('a browser exposing only navigator.modelContext still gets the tools', async () => {
  const tools: ModelContextTool[] = [];
  const legacy = await mount({ onNavigator: (tool) => { tools.push(tool); } });
  assert.deepEqual(legacy.failures, []);
  assert.deepEqual(legacy.unhandled, []);
  assert.deepEqual(tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
});

test('document.modelContext is preferred when a browser exposes both', async () => {
  const onDocument = recorder();
  const onNavigator = recorder();
  await mount({ onDocument: onDocument.register, onNavigator: onNavigator.register });
  assert.deepEqual(onDocument.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.deepEqual(onNavigator.tools, [], 'the tools were registered twice, once on each object');
});

// --- The page is for readers first. None of this may cost them anything.
const rendersTalks = (document: Document) => document.querySelectorAll('.talk-row').length;

test('a browser without WebMCP runs the page exactly as before', async () => {
  const plain = await mount();
  assert.deepEqual(plain.failures, []);
  assert.deepEqual(plain.unhandled, []);
  assert.equal(rendersTalks(plain.document), talks.length);
});

test('a registration the browser rejects does not surface as a page error', async () => {
  const refused = await mount({
    onDocument: () => Promise.reject(new Error('NotAllowedError: the "tools" feature is disabled by permissions policy')),
  });
  assert.deepEqual(refused.failures, []);
  assert.deepEqual(refused.unhandled, [], 'a rejected registerTool() was left unhandled');
  assert.equal(rendersTalks(refused.document), talks.length);
});

test('a registration that throws synchronously does not surface as a page error', async () => {
  const throwing = await mount({
    onNavigator: () => { throw new Error('InvalidStateError: a tool with this name is already registered'); },
  });
  assert.deepEqual(throwing.failures, []);
  assert.deepEqual(throwing.unhandled, []);
  assert.equal(rendersTalks(throwing.document), talks.length);
});

// With no data, "there are no talks" would be a confident wrong answer. The
// page shows its error row in this state; the tools simply are not offered.
test('no tool is registered when talks.js did not load', async () => {
  const empty = recorder();
  const broken = await mount({ onDocument: empty.register, missing: ['/static/js/talks.js'] });
  assert.equal(broken.window.TALKS, undefined, 'fixture assumption broken: talks.js still loaded');
  assert.deepEqual(empty.tools, []);
});
