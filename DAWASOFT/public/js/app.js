/**
 * app.js — page bootstrap shared by every screen.
 * Handles: theme, auth guard, header, bottom navigation, service worker, and the sync loop.
 *
 * A page calls:  PH.app.boot({ page: 3 }, function (user) { ...start the page... });
 */
(function () {
  window.PH = window.PH || {};

  var THEME_KEY = 'ph.theme';
  var FONT_KEY = 'ph.font';
  var BG_KEY = 'ph.bg';

  function applyTheme() {
    var theme = localStorage.getItem(THEME_KEY) || 'auto';
    var resolved = theme;
    if (theme === 'auto') {
      resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', theme);

    var font = localStorage.getItem(FONT_KEY) || 'system';
    document.documentElement.setAttribute('data-font', font);

    var bg = localStorage.getItem(BG_KEY) || 'default';
    document.documentElement.setAttribute('data-bg', bg);
  }

  function renderHeader() {
    var host = document.getElementById('ph-header');
    if (!host) return;
    var title = host.getAttribute('data-title') || document.title || '';
    var back = host.getAttribute('data-back') !== 'false';
    var right = '<button class="ph-sync-badge" id="ph-sync-badge" title="Sync status"></button>';
    host.innerHTML =
      (back ? '<button class="icon-btn" id="ph-back" aria-label="Back">' + PH.icon('back', 22) + '</button>' : '<span class="icon-btn ghost"></span>') +
      '<h1 class="ph-title">' + PH.format.escape(title) + '</h1>' +
      '<div class="ph-header-right">' + right + '</div>';
    var backBtn = document.getElementById('ph-back');
    if (backBtn) backBtn.onclick = function () { history.length > 1 ? history.back() : (window.location.href = 'home.html'); };
    updateSyncBadge();
  }

  function updateSyncBadge() {
    var b = document.getElementById('ph-sync-badge');
    if (!b) return;
    PH.sync.pending().then(function (n) {
      var online = navigator.onLine;
      b.className = 'ph-sync-badge' + (online ? ' online' : ' offline') + (n ? ' has-pending' : '');
      b.innerHTML = PH.icon(online ? 'refresh' : 'wifiOff', 16) + (n ? '<span class="badge-count">' + n + '</span>' : '');
      b.title = online ? (n ? n + ' change(s) waiting to sync' : 'All changes synced') : 'Offline';
    });
  }

  PH.app = {
    boot: function (opts, onReady) {
      opts = opts || {};
      applyTheme();

      if (opts.requireAuth !== false && !PH.auth.requireLogin()) return;

      renderHeader();
      PH.ui.renderBottomNav(opts.page);
      PH.ui.renderHomeGrid();
      PH.ui.updateConnectivity();

      window.addEventListener('online', PH.ui.updateConnectivity);
      window.addEventListener('offline', PH.ui.updateConnectivity);
      window.addEventListener('ph:sync-changed', updateSyncBadge);
      window.addEventListener('ph:synced', function () { updateSyncBadge(); if (opts.onSynced) opts.onSynced(); });

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(function () {});
        navigator.serviceWorker.addEventListener('message', function (e) {
          if (e.data && e.data.type === 'ph-flush') PH.sync.flush();
        });
      }

      if (opts.requireAuth !== false) PH.sync.start();

      if (onReady) onReady(PH.auth.user());
    },

    setTheme: function (theme) { localStorage.setItem(THEME_KEY, theme); applyTheme(); },
    setFont: function (font) { localStorage.setItem(FONT_KEY, font); applyTheme(); },
    setBg: function (bg) { localStorage.setItem(BG_KEY, bg); applyTheme(); },
    getTheme: function () { return localStorage.getItem(THEME_KEY) || 'auto'; },
    getFont: function () { return localStorage.getItem(FONT_KEY) || 'system'; },
    getBg: function () { return localStorage.getItem(BG_KEY) || 'default'; },
    refreshShell: function (page) { renderHeader(); PH.ui.renderBottomNav(page); PH.ui.updateConnectivity(); }
  };
})();
