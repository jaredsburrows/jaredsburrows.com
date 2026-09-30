# MCP server, server card, agent-skills index and WebMCP

- **Date:** 2026-09-17
- **Status:** approved, not yet implemented
- **Closes:** `mcpServerCard`, `agentSkills`, `webMcp` on `isitagentready.com/api/scan`

## Context

The site reached Level 5 ("Agent-Native") on the isitagentready scan in 2026-09.
Six checks still fail. Three of them are in scope here; the other three
(`oauthDiscovery`, `oauthProtectedResource`, `a2aAgentCard`) remain deliberately
unfixable, because `/auth.md` declares no issuer and no protected resources and
there is no A2A agent behind a card.

All three checks in this document were previously declined, and the reasons are
recorded. They are revisited here because two of the three rationales expired:

- **`mcpServerCard`** was declined because "the card must advertise a live
  transport endpoint that does not exist". This document builds the endpoint, so
  the card becomes truthful rather than aspirational. The principle is upheld,
  not waived.
- **`agentSkills`** was declined because its only genuine artifact duplicated the
  RFC 9727 api-catalog and a hand-synced digest rots. An MCP server is a new,
  non-duplicative artifact, and the digest is pinned by a CI invariant.
- **`webMcp`** was declined as "wait — detection unverified, the Chrome origin
  trial exposes nothing without a token". The scan's own evidence settles it: the
  scanner reports `Check imperative WebMCP API -> No tools registered via
  navigator.modelContext`, meaning it installs the object itself and records
  calls. Detection does not depend on the origin trial.

The site has run a Worker since PR #148, so the "assets-only" constraint that
once ruled out server code no longer applies.

## Specification landscape

The scanner is one revision behind the standard, and the design must satisfy
both without lying in either direction.

| | Scanner expects | SEP-2127 (Final, 2026-01-21) |
| --- | --- | --- |
| Path | `/.well-known/mcp/server-cards.json`, `/.well-known/mcp/server-card.json`, `/.well-known/mcp.json` | `<streamable-http-url>/server-card` |
| Shape | `serverInfo`, `endpoint`, `capabilities` (SEP-1649) | `$schema`, `name`, `version`, `description`, `remotes[]` |
| Domain discovery | — | `/.well-known/ai-catalog.json` |

SEP-2127 explicitly considered and rejected a `.well-known` location for the
card: `.well-known` is for site-wide metadata, and "the card can live anywhere
the catalog points". It also deliberately omits tools/resources/prompts from
cards, because a static document cannot represent a dynamic primitive set.

Two facts make reconciliation cheap:

1. The AI Catalog entry shape SEP-2127 specifies — `specVersion`, `entries[]`
   with `identifier` as `urn:air:{publisher}:{namespace}:{name}`, `type`, `url` —
   is exactly the manifest this site already publishes at
   `.well-known/ai-catalog.json` and `.well-known/ard.json`.
2. `ServerCard` leaves `additionalProperties` unset, so one document may legally
   carry both the SEP-2127 fields and the legacy SEP-1649 fields.

### Decisions

- **Card strategy: canonical plus compatibility aliases.** The card is published
  at the SEP-2127 reserved location and, byte-identical, at the two scanner paths
  that the scanner probes. Publishing only the canonical path would leave the
  check red after building the whole server; publishing only the scanner paths
  would target the one location the Final spec argues against.
- **Protocol era: `2026-07-28` only.** The current revision, and the only one the
  card will claim. Clients speaking `2025-06-18` receive a spec-correct
  `UnsupportedProtocolVersionError` and cannot connect. This is accepted: a new
  build should not be written against a superseded revision, and supporting both
  eras roughly doubles the protocol code and the test matrix.

## Component 1 — MCP server

New file `src/mcp.mjs`, routed from `src/worker.mjs`. Endpoint: `POST /mcp`.

Protocol revision `2026-07-28` requires, and this server implements:

- **`server/discover`** — mandatory. Returns `resultType: "complete"`,
  `supportedVersions: ["2026-07-28"]`, `capabilities: { tools: {} }`,
  `instructions`, and `_meta["io.modelcontextprotocol/serverInfo"]` with name and
  version.
- **`MCP-Protocol-Version` header** on every POST, which MUST equal
  `params._meta["io.modelcontextprotocol/protocolVersion"]`. A mismatch is
  `400` with JSON-RPC error `-32020` (`HeaderMismatch`).
- **`Mcp-Method` and `Mcp-Name` headers** validated against `method` and
  `params.name`. `Mcp-Name` is required for `tools/call`. Values in the
  `=?base64?{value}?=` sentinel form are decoded before comparison.
- **Unsupported version** — `400` with `UnsupportedProtocolVersionError` listing
  `["2026-07-28"]`.
