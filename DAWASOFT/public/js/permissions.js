/**
 * permissions.js — client-side mirror of the server's rules.
 * The server ALWAYS re-checks; this only hides things the user cannot use.
 */
(function () {
  window.PH = window.PH || {};

  function u() { return PH.auth.user() || { pages: [], actions: [], role: 'worker' }; }

  PH.perm = {
    isOwner: function () { return u().role === 'owner'; },

    canViewPage: function (n) {
      if (PH.perm.isOwner()) return true;
      if (n === 9) return false;
      return (u().pages || []).indexOf(n) !== -1;
    },

    /** Server-side rule: no explicit actions configured => page grant is enough. */
    canDo: function (action) {
      if (PH.perm.isOwner()) return true;
      var list = u().actions || [];
      if (list.length === 0) return true;
      return list.indexOf(action) !== -1;
    },

    navPages: function () {
      var out = [];
      Object.keys(PH.config.PAGES).forEach(function (k) {
        var n = parseInt(k, 10);
        var meta = PH.config.PAGES[k];
        if (!meta.nav) return;
        if (PH.perm.canViewPage(n)) out.push({ n: n, meta: meta });
      });
      out.sort(function (a, b) { return a.n - b.n; });
      return out;
    },

    /** Guard a page: if the current user may not view `n`, bounce to home. */
    guardPage: function (n) {
      if (!PH.auth.isLoggedIn()) { window.location.href = 'index.html'; return false; }
      if (!PH.perm.canViewPage(n)) { window.location.href = 'home.html'; return false; }
      return true;
    }
  };
})();
