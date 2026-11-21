// Unit tests for src/oauth.mts — the two endpoints the OAuth metadata names.
//
// They exist so that metadata is true, and they are safe to publish for one
// reason: neither can be made to do anything. These cases are that claim, held
// to the things an authorization endpoint and a token endpoint are attacked
// through — a redirect URI, a request body, a cache — and to the two documents
// that describe them, which are read from the tree so the code and its
// description cannot drift apart unnoticed.
//
// Run: node --test src/oauth.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { handleOAuth, AUTHORIZATION_PATH, TOKEN_PATH, AUTH_POLICY } from './oauth.mts';

const ORIGIN = 'https://jaredsburrows.com';
const metadata = JSON.parse(fs.readFileSync(
  new URL('../.well-known/oauth-authorization-server', import.meta.url), 'utf8'));

/** The response for a request to one of the endpoints; fails if the path is not handled. */
const answer = (path: string, init?: RequestInit): Response => {
  const response = handleOAuth(new Request(`${ORIGIN}${path}`, init));
  assert.ok(response, `${path} was not handled`);
  return response;
};

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

test('the endpoints handled here are the ones the metadata names', () => {
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}${AUTHORIZATION_PATH}`);
  assert.equal(metadata.token_endpoint, `${ORIGIN}${TOKEN_PATH}`);
  assert.equal(metadata.service_documentation, AUTH_POLICY);
});

// --- The authorization endpoint. An open redirect is the classic way one of
// these is abused: a link on a trusted domain that lands on an attacker's page.
// This one cannot be, whatever it is sent.
const AUTHORIZE_QUERIES = [
  '',
  '?response_type=code&client_id=agent&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=xyz',
  '?response_type=token&client_id=agent&redirect_uri=https%3A%2F%2Fevil.example%2Fcb',
  '?redirect_uri=//evil.example',
  '?client_id=https%3A%2F%2Fevil.example%2Fclient.json&redirect_uri=https%3A%2F%2Fevil.example',
];

test('the authorization endpoint refuses every request and never redirects', async () => {
  for (const query of AUTHORIZE_QUERIES) {
    const response = answer(`${AUTHORIZATION_PATH}${query}`);
    assert.equal(response.status, 400, `${query || '(no query)'} was not refused`);
    assert.equal(response.headers.get('location'), null, `${query} produced a redirect`);
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.text();
    assert.ok(body.startsWith('unauthorized_client\n'), 'the refusal does not lead with the OAuth error it is');
    assert.ok(body.includes(AUTH_POLICY), 'the refusal does not say where the explanation is');
    assert.ok(!body.includes('evil.example'), 'the refusal echoed something from the request');
  }
});

test('the authorization refusal is plain text and is never cached', () => {
  const response = answer(AUTHORIZATION_PATH);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8',
    'plain text cannot carry markup, so there is nothing in it for a browser to run');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the authorization endpoint also answers POST and HEAD, and no other method', async () => {
  assert.equal(answer(AUTHORIZATION_PATH, form({ response_type: 'code' })).status, 400,
    'RFC 6749 section 3.1 permits POST here');
  const head = answer(AUTHORIZATION_PATH, { method: 'HEAD' });
  assert.equal(head.status, 400);
  assert.equal(await head.text(), '', 'a HEAD response carries no body');
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = answer(AUTHORIZATION_PATH, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD, POST');
  }
});

// --- The token endpoint. The metadata lists no grant types, so every grant is
// unsupported — including the ones a real server would accept.
const GRANTS: Array<Record<string, string>> = [
  { grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://evil.example/cb', client_id: 'agent' },
  { grant_type: 'client_credentials', client_id: 'agent', client_secret: 'hunter2' },
  { grant_type: 'refresh_token', refresh_token: 'abc' },
  { grant_type: 'password', username: 'jared', password: 'hunter2' },
  { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'a.b.c' },
  { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'abc' },
  {},
];

test('the token endpoint issues nothing, for any grant', async () => {
  assert.deepEqual(metadata.grant_types_supported, [],
    'the metadata lists a grant type, so refusing every grant is no longer what it describes');
  for (const fields of GRANTS) {
    const response = answer(TOKEN_PATH, form(fields));
    assert.equal(response.status, 400, `${JSON.stringify(fields)} was not refused`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error, 'unsupported_grant_type');
    assert.equal(body.error_uri, AUTH_POLICY);
    assert.equal(typeof body.error_description, 'string');
    for (const issued of ['access_token', 'refresh_token', 'id_token', 'token_type', 'expires_in']) {
      assert.ok(!(issued in body), `the response to ${JSON.stringify(fields)} carries ${issued}`);
    }
  }
});

test('the token refusal is JSON, uncacheable, and readable from a browser', () => {
  const response = answer(TOKEN_PATH, form({ grant_type: 'client_credentials' }));
  assert.equal(response.headers.get('content-type'), 'application/json;charset=UTF-8');
  assert.equal(response.headers.get('cache-control'), 'no-store', 'RFC 6749 section 5.1 requires no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('www-authenticate'), null,
    'a challenge would tell a client that credentials could work here');
});

// The answer cannot depend on the body, so the body is never read — which is
// what bounds the work an anonymous POST can cause, whatever it sends.
test('the token endpoint never reads the request body', async () => {
  for (const body of ['{not form data', 'x'.repeat(1 << 20)]) {
    const request = new Request(`${ORIGIN}${TOKEN_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    const response = handleOAuth(request);
    assert.ok(response);
    assert.equal(response.status, 400);
    assert.equal(request.bodyUsed, false, 'the handler consumed the request body');
  }
});

test('the token endpoint answers only POST', () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const response = answer(TOKEN_PATH, { method });
    assert.equal(response.status, 405, `${method} was not refused`);
    assert.equal(response.headers.get('allow'), 'POST');
  }
});

// Exact matches, like the routes in wrangler.jsonc: everything else under
// /oauth/ belongs to the asset router, the key set included.
test('paths that are not one of the two endpoints are not handled', () => {
  for (const path of ['/oauth', '/oauth/', '/oauth/jwks.json', '/oauth/token/', '/oauth/authorize/x',
    '/oauth/tokens', '/OAuth/token', '/', '/mcp']) {
    assert.equal(handleOAuth(new Request(`${ORIGIN}${path}`, { method: 'POST' })), null, `${path} was handled`);
  }
});
