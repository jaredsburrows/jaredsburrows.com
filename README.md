# jaredsburrows.com

My blog, presentations, GitHub, and social links.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Build](https://github.com/jaredsburrows/jaredsburrows.com/workflows/build/badge.svg)](https://github.com/jaredsburrows/jaredsburrows.com/actions)
[![Twitter Follow](https://img.shields.io/twitter/follow/jaredsburrows.svg?style=social)](https://twitter.com/jaredsburrows)

Personal website — fully static, no build step. GitHub Pages serves the repo as-is (`.nojekyll`).

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
for a week, HTML revalidates on every view — so changes converge on their own,
no cache-busting query strings.

### Add a talk

Add one entry to `static/js/talks.js`.

### Update the avatar

The avatar is self-hosted (Gravatar's 5-minute cache TTL made it flash in on
every visit). To regenerate the three sizes from the Gravatar original:

```
curl -o /tmp/avatar.png "https://gravatar.com/avatar/115b70e2ab7a0aa826f998ee7f2b34baf32da88f0bf932ab5987d1350a50c85e?s=2048"
magick /tmp/avatar.png -resize 208x208 -strip -quality 84 static/image/avatar.webp
magick /tmp/avatar.png -resize 180x180 -strip apple-touch-icon.png
magick /tmp/avatar.png -resize 460x460 -strip -quality 85 static/image/avatar-460.jpg
```

Returning visitors may see the old photo for up to a week (image TTL above).

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
