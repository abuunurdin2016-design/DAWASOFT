/**
 * sync.js — the offline outbox (local message queue) and its sync engine.
 *
 * Flow:
 *   mutation while offline -> enqueue() -> IndexedDB 'outbox'
 *   background loop / online event -> flush() -> POST syncBatch (one round-trip)
 *   - success           -> remove from outbox
 *   - transient failure -> keep, retry with backoff (bounded)
 *   - permanent failure -> move to server dead-letter queue (Alerts page) and drop locally
 */
(function () {
  window.PH = window.PH || {};

  var PERMANENT = ['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BAD_REQUEST', 'UNAUTHORIZED'];
  var flushing = null;
  var lastSyncAt = 0;

  function emit(name) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: PH.sync.status() })); } catch (e) {}
  }

  PH.sync = {
    enqueue: function (action, payload) {
      var op = {
        opId: PH.format.uuid(),
        action: action,
        payload: payload || {},
        status: 'pending',
        attempts: 0,
        createdAt: Date.now(),
        lastError: ''
      };
      return PH.db.put('outbox', op).then(function () {
        emit('ph:sync-changed');
        PH.sync.requestBackgroundSync();
        if (navigator.onLine) PH.sync.flush();
        return op.opId;
      });
    },

    pending: function () {
      return PH.db.all('outbox').then(function (ops) {
        return ops.filter(function (o) { return o.status === 'pending' || o.status === 'failed'; }).length;
      });
    },

    /** Flush queued operations in one batch. Safe to call often. */
    flush: function () {
      if (flushing) return flushing;
      if (!navigator.onLine) return Promise.resolve({ sent: 0, failed: 0, offline: true });

      flushing = PH.db.all('outbox').then(function (ops) {
        var queue = ops.filter(function (o) { return o.status === 'pending' || o.status === 'failed'; });
        if (!queue.length) return { sent: 0, failed: 0 };
        if (!PH.auth.isLoggedIn()) return { sent: 0, failed: 0, noAuth: true };

        var batch = queue.slice(0, 20).map(function (o) {
          return { opId: o.opId, action: o.action, payload: o.payload, clientTime: new Date(o.createdAt).toISOString() };
        });

        return PH.api.raw('syncBatch', { operations: batch }).then(function (env) {
          if (!env.ok) return { sent: 0, failed: 0, error: env.error };
          var results = (env.data && env.data.results) || [];
          var sent = 0, failed = 0;
          var jobs = results.map(function (r) {
            if (r.ok) { sent++; return PH.db.del('outbox', r.opId); }
            var op = queue.filter(function (o) { return o.opId === r.opId; })[0] || { attempts: 0 };
            var code = r.error && r.error.code;
            if (PERMANENT.indexOf(code) !== -1 || (op.attempts || 0) + 1 >= PH.config.MAX_SYNC_ATTEMPTS) {
              failed++;
              return PH.db.del('outbox', r.opId);
            }
            // transient -> keep for the next round
            op.attempts = (op.attempts || 0) + 1;
            op.status = 'failed';
            op.lastError = (r.error && r.error.message) || 'unknown';
            return PH.db.put('outbox', op);
          });
          return Promise.all(jobs).then(function () {
            lastSyncAt = Date.now();
            emit('ph:sync-changed');
            emit('ph:synced');
            return { sent: sent, failed: failed };
          });
        }).catch(function (err) {
          return { sent: 0, failed: 0, error: err && err.message };
        });
      }).then(function (res) { flushing = null; return res; }, function (e) { flushing = null; throw e; });

      return flushing;
    },

    status: function () {
      return { online: navigator.onLine, lastSyncAt: lastSyncAt };
    },

    requestBackgroundSync: function () {
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(function (reg) {
          return reg.sync.register('ph-sync').catch(function () {});
        }).catch(function () {});
      }
    },

    /** Start the background loop. Call once per page. */
    start: function () {
      window.addEventListener('online', function () { emit('ph:sync-changed'); PH.sync.flush(); });
      window.addEventListener('offline', function () { emit('ph:sync-changed'); });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') PH.sync.flush();
      });
      setInterval(function () { PH.sync.flush(); }, PH.config.SYNC_INTERVAL_MS);
      PH.sync.flush();
      PH.sync.pending().then(function (n) { emit('ph:sync-changed'); });
    }
  };
})();
