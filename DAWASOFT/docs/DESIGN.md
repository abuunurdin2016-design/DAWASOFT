# Pharmacy Management System — Design & Implementation Plan

> Status: **CONFIRMED — built to this design.** The Section 12 questions were answered (see that
> section) and the implementation is complete. See [DEPLOYMENT.md](./DEPLOYMENT.md) to deploy.
> Source spec: `Design a p....txt` (pharmacy management brief). This document turns that brief
> into a concrete, buildable architecture and is the single source of truth for the build.

---

## 1. Goal

An offline-capable web application used in a pharmacy to:

1. Record sales (POS).
2. Assist the dispenser with drug info (rate, UOM, dosage, contraindications) from the data sheet — **not** an online AI.
3. Produce daily / weekly / monthly / annual reports (items sold, amount collected, cash vs Lipa Namba, profit).
4. Track expiry dates and stock-outs.
5. Receive restocks and update stock.
6. Manage sales (history + editing of already-made sales).

Ten pages, two user classes (Administrator/Owner, Worker), page- and action-level permissions.

---

## 2. Proposed Architecture

The brief asks for "NETLIFY as server" **and** a Google Sheets schema **and** Apps Script. Those only
fit together one coherent way:

```
  Browser (offline-first PWA)
  HTML + CSS + Vanilla JS  ──┐
                             │  (works offline via IndexedDB + Service Worker)
                             ▼
  Netlify  ── static hosting + Netlify Functions (API gateway / reverse proxy)
                             │  rate limiting, timeout, retry, CORS, auth check
                             ▼
  Google Apps Script Web App  (the "server" that owns the Sheets)
                             │  doGet / doPost router, validation, audit, locking
                             ▼
  Google Sheets  =  the database (5 sheets, schema in Section 5)
```

- **Netlify** = static host **+ serverless API gateway** (this is what makes "Netlify + Sheets + Apps Script" work, and it is the ONLY reliable way to avoid Apps Script CORS problems).
- **Google Apps Script** = backend business logic and the only thing that touches Sheets.
- **Google Sheets** = database, exactly as specified.
- **Browser** = offline-first client that queues writes locally and auto-syncs.

### Why a Netlify Function proxy (not direct browser → Apps Script)
Google Apps Script Web Apps do not return CORS headers, so a browser `fetch` from the Netlify
origin cannot read the response. Routing all calls through a Netlify Function fixes CORS, and gives
us one place for rate limiting, timeouts, retries, request validation and API-version handling.

---

## 3. Tech stack (per brief)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | HTML + CSS + **Vanilla JavaScript** | Brief mandates these; no framework |
| Offline | IndexedDB + Service Worker + Background Sync | Auto-sync on reconnect |
| Hosting / gateway | Netlify (static + Netlify Functions) | Brief says use Netlify |
| Backend | Google Apps Script Web App (`doGet`/`doPost`) | Brief says use App Script |
| Database | Google Sheets (5 sheets) | Brief's schema |
| Repo / CI | Git + GitHub Actions (lint + unit tests) | CI/CD |

---

## 4. How the 111 engineering considerations map to THIS project

The user asked that these be "seriously considered". Applied-vs-not for this specific system:

**Applied (meaningful here):**
- **Caching** — client-side cache of inventory/drug data (IndexedDB) so the Assistant + POS work offline and are fast.
- **Cache invalidation** — version/`Last Update Date` stamp invalidates cached inventory.
- **Rate limiting** — in the Netlify Function gateway (per-user token), protects Apps Script quota (6 min/day execution limit, 20k URL-fetch/day, etc.).
- **Reverse proxy / API gateway** — the Netlify Function itself.
- **Timeouts** — every gateway → Apps Script call has an `AbortController` timeout.
- **Retries + exponential backoff + jitter** — sync engine and gateway retries.
- **Idempotency** — every queued mutation carries a client-generated `idempotencyKey`; Apps Script de-dupes → prevents double sales/restocks on reconnect. **Critical for offline.**
- **Message queue / DLQ** — the offline outbox is a queue; permanently-failed ops go to a Dead-Letter store surfaced in the Alerts page.
- **Event-driven (light)** — domain events (SaleRecorded, StockRestocked, ExpiryThresholdCrossed) drive audit log + alerts.
- **Cron jobs** — Apps Script time-driven trigger for nightly report rollups + expiry scan.
- **Database indexing** — Apps Script builds in-memory maps keyed by item name / user id instead of linear scans (Sheets `getDataRange` is O(n)).
- **Query optimization / N+1** — batch reads: read a whole sheet once per request, never per-row lookups.
- **Optimistic locking** — row `version` / `Last Update Date` check before write → 409 on conflict; re-merge in client.
- **Race conditions / thread safety** — Apps Script `LockService` around writes + idempotency keys.
- **Optimistic + pessimistic locking** — `LockService` = pessimistic for critical sections; version field = optimistic.
- **Health checks** — a `?action=health` endpoint the gateway pings.
- **Monitoring / Logging / Metrics / Audit** — Audit Log sheet + structured gateway logs + an `/metrics` summary endpoint.
- **Secrets management** — Apps Script Script Properties + Netlify env vars (never in client).
- **OAuth / TLS / Encryption in transit** — Google OAuth for deploy-time; HTTPS everywhere.
- **JWT rotation** — session tokens with short TTL + refresh (see Section 8).
- **CORS** — handled in the gateway.
- **XSS / CSRF / SSRF / input validation** — output-escaping, token checks, allow-listed upstream URL, schema validation on every write.
- **Feature flags** — settings-gated features (e.g. receipts, WhatsApp share).
- **Blue-green / canary / rolling / rollback** — Netlify deploy previews + atomic publish + instant rollback; Apps Script versioned deployments.
- **API versioning + semantic versioning** — `/api/v1` prefix; `vX.Y.Z` releases.
- **Backups / DR / failover** — daily Sheet copy to Drive; documented restore.
- **Observability / SLOs / SLIs / error budgets** — light: p95 latency + sync-failure-rate targets.
- **Latency / throughput / P99 / tail latency** — measured at the gateway.
- **Clock skew** — always use server timestamps; client time only as a hint.
- **Cost optimization** — batching keeps us inside free Apps Script/Netlify tiers.
- **Webhooks / SSE / long polling** — the Alerts page uses polling; SSE optional later.
- **PWA / Service Worker** — first-class, because offline is required.

