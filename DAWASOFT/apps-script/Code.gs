/**
 * Code.gs — the single HTTP entry point (router).
 *
 *  doPost  : every API call
 *  doGet   : health check only (handy for uptime pings / the gateway)
 *
 * Checklist mapping: API gateway pattern (this is the origin behind the Netlify gateway),
 * pessimistic locking (LockService) around writes, idempotency for replayed mutations,
 * uniform error envelope, audit of every request outcome.
 */

var PUBLIC_ACTIONS = ['signup', 'login', 'forgotPassword', 'health', 'version'];
var MUTATING_ACTIONS = ['createSale', 'addItem', 'removeItem', 'editItem', 'restockItem', 'editSale', 'confirmSale', 'setPermissions', 'suspendUser', 'approveUser', 'rejectUser'];
var PERMANENT_ERROR_CODES = ['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BAD_REQUEST'];

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'health';
  if (action === 'health') return jsonOut(ok('health', { status: 'ok', service: 'pharmacy-api' }));
  return jsonOut(fail(action, 'BAD_REQUEST', 'Use POST for this action.'));
}

function doPost(e) {
  var body = parseBody(e);
  var action = body.action || '';
  var requestId = body.requestId || '';
  var payload = body.payload || {};

  try {
    if (!action) throw appError('BAD_REQUEST', 'Missing action.');

    if (PUBLIC_ACTIONS.indexOf(action) !== -1) {
      return jsonOut(dispatchPublic(action, payload, requestId));
    }

    var authInfo = requireAuth(body.token);
    var user = authInfo.user;

    var cached = (requestId && MUTATING_ACTIONS.indexOf(action) !== -1) ? idempotencyGet(requestId) : null;
    if (cached) return jsonOut(cached);

    var response = withLock(function () {
      guard(action, user);
      return dispatchProtected(action, user, payload, authInfo.session, requestId);
    });

    if (requestId && MUTATING_ACTIONS.indexOf(action) !== -1) idempotencyPut(requestId, user.id, action, response);
    return jsonOut(response);
  } catch (err) {
    var code = err && err.code ? err.code : 'SERVER_ERROR';
    var msg = err && err.message ? err.message : String(err);
    try { writeAudit(null, action || 'unknown', 'Request', requestId, 'error', { code: code, message: msg }); } catch (e2) {}
    return jsonOut(fail(action, code, msg, requestId));
  }
}

/* ----------------------------- dispatch ----------------------------- */

function dispatchPublic(action, payload, requestId) {
  switch (action) {
    case 'health': return ok('health', { status: 'ok', service: 'pharmacy-api', sheets: Object.keys(SCHEMA) }, requestId);
    case 'version': return ok('version', { version: APP_VERSION }, requestId);
    case 'signup': return ok('signup', handleSignup(payload), requestId);
    case 'login': return ok('login', handleLogin(payload), requestId);
    case 'forgotPassword': return ok('forgotPassword', handleForgotPassword(payload), requestId);
  }
  throw appError('BAD_REQUEST', 'Unknown action: ' + action);
}

function dispatchProtected(action, user, payload, session, requestId) {
  switch (action) {
    /* auth */
    case 'refreshToken': return ok('refreshToken', handleRefreshToken(session), requestId);
    case 'logout': return ok('logout', handleLogout(session), requestId);
    case 'changePassword': return ok('changePassword', handleChangePassword(user, payload), requestId);

    /* users */
    case 'listUsers': return ok('listUsers', handleListUsers(), requestId);
    case 'getUser': return ok('getUser', handleGetUser(payload), requestId);
    case 'setPermissions': return ok('setPermissions', handleSetPermissions(user, payload), requestId);
    case 'suspendUser': return ok('suspendUser', handleSuspendUser(user, payload), requestId);
    case 'approveUser': return ok('approveUser', handleApproveUser(user, payload), requestId);
    case 'rejectUser': return ok('rejectUser', handleRejectUser(user, payload), requestId);

    /* inventory */
    case 'listInventory': return ok('listInventory', handleListInventory(payload), requestId);
    case 'getItem': return ok('getItem', handleGetItem(payload), requestId);
    case 'addItem': return ok('addItem', handleAddItem(user, payload), requestId);
    case 'removeItem': return ok('removeItem', handleRemoveItem(user, payload), requestId);
    case 'editItem': return ok('editItem', handleEditItem(user, payload), requestId);
    case 'restockItem': return ok('restockItem', handleRestockItem(user, payload), requestId);
    case 'listRestockHistory': return ok('listRestockHistory', handleListRestockHistory(payload), requestId);

    /* sales */
    case 'createSale': return ok('createSale', handleCreateSale(user, payload), requestId);
    case 'listSales': return ok('listSales', handleListSales(payload), requestId);
    case 'getSale': return ok('getSale', handleGetSale(payload), requestId);
    case 'editSale': return ok('editSale', handleEditSale(user, payload), requestId);
    case 'confirmSale': return ok('confirmSale', handleConfirmSale(user, payload), requestId);

    /* assistant */
    case 'searchItems': return ok('searchItems', handleSearchItems(payload), requestId);
    case 'searchByUse': return ok('searchByUse', handleSearchByUse(payload), requestId);

    /* reports */
    case 'dashboard': return ok('dashboard', handleDashboard(payload), requestId);
    case 'dailyReport': return ok('dailyReport', handleDailyReport(payload), requestId);
    case 'weeklyReport': return ok('weeklyReport', handleWeeklyReport(payload), requestId);
    case 'monthlyReport': return ok('monthlyReport', handleMonthlyReport(payload), requestId);
    case 'annualReport': return ok('annualReport', handleAnnualReport(payload), requestId);

    /* alerts */
    case 'listAlerts': return ok('listAlerts', handleListAlerts(), requestId);
    case 'listDLQ': return ok('listDLQ', handleListDLQ(), requestId);

    /* offline sync */
    case 'syncBatch': return ok('syncBatch', handleSyncBatch(user, payload, session), requestId);
  }
  throw appError('BAD_REQUEST', 'Unknown action: ' + action);
}

