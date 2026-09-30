(() => {
  'use strict';

  // `as HTMLElement` below is a type assertion, not code: it compiles to
  // nothing. Each one marks a lookup whose element index.html is required to
  // contain -- validate-site.ts is what holds that end of the contract. They
  // are assertions rather than runtime guards so this file behaves exactly as
  // it did before it was type checked.
  //
  // This file is the SOURCE. The browser is served static/js/home.js, emitted
  // from here by `npm run build` and committed alongside; CI rebuilds and
  // diffs to prove the two agree.

  // © year — auto-updates the digits only; the wording lives in the HTML.
  (document.getElementById('year') as HTMLElement).textContent = `${new Date().getFullYear()}`;

  // Live stats (fall back to baked-in text when offline/rate-limited).
  // The baked-in numbers are a hand-maintained snapshot — no build step
  // regenerates them — so they drift, and this swap is visible whenever they
  // have. The <head> preconnect hints exist to make it land sooner.
  (async () => {
    try {
      const response = await fetch('https://api.github.com/users/jaredsburrows');
      if (!response.ok) return;
      const { followers } = await response.json();
      if (Number.isFinite(followers)) {
        (document.getElementById('gh-followers') as HTMLElement).textContent =
          `${followers.toLocaleString('en-US')} followers on GitHub`;
      }
    } catch {
      // keep baked-in count
    }
  })();

  (async () => {
    try {
      const response = await fetch('https://api.stackexchange.com/2.3/users/950427?site=stackoverflow');
      if (!response.ok) return;
      const { items } = await response.json();
      const reputation = items?.[0]?.reputation;
      if (Number.isFinite(reputation)) {
        (document.getElementById('so-rep') as HTMLElement).textContent =
          `${reputation.toLocaleString('en-US')} rep on Stack Overflow`;
      }
    } catch {
      // keep baked-in value
    }
  })();

  // Talks — rendered from talks.js (window.TALKS), newest first.
  // Each row expands in place; slide/video embeds load on first expand.
  const monthYear = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  // YouTube and Speaker Deck refuse to be framed by a page with a null
  // referer, which is what file:// sends — so local previews get thumbnail
  // links instead of iframes.
  const LOCAL = window.location.protocol === 'file:';

  /**
   * Returns the concrete element type, which is what lets callers below set
   * `.src`, `.type` and `.href` without an assertion.
   */
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  /** @param allow Permissions delegated to the frame, per provider. */
  const embed = (src: string, title: string, allow: string): HTMLIFrameElement => {
    const frame = el('iframe');
    frame.src = src;
    frame.title = title;
    frame.setAttribute('loading', 'lazy');
    // Least privilege, per provider: callers delegate only the capabilities
    // their player uses, so the slide deck gets no EME (a Widevine
    // device-identifier surface) or picture-in-picture. Not a live hole —
    // `allow` can only hand a frame permissions this document already holds.
    // `allowfullscreen` below is the legacy alias, and only applies when
    // `allow` omits fullscreen; both players use it, so both lists keep it.
    frame.setAttribute('allow', allow);
    frame.setAttribute('allowfullscreen', '');
    // Not redundant with the _headers Referrer-Policy: that one belongs to the
    // document, and a Cloudflare zone rule rewrote it to same-origin in
    // September 2026, stripping the referer cross-origin and leaving YouTube's
    // player at Error 153. The rule is fixed, but the attribute pins the policy
    // to the frames themselves, so no later change to the document policy — a
    // zone setting, a _headers edit — can take their referer away again.
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    return frame;
  };

  const card = (href: string, thumb: string, label: string): HTMLAnchorElement => {
    const link = el('a', 'talk-ext');
    Object.assign(link, { href, target: '_blank', rel: 'noopener' });
    const img = el('img');
    img.src = thumb;
    img.alt = '';
    img.setAttribute('loading', 'lazy');
    link.append(img, el('span', 'cap', `${label} ↗`));
    return link;
  };

  const appendEmbeds = (body: HTMLElement, talk: Talk) => {
    if (talk.youtube) {
      body.append(LOCAL
        ? card(`https://www.youtube.com/watch?v=${talk.youtube}`,
               `https://img.youtube.com/vi/${talk.youtube}/hqdefault.jpg`,
               'Watch on YouTube')
        : embed(`https://www.youtube-nocookie.com/embed/${talk.youtube}`, `${talk.title} (video)`,
                'fullscreen; encrypted-media; picture-in-picture'));
    }
    if (talk.speakerdeck) {
      body.append(LOCAL
        ? card(`https://speakerdeck.com/player/${talk.speakerdeck}`,
               `https://speakerd.s3.amazonaws.com/presentations/${talk.speakerdeck}/slide_0.jpg`,
               'View slides on Speaker Deck')
        : embed(`https://speakerdeck.com/player/${talk.speakerdeck}`, `${talk.title} (slides)`,
                'fullscreen'));
    }
  };

  const buildBody = (talk: Talk): HTMLDivElement => {
    const body = el('div', 'talk-body');
    for (const text of talk.description ?? []) {
      body.append(el('p', '', text));
    }
    if (talk.link) {
      const meta = el('p', 'talk-meta');
      const link = el('a', '', `${talk.where}${talk.location ? ` · ${talk.location}` : ''} ↗`);
      Object.assign(link, { href: talk.link, target: '_blank', rel: 'noopener' });
      meta.append(link);
      body.append(meta);
    }
    return body;
  };

  const talks = [...(window.TALKS ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  if (!talks.length) {
    (document.getElementById('talks-error') as HTMLElement).hidden = false;
    return;
  }

  const list = document.getElementById('talks-list') as HTMLElement;
  const fragment = document.createDocumentFragment();
  for (const talk of talks) {
    const item = el('div', 'talk');

    const row = el('button', 'talk-row');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    const toggle = el('span', 'tg', '+');
    row.append(
      el('span', 'dt', monthYear.format(new Date(talk.date))),
      el('span', 'tt', talk.title),
      el('span', 'vn', talk.where),
      toggle,
    );

    const body = buildBody(talk);
    const inner = el('div', 'talk-inner');
    inner.append(body);
    const panel = el('div', 'talk-panel');
    panel.append(inner);
    // The collapse is visual-only (0fr rows + overflow hidden), so inert keeps
    // the hidden links/iframes out of the tab order and accessibility tree.
    panel.inert = true;

    let loaded = false;
    row.addEventListener('click', () => {
      const open = item.classList.toggle('open');
      row.setAttribute('aria-expanded', String(open));
      panel.inert = !open;
      toggle.textContent = open ? '−' : '+';
      if (!open) return;
      // accordion: close any other open talk
      for (const other of list.querySelectorAll('.talk.open')) {
        if (other === item) continue;
        other.classList.remove('open');
        (other.querySelector('.talk-panel') as HTMLElement).inert = true;
        const otherRow = other.querySelector('.talk-row') as HTMLElement;
        otherRow.setAttribute('aria-expanded', 'false');
        (otherRow.querySelector('.tg') as HTMLElement).textContent = '+';
      }
      if (!loaded) {
        loaded = true;
        appendEmbeds(body, talk);
      }
    });

    item.append(row, panel);
    fragment.append(item);
  }
  list.replaceChildren(fragment);
})();
