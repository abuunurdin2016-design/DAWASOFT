'use strict';

/**
 * test support — loads the Google Apps Script sources into a Node `vm` sandbox together with a
 * minimal in-memory emulation of the Google services they use (SpreadsheetApp, CacheService,
 * PropertiesService, Utilities, LockService…). That lets us unit-test the real backend logic
 * (report aggregation, expiry banding, permissions, idempotency, sale maths) without Google.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const GS_DIR = path.join(__dirname, '..', '..', 'apps-script');

// Utils first: it declares the constants/schema the others rely on.
const FILES = [
  'Utils.gs', 'Audit.gs', 'Idempotency.gs', 'Auth.gs', 'Users.gs',
  'Sales.gs', 'Reports.gs', 'Alerts.gs'
];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/**
 * Emulates Utilities.formatDate for the patterns Utils.gs uses.
 * It formats in the process' LOCAL time zone and the sandbox reports that same zone via
 * Session.getScriptTimeZone(). The backend mixes Date's local-time methods (getDay, setHours…)
 * with formatDate, so the two must agree — exactly as they do in real Apps Script, whose script
 * time zone is set to the pharmacy's local zone.
 */
function formatDate(date, tz, pattern) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return 'Invalid Date';
  const map = {
    yyyy: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    dd: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds())
  };
  // SimpleDateFormat semantics: text between single quotes is literal and the quotes are dropped,
  // while '' means one literal quote. (e.g. "yyyy-MM-dd'T'HH:mm:ss" -> "2026-10-18T22:15:30".)
  let out = '';
  let literal = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i++; continue; }
      literal = !literal;
      continue;
    }
    if (literal) { out += ch; continue; }
    const four = pattern.slice(i, i + 4);
    const two = pattern.slice(i, i + 2);
    if (map[four] !== undefined) { out += map[four]; i += 3; }
    else if (map[two] !== undefined) { out += map[two]; i += 1; }
    else out += ch;
  }
  return out;
}

/** A very small spreadsheet emulation: sheet name -> array of rows (row 0 = headers). */
function makeFakeSpreadsheet() {
  const sheets = {};

  function sheetHandle(name) {
    const data = sheets[name] || (sheets[name] = []);
    return {
      getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
      appendRow: (row) => { data.push(row.slice()); },
      deleteRow: (n) => { data.splice(n - 1, 1); },
      getRange: (r, c, nr, nc) => ({
        setValues: (vals) => {
          for (let i = 0; i < nr; i++) {
            const ri = r - 1 + i;
            if (!data[ri]) data[ri] = [];
            for (let j = 0; j < nc; j++) data[ri][c - 1 + j] = vals[i][j];
          }
          return { setFontWeight: () => ({}) };
        },
        setFontWeight: () => ({})
      })
    };
  }

  const ss = {
    getSheetByName: (name) => (sheets[name] ? sheetHandle(name) : null),
    insertSheet: (name) => { sheets[name] = []; return sheetHandle(name); }
  };

  return { sheets, ss };
}

function kvStore() {
  const map = new Map();
  return {
    getProperty: (k) => (map.has(k) ? map.get(k) : null),
    setProperty: (k, v) => { map.set(k, String(v)); },
    get: (k) => (map.has(k) ? map.get(k) : null),
    put: (k, v) => { map.set(k, String(v)); },
    remove: (k) => { map.delete(k); }
  };
}

function createSandbox() {
  const { sheets, ss } = makeFakeSpreadsheet();
  const scriptProps = kvStore();
  const scriptCache = kvStore();

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,

    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss
    },
    PropertiesService: { getScriptProperties: () => scriptProps },
    CacheService: { getScriptCache: () => scriptCache },
    Session: { getScriptTimeZone: () => (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    MailApp: { sendEmail: () => {} },
    Logger: { log: () => {} },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ setMimeType: () => ({}) })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      formatDate,
      getUuid: () => crypto.randomUUID(),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
      base64DecodeWebSafe: (str) => Array.from(Buffer.from(str, 'base64url')),
      computeDigest: (alg, str) => Array.from(crypto.createHash('sha256').update(String(str), 'utf8').digest()),
      computeHmacSha256Signature: (value, secret) =>
        Array.from(crypto.createHmac('sha256', String(secret)).update(String(value)).digest()),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
    }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const source = FILES.map((f) => fs.readFileSync(path.join(GS_DIR, f), 'utf8')).join('\n;\n');
  vm.runInContext(source, sandbox, { filename: 'apps-script-bundle.gs' });

  return { sandbox, sheets };
}

/** Seeds a sheet from logical rows: seedSheet(sheets, 'Sales History', SCHEMA['Sales History'], rows) */
function seedSheet(sheets, name, headers, objects) {
  const data = [headers.slice()];
  objects.forEach((o) => data.push(headers.map((h) => (o[h] === undefined ? '' : o[h]))));
  sheets[name] = data;
}

function loadFrontend() {
  const publicDir = path.join(__dirname, '..', '..', 'public', 'js');
  const state = { user: null };

  const sandbox = {
    console,
    crypto: crypto.webcrypto || crypto,
    navigator: { onLine: true },
    location: { pathname: '/home.html', href: 'home.html' },
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k)
      };
    })()
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const run = (file) => vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), sandbox, { filename: file });
  run('config.js');
  sandbox.PH.auth = { user: () => state.user };
  run('format.js');
  run('permissions.js');

  return { PH: sandbox.PH, state };
}

module.exports = { createSandbox, seedSheet, loadFrontend, GS_DIR };
