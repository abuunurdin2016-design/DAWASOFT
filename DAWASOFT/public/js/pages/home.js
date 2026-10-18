/**
 * pages/home.js — the navigation hub.
 */
(function () {
  PH.app.boot({ page: 2 }, function (user) {
    var name = (user && (user.fullName || user.username)) || 'there';
    document.getElementById('home-greeting').innerHTML =
      '<div class="row between">' +
        '<div><h2>Hi, ' + PH.format.escape(name) + '</h2>' +
        '<p class="muted small">' + PH.format.escape((user && user.profession) || '') +
        (PH.perm.isOwner() ? ' · Owner — full access' : ' · Worker') + '</p></div>' +
        '<span class="badge ' + (navigator.onLine ? 'ok' : 'warn') + '">' + (navigator.onLine ? 'Online' : 'Offline') + '</span>' +
      '</div>';

    function refreshPending() {
      PH.sync.pending().then(function (n) {
        var box = document.getElementById('home-pending');
        if (!n) { box.classList.add('hidden'); return; }
        box.classList.remove('hidden');
        box.innerHTML = PH.icon('refresh', 18) + ' <strong>' + n + '</strong> change(s) waiting to sync.' +
          ' <button class="btn btn-sm btn-ghost" id="sync-now">Sync now</button>';
        var b = document.getElementById('sync-now');
        if (b) b.onclick = function () {
          PH.ui.spinner.show('Syncing…');
          PH.sync.flush().then(function (r) {
            PH.ui.spinner.hide();
            PH.ui.toast(r.sent ? (r.sent + ' change(s) synced') : 'Nothing to sync', 'success');
            refreshPending();
          });
        };
      });
    }
    refreshPending();
    window.addEventListener('ph:sync-changed', refreshPending);

    if (PH.perm.isOwner()) {
      var hint = document.getElementById('home-owner-hint');
      hint.classList.remove('hidden');
      hint.innerHTML = '<div class="card-head"><h3>Owner tools</h3></div>' +
        '<p class="muted small">Grant page and action access to your workers from the User Control panel.</p>' +
        '<a class="btn btn-primary" href="users.html">' + PH.icon('users', 18) + ' User Control</a>';
    }
  });
})();
