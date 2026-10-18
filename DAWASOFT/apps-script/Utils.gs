/**
 * Utils.gs — constants, schema, and generic helpers.
 * Shared by every other backend file (Apps Script files share one global scope).
 *
 * Design notes (mapped to the 111 engineering checklist):
 *  - "Indexing / query optimization": all reads go through readObjects() which loads a
 *    sheet ONCE and returns plain objects, so handlers never do per-row range reads (no N+1).
 *  - "Clock skew": the server is the source of truth for time (nowIso()); client time is a hint only.
 */

var APP_VERSION = '1.0.0';
var SESSION_TTL_HOURS = 12;
var MAX_LOGIN_ATTEMPTS = 5;

/** Logical field-name -> Google Sheet header. The sheet stays human friendly (brief's names). */
var FIELDS = {
  inventory: {
    itemId: 'Item ID', itemName: 'Item name', description: 'Description', category: 'Category',
    uom: 'UOM', buyingPrice: 'Buying Price', rate: 'Rate', currentStock: 'Current Stock',
    reorderLevel: 'Reorder Level', expiryDate: 'Expiry Date', dosage: 'Dosage',
    contraindications: 'Contraindications', lastUpdateDate: 'Last Update Date', lastUpdater: 'Last Updater'
  },
  users: {
    userId: 'User ID', fullName: 'Full name', dob: 'DOB', email: 'Email', username: 'Username',
    passwordHash: 'Password Hash', passwordSalt: 'Password Salt', profession: 'Profession',
    profilePicture: 'Profile Picture', status: 'Status', pages: 'Pages', actions: 'Actions',
    createdAt: 'Created At', updatedAt: 'Updated At', lastLogin: 'Last Login',
    mustChangePassword: 'Must Change Password'
  },
  audit: {
    timestamp: 'Timestamp', actorId: 'Actor ID', actorUsername: 'Actor Username', action: 'Action',
    entity: 'Entity', entityId: 'Entity ID', result: 'Result', details: 'Details'
  },
  restock: {
    timestamp: 'Timestamp', itemId: 'Item ID', item: 'Item', quantityAdded: 'Quantity Added',
    resultantQuantity: 'Resultant Quantity', buyingPricePerUom: 'Buying Price Per UOM', updater: 'Updater'
  },
  sales: {
    timestamp: 'Timestamp', saleId: 'Sale ID', itemName: 'Item Name', quantitySold: 'Quantity sold',
    sellingPrice: 'Selling price', buyingPrice: 'Buying Price', paymentMode: 'Mode of payment',
    profit: 'Profit of Sale', dispenser: 'Dispenser', clientName: 'Client Name', status: 'Status'
  },
  sessions: { token: 'Token', userId: 'User ID', username: 'Username', issuedAt: 'Issued At', expiresAt: 'Expires At' },
  idempotency: { key: 'Key', userId: 'User ID', action: 'Action', response: 'Response', createdAt: 'Created At' },
  dlq: { timestamp: 'Timestamp', userId: 'User ID', operation: 'Operation', attempts: 'Attempts', lastError: 'Last Error' },
  settings: { key: 'Key', value: 'Value' }
};

/** Sheet name -> header row. Used by Setup.gs and by the generic reader/writer. */
var SCHEMA = {
  'Inventory': headerList(FIELDS.inventory),
  'Users': headerList(FIELDS.users),
  'Audit Log': headerList(FIELDS.audit),
  'Item Restock History': headerList(FIELDS.restock),
  'Sales History': headerList(FIELDS.sales),
  'Sessions': headerList(FIELDS.sessions),
  'Idempotency': headerList(FIELDS.idempotency),
  'Sync DLQ': headerList(FIELDS.dlq),
  'Settings': headerList(FIELDS.settings)
};

var PROFESSIONS = ['Superintendent', 'Dispenser', 'Manager', 'Storekeeper', 'Accountant', 'Administrator'];

/** Every page a permission can point to (1..10). Page 9 is owner-only. */
var ALL_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
var OWNER_ONLY_PAGES = [9];

/** Fine-grained action permissions. */
var ALL_ACTIONS = [
  'assistant.search',
  'sales.create', 'sales.edit', 'sales.confirm',
  'inventory.restock', 'inventory.add', 'inventory.remove', 'inventory.edit',
  'alerts.view', 'reports.view', 'settings.manage', 'users.manage'
];

function headerList(fieldMap) {
  var out = [];
  for (var k in fieldMap) out.push(fieldMap[k]);
  return out;
}

/* ------------------------------------------------------------------ *
 * Spreadsheet access                                                  *
 * ------------------------------------------------------------------ */

/**
 * Resolves the spreadsheet.
 *
 * NOTE: read SPREADSHEET_ID straight from Script Properties — never via getSetting(), which falls
 * back to reading the Settings sheet and would recurse (getSetting -> readObjects -> getSheet ->
 * getSpreadsheet -> getSetting ...).
 */
function getSpreadsheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet found. Bind this script to your sheet or set SPREADSHEET_ID.');
  return ss;
}

function getSheet(name) {
  var ss = getSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    var headers = SCHEMA[name];
    if (headers) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

/* ------------------------------------------------------------------ *
 * Generic read / write (single read per sheet => no N+1)              *
 * ------------------------------------------------------------------ */

/** Returns an array of objects keyed by the sheet's header names, plus __row. */
function readObjects(sheetName) {
  var sh = getSheet(sheetName);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var empty = true;
    for (var c = 0; c < row.length; c++) { if (row[c] !== '' && row[c] !== null) { empty = false; break; } }
    if (empty) continue;
    var o = {};
    for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i];
    o.__row = r + 1;
    out.push(o);
  }
  return out;
}

