(function () {
  'use strict';

  // © year
  document.getElementById('copyright').textContent = '© ' + new Date().getFullYear();

  // GitHub follower count (falls back to baked-in text when offline/rate-limited)
  fetch('https://api.github.com/users/jaredsburrows')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
    .then(function (d) {
      if (d && typeof d.followers === 'number') {
        document.getElementById('gh-followers').textContent =
          d.followers.toLocaleString() + ' followers on GitHub';
      }
    })
    .catch(function () { /* keep baked-in count */ });

  // Talks — rendered from talks.js (window.TALKS), newest first.
  // Each row expands in place; slide/video embeds load on first expand.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function displayDate(iso) {
    var parts = iso.split('-'); // YYYY-MM-DD
    var m = parseInt(parts[1], 10);
    return MONTHS[m - 1] + ' ' + parts[0];
  }

  function span(className, text) {
    var s = document.createElement('span');
    s.className = className;
    s.textContent = text;
    return s;
  }

  // YouTube and Speaker Deck refuse to be framed by a page with a null
  // referer, which is what file:// sends — so local previews get thumbnail
  // links instead of iframes.
  var LOCAL = window.location.protocol === 'file:';

  function embed(src, title) {
    var f = document.createElement('iframe');
    f.src = src;
    f.title = title;
    f.loading = 'lazy';
    f.setAttribute('allow', 'fullscreen; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    return f;
  }

  function card(href, thumb, label) {
    var a = document.createElement('a');
    a.className = 'talk-ext';
    a.href = href;

    var img = document.createElement('img');
    img.src = thumb;
    img.alt = '';
    img.loading = 'lazy';
    a.appendChild(img);

    var cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = label + ' ↗';
    a.appendChild(cap);

    return a;
  }

  function appendEmbeds(body, talk) {
    if (talk.youtube) {
      body.appendChild(LOCAL
        ? card('https://www.youtube.com/watch?v=' + talk.youtube,
               'https://img.youtube.com/vi/' + talk.youtube + '/hqdefault.jpg',
               'Watch on YouTube')
        : embed('https://www.youtube-nocookie.com/embed/' + talk.youtube, talk.title + ' — video'));
    }
    if (talk.speakerdeck) {
      body.appendChild(LOCAL
        ? card('https://speakerdeck.com/player/' + talk.speakerdeck,
               'https://speakerd.s3.amazonaws.com/presentations/' + talk.speakerdeck + '/slide_0.jpg',
               'View slides on Speaker Deck')
        : embed('https://speakerdeck.com/player/' + talk.speakerdeck, talk.title + ' — slides'));
    }
  }

  function buildBody(talk) {
    var body = document.createElement('div');
    body.className = 'talk-body';

    (talk.description || []).forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      body.appendChild(p);
    });

    if (talk.link) {
      var meta = document.createElement('p');
      meta.className = 'talk-meta';
      var a = document.createElement('a');
      a.href = talk.link;
      a.textContent = talk.where + (talk.location ? ' · ' + talk.location : '') + ' ↗';
      meta.appendChild(a);
      body.appendChild(meta);
    }

    return body;
  }

  var talks = (window.TALKS || []).slice();
  if (talks.length) {
    talks.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var list = document.getElementById('talks-list');
    list.textContent = '';
    talks.forEach(function (talk) {
      var item = document.createElement('div');
      item.className = 'talk';

      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'talk-row';
      row.setAttribute('aria-expanded', 'false');

      var tg = span('tg', '+');
      row.appendChild(span('dt', displayDate(talk.date)));
      row.appendChild(span('tt', talk.title));
      row.appendChild(span('vn', talk.where));
      row.appendChild(tg);

      var body = buildBody(talk);
      var inner = document.createElement('div');
      inner.className = 'talk-inner';
      inner.appendChild(body);
      var panel = document.createElement('div');
      panel.className = 'talk-panel';
      panel.appendChild(inner);

      var loaded = false;
      row.addEventListener('click', function () {
        var open = item.classList.toggle('open');
        row.setAttribute('aria-expanded', String(open));
        tg.textContent = open ? '−' : '+';
        if (open) {
          // accordion: close any other open talk
          Array.prototype.forEach.call(list.querySelectorAll('.talk.open'), function (other) {
            if (other === item) { return; }
            other.classList.remove('open');
            var otherRow = other.querySelector('.talk-row');
            otherRow.setAttribute('aria-expanded', 'false');
            otherRow.querySelector('.tg').textContent = '+';
          });
          if (!loaded) {
            loaded = true;
            appendEmbeds(body, talk);
          }
        }
      });

      item.appendChild(row);
      item.appendChild(panel);
      list.appendChild(item);
    });
  } else {
    document.getElementById('talks-error').hidden = false;
  }
})();
