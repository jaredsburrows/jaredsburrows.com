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

OAuth metadata is published, and it says the same thing in OAuth's own terms.
[`/.well-known/oauth-protected-resource`](/.well-known/oauth-protected-resource)
(RFC 9728) lists no scopes and no bearer methods: there is no way to present a
token here, because nothing takes one.
[`/.well-known/oauth-authorization-server`](/.well-known/oauth-authorization-server)
(RFC 8414) lists no grant types and no response types, and its key set is
empty. The two endpoints it names exist and answer the way that describes:
`/oauth/authorize` refuses every request and never redirects, and
`/oauth/token` answers every request with `unsupported_grant_type`. No client
is registered, none can be, and no token is ever issued. Do not run an
authorization flow: there is nothing for one to unlock.

Do not probe for registration routes such as `POST /agent/auth`. They are not
merely unimplemented — nothing on this origin is protected, so there is no
account to create and no credential to issue. Unknown paths return the 404 page.

## Access policy

Crawl and training permissions are declared in [`/robots.txt`](/robots.txt) via
`Content-Signal`, not here. That file is the authoritative statement of what
automated clients may do with this content.

## Contact

Security reports: [`/.well-known/security.txt`](/.well-known/security.txt)
