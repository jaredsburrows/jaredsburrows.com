(() => {
  'use strict';

  // WebMCP: registers this page's tools with the browser, so an agent driving
  // the tab can ask for the talks instead of scraping an accordion.
  // https://webmachinelearning.github.io/webmcp/
  //
  // They are the same two tools the MCP server at /mcp exposes — same names,
  // descriptions, schemas and answers — answered here from window.TALKS, which
  // the page has already loaded, so calling one costs no request and no Worker
  // invocation. src/mcp.mts cannot be imported: these are classic scripts with
  // no bundler, and that module runs on the edge. So the definitions are written
  // twice, and .github/webmcp.test.mts mounts this page and compares what it
  // registers, and what each tool answers, against that module. Change a tool
  // there and that test names what to change here.
  //
  // This file is the SOURCE. The browser is served static/js/webmcp.js, emitted
  // from here by `npm run build` and committed alongside.

  // `document.modelContext` is where the specification puts the API. Chrome's
  // earlier builds had it on `navigator`, and the scanners that look for these
  // tools still check both.
  const modelContext = document.modelContext ?? navigator.modelContext;
  if (!modelContext) return;

  // In the order talks.js lists them, which is the order api/talks.json — and
  // so the MCP server — returns them in. No talks means talks.js did not load;
  // a tool answering "there are none" would then be a wrong answer rather than
  // a missing one, so nothing is registered.
  const talks = window.TALKS ?? [];
  if (!talks.length) return;

  // The date is part of the id because two talks share a title.
  const talkId = (talk: Talk): string => {
    const slug = talk.title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${talk.date}-${slug}`;
  };

  const summary = (talk: Talk) => ({
    id: talkId(talk),
    date: talk.date,
    title: talk.title,
    where: talk.where,
    location: talk.location,
    ...(talk.link ? { link: talk.link } : {}),
    ...(talk.speakerdeck ? { slides: `https://speakerdeck.com/player/${talk.speakerdeck}` } : {}),
    ...(talk.youtube ? { video: `https://www.youtube.com/watch?v=${talk.youtube}` } : {}),
  });

  // Both tools only read, and say so: the hint lets an agent call them without
  // stopping to ask.
  const annotations = { readOnlyHint: true };

  const tools: ModelContextTool[] = [
    {
      name: 'list_talks',
      description: "List Jared Burrows' conference talks, newest first. Returns each talk's id, date, title, venue, location and links; call get_talk for the abstract.",
      inputSchema: {
        type: 'object',
        properties: {
          year: { type: 'integer', description: 'Only talks given in this calendar year.' },
        },
        additionalProperties: false,
      },
      annotations,
      execute: async ({ year }) => ({
        talks: (year === undefined
          ? talks
          : talks.filter((talk) => Number(talk.date.slice(0, 4)) === Number(year))
        ).map(summary),
      }),
    },
    {
      name: 'get_talk',
      description: 'Get one talk in full, including its abstract, by the id that list_talks returns.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A talk id, for example 2017-11-08-the-road-to-single-dex.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations,
      execute: async ({ id }) => {
        const wanted = String(id ?? '');
        const talk = talks.find((candidate) => talkId(candidate) === wanted);
        // Returned, not thrown. A rejected execute reaches the agent as a bare
        // "OperationError" with the reason stripped, and the reason — which ids
        // do exist — is the useful part.
        if (!talk) {
          return { error: `No talk with id ${JSON.stringify(wanted)}. Valid ids: ${talks.map(talkId).join(', ')}.` };
        }
        return { ...summary(talk), description: talk.description ?? [] };
      },
    },
  ];

  // No AbortSignal is passed: the tools are valid for as long as the page is,
  // and the browser drops them with the document.
  //
  // A browser may refuse a registration — the "tools" permissions policy, a
  // name already taken — by rejecting the promise, and the earlier builds threw
  // instead and returned nothing. Either way it is the agent's loss, not the
  // reader's: the page must not surface an error for a feature it does not
  // need, so both are caught here.
  for (const tool of tools) {
    (async () => {
      try {
        await modelContext.registerTool(tool);
      } catch {
        // No tools for this agent; the page is unaffected.
      }
    })();
  }
})();
