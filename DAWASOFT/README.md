# Pharmacy Management System

An offline-capable pharmacy management web app. It records sales, helps the dispenser look up drug
information, tracks stock and expiry, and produces daily / weekly / monthly / annual reports.

Built with **HTML + CSS + vanilla JavaScript** on the front end, a **Netlify Function** as the API
gateway, **Google Apps Script** as the backend, and **Google Sheets** as the database — all on free
tiers.

```
  Browser (offline-first PWA)
  HTML + CSS + Vanilla JS            works offline (IndexedDB + Service Worker + outbox)
        │
        ▼
  Netlify  ── static hosting + Function API gateway
        │      rate limiting · timeouts · retries · circuit breaker · CORS · API versioning
        ▼
  Google Apps Script  ── doPost router, validation, locking, audit, idempotency
        │
        ▼
  Google Sheets  ── the database
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture and the mapping of the 111 engineering
considerations, [docs/API_CONTRACT.md](docs/API_CONTRACT.md) for the action list, and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the step-by-step deployment guide.

---

## Features

- **POS sales entry** with cash / Lipa Namba payment, works fully offline.
- **Drug assistant** — search an item (or by use) for rate, UOM, dosage and contraindications, read
  straight from the Sheets data (no external AI).
- **Reports & dashboard** — items sold, amount collected, cash vs Lipa Namba and profit, for daily,
  weekly, monthly and annual periods, with charts.
- **Alerts** — stock-outs, low stock, and expiry colour bands (6 mo green, 5 yellow, 4 purple,
  3 pink, 2 & 1 deep red), plus a sync-issues (dead-letter) view for the owner.
- **Inventory** — restock, add / remove item, edit item (with optimistic locking).
- **Sales management** — browse history, open a sale, edit or confirm it.
- **Users & permissions** — two roles (Owner, Worker) with **page-level and action-level** control;
  the user-control page is owner-only.
- **Appearance** — theme, font and background options; Windows-11 style dotted spinner; Instagram
  style bottom navigation.
- **Offline-first** — an outbox with idempotent replay, so reconnecting never double-records a sale.

## Pages

| # | Page | File |
|---|------|------|
| 1 | Login / Sign up / Forgot password | `public/index.html` |
| 2 | Home (navigation) | `public/home.html` |
| 3 | Sales entry (POS) | `public/sales.html` |
| 4 | Assistant | `public/assistant.html` |
| 5 | Inventory update | `public/inventory.html` |
| 6 | Alerts | `public/alerts.html` |
| 7 | Reports / dashboard | `public/reports.html` |
| 8 | Settings | `public/settings.html` |
| 9 | User control panel (owner only) | `public/users.html` |
| 10 | Sales management | `public/sales-management.html` |

## Project structure

```
pharmacy-management-system/
├─ public/                static front end (deployed to Netlify)
│  ├─ *.html              the ten pages
│  ├─ css/                base · themes · layout · components
│  ├─ js/                 config · api · db (IndexedDB) · sync (outbox + DLQ) · auth ·
│  │                      permissions · ui · charts · format · icons · app
│  ├─ js/pages/           one script per page
│  ├─ manifest.webmanifest
│  └─ service-worker.js   app-shell cache + background sync
├─ netlify/functions/api.js   API gateway / reverse proxy to Apps Script
├─ apps-script/           the backend (paste into the Apps Script editor)
│  ├─ Code.gs             doGet/doPost router, locking, idempotency
│  ├─ Utils.gs            constants, schema, helpers
│  ├─ Auth.gs  Users.gs  Inventory.gs  Sales.gs  Assistant.gs
│  ├─ Reports.gs  Alerts.gs  Idempotency.gs  Audit.gs
│  ├─ Setup.gs            one-time bootstrap (sheets, owner, secret)
│  └─ appsscript.json
├─ tests/                 backend unit tests (Node's built-in test runner)
├─ tools/dev-server.js    local test server (runs the real backend, no Google needed)
├─ docs/                  DESIGN.md · API_CONTRACT.md · DEPLOYMENT.md
├─ netlify.toml
└─ package.json
```

## Local development

Requires Node 18+.

### Test the whole system locally — no Google account, no deployment

```bash
cd pharmacy-management-system
npm run dev:local        # or: PORT=9000 npm run dev:local
```

Then open <http://localhost:8888> and sign in as **`owner` / `owner123`**.

This serves `public/` and runs the **real** `apps-script/*.gs` backend in a Node sandbox that
emulates the Google services (`SpreadsheetApp`, `PropertiesService`, `CacheService`, `MailApp`, …).
So the browser exercises the same code paths it will hit in production; the only difference is that
Google Sheets lives in memory, persisted to `.dev-data.json`.

- Sign-up, login, sales, restock, edits, reports and alerts all work.
- Offline: DevTools → **Network → Offline**, record a sale, go back **Online**, and watch it sync
  (the header badge shows pending changes).
- `MailApp` (password-reset emails) prints to the terminal instead of sending.
- Reset all local data with `npm run dev:local -- --reset` (or delete `.dev-data.json`).

While developing, tick DevTools → **Application → Service Workers → Update on reload** so the
service worker does not serve a stale app shell.

### Run against Netlify (needs a deployed Apps Script backend)

```bash
npm install -g netlify-cli   # once, if you don't have it
npm run dev                  # netlify dev — serves public/ and the function at /api/v1
```

Set `APPS_SCRIPT_URL` in the environment (or a `.env` file) before running:

```
APPS_SCRIPT_URL=https://script.google.com/macros/s/..../exec
```

## Tests

The backend business logic (sale profit maths, report aggregation, expiry banding, permissions,
idempotency, password/token handling) is unit-tested without Google, using a `vm` sandbox that
emulates the Apps Script services.

```bash
npm test        # node --test "tests/**/*.test.js"
npm run lint    # eslint over public/js and netlify/functions
```

## Deployment

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short:

1. Create a Google Sheet and open **Extensions → Apps Script**.
2. Paste the `apps-script/*.gs` files, run **`setupSystem()`**, then deploy as a Web App
   (*Execute as: Me*, *Who has access: Anyone*) and copy the `/exec` URL.
3. Deploy this repo to Netlify (it reads `netlify.toml`) and set the `APPS_SCRIPT_URL` environment
   variable.
4. Sign in as `owner` / `owner123` and **change the password immediately**.

## Security notes

- Passwords are stored as salted, iterated SHA-256 hashes (Apps Script has no bcrypt).
- Sessions are opaque, HMAC-signed tokens with a short TTL and rotation on refresh; the signing
  secret lives in Apps Script Script Properties.
- The Netlify gateway is the only public entry point; it rate-limits, times out, retries and
  enforces the `/api/v1` version.
- Every protected action is re-checked server-side; the client is never trusted for permissions.
- Every write is audited in the `Audit Log` sheet.