- **Unknown method** — `404` with JSON-RPC `-32601`. Not `200`; the status is how
  a client distinguishes a modern server from a legacy one.
- **Notifications** — `202 Accepted` with no body.
- **`GET` and `DELETE` on `/mcp`** — `405 Method Not Allowed`.
- **`Mcp-Session-Id` and `Last-Event-ID`** — ignored; no session is minted or
  echoed, and streams are not resumable.
- **JSON-RPC batching** — rejected with `-32600`; batching is not part of this
  revision.

Responses are `application/json`. The revision permits a single JSON object in
place of an SSE stream, and nothing this server does is long-running, so no SSE
path is implemented at all.

### Origin policy

The transport spec says servers MUST validate `Origin` and answer `403` when it
is present and invalid. That requirement exists to stop DNS rebinding from
reaching local servers that hold ambient authority. This endpoint is public,
read-only, credential-free, holds no session, and returns data already served at
`/api/talks.json`. Every origin is therefore valid, and the server says so
deliberately in a comment rather than copying an allowlist that would protect
nothing. CORS is `*`, which is also what the hosted-card CORS requirement asks
for.

### Tools

Two talks share the title "The Road to Single Dex", so title cannot key a
lookup. Every talk gets a stable id of `{date}-{slug(title)}`, for example
`2017-11-08-the-road-to-single-dex`.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_talks` | optional `year` (integer) | id, date, title, venue, location, event link, and slide/video ids where present |
| `get_talk` | required `id` (string) | the full record, including abstract paragraphs and resolved Speaker Deck and YouTube URLs |

Results carry both a `content` text block and `structuredContent`. Tool-level
failures (an unknown `id`) return `isError: true` with a message naming the valid
ids, not a JSON-RPC error — a JSON-RPC error means the call was malformed, not
that the answer was "no such talk".

**No `search_talks`**: across three records it is `list_talks` plus a filter.
**No resources**: `index.md` and `api/talks.json` are already reachable through
markdown negotiation and the ARD manifest, and duplication is the precise reason
`agentSkills` was declined the first time.

The talk data is read through `env.ASSETS.fetch("/api/talks.json")`, so the
dataset has exactly one copy in the repository and the MCP server cannot drift
from the REST API or the homepage.

### Request guards

Before parsing, the handler rejects: any method other than POST/OPTIONS, a
`Content-Type` that is not JSON, and a body over 64 KB. These bound the work an
anonymous caller can cause on a metered account.

## Component 2 — Card documents

One body, three paths, byte-identical:

- `mcp/server-card` — canonical (SEP-2127 `<streamable-http-url>/server-card`),
  extensionless, `Content-Type: application/mcp-server-card+json` set in
  `_headers`, the same mechanism already used for `/.well-known/api-catalog`
- `.well-known/mcp/server-card.json` — scanner probe path
- `.well-known/mcp.json` — scanner probe path

All three are static assets. `run_worker_first` uses the exact pattern `/mcp`, so
none of them invokes the Worker.

Body (hybrid, every legacy field restating something true):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "jaredsburrows.com/talks",
  "title": "Jared Burrows — Talks",
  "version": "1.0.0",
  "description": "Read-only MCP server over Jared Burrows' conference talks.",
  "websiteUrl": "https://jaredsburrows.com",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://jaredsburrows.com/mcp",
      "supportedProtocolVersions": ["2026-07-28"]
    }
  ],
  "serverInfo": { "name": "jaredsburrows.com/talks", "version": "1.0.0" },
  "endpoint": "https://jaredsburrows.com/mcp",
  "capabilities": { "tools": ["list_talks", "get_talk"] }
}
```

`$schema` must match the schema's own pattern exactly, and `name` must match
`^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` — one slash, namespace then server name.

## Component 3 — Catalog entry

A fourth entry is added to both `.well-known/ard.json` and
`.well-known/ai-catalog.json`, which must remain byte-identical:

```json
{
  "identifier": "urn:air:jaredsburrows.com:mcp:talks",
  "type": "application/mcp-server-card+json",
  "url": "https://jaredsburrows.com/mcp/server-card"
}
```

This is the discovery path SEP-2127 specifies. The entry deliberately does not
repeat the card's `title`, `description` or `version`; the spec says clients read
those from the card, and duplicating them invites drift.

`representativeQueries` is omitted for this entry: it describes a transport, not
a document a query would retrieve.

## Component 4 — Agent Skills index

`.well-known/agent-skills/index.json`:

```json
{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "talks-mcp",
      "type": "skill-md",
      "description": "Connect to the Talks MCP server and call its tools.",
      "url": "https://jaredsburrows.com/.well-known/agent-skills/talks-mcp/SKILL.md",
      "digest": "sha256:<the SHA-256 of SKILL.md's bytes>"
    }
  ]
}
```

