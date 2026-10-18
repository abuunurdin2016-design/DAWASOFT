/**
 * Idempotency.gs — guarantees a replayed operation (offline sync, retries) is applied once only.
 *
 * Two layers:
 *  1. CacheService (fast, 6h TTL)
 *  2. Idempotency sheet (durable, pruned daily)
 */

var IDEMPOTENCY_TTL_SECONDS = 21600; // 6 hours

function idempotencyGet(key) {
  if (!key) return null;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('idem:' + key);
  if (cached) return parseJson(cached, null);

  var rows = readObjects('Idempotency');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i]['Key'] === key) {
      var resp = parseJson(rows[i]['Response'], null);
      if (resp) cache.put('idem:' + key, JSON.stringify(resp), IDEMPOTENCY_TTL_SECONDS);
      return resp;
    }
  }
  return null;
}

function idempotencyPut(key, userId, action, response) {
  if (!key) return;
  try {
    CacheService.getScriptCache().put('idem:' + key, JSON.stringify(response), IDEMPOTENCY_TTL_SECONDS);
    appendObject('Idempotency', unpick(FIELDS.idempotency, {
      key: key, userId: userId || '', action: action || '',
      response: JSON.stringify(response), createdAt: nowIso()
    }));
  } catch (e) {
    Logger.log('idempotency put failed: ' + e);
  }
}