**Considered but intentionally NOT used (and why):**
- **Docker / Kubernetes / Helm / Terraform / service discovery / load balancing / leader election / sharding / partitioning / read replicas / replication / CAP tuning / multi-region** — this is a single-pharmacy, serverless, managed-platform app. There is no cluster to orchestrate. Google Sheets + Apps Script + Netlify are managed; adding K8s/Helm/Terraform would be over-engineering and increase cost/ops. (If the system later grows multi-branch, revisit: replica shops = API gateway + caching, not K8s.)
- **gRPC / HTTP/2-3 / TCP-UDP tuning** — browser ↔ REST/JSON only; not applicable.
- **Distributed transactions / Saga** — one Sheets "transaction" boundary; multi-step writes use idempotency + compensating audit entries rather than a full Saga framework.
- **Circuit breakers** — a *simple* breaker is included in the gateway (open after N consecutive failures) rather than a full library.
- **CDN / edge caching** — Netlify's CDN is used implicitly for static assets; no separate config.
- **Chaos engineering / on-call / postmortems** — process items for a team; documented as recommendations, not code.
- **Garbage collection / memory leaks / backpressure / serverless cold starts / serverless limits** — mostly platform-internal; where relevant (cold starts on Netlify Functions, Apps Script 6-min limit) they are called out in the code and deployment doc.

---

## 5. Data model (Google Sheets) — per brief

**Sheet 1 — `Inventory` (13 cols):** Item name, Description, Category, UOM, Buying Price, Rate,
Current Stock, Reorder Level, Expiry Dates, Dosage, Contraindications, Last Update Date, Last Updater.

**Sheet 2 — `Users`:** user_id, Full name, DOB, Email, Username, Password hash + salt, Profession,
Profile picture URL, Status (active/suspended), Date created, plus permission lists (see Section 8).

**Sheet 3 — `AuditLog`:** Timestamp, Actor (user_id/username), Action, Entity, EntityId, Before, After, IP/hint.

**Sheet 4 — `ItemRestockHistory` (6 cols):** Timestamp, Item, Quantity Added, Resultant Quantity,
Buying Price Per UOM, Updater.

**Sheet 5 — `SalesHistory` (9 cols):** Timestamp, Item Name, Quantity sold, Selling price, Buying Price,
Mode of payment (Lipa Namba / Cash), Profit of Sale, Dispenser, Status (Need Review / Confirmed).

Additional **helper sheets** (new, needed for a correct system — to confirm):
- `Permissions` (or columns on Users): per-user granted **pages** and **actions**.
- `Sessions`: token, user_id, issued_at, expires_at (for JWT-style session + rotation).
- `Idempotency`: key, user_id, endpoint, result — to de-dupe offline replays.
- `SyncDLQ`: failed client operations for the Alerts page.
- `Settings` (optional): shop name, currency, theme defaults, expiry-warning months.

---

## 6. API surface (Apps Script `doPost` action router, behind `/api/v1`)

Auth: `login`, `signup`, `forgotPassword`, `refreshToken`, `logout`
Users: `listUsers`, `getUser`, `setPermissions` (pages + actions), `suspendUser`
Inventory: `listInventory`, `getItem`, `addItem`, `removeItem`, `editItem`, `restockItem`, `listRestockHistory`
Sales: `createSale` (idempotent), `listSales`, `getSale`, `editSale`, `confirmSale`
Assistant: `searchItems`, `searchByUse` (reads Inventory only — no AI)
Reports: `dailyReport`, `weeklyReport`, `monthlyReport`, `annualReport`, `dashboard`
Alerts: `listAlerts` (stock-outs + expiry by month-band), `listDLQ`
System: `health`, `version`, `syncBatch` (offline outbox flush)

All mutations accept an `idempotencyKey`; all mutations are `LockService`-guarded and version-checked.

---

## 7. Offline-first design (the hard part)

