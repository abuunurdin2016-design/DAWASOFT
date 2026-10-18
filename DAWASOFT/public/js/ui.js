/**
 * ui.js — shared UI pieces: the Windows-11 style loading spinner, toasts, modal/confirm dialogs,
 * the Instagram-style bottom navigation, and the home grid.
 */
(function () {
  window.PH = window.PH || {};

  /* ------------------------------ loading spinner (Win11 dotted) ------------------------------ */

  var spinnerEl = null;
  function ensureSpinner() {
    if (spinnerEl) return spinnerEl;
    spinnerEl = document.createElement('div');
    spinnerEl.className = 'ph-loading';
    spinnerEl.innerHTML = '<div class="ph-loading-box"><div class="ph-dots">' +
      '<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>' +
      '</div><p class="ph-loading-text">Loading…</p></div>';
    document.body.appendChild(spinnerEl);
    return spinnerEl;
  }

  /* ------------------------------ toast ------------------------------ */

  function toast(msg, type) {
    var host = document.getElementById('ph-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ph-toasts';
      host.className = 'ph-toasts';
      document.body.appendChild(host);
    }
    var t = document.createElement('div');
    t.className = 'ph-toast ph-toast-' + (type || 'info');
    t.innerHTML = PH.icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info', 18) +
      '<span>' + PH.format.escape(msg) + '</span>';
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 250); }, 3200);
  }

  /* ------------------------------ modal / confirm ------------------------------ */

  function modal(opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'ph-modal-backdrop';
      var actions = (opts.actions || [{ label: 'Close', value: null }]).map(function (a, i) {
        return '<button class="btn ' + (a.class || 'btn-ghost') + '" data-i="' + i + '">' + PH.format.escape(a.label) + '</button>';
      }).join('');
      wrap.innerHTML = '<div class="ph-modal" role="dialog" aria-modal="true">' +
        '<div class="ph-modal-head"><h3>' + PH.format.escape(opts.title || '') + '</h3>' +
        '<button class="ph-modal-x" aria-label="Close">&times;</button></div>' +
        '<div class="ph-modal-body">' + (opts.html || '') + '</div>' +
        '<div class="ph-modal-actions">' + actions + '</div></div>';
      document.body.appendChild(wrap);
      function close(val) { wrap.classList.remove('show'); setTimeout(function () { wrap.remove(); }, 180); resolve(val); }
      wrap.querySelector('.ph-modal-x').onclick = function () { close(null); };
      wrap.querySelectorAll('.ph-modal-actions .btn').forEach(function (b) {
        b.onclick = function () {
          var a = (opts.actions || [])[parseInt(b.getAttribute('data-i'), 10)];
          if (a && a.collect) { close(a.collect(wrap)); } else { close(a ? a.value : null); }
        };
      });
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(null); });
      setTimeout(function () { wrap.classList.add('show'); }, 10);
    });
  }

  function confirm(message, opts) {
    opts = opts || {};
    return modal({
      title: opts.title || 'Please confirm',
      html: '<p>' + PH.format.escape(message) + '</p>',
      actions: [
        { label: opts.cancelLabel || 'Cancel', value: false, class: 'btn-ghost' },
        { label: opts.confirmLabel || 'Confirm', value: true, class: opts.danger ? 'btn-danger' : 'btn-primary' }
      ]
    }).then(function (v) { return v === true; });
  }

  /* ------------------------------ navigation ------------------------------ */

  function renderBottomNav(current) {
    var host = document.getElementById('ph-bottomnav');
    if (!host) return;
    var items = PH.perm.navPages();
    var links = items.map(function (it) {
      var active = it.n === current ? ' active' : '';
      return '<a class="bn-item' + active + '" href="' + it.meta.file + '">' +
        PH.icon(it.meta.icon, 22) + '<span>' + PH.format.escape(it.meta.title) + '</span></a>';
    }).join('');

    host.className = 'bottom-nav';
    host.innerHTML = '<div class="bn-scroll">' + links + '</div>' +
      '<button class="bn-avatar" id="bn-avatar" aria-label="Account">' + avatarHtml() + '</button>';

    host.querySelector('#bn-avatar').onclick = openAccountSheet;
  }

  function avatarHtml() {
    var u = PH.auth.user() || {};
    if (u.profilePicture) return '<img src="' + PH.format.escape(u.profilePicture) + '" alt="">';
    var initials = (u.fullName || u.username || '?').trim().split(/\s+/).map(function (s) { return s[0]; }).slice(0, 2).join('').toUpperCase();
    return '<span class="bn-initials">' + PH.format.escape(initials) + '</span>';
  }

  function openAccountSheet() {
    var u = PH.auth.user() || {};
    var pages = PH.perm.navPages().map(function (it) { return '<a class="chip" href="' + it.meta.file + '">' + PH.icon(it.meta.icon, 16) + it.meta.title + '</a>'; }).join('');
    var pending = '';
    modal({
      title: u.fullName || u.username || 'Account',
      html: '<div class="account-sheet">' +
        '<div class="account-row"><span class="avatar-lg">' + avatarHtml() + '</span>' +
        '<div><strong>' + PH.format.escape(u.fullName || '') + '</strong><div class="muted">' + PH.format.escape(u.profession || '') +
        (PH.perm.isOwner() ? ' · Owner' : ' · Worker') + '</div></div></div>' +
        '<div class="chips">' + pages + '</div>' +
        (PH.sync ? '<div class="muted small" id="acct-sync">' + syncLine() + '</div>' : '') +
        '</div>',
      actions: [
        { label: 'Sign out', value: 'logout', class: 'btn-danger' },
        { label: 'Close', value: null, class: 'btn-ghost' }
      ]
    }).then(function (v) { if (v === 'logout') PH.auth.logout(); });
    return pending;
  }

  function syncLine() {
    var s = PH.sync.status();
    return s.online ? 'Online · auto-sync on' : 'Offline · changes will sync when you reconnect';
  }

  /* ------------------------------ home grid ------------------------------ */

  function renderHomeGrid() {
    var host = document.getElementById('ph-home-grid');
    if (!host) return;
    var cards = [];
    Object.keys(PH.config.PAGES).forEach(function (k) {
      var n = parseInt(k, 10);
      var meta = PH.config.PAGES[k];
      if (n === 1) return;
      if (!PH.perm.canViewPage(n)) return;
      cards.push('<a class="home-card" href="' + meta.file + '">' +
        '<span class="home-icon">' + PH.icon(meta.icon, 28) + '</span>' +
        '<span class="home-label">' + PH.format.escape(meta.title) + '</span></a>');
    });
    host.innerHTML = cards.join('') || '<p class="muted">You have not been granted access to any page yet. Ask the owner.</p>';
  }

  /* ------------------------------ offline banner ------------------------------ */

  function updateConnectivity() {
    var b = document.getElementById('ph-offline-banner');
    if (!b) return;
    if (navigator.onLine) { b.classList.remove('show'); }
    else { b.innerHTML = PH.icon('wifiOff', 16) + ' Offline — your changes are saved and will sync automatically'; b.classList.add('show'); }
  }

  PH.ui = {
    spinner: {
      show: function (text) { var s = ensureSpinner(); s.querySelector('.ph-loading-text').textContent = text || 'Loading…'; s.classList.add('show'); },
      hide: function () { if (spinnerEl) spinnerEl.classList.remove('show'); }
    },
    toast: toast,
    modal: modal,
    confirm: confirm,
    renderBottomNav: renderBottomNav,
    renderHomeGrid: renderHomeGrid,
    openAccountSheet: openAccountSheet,
    updateConnectivity: updateConnectivity,
    syncLine: syncLine
  };
})();
