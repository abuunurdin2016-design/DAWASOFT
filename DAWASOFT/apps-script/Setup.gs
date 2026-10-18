/**
 * Setup.gs — one-time bootstrap.
 *
 * Run `setupSystem()` once from the Apps Script editor (it is idempotent).
 * It creates every sheet + header, seeds the owner account and the signing secret.
 */

function setupSystem() {
  ensureSheets();
  ensureSecret();
  ensureOwner();
  ensureSettings();
  return {
    ok: true,
    message: 'Setup complete. Sheets created, owner seeded, secret generated.',
    sheets: Object.keys(SCHEMA),
    ownerHint: 'Default owner login -> username: owner  password: owner123 (change it immediately).'
  };
}

function ensureSheets() {
  for (var name in SCHEMA) {
    var sh = getSheet(name);
    var headers = SCHEMA[name];
    var existing = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    var needHeader = false;
    for (var i = 0; i < headers.length; i++) if (existing[i] !== headers[i]) { needHeader = true; break; }
    if (needHeader) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
  }
}

function ensureSecret() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN_SECRET')) {
    props.setProperty('TOKEN_SECRET', uuid() + uuid());
  }
}

function ensureOwner() {
  var existing = readObjects('Users');
  if (existing.length > 0) return;
  var salt = randomBytesB64(16);
  var now = nowIso();
  var owner = {
    userId: 1, fullName: 'System Owner', dob: '', email: '', username: 'owner',
    passwordHash: hashPassword('owner123', salt), passwordSalt: salt,
    profession: 'Administrator', profilePicture: '', status: 'active',
    pages: JSON.stringify(ALL_PAGES), actions: JSON.stringify(ALL_ACTIONS),
    createdAt: now, updatedAt: now, lastLogin: '', mustChangePassword: 'TRUE'
  };
  appendObject('Users', unpick(FIELDS.users, owner));
}

function ensureSettings() {
  var defaults = {
    SHOP_NAME: 'Pharmacy',
    CURRENCY: 'TZS',
    EXPIRY_WARNING_MONTHS: '6',
    LOW_STOCK_ALERT: 'TRUE',
    RECEIPTS_ENABLED: 'TRUE'
  };
  var rows = readObjects('Settings');
  var have = {};
  for (var i = 0; i < rows.length; i++) have[rows[i]['Key']] = true;
  for (var k in defaults) {
    if (!have[k]) appendObject('Settings', unpick(FIELDS.settings, { key: k, value: defaults[k] }));
  }
}

/**
 * Prune housekeeping data. Wire this to a time-driven trigger (daily)
 * — this is the "Cron Jobs" item from the checklist.
 */
function dailyMaintenance() {
  pruneIdempotency(7);
  pruneSessions();
  pruneDLQ(30);
  refreshAlertCache();
}

function pruneIdempotency(daysOld) {
  var sh = getSheet('Idempotency');
  var rows = readObjects('Idempotency');
  var cutoff = Date.now() - daysOld * 86400000;
  for (var i = rows.length - 1; i >= 0; i--) {
    var t = parseDate(rows[i]['Created At']);
    if (t && t.getTime() < cutoff) sh.deleteRow(rows[i].__row);
  }
}

function pruneSessions() {
  var sh = getSheet('Sessions');
  var rows = readObjects('Sessions');
  var now = Date.now();
  for (var i = rows.length - 1; i >= 0; i--) {
    var t = parseDate(rows[i]['Expires At']);
    if (t && t.getTime() < now) sh.deleteRow(rows[i].__row);
  }
}

function pruneDLQ(daysOld) {
  var sh = getSheet('Sync DLQ');
  var rows = readObjects('Sync DLQ');
  var cutoff = Date.now() - daysOld * 86400000;
  for (var i = rows.length - 1; i >= 0; i--) {
    var t = parseDate(rows[i]['Timestamp']);
    if (t && t.getTime() < cutoff) sh.deleteRow(rows[i].__row);
  }
}

/** Placeholder so the cron trigger can warm the alerts cache as well. */
function refreshAlertCache() {
  try { computeAlerts(); } catch (e) { /* ignore during bootstrap */ }
}
