'use strict';

/**
 * tools/dev-server.js — run the WHOLE system locally, with no Google account and no deployment.
 *
 * It serves the static front end from `public/` and executes the REAL Apps Script backend
 * (`apps-script/*.gs`) inside a `vm` sandbox with an in-memory emulation of the Google services the
 * backend uses (SpreadsheetApp, PropertiesService, CacheService, LockService, MailApp, ContentService,
 * Utilities, Session). So the browser talks to the exact same code paths it will hit in production —
 * the only difference is that "Google Sheets" lives in memory (persisted to .dev-data.json).
 *
 * Usage:
 *   node tools/dev-server.js            # start (loads .dev-data.json if present)
 *   node tools/dev-server.js --reset    # wipe all local data and re-seed, then start
 *   PORT=9000 node tools/dev-server.js  # choose a port (default 8888)
 *
 * Then open http://localhost:8888 and sign in with  owner / owner123
 *
 * The spreadsheet's tabs and the owner account are created by running the real `setupSystem()`
 * (Setup.gs) at boot, so this doubles as a smoke test of the bootstrap path.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GS_DIR = path.join(ROOT, 'apps-script');
const DATA_FILE = path.join(ROOT, '.dev-data.json');
const PORT = parseInt(process.env.PORT || '8888', 10);
const RESET = process.argv.includes('--reset');

/** Load order is irrelevant (Apps Script files share one global scope) but keep it readable. */
const GS_FILES = [
  'Utils.gs', 'Code.gs', 'Auth.gs', 'Users.gs', 'Inventory.gs', 'Sales.gs',
  'Assistant.gs', 'Reports.gs', 'Alerts.gs', 'Idempotency.gs', 'Audit.gs', 'Setup.gs'
];

/* ------------------------------------------------------------------ *
 * Google services emulation                                          *
 * ------------------------------------------------------------------ */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/**
 * Utilities.formatDate for the patterns the backend uses. The backend mixes Date's local-time
 * methods (getDay, setHours, …) with formatDate, and appsscript.json pins the script time zone to
 * the pharmacy's zone, so formatting in the process' local zone keeps both consistent.
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

/** In-memory spreadsheet: sheet name -> rows (row 0 = header row). `sheets` is mutated in place. */
function makeSpreadsheet(sheets) {
  function range(data, r, c, nr, nc) {
    const range = {
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = data[r - 1 + i] || [];
          const outRow = [];
          for (let j = 0; j < nc; j++) outRow.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(outRow);
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < nr; i++) {
          const ri = r - 1 + i;
          if (!data[ri]) data[ri] = [];
          for (let j = 0; j < nc; j++) data[ri][c - 1 + j] = vals[i][j];
        }
        return range;
      },
      setFontWeight: () => range
    };
    return range;
  }

  function handle(name) {
    const data = sheets[name] || (sheets[name] = []);
    return {
      getDataRange: () => ({ getValues: () => data.map((row) => row.slice()) }),
      getRange: (r, c, nr, nc) => range(data, r, c, nr, nc),
      appendRow: (row) => { data.push(row.slice()); },
      deleteRow: (n) => { data.splice(n - 1, 1); }
    };
  }

  const ss = {
    getSheetByName: (name) => (sheets[name] ? handle(name) : null),
    insertSheet: (name) => { sheets[name] = []; return handle(name); }
  };
  return ss;
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

/** Builds the sandbox and evaluates the real backend into it. */
function buildBackend(sheets) {
  const ss = makeSpreadsheet(sheets);
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
    MailApp: {
      sendEmail: (opts) => {
        console.log('\n--- MailApp.sendEmail (dev: printed instead of sent) ---');
        console.log('  to:      ' + opts.to);
        console.log('  subject: ' + opts.subject);
        console.log('  body:    ' + String(opts.body).replace(/\n/g, '\n           '));
        console.log('-------------------------------------------------------\n');
      }
    },
    Logger: { log: (m) => console.log('  [Logger] ' + m) },
    // createTextOutput carries the JSON so the HTTP layer can read it back out of doGet/doPost.
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => { const o = { __json: String(s), setMimeType: () => o }; return o; }
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

  const source = GS_FILES.map((f) => fs.readFileSync(path.join(GS_DIR, f), 'utf8')).join('\n;\n');
  vm.runInContext(source, sandbox, { filename: 'apps-script-bundle.gs' });

  return sandbox;
}