The field is `digest`, formatted `sha256:{lowercase hex}` — not `sha256`, which
is what the isitagentready issue text calls it.

The digest is computed once and committed as a literal. This site has no build
step, so there is nothing to generate it at deploy time; invariant 5 below is
what keeps it correct, failing CI whenever SKILL.md changes without it.

One skill, not two. A `talks-api` skill would restate the api-catalog, and that
duplication is why this check was declined before.

`.well-known/agent-skills/talks-mcp/SKILL.md` documents the endpoint, the
required `2026-07-28` headers, and both tools, with a worked `tools/call`
example.

The legacy `/.well-known/skills/index.json` alias is not published: the scanner
probes it only after the v0.2.0 path 404s, and that path will return 200.

## Component 5 — WebMCP

New `static/js/webmcp.js`, loaded `defer` from `index.html` after `talks.js`.

Feature-detected against whichever surface exists — the API is mid-rename, so the
script checks `navigator.modelContext` (what the scanner shims and probes) and
`document.modelContext` (what the W3C explainer names), and uses
`provideContext()` when available, falling back to `registerTool()` per tool.
When neither object exists the script does nothing and costs one no-op.

Tools are page actions, which is what WebMCP is for:

| Tool | Arguments | Effect |
| --- | --- | --- |
| `list_talks` | none | returns the talks rendered on the page |
| `show_talk` | required `id` | expands that talk's accordion entry and scrolls it into view |

`script-src 'self'` already permits the file. No CSP change, in `_headers` or in
the mirrored meta tag.

## CI invariants

Added to `.github/validate-site.js`, with cases in
`.github/validate-site.test.js`. These are what keep the work from rotting:

1. The three card documents are byte-identical.
2. The card's `remotes[0].url` and its legacy `endpoint` agree, and both equal
   `https://jaredsburrows.com/mcp`.
3. The card's `$schema` is the exact required URL and `name` matches the
   reverse-DNS pattern.
4. The card's advertised `capabilities.tools` equals the tool names
   `src/mcp.mjs` actually exports — the card cannot drift from the server.
5. Every `skills[]` entry resolves to a local file, and its `digest` equals
   `sha256:` plus the real SHA-256 of that file's bytes.
6. The catalog entry's `url` resolves to a local file and its `type` is
   `application/mcp-server-card+json`.
7. `_headers` sets the expected `Content-Type` and `Access-Control-Allow-Origin`
   on every new path, and adds no rule that collides with `/*` — the file's
   existing rule that two matching rules would comma-join their values. The
   card paths additionally must have a `Content-Type` rule at all: an
   extensionless asset is otherwise served with none (measured below), and
   `_redirects` must contain no rule matching `/mcp`, which would shadow the
   endpoint since redirects fire ahead of the Worker.
8. `webmcp.js` is referenced from `index.html`, and the element ids it looks up
   exist there — the same HTML/JS contract already enforced for `home.js`.

## Files

**Added**

- `src/mcp.mjs`, `src/mcp.test.mjs`
- `mcp/server-card`
- `.well-known/mcp/server-card.json`, `.well-known/mcp.json`
- `.well-known/agent-skills/index.json`
- `.well-known/agent-skills/talks-mcp/SKILL.md`
- `static/js/webmcp.js`
- this document

**Modified**

- `src/worker.mjs` — route `/mcp` to the MCP handler, leaving `/` negotiation intact
- `wrangler.jsonc` — `run_worker_first: ["/", "/mcp"]`
- `_headers` — media types and CORS for the new paths
- `.well-known/ard.json`, `.well-known/ai-catalog.json` — the catalog entry
- `index.html` — the `webmcp.js` script tag
- `.github/validate-site.js`, `.github/validate-site.test.js` — the invariants
- `.assetsignore` — add `docs`, so this spec is not served from the website
- `README.md` — document the endpoint and the new files

## Delivery

Three pull requests, not one, following this repository's established practice of
one small PR per scan check. The order is a real dependency chain: the skill
document in PR 2 describes the server built in PR 1.

1. **MCP server, card, catalog entry** — `src/mcp.mjs` and its tests, the three
   card documents, the `ard.json`/`ai-catalog.json` entry, `wrangler.jsonc`,
   `_headers`, invariants 1–4, 6 and 7. Flips `mcpServerCard`.
2. **Agent Skills index** — `index.json`, `talks-mcp/SKILL.md`, invariant 5.
   Flips `agentSkills`.
3. **WebMCP** — `static/js/webmcp.js`, the `index.html` script tag, invariant 8.
   Flips `webMcp`.

