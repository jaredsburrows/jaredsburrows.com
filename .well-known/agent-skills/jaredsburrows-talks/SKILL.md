---
name: jaredsburrows-talks
description: Look up the conference talks Jared Burrows has given, with their dates, venues, abstracts, slides and video, from jaredsburrows.com. Use when asked which talks he has given, or for the slides, recording or abstract of one of them.
---

# Jared Burrows' conference talks

jaredsburrows.com publishes every conference talk Jared Burrows has given: the
date, the venue, the location, the event page, the abstract, and the slides and
video where they exist. All of it is public and read-only. There is no API key,
no account and no sign-in, so send no `Authorization` header. The
[authentication policy](https://jaredsburrows.com/auth.md) says the same at
more length.

The same data is published three ways. Use the first one your environment
supports.

## 1. Fetch the JSON

```
GET https://jaredsburrows.com/api/talks.json
```

The response is `{ "talks": [ ... ] }`, small and unpaginated. Every talk has:

- `date`: the day it was given, as `YYYY-MM-DD`
- `title`
- `where`: the conference or venue

and may have:

- `location`: city, region and country
- `link`: the event page
- `description`: the abstract, one string per paragraph
- `speakerdeck`: a Speaker Deck id
- `youtube`: a YouTube video id

Turn the two ids into links like this:

- slides: `https://speakerdeck.com/player/{speakerdeck}`
- video: `https://www.youtube.com/watch?v={youtube}`

The [OpenAPI 3.1 description](https://jaredsburrows.com/api/openapi.json) has
the full schema.

## 2. Call the MCP server

```
POST https://jaredsburrows.com/mcp
```

It speaks streamable HTTP, protocol revision `2026-07-28` only, and keeps no
session: there is no `initialize` handshake. Its
[server card](https://jaredsburrows.com/mcp/server-card) describes it. It has
two tools:

- `list_talks` takes an optional integer `year` and returns each talk's `id`,
  `date`, `title`, `where`, `location`, `link`, `slides` and `video`.
- `get_talk` takes an `id` from `list_talks` and returns the same fields plus
  `description`.

Here `slides` and `video` are already full URLs.

## 3. Read the page as Markdown

```
GET https://jaredsburrows.com/index.md
```

This is the whole homepage as Markdown: the bio, where else he publishes, and
the talks with their links. It leaves out the abstracts.

## Things to get right

- Two entries share the title "The Road to Single Dex". They are the same talk
  given at two events, not a duplicate, so tell them apart by date. The MCP
  server's ids do that for you: an id is the date, then the title in lowercase
  with hyphens, for example `2017-06-22-the-road-to-single-dex`.
- A talk with no `youtube` id was not recorded. Say so instead of searching for
  a recording.
- Several `link` values point at the Internet Archive on purpose, because the
  original event pages are gone.
- Quote the abstracts as written. They are the speaker's own descriptions.
