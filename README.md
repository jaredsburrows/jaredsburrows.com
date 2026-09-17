# jaredsburrows.com

My blog, presentations, GitHub, and social links.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Build](https://github.com/jaredsburrows/jaredsburrows.com/workflows/build/badge.svg)](https://github.com/jaredsburrows/jaredsburrows.com/actions)
[![Twitter Follow](https://img.shields.io/twitter/follow/jaredsburrows.svg?style=social)](https://twitter.com/jaredsburrows)

Personal website — fully static, no build step. Cloudflare Workers serves the repo as-is from its edge.

### Preview the website

Open `index.html` in a browser, or serve the directory:

```
python3 -m http.server
```

If an edit doesn't show up, hard-refresh (Cmd+Shift+R) — the browser may
cache JS/CSS between refreshes.

For a production-parity preview (Cloudflare `_headers`: CSP, caching, 404 page):

```
npx wrangler dev
```

### Caching

Production TTLs live in `_headers`: CSS/JS cache for an hour, images and icons
for 30 days, HTML revalidates on every view — so changes converge on their own,
no cache-busting query strings.

### Add a talk

Add one entry to `static/js/talks.js`, then mirror it into `api/talks.json`
(see below). CI fails if the two disagree.

### API

`/api/talks.json` serves the talks as JSON, described by `api/openapi.json`
(OpenAPI 3.1) and documented at `/api/`. `/.well-known/api-catalog` advertises
all three as an [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727) linkset, so
an agent can find the API without being told where it is.

`static/js/talks.js` stays the source a human edits — the homepage loads it
directly, including over `file://`, which a `fetch` of the JSON would break.
`api/talks.json` is its published copy. To regenerate it after editing a talk:

```
node -e 'global.window={};require("./static/js/talks.js");
require("fs").writeFileSync("api/talks.json",
  JSON.stringify({talks:window.TALKS},null,2)+"\n")'
```

### Markdown twin of the homepage

`index.md` is a hand-written copy of `index.html` for agents that ask for
Markdown instead of HTML. Edit it whenever you edit the homepage — CI fails if
its opening paragraph stops matching the page's `<meta name="description">`, or
if its talks stop matching `static/js/talks.js` in either direction — and
`<link rel="alternate" type="text/markdown">` in the head points at it.

### The Worker

`src/worker.mjs` is the only server code on this site. `_headers` and
`_redirects` cannot branch on a request header, so the Markdown negotiation on
`/` is a Worker: when the request names `text/markdown` in `Accept` — exactly,
with a non-zero q, and at least as preferred as `text/html` — it returns
`index.md` as the homepage; everything else gets the HTML.

Revalidation works on both representations: `If-None-Match` and
`If-Modified-Since` are forwarded onto the `index.md` subrequest, so an agent
that already holds the Markdown homepage gets a 304 rather than the document
again. The two carry different ETags, so neither one's validator can ever
produce a 304 for the other.

`assets.run_worker_first: ["/"]` in `wrangler.jsonc` scopes it to `/`, and
`assets.binding` is what gives it `env.ASSETS.fetch`. Every other path is
matched by Cloudflare's asset router before any code runs, so those requests
are neither slowed down nor billed as Worker invocations.

`/` must never be given a cache TTL. It has two representations on one URL, and
Cloudflare's cache keys only on the URL and `Accept-Encoding` — it ignores
`Vary` for every other request header, so a stored copy goes to every client
whatever its `Accept` says. What keeps them apart today is that `/` is never
stored: Workers Assets serves it `max-age=0, must-revalidate`, so every hit
revalidates through the Worker. Adding a `Cache-Control` with a positive
`max-age` or `s-maxage` for `/` to `_headers` — its own rule or any glob that
matches it — would let one agent request leave the Markdown in the edge cache
for every browser and Googlebot behind it. `validate-site.js` fails the build on
that; `Vary: Accept` stays for downstream caches that do honour it.

Wildcards never select Markdown: a browser ends its `Accept` with `*/*;q=0.8`
and `curl` sends nothing but `*/*`, so matching one would hand ordinary
visitors — and Googlebot — a page with no HTML in it. `src/worker.test.mjs` is
that truth table; run it with `node --test src/worker.test.mjs`.

Both directions are checkable locally, against the real asset router:

```
npx wrangler dev
curl -sI -H 'Accept: text/markdown' localhost:8787/ | grep -i -e content-type -e vary
curl -sI localhost:8787/ | grep -i content-type
```

### Update the avatar

The avatar is self-hosted (Gravatar's 5-minute cache TTL made it flash in on
every visit). To regenerate the three sizes from the Gravatar original:

```
curl -o /tmp/avatar.png "https://gravatar.com/avatar/115b70e2ab7a0aa826f998ee7f2b34baf32da88f0bf932ab5987d1350a50c85e?s=2048"
magick /tmp/avatar.png -resize 208x208 -strip -quality 84 static/image/avatar.webp
magick /tmp/avatar.png -resize 180x180 -strip apple-touch-icon.png
magick /tmp/avatar.png -resize 460x460 -strip -quality 85 static/image/avatar-460.jpg
```

Returning visitors may see the old photo for up to 30 days (image TTL above);
renaming the file — and its references in `index.html` and the `_headers`
preload — busts the cache immediately if that ever matters.

License
=======

```
Copyright (C) 2026 Jared Burrows

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
