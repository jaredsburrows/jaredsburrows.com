// The two OAuth endpoints /.well-known/oauth-authorization-server names.
//
// This origin has nothing to protect: every URL it serves is public, and no
// request is ever answered differently for carrying a credential. The OAuth
// metadata it publishes says exactly that in OAuth's own vocabulary — no grant
// types, no response types, no scopes, no bearer methods, an empty key set —
// and these handlers are what make that metadata true rather than merely
// well-formed. A metadata document that names an authorization endpoint and a
// token endpoint is making a claim about two URLs. Without this file both
// would be the 404 page, and the claim would be false.
//
// So both exist, and both do the one thing an authorization server with no
// clients and no grants can correctly do: refuse, in the form RFC 6749
// prescribes, and say where the explanation is. No request can make either
// one issue a token, set a cookie, redirect, or read a byte of its body. There
// is no state here and no secret, which is the whole security argument.
//
// The extension is .mts for the reason worker.mts gives. Nothing here imports a
// `cloudflare:` module, so the test beside it runs this same code under Node.

/** Where a person, or an agent, reads why every request here is refused. */
export const AUTH_POLICY = 'https://jaredsburrows.com/auth.md';

/** `authorization_endpoint` in the metadata; validate-site.ts pins the two together. */
export const AUTHORIZATION_PATH = '/oauth/authorize';

/** `token_endpoint` in the metadata. */
export const TOKEN_PATH = '/oauth/token';

/**
 * Never stored, by anything. RFC 6749 requires `no-store` and the legacy
 * `Pragma` on every token response; the authorization endpoint gets the same,
 * so no intermediary can replay a refusal for a request it never saw.
 */
const UNCACHEABLE = { 'cache-control': 'no-store', pragma: 'no-cache' };

/**
 * `GET /oauth/authorize` (and POST, which RFC 6749 section 3.1 permits).
 *
 * An authorization request names a client and a redirect URI, and the normal
 * way to report an error is to redirect back to that URI. Section 4.1.2.1
 * carves out the one case where that is forbidden: when the client or its
 * redirect URI cannot be verified, the server "MUST NOT automatically redirect"
 * and informs the person in front of it instead. No client is registered here,
 * so that is every request — which is also what makes this endpoint safe to
 * publish. It reads nothing from the query string and never emits a
 * `Location`, so it cannot be turned into an open redirect.
 */
function authorize(request: Request): Response {
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, POST', ...UNCACHEABLE } });
  }
  const body = [
    'unauthorized_client',
    '',
    'This authorization server has no registered clients and supports no',
    'response types, so it cannot authorize this or any request.',
    '',
    'Nothing on jaredsburrows.com needs a token. Every URL is public: fetch it',
    'directly and send no Authorization header.',
    '',
    AUTH_POLICY,
    '',
  ].join('\n');
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...UNCACHEABLE },
  });
}

/**
 * `POST /oauth/token`.
 *
 * The metadata lists no grant types, so whatever `grant_type` a request names
 * is one this server does not support, and RFC 6749 section 5.2 has a code for
 * precisely that. The body is deliberately never read: the answer does not
 * depend on it, and an endpoint that parses nothing has nothing to get wrong
 * and bounds the work an anonymous POST can cause at zero. `error_uri` is the
 * part that matters to an agent — it leads to the document that says no token
 * is needed, which is the thing it was actually trying to find out.
 *
 * The CORS header is what lets a browser-based agent read the refusal instead
 * of an opaque network error. A form-encoded POST needs no preflight.
 */
function token(request: Request): Response {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST', ...UNCACHEABLE } });
  }
  return new Response(JSON.stringify({
    error: 'unsupported_grant_type',
    error_description: 'This authorization server supports no grant types and issues no tokens. Nothing on jaredsburrows.com needs one.',
    error_uri: AUTH_POLICY,
  }), {
    status: 400,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'access-control-allow-origin': '*',
      ...UNCACHEABLE,
    },
  });
}

/**
 * Answers a request for one of the two endpoints, or returns null for any
 * other path so the caller carries on. Exact matches only: `/oauth/jwks.json`
 * is a static file and must stay one.
 */
export function handleOAuth(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (pathname === AUTHORIZATION_PATH) return authorize(request);
  if (pathname === TOKEN_PATH) return token(request);
  return null;
}