/** Append a header-keyed object. */
function appendObject(sheetName, headerKeyedObj) {
  var sh = getSheet(sheetName);
  var headers = SCHEMA[sheetName];
  sh.appendRow(buildRow(headers, headerKeyedObj));
}

/** Overwrite a single row (1-based) with a header-keyed object. */
function writeRow(sheetName, rowNumber, headerKeyedObj) {
  var sh = getSheet(sheetName);
  var headers = SCHEMA[sheetName];
  sh.getRange(rowNumber, 1, 1, headers.length).setValues([buildRow(headers, headerKeyedObj)]);
}

/** Delete a row (1-based). */
function deleteRow(sheetName, rowNumber) {
  getSheet(sheetName).deleteRow(rowNumber);
}

function buildRow(headers, obj) {
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var v = obj[headers[i]];
    row.push(v === undefined || v === null ? '' : v);
  }
  return row;
}

/** Convert a logical-name object to a header-keyed object. */
function unpick(fieldMap, obj) {
  var hk = {};
  for (var logical in fieldMap) hk[fieldMap[logical]] = obj[logical];
  return hk;
}

/** Convert a header-keyed row to a logical-name object. */
function pick(fieldMap, row) {
  var o = {};
  for (var logical in fieldMap) o[logical] = row[fieldMap[logical]];
  return o;
}

/* ------------------------------------------------------------------ *
 * Responses                                                           *
 * ------------------------------------------------------------------ */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok(action, data, requestId) {
  return { ok: true, action: action, requestId: requestId || '', data: data === undefined ? null : data,
    error: null, serverTime: nowIso(), version: APP_VERSION };
}

function fail(action, code, message, requestId) {
  return { ok: false, action: action, requestId: requestId || '', data: null,
    error: { code: code, message: message }, serverTime: nowIso(), version: APP_VERSION };
}

function appError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ *
 * Time / numbers / strings                                            *
 * ------------------------------------------------------------------ */

function nowIso() { return new Date().toISOString(); }

function toIsoDate(d) {
  var dt = (d instanceof Date) ? d : new Date(d);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function toIsoDateTime(d) {
  var dt = (d instanceof Date) ? d : new Date(d);
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

/** Whole-ish month difference (expiry banding). */
function monthsUntil(target, from) {
  var t = parseDate(target); if (!t) return null;
  var f = parseDate(from) || new Date();
  var months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
  if (t.getDate() < f.getDate()) months -= 1;
  return months;
}

function uuid() { return Utilities.getUuid(); }

function randomBytesB64(len) {
  var arr = [];
  for (var i = 0; i < len; i++) arr.push(Math.floor(Math.random() * 256));
  return Utilities.base64EncodeWebSafe(arr).replace(/=+$/, '');
}

function bytesToHex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) { var h = (bytes[i] & 0xff).toString(16); s += (h.length === 1 ? '0' : '') + h; }
  return s;
}

function sha256Hex(str) { return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str)); }

function hmacB64Url(value, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret)).replace(/=+$/, '');
}

function hashPassword(password, salt) {
  // Iterated hashing to slow brute force (Apps Script has no bcrypt).
  var h = sha256Hex(salt + ':' + password);
  for (var i = 0; i < 500; i++) h = sha256Hex(h + ':' + salt);
  return h;
}

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Settings (sheet-backed key/value)                                   *
 * ------------------------------------------------------------------ */

function getSetting(key, fallback) {
  var props = PropertiesService.getScriptProperties();
  var pv = props.getProperty(key);
  if (pv !== null && pv !== undefined && pv !== '') return pv;
  try {
    var rows = readObjects('Settings');
    for (var i = 0; i < rows.length; i++) if (rows[i]['Key'] === key) return rows[i]['Value'];
  } catch (e) { /* sheet may not exist yet during bootstrap */ }
  return fallback;
}

function setSetting(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/* ------------------------------------------------------------------ *
 * Standardised item / sale serializers                                *
 * ------------------------------------------------------------------ */

function itemToApi(row) {
  var i = pick(FIELDS.inventory, row);
  return {
    itemId: i.itemId, itemName: i.itemName, description: i.description, category: i.category,
    uom: i.uom, buyingPrice: num(i.buyingPrice), rate: num(i.rate), currentStock: num(i.currentStock),
    reorderLevel: num(i.reorderLevel), expiryDate: i.expiryDate ? toIsoDate(i.expiryDate) : '',
    dosage: i.dosage, contraindications: i.contraindications,
    lastUpdateDate: i.lastUpdateDate, lastUpdater: i.lastUpdater
  };
}

function assistantItemToApi(row) {
  var i = pick(FIELDS.inventory, row);
  return {
    itemId: i.itemId, itemName: i.itemName, description: i.description, category: i.category,
    uom: i.uom, rate: num(i.rate), dosage: i.dosage, contraindications: i.contraindications
  };
}

function userToApi(row) {
  var u = pick(FIELDS.users, row);
  return {
    id: u.userId, fullName: u.fullName, dob: u.dob ? toIsoDate(u.dob) : '', email: u.email,
    username: u.username, profession: u.profession, profilePicture: u.profilePicture,
    // A pending administrator holds no owner power until the first administrator approves the request.
    status: u.status,
    role: num(u.userId) === 1 || (u.profession === 'Administrator' && String(u.status) !== 'pending') ? 'owner' : 'worker',
    pages: parseJson(u.pages, []), actions: parseJson(u.actions, []),
    createdAt: u.createdAt, lastLogin: u.lastLogin
  };
}

function parseJson(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
