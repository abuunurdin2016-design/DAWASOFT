/**
 * pages/settings.js — Settings (page 8).
 * Appearance (theme / font / background) is a device preference kept in localStorage.
 * The account block shows the signed-in user and lets them rotate their password.
 */
(function () {
  PH.app.boot({ page: 8 }, function (user) {
    var u = user || PH.auth.user() || {};

    function markSeg(id, value) {
      var host = document.getElementById(id);
      Array.prototype.forEach.call(host.children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-v') === value);
      });
    }

    function wire(id, apply, get) {
      var host = document.getElementById(id);
      markSeg(id, get());
      host.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        apply(b.getAttribute('data-v'));
        markSeg(id, b.getAttribute('data-v'));
      });
    }

    wire('set-theme', PH.app.setTheme, PH.app.getTheme);
    wire('set-font', PH.app.setFont, PH.app.getFont);
    wire('set-bg', PH.app.setBg, PH.app.getBg);

    /* --------------------------- account --------------------------- */

    document.getElementById('set-account').innerHTML =
      '<div class="list">' +
      row('Full name', u.fullName) +
      row('Username', u.username) +
      row('Email', u.email) +
      row('Profession', u.profession) +
      row('Role', PH.perm.isOwner() ? 'Administrator (Owner)' : 'Worker') +
      row('Date of birth', u.dob ? PH.format.date(u.dob) : '') +
      '</div>';

    function row(label, value) {
      return '<div class="list-row"><div class="grow muted small">' + PH.format.escape(label) + '</div>' +
        '<div><strong>' + PH.format.escape(value || '-') + '</strong></div></div>';
    }

    /* --------------------------- password --------------------------- */

    document.getElementById('cp-save').onclick = function () {
      var cur = document.getElementById('cp-current').value;
      var next = document.getElementById('cp-new').value;
      if (next.length < 6) { PH.ui.toast('New password must be at least 6 characters.', 'error'); return; }
      PH.ui.spinner.show('Updating password…');
      PH.api.call('changePassword', { currentPassword: cur, newPassword: next }).then(function () {
        PH.ui.spinner.hide();
        document.getElementById('cp-current').value = '';
        document.getElementById('cp-new').value = '';
        PH.ui.toast('Password updated.', 'success');
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not update the password', 'error');
      });
    };

    /* --------------------------- system --------------------------- */

    function renderSystem() {
      var pending = 0;
      PH.sync.pending().then(function (n) {
        pending = n;
        document.getElementById('set-system').innerHTML =
          '<div class="list">' +
          row('App version', PH.config.APP_VERSION) +
          row('Connection', navigator.onLine ? 'Online' : 'Offline') +
          row('Changes waiting to sync', String(pending)) +
          row('Offline database', 'IndexedDB (on this device)') +
          '</div>';
      });
    }
    renderSystem();
    window.addEventListener('ph:sync-changed', renderSystem);

    document.getElementById('set-sync').onclick = function () {
      PH.ui.spinner.show('Syncing…');
      PH.sync.flush().then(function (r) {
        PH.ui.spinner.hide();
        PH.ui.toast(r.sent ? r.sent + ' change(s) synced' : (r.offline ? 'You are offline.' : 'Nothing to sync'), 'success');
        renderSystem();
      });
    };

    document.getElementById('set-reload').onclick = function () {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.update(); }));
        }).catch(function () {});
      }
      window.location.reload();
    };
  });
})();
