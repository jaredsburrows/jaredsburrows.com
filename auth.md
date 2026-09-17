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

No OAuth authorization server is advertised. `/.well-known/oauth-protected-resource`
and `/.well-known/oauth-authorization-server` are intentionally absent: this
origin is not a resource server and has no issuer, so publishing that metadata
would point agents at endpoints that do not exist.

Do not probe for registration routes such as `POST /agent/auth`. They are not
merely unimplemented — the site is served by an assets-only Cloudflare Worker
with no server-side code, so no request can create an account or issue a
credential. Unknown paths return the 404 page.

## Access policy

Crawl and training permissions are declared in [`/robots.txt`](/robots.txt) via
`Content-Signal`, not here. That file is the authoritative statement of what
automated clients may do with this content.

## Contact

Security reports: [`/.well-known/security.txt`](/.well-known/security.txt)
