/**
 * api.js — the single client for the backend (through the Netlify gateway).
 *
 * Responsibilities (checklist): timeouts (AbortController), a uniform request envelope,
 * token handling, and the offline path — mutations made while offline are queued in the outbox
 * (local message queue) instead of being lost, and reads fall back to the IndexedDB cache.
 */
(function () {
  window.PH = window.PH || {};

  var MUTATING = ['createSale', 'addItem', 'removeItem', 'editItem', 'restockItem', 'editSale',
    'confirmSale', 'setPermissions', 'suspendUser'];
  var TIMEOUT_MS = 30000;

  function apiError(env, fallback) {
    var e = new Error((env && env.error && env.error.message) || fallback || 'Request failed');
    e.code = (env && env.error && env.error.code) || 'SERVER_ERROR';
    return e;
  }

  PH.api = {
    MUTATING: MUTATING,

    /** Returns the full response envelope. */
    raw: function (action, payload, opts) {
      opts = opts || {};
      var body = {
        action: action,
        token: opts.public ? null : PH.auth.token(),
        requestId: PH.format.uuid(),
        clientTime: new Date().toISOString(),
        appVersion: PH.config.APP_VERSION,
        payload: payload || {}
      };

      var controller = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);

      return fetch(PH.config.API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        clearTimeout(timer);
        return res.json().catch(function () {
          throw { code: 'SERVER_ERROR', message: 'Bad response from server (HTTP ' + res.status + ').' };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        if (err && err.code) throw err;
        if (err && err.name === 'AbortError') throw { code: 'UPSTREAM_TIMEOUT', message: 'The request timed out. It will retry.' };
        throw { code: 'NETWORK', message: 'You are offline. Changes are saved and will sync automatically.' };
      }).then(function (env) {
        if (env && !env.ok && env.error && env.error.code === 'UNAUTHORIZED' && !opts.public && !opts.silent) {
          PH.auth.clear();
          if (!/index\.html$/.test(window.location.pathname)) window.location.href = 'index.html';
        }
        return env;
      });
    },

    /**
     * Call an action. Resolves with `data`.
     * If it is a mutation and we are offline, it is queued and resolves with { _queued:true, opId }.
     */
    call: function (action, payload, opts) {
      opts = opts || {};
      var isMutation = MUTATING.indexOf(action) !== -1;

      if (isMutation && opts.queueIfOffline !== false && !navigator.onLine) {
        return PH.sync.enqueue(action, payload || {}).then(function (opId) {
          return { _queued: true, opId: opId, action: action };
        });
      }

      return PH.api.raw(action, payload, opts).then(function (env) {
        if (!env.ok) throw apiError(env);
        return env.data;
      });
    },

    /** Mutation helper: queues when offline, calls the API when online. */
    mutation: function (action, payload) {
      return PH.api.call(action, payload, { queueIfOffline: true });
    },

    /**
     * Read with caching: try the server, persist the result, and fall back to the cached copy
     * when offline (Caching + Cache fallback from the checklist).
     */
    withCache: function (cacheKey, action, payload) {
      return PH.api.call(action, payload).then(function (data) {
        PH.db.cachePut(cacheKey, data).catch(function () {});
        return data;
      }).catch(function (err) {
        return PH.db.cacheGet(cacheKey).then(function (cached) {
          if (cached) { cached._fromCache = true; return cached; }
          throw err;
        });
      });
    }
  };
})();