/** Route-level permission guard (page + action key). */
function guard(action, user) {
  switch (action) {
    case 'listUsers': case 'getUser': case 'setPermissions': case 'suspendUser': case 'approveUser': case 'rejectUser':
      requireAccess(user, 9, 'users.manage'); break;
    case 'addItem': requireAccess(user, 5, 'inventory.add'); break;
    case 'removeItem': requireAccess(user, 5, 'inventory.remove'); break;
    case 'editItem': requireAccess(user, 5, 'inventory.edit'); break;
    case 'restockItem': requireAccess(user, 5, 'inventory.restock'); break;
    case 'listRestockHistory': requireAnyPage(user, [5, 6, 10]); break;
    case 'listInventory': case 'getItem': requireAnyPage(user, [3, 4, 5, 6, 10]); break;
    case 'createSale': requireAccess(user, 3, 'sales.create'); break;
    case 'listSales': case 'getSale': requireAnyPage(user, [3, 10]); break;
    case 'editSale': requireAccess(user, 10, 'sales.edit'); break;
    case 'confirmSale': requireAccess(user, 10, 'sales.confirm'); break;
    case 'searchItems': case 'searchByUse': requireAccess(user, 4, 'assistant.search'); break;
    case 'dashboard': case 'dailyReport': case 'weeklyReport': case 'monthlyReport': case 'annualReport':
      requireAccess(user, 7, 'reports.view'); break;
    case 'listAlerts': requireAccess(user, 6, 'alerts.view'); break;
    case 'listDLQ': requireAnyPage(user, [6]); break;
    case 'changePassword': case 'refreshToken': case 'logout': break; // any authenticated user
    case 'syncBatch': break; // inner operations are guarded individually
    default: break;
  }
}

/* ----------------------------- offline sync ----------------------------- */

/** Replays queued offline operations. Each op is idempotent by its opId. */
function handleSyncBatch(user, payload) {
  var ops = payload.operations || [];
  var results = [];
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    var opId = op.opId || '';
    try {
      var cached = opId ? idempotencyGet(opId) : null;
      if (cached) { results.push({ opId: opId, ok: true, data: cached.data, replayed: true }); continue; }

      var resp = withLock(function () {
        guard(op.action, user);
        return dispatchProtected(op.action, user, op.payload || {}, null, opId);
      });
      if (opId && MUTATING_ACTIONS.indexOf(op.action) !== -1) idempotencyPut(opId, user.id, op.action, resp);
      results.push({ opId: opId, ok: true, data: resp.data });
    } catch (err) {
      var code = err && err.code ? err.code : 'SERVER_ERROR';
      // Only PERMANENT failures go to the dead-letter queue (transient ones are retried by the client).
      if (PERMANENT_ERROR_CODES.indexOf(code) !== -1) {
        try {
          appendObject('Sync DLQ', unpick(FIELDS.dlq, {
            timestamp: nowIso(), userId: user.id, operation: JSON.stringify(op),
            attempts: 1, lastError: code + ': ' + (err.message || err)
          }));
        } catch (e2) {}
      }
      results.push({ opId: opId, ok: false, error: { code: code, message: err.message || String(err) } });
    }
  }
  return { results: results };
}

/* ----------------------------- helpers ----------------------------- */

function parseBody(e) {
  var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
  if (raw) { try { return JSON.parse(raw); } catch (err) { /* fall through */ } }
  if (e && e.parameter) {
    var p = {};
    for (var k in e.parameter) p[k] = e.parameter[k];
    if (p.payload) { try { p.payload = JSON.parse(p.payload); } catch (e2) { p.payload = {}; } }
    return p;
  }
  return {};
}

/** Pessimistic lock for write paths; degrades gracefully to a best-effort run on timeout. */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(15000); } catch (e) { locked = false; }
  try {
    return fn();
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (e2) {} }
  }
}
