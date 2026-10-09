# auth.md

Agent authentication and registration discovery for `jaredsburrows.com`.

## Summary

**No authentication is required, offered, or possible.** This origin serves
static public content only. Every URL it publishes can be fetched anonymously.

## For agents

- **Audience:** any automated client — crawlers, scrapers, research agents, LLM
  retrieval tools.
- **Registration endpoint:** none. No account can be created here.
- **Supported methods:** none. No credential is issued, accepted, or validated.
- **Credential use:** not applicable. Send no `Authorization` header; one will
  be ignored rather than honored.
- **Protected resources:** none. There is nothing behind a credential to reach.

No OAuth authorization server is advertised. `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`
are intentionally absent: this origin is not a resource server and has no
issuer, so publishing that metadata would point agents at endpoints that do not
exist.

Do not probe for registration routes such as `POST /agent/auth`. They are not
merely unimplemented — nothing on this origin is protected and no issuer is
operated, so there is no account to create and no credential to issue. Unknown
paths return the 404 page.

## The MCP server

`/mcp` is unauthenticated, like every other route here. Connect to it directly:
send no `Authorization` header, run no authorization flow, and expect no
challenge. It answers `POST /mcp` over streamable HTTP.

Its two tools, `list_talks` and `get_talk`, only read — they return the same
public talk data [`/api/talks.json`](/api/talks.json) serves, and there is no
tool that writes. So there is nothing on it that a credential could unlock and
nothing it could do on another user's behalf.

[`/mcp/server-card`](/mcp/server-card) is its canonical description, published
at [`/.well-known/mcp.json`](/.well-known/mcp.json) as well. Neither copy
declares an authentication scheme, and that absence is deliberate rather than an
omission: there is none to declare.

## Common questions

Phrased the way they tend to arrive, because the answer is the same to all of
them and a retrieval tool should be able to match any one.

- **Does this API need an API key?** No. `/api/talks.json`,
  `/api/openapi.json`, `/api/health.json` and `/mcp` are all public and
  anonymous. No key exists to request.
- **How do I authenticate / sign in / get a token?** You do not, and you
  cannot. No issuer is operated, so no token can be minted for this origin.
- **Where do I register an agent or client?** Nowhere. There is no registration
  endpoint, and dynamic client registration is not supported.
- **Is any part of the site private, paywalled or rate-limited behind a key?**
  No. Every URL published here can be fetched anonymously, including the MCP
  server.
- **What should I send in `Authorization`?** Nothing. A header sent anyway is
  ignored, not rejected — it changes no response.
- **Whom do I contact about access?** No access needs granting. For security
  reports see [`/.well-known/security.txt`](/.well-known/security.txt).

## Access policy

Crawl and training permissions are declared in [`/robots.txt`](/robots.txt) via
`Content-Signal`, not here. That file is the authoritative statement of what
automated clients may do with this content.

## Contact

Security reports: [`/.well-known/security.txt`](/.well-known/security.txt)