/* ------------------------------------------------------------------ *
 * Local persistence for the "sheets"                                  *
 * ------------------------------------------------------------------ */

function loadData(sheets) {
  if (RESET || !fs.existsSync(DATA_FILE)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(sheets, parsed);
    return true;
  } catch (e) {
    console.warn('Could not read ' + path.basename(DATA_FILE) + ' (' + e.message + '); starting fresh.');
    return false;
  }
}

function saveData(sheets) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(sheets));
  } catch (e) {
    console.warn('Could not persist local data: ' + e.message);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP: static files + /api/v1                                        *
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, '{"error":"forbidden"}');

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      sendJson(res, 404, JSON.stringify({ error: 'Not found: ' + rel }));
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // no-store keeps the HTTP cache out of the way while developing; the service worker manages
    // the app shell itself (DevTools -> Application -> "Update on reload" avoids stale assets).
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function handleApi(req, res, sandbox, sheets, urlPath) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const query = Object.fromEntries(new URL(urlPath, 'http://localhost').searchParams);
    const started = Date.now();

    let out;
    try {
      out = (req.method === 'GET')
        ? sandbox.doGet({ parameter: query })
        : sandbox.doPost({ postData: { contents: raw }, parameter: query });
    } catch (err) {
      console.error('  !! unhandled backend error: ' + (err && err.stack ? err.stack : err));
      return sendJson(res, 500, JSON.stringify({ ok: false, action: '', error: { code: 'SERVER_ERROR', message: String(err) } }));
    }

    const json = (out && out.__json) ? out.__json : '{"ok":false,"error":{"code":"SERVER_ERROR","message":"No output"}}';
    saveData(sheets);

    let label = {};
    try { label = JSON.parse(json); } catch (e) { /* ignore */ }
    const mark = label.ok ? 'ok  ' : 'fail';
    console.log('  [' + mark + '] ' + (label.action || query.action || req.method) + ' (' + (Date.now() - started) + 'ms)' +
      (label.ok ? '' : ' -> ' + (label.error && label.error.code) + ': ' + (label.error && label.error.message)));

    sendJson(res, 200, json);
  });
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

const sheets = {};
const hadData = loadData(sheets);
const sandbox = buildBackend(sheets);

// Idempotent: creates any missing sheets/headers, the owner account and the signing secret.
try {
  const result = sandbox.setupSystem();
  saveData(sheets);
  console.log('Backend ready — ' + (result.sheets || []).length + ' sheets: ' + (result.sheets || []).join(', '));
} catch (e) {
  console.error('setupSystem() failed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  if (urlPath.startsWith('/api/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    return handleApi(req, res, sandbox, sheets, urlPath);
  }
  if (req.method !== 'GET') return sendJson(res, 405, '{"error":"method not allowed"}');
  serveStatic(res, urlPath);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Pharmacy Management System — LOCAL TEST SERVER');
  console.log('  -------------------------------------------------------------');
  console.log('  Open:      http://localhost:' + PORT);
  console.log('  Sign in:   owner / owner123   (change it in Settings when you go live)');
  console.log('  Data:      ' + (hadData ? 'loaded from ' : 'new file ') + path.basename(DATA_FILE) + '  (delete it or pass --reset to wipe)');
  console.log('  API:       POST http://localhost:' + PORT + '/api/v1  (same code as production)');
  console.log('');
  console.log('  Test offline:  DevTools -> Network -> Offline, record a sale, then go back Online');
  console.log('                 and watch it sync (the header badge shows pending changes).');
  console.log('  MailApp:       password-reset emails are printed in THIS terminal instead of sent.');
  console.log('  Stop:          Ctrl + C');
  console.log('');
});