Each merges to `gh-pages` and deploys before the next is opened, and the scan is
re-run against production after each. A check only counts as passing once the
production scan says so; a local change never does.

Per the recorded rebase rule, each branch is rebased on `gh-pages` before it is
pushed — a conflicting PR skips CI entirely while CodeQL still reports green.

## Testing

Test-first, following the repo's existing pattern: `src/mcp.test.mjs` uses
`node:test` and imports handlers directly from `src/mcp.mjs`, as
`src/worker.test.mjs` does today. Nothing in `src/mcp.mjs` imports a
`cloudflare:` module or touches global state at load time, so it is importable
outside workerd.

Coverage, one case per normative rule:

- `server/discover` returns the supported version, capabilities and `serverInfo`
- header/body mismatch on each of `MCP-Protocol-Version`, `Mcp-Method`,
  `Mcp-Name` gives `400` and `-32020`
- a base64-sentinel `Mcp-Name` is decoded before comparison
- a missing `MCP-Protocol-Version` header is rejected
- an unsupported version gives `400` and lists `["2026-07-28"]`
- an unknown method gives `404` and `-32601`
- a notification gives `202` and an empty body
- `GET` and `DELETE` give `405`
- `Mcp-Session-Id` and `Last-Event-ID` are ignored, and no session id is echoed
- a JSON-RPC batch is rejected with `-32600`
- oversized and non-JSON bodies are rejected before parsing
- `tools/list` returns exactly the two tools
- `list_talks` with and without `year`; `get_talk` for each id
- `get_talk` with an unknown id returns `isError` with the valid ids, not a
  JSON-RPC error
- duplicate titles resolve to distinct ids

Then the full existing suite: `src/worker.test.mjs`,
`.github/validate-site.test.js`, `.github/validate-talks.js`.

### Routing, measured

The routing assumptions were checked under `wrangler dev` (wrangler 4.134.0)
before any protocol code was written, using a throwaway probe: `run_worker_first:
["/", "/mcp"]`, a stub `mcp/server-card` asset, and a Worker branch returning a
marker for `/mcp`. All four results held, and the probe was reverted.

| Probe | Result |
| --- | --- |
| `POST /mcp` | `200`, Worker marker, **no redirect** |
| `GET /mcp` | `200`, Worker marker, **no redirect** |
| `GET /mcp/server-card` | the asset, with `ETag` and `CF-Cache-Status: HIT` and no Worker marker — the asset router served it |
| `GET /` and `GET /` with `Accept: text/markdown` | unchanged: `text/html` and `text/markdown` respectively, both `Vary: Accept` |

So `run_worker_first` is exact-match — `/mcp` does not capture `/mcp/server-card`
— and a repository directory named `mcp/` does not make the asset router redirect
`/mcp` to `/mcp/` before the Worker sees it. The fallback of serving the
canonical card from the Worker is not needed.

Two further findings from the same probe:

- The extensionless `mcp/server-card` asset is served with **no `Content-Type` at
  all** unless `_headers` supplies one. The `_headers` rule is load-bearing, not
  cosmetic, and a missing rule fails open (no type) rather than closed.
- A `_headers` rule on `/mcp/server-card` does apply `Content-Type:
  application/mcp-server-card+json` and `Access-Control-Allow-Origin: *` to that
  path, confirmed in the response.

`_redirects` contains no rule matching `/mcp` or `/.well-known/*`, so nothing
pre-empts the route. Redirects fire ahead of asset serving, so a future redirect
rule on `/mcp` would shadow the endpoint; invariant 7 should cover that.

## Operational notes

**Billing.** `/mcp` becomes the second billed route. `/mcp/server-card` and every
other new file stays on the unbilled asset path.

**Abuse.** A public, unauthenticated POST endpoint on a free-tier account (100k
requests/day) is new exposure. In-code guards bound per-request work; a
Cloudflare WAF rate-limiting rule is the real control and is dashboard-only, so
it cannot live in this repository. It is a follow-up, recorded here rather than
silently skipped.

**Observability.** `/mcp` invocations will appear in Workers Logs under the
existing `observability` settings, at sampling rate 1, with query strings
redacted.

## Out of scope

- `oauthDiscovery`, `oauthProtectedResource` — `/auth.md` declares no issuer and
  no protected resources on purpose
- `a2aAgentCard` — no A2A agent exists; a card would advertise a dead endpoint
- `webBotAuth` — scored neutral, informational only; would mean publishing
  signing keys for a bot this site does not operate
- `_mcp` DNS SVCB record — the `_index._agents` record is honest precisely
  because it omits endpoints that do not exist. Adding `_mcp` is a separate
  decision, to be made on its own merits after the endpoint is live, not folded
  into this change.
