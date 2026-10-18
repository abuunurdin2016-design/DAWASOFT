/**
 * db.js — tiny IndexedDB wrapper (Promise based).
 *
 * Stores:
 *   cache  : last-known server data (inventory, items) so pages work offline & fast  [Caching]
 *   outbox : queued writes waiting to sync (the local message queue)                 [Queue]
 *   dlq    : writes that permanently failed (dead-letter queue)                      [DLQ]
 */
(function () {
  window.PH = window.PH || {};
  var DB_NAME = 'pharmacy-db';
  var DB_VERSION = 1;
  var STORES = ['cache', 'outbox', 'dlq'];
  var _dbp = null;

  function open() {
    if (_dbp) return _dbp;
    _dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            var store = db.createObjectStore(s, { keyPath: s === 'outbox' ? 'opId' : 'k' });
            if (s === 'outbox') store.createIndex('status', 'status', { unique: false });
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var os = t.objectStore(store);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  PH.db = {
    get: function (store, key) { return tx(store, 'readonly', function (os) { return os.get(key); }); },
    put: function (store, value) { return tx(store, 'readwrite', function (os) { return os.put(value); }); },
    del: function (store, key) { return tx(store, 'readwrite', function (os) { return os.delete(key); }); },
    all: function (store) { return tx(store, 'readonly', function (os) { return os.getAll(); }); },
    clear: function (store) { return tx(store, 'readwrite', function (os) { return os.clear(); }); },
    count: function (store) { return tx(store, 'readonly', function (os) { return os.count(); }); },

    /** Convenience: cache a named value under store 'cache'. */
    cacheGet: function (key) {
      return PH.db.get('cache', key).then(function (r) { return r ? r.v : null; });
    },
    cachePut: function (key, value) {
      return PH.db.put('cache', { k: key, v: value, at: Date.now() });
    }
  };
})();
