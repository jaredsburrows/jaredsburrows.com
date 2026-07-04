(() => {
  'use strict';

  // © year
  document.getElementById('copyright').textContent = `Jared Burrows © ${new Date().getFullYear()}`;

  // Live stats (fall back to baked-in text when offline/rate-limited).
  // Baked values match the live ones so the update is invisible unless
  // a count actually changed; en-US formatting keeps them identical.
  (async () => {
    try {
      const response = await fetch('https://api.github.com/users/jaredsburrows');
      if (!response.ok) return;
      const { followers } = await response.json();
      if (Number.isFinite(followers)) {
        document.getElementById('gh-followers').textContent =
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
        document.getElementById('so-rep').textContent =
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

  const el = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const embed = (src, title) => {
    const frame = el('iframe');
    frame.src = src;
    frame.title = title;
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allow', 'fullscreen; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    return frame;
  };

  const card = (href, thumb, label) => {
    const link = el('a', 'talk-ext');
    Object.assign(link, { href, target: '_blank', rel: 'noopener' });
    const img = el('img');
    img.src = thumb;
    img.alt = '';
    img.setAttribute('loading', 'lazy');
    link.append(img, el('span', 'cap', `${label} ↗`));
    return link;
  };

  const appendEmbeds = (body, talk) => {
    if (talk.youtube) {
      body.append(LOCAL
        ? card(`https://www.youtube.com/watch?v=${talk.youtube}`,
               `https://img.youtube.com/vi/${talk.youtube}/hqdefault.jpg`,
               'Watch on YouTube')
        : embed(`https://www.youtube-nocookie.com/embed/${talk.youtube}`, `${talk.title} — video`));
    }
    if (talk.speakerdeck) {
      body.append(LOCAL
        ? card(`https://speakerdeck.com/player/${talk.speakerdeck}`,
               `https://speakerd.s3.amazonaws.com/presentations/${talk.speakerdeck}/slide_0.jpg`,
               'View slides on Speaker Deck')
        : embed(`https://speakerdeck.com/player/${talk.speakerdeck}`, `${talk.title} — slides`));
    }
  };

  const buildBody = (talk) => {
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
    document.getElementById('talks-error').hidden = false;
    return;
  }

  const list = document.getElementById('talks-list');
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

    let loaded = false;
    row.addEventListener('click', () => {
      const open = item.classList.toggle('open');
      row.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '−' : '+';
      if (!open) return;
      // accordion: close any other open talk
      for (const other of list.querySelectorAll('.talk.open')) {
        if (other === item) continue;
        other.classList.remove('open');
        const otherRow = other.querySelector('.talk-row');
        otherRow.setAttribute('aria-expanded', 'false');
        otherRow.querySelector('.tg').textContent = '+';
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
