"use strict";
(() => {
    'use strict';
    const modelContext = document.modelContext ?? navigator.modelContext;
    if (!modelContext)
        return;
    const talks = window.TALKS ?? [];
    if (!talks.length)
        return;
    const talkId = (talk) => {
        const slug = talk.title
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return `${talk.date}-${slug}`;
    };
    const summary = (talk) => ({
        id: talkId(talk),
        date: talk.date,
        title: talk.title,
        where: talk.where,
        location: talk.location,
        ...(talk.link ? { link: talk.link } : {}),
        ...(talk.speakerdeck ? { slides: `https://speakerdeck.com/player/${talk.speakerdeck}` } : {}),
        ...(talk.youtube ? { video: `https://www.youtube.com/watch?v=${talk.youtube}` } : {}),
    });
    const annotations = { readOnlyHint: true };
    const tools = [
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
                    : talks.filter((talk) => Number(talk.date.slice(0, 4)) === Number(year))).map(summary),
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
                if (!talk) {
                    return { error: `No talk with id ${JSON.stringify(wanted)}. Valid ids: ${talks.map(talkId).join(', ')}.` };
                }
                return { ...summary(talk), description: talk.description ?? [] };
            },
        },
    ];
    for (const tool of tools) {
        (async () => {
            try {
                await modelContext.registerTool(tool);
            }
            catch {
            }
        })();
    }
})();