- **Outbox queue** in IndexedDB: every write (sale, restock, edit) is appended with a UUID `idempotencyKey` and a status.
- **Service Worker** serves the app shell + cached data offline; app works fully offline for sales.
- **Sync engine**: on `online` event (and every N seconds), flush the outbox via `syncBatch`.
  - **Retries** with **exponential backoff + jitter**.
  - Server de-dupes by `idempotencyKey` → **no double sales** (idempotency).
  - Ops that fail after max attempts → **Dead-Letter** (visible in Alerts page).
  - **Optimistic locking**: if server row changed (`Last Update Date` newer), return conflict; client re-merges.
- Local reads merge server data + pending local ops so the UI is correct while offline.

---

## 8. Auth & permissions

- Login by username **or** email + password (salted hash; Apps Script `Utilities.computeDigest`).
- Two account types: **Administrator/Owner** (all pages + all actions) and **Worker** (only granted pages/actions).
- **Page-level + action-level** permissions, stored per user; Owner edit in User Control Panel (page 9, hidden from workers).
- Sessions: short-TTL token + refresh = "JWT rotation" pattern (Google Apps Script cannot mint real JWTs cheaply, so an HMAC-signed token in Script Properties is used).
- Every protected endpoint re-checks permission server-side (never trust the client).

---

## 9. Pages (10)

1. `index.html` — Login / Sign up / Forgot password (Instagram-style animated gradient).
2. `home.html` — navigation grid (icons + labels, only permitted pages).
3. `sales.html` — POS: search item, qty, payment method, confirm, optional receipt (PDF/image/print/WhatsApp/email).
4. `assistant.html` — search by **item** or by **use/description**.
5. `inventory.html` — Update stock / Add-Remove item / Edit item.
6. `alerts.html` — stock-outs + expiry color bands (6→green, 5→yellow, 4→purple, 3→pink, 2&1→deep red).
7. `reports.html` — dashboard + Daily/Weekly/Monthly/Annual with compound bar graphs.
8. `settings.html` — theme, background, font, night/dark/auto mode.
9. `users.html` — User Control Panel (Owner only).
10. `sales-management.html` — Sales History (read-only) + Edit Sale.

UI: bottom nav (Instagram-like), Windows-11 dotted-spinner loading on every action, responsive.

---

## 10. File structure

```
DAWASOFT/pharmacy-management-system/
├─ docs/
│  ├─ DESIGN.md            ← this file
│  └─ DEPLOYMENT.md        ← written after build
├─ netlify/
│  └─ functions/
│     ├─ api.js            (gateway: rate limit, timeout, retry, CORS, auth, version)
│     └─ _lib/…
├─ apps-script/
│  ├─ appsscript.json
│  ├─ Code.gs             (router + auth + lock)
│  ├─ Auth.gs  Users.gs  Inventory.gs  Sales.gs  Assistant.gs
│  ├─ Reports.gs  Alerts.gs  Audit.gs  Idempotency.gs  Utils.gs
│  └─ Setup.gs            (creates sheets + headers + seeds owner)
├─ public/                (deployed to Netlify)
│  ├─ index.html home.html sales.html assistant.html inventory.html
│  ├─ alerts.html reports.html settings.html users.html sales-management.html
│  ├─ manifest.webmanifest  service-worker.js
│  ├─ css/ (base.css, themes.css, layout.css, components.css)
│  └─ js/
│     ├─ config.js  api.js  db.js(IndexedDB)  sync.js(outbox+DLQ)
│     ├─ auth.js  permissions.js  ui.js  charts.js  format.js
│     └─ pages/*.js
├─ tests/                 (pure-logic unit tests, run in CI)
├─ netlify.toml
├─ package.json
└─ README.md
```

---

## 11. Build & test plan

1. Scaffold project + config + design docs.
2. Apps Script backend (Setup.gs → Auth → Inventory → Sales → Assistant → Reports → Alerts → Audit/Idempotency).
3. Frontend shell (layout, themes, bottom nav, spinner) + auth pages.
4. Each of the 10 pages wired to the API.
5. Offline layer (Service Worker, IndexedDB, outbox, sync engine, DLQ).
6. Netlify gateway functions.
7. Tests: pure logic (calc profit, report aggregation, expiry banding, permission checks, idempotency) run locally + in CI; end-to-end checklist run against a real Apps Script deployment.
8. Deployment guide.

Testing note: business logic will be written as pure functions so it can be unit-tested locally without Google. Full end-to-end testing requires your Apps Script deployment.

---

## 12. Decisions (previously open questions — now answered)

1. **Architecture** — confirmed: Netlify static + Netlify Function gateway → Apps Script → Sheets.
2. **Currency / locale** — **TZS**, English.
3. **Offline scope** — sales entry, **restock** and **edit** are all offline-capable.
4. **Google account** — owned by the user; a blank Sheet exists and is customised by `setupSystem()`.
5. **Cost** — free tiers only; no subscriptions, no heavy infrastructure.
6. **Receipts** — share (WhatsApp / email / PDF) is **in scope now**.
7. **Multi-branch** — **single pharmacy only**.
