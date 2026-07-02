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
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function displayDate(iso) {
    var parts = iso.split('-'); // YYYY-MM-DD
    var m = parseInt(parts[1], 10);
    return MONTHS[m - 1] + ' ' + parts[0];
  }

  var talks = (window.TALKS || []).slice();
  if (talks.length) {
    talks.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var list = document.getElementById('talks-list');
    list.textContent = '';
    talks.forEach(function (talk) {
      var a = document.createElement('a');
      a.href = talk.url;

      var dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = displayDate(talk.date);

      var tt = document.createElement('span');
      tt.className = 'tt';
      tt.textContent = talk.title;

      var vn = document.createElement('span');
      vn.className = 'vn';
      vn.textContent = talk.where;

      a.appendChild(dt);
      a.appendChild(tt);
      a.appendChild(vn);
      list.appendChild(a);
    });
  } else {
    document.getElementById('talks-error').hidden = false;
  }
})();
