/**
 * auth.js — session handling on the client.
 * The session ({token, expiresAt, user}) is kept in localStorage.
 */
(function () {
  window.PH = window.PH || {};

  function read() {
    try { return JSON.parse(localStorage.getItem(PH.config.SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }

  PH.auth = {
    getSession: read,

    user: function () { var s = read(); return s ? s.user : null; },

    token: function () { var s = read(); return s ? s.token : null; },

    isLoggedIn: function () {
      var s = read();
      return !!(s && s.token && (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now()));
    },

    save: function (token, expiresAt, user) {
      localStorage.setItem(PH.config.SESSION_KEY, JSON.stringify({ token: token, expiresAt: expiresAt, user: user }));
    },

    updateUser: function (user) {
      var s = read();
      if (!s) return;
      s.user = user;
      localStorage.setItem(PH.config.SESSION_KEY, JSON.stringify(s));
    },

    clear: function () {
      localStorage.removeItem(PH.config.SESSION_KEY);
    },

    /** Promise -> user. Throws on bad credentials. */
    login: function (identifier, password) {
      return PH.api.call('login', { identifier: identifier, password: password }, { public: true })
        .then(function (data) {
          PH.auth.save(data.token, data.expiresAt, data.user);
          return data;
        });
    },

    logout: function () {
      var done = PH.auth.isLoggedIn()
        ? PH.api.call('logout', {}, { silent: true }).catch(function () { return null; })
        : Promise.resolve(null);
      return done.then(function () {
        PH.auth.clear();
        window.location.href = 'index.html';
      });
    },

    /** Redirect to login if there is no valid session. Returns the user otherwise. */
    requireLogin: function () {
      if (!PH.auth.isLoggedIn()) {
        window.location.href = 'index.html';
        return null;
      }
      return PH.auth.user();
    }
  };
})();
