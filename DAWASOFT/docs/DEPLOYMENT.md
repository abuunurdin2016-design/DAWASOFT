# Deployment Guide — Pharmacy Management System

This guide takes you from zero to a live system. You only do steps **1–5** once; step **6** is how
you ship future changes.

Everything runs on **free tiers**: Netlify (static hosting + serverless function) and Google
(Sheets + Apps Script). No credit card and no subscription is required.

```
  Browser  ──►  Netlify (static site + API gateway function)  ──►  Google Apps Script  ──►  Google Sheets
  offline-first PWA        /api/v1/*  →  /.netlify/functions/api        doPost router          database
```

Read [DESIGN.md](./DESIGN.md) for the architecture and [API_CONTRACT.md](./API_CONTRACT.md) for the
action list. Terminology in this guide matches those documents.

---

## Part 0 — Try it locally first (optional, recommended)

You can click through the entire system before deploying anything:

```bash
cd pharmacy-management-system
npm run dev:local
```

Open <http://localhost:8888> and sign in as `owner` / `owner123`. This runs the **real** backend
(`apps-script/*.gs`) in a Node sandbox with an in-memory stand-in for Google Sheets, so it is a
faithful preview — including offline sales and the automatic re-sync. Nothing is sent to Google and
no account is needed. See the README’s *Local development* section for details.

When you are happy with it, continue with Part 1.

---

## Part 1 — Google Sheets + Apps Script (the backend + database)

### 1.1 Create the spreadsheet

1. Sign in to the Google account that will own the pharmacy data.
2. Go to <https://sheets.new> to create a blank spreadsheet.
3. Rename it (top-left) to something like **Pharmacy Database**.

You do **not** need to create any tabs or headers by hand — the next steps do it for you.

### 1.2 Open the bound Apps Script project

1. In the spreadsheet, click **Extensions → Apps Script**.
2. A new Apps Script project opens. Rename it to **Pharmacy Backend** (click the project title).
3. In **Project Settings** (gear icon, left sidebar):
   - Tick **“Show `appsscript.json` manifest file in editor”**.
   - Set **Time zone** to **`(GMT+03:00) Nairobi`** (Africa/Dar_es_Salaam) — it must match
     `apps-script/appsscript.json` and the pharmacy's local time, otherwise daily/weekly reports
     will land in the wrong day.

### 1.3 Paste the backend files

The `apps-script/` folder in this repo is the *entire* backend. Each `.gs` file maps to one file in
the Apps Script editor.

1. In the editor, delete the default `Code.gs` contents (keep the file — you will overwrite it).
2. Create one file per `.gs` file below (**File → New → Script**, name it exactly), and paste the
   matching file's contents from this repo:
   - `Utils.gs`
   - `Code.gs`  ← the HTTP router (`doGet` / `doPost`)
   - `Auth.gs`
   - `Users.gs`
   - `Inventory.gs`
   - `Sales.gs`
   - `Assistant.gs`
   - `Reports.gs`
   - `Alerts.gs`
   - `Idempotency.gs`
   - `Audit.gs`
   - `Setup.gs`  ← the one-time bootstrap
3. Open `appsscript.json` in the editor and paste the contents of `apps-script/appsscript.json`.
4. Click **Save** (💾).

> Order does not matter — Apps Script files share one global scope. Keep the names identical to
> avoid confusion.

### 1.4 Run the one-time setup

1. At the top of the editor, select the function **`setupSystem`** from the function dropdown.
2. Click **Run**.
3. Google asks for authorization the first time:
   - **Review permissions** → choose the owning account.
   - If you see **“Google hasn't verified this app”**, click **Advanced → Go to Pharmacy Backend (unsafe)**.
     This is expected: it is *your own* script, so the warning is normal.
   - Allow the requested scopes (Sheets + sending email for password resets).
4. When it finishes, open the spreadsheet: every tab now exists with a bold header row, and the
   **Users** tab contains one row — the owner account.

`setupSystem()` is idempotent: running it again will not duplicate data.

### 1.5 Deploy the Web App (this produces your `APPS_SCRIPT_URL`)

1. In the editor, click **Deploy → New deployment**.
2. Click the gear next to “Select type” and pick **Web app**.
3. Configure:
   - **Description:** `pharmacy-api v1`
   - **Execute as:** **Me** (your Google account)
   - **Who has access:** **Anyone**
     *(Required — the Netlify gateway must be able to reach it without an interactive login. All
     real access control happens in the app: sessions + page/action permissions.)*
4. Click **Deploy**, then **copy the Web app URL**. It looks like:
   `https://script.google.com/macros/s/AKfycb..../exec`
5. Keep this URL — it is the `APPS_SCRIPT_URL` you will paste into Netlify in Part 2.

Quick sanity check — open this in a browser tab (replace with your URL):

```
https://script.google.com/macros/s/AKfycb..../exec?action=health
```

You should see JSON containing `"ok": true` and `"service": "pharmacy-api"`.

### 1.6 (Recommended) daily maintenance trigger

The app prunes expired sessions and old idempotency/DLQ rows via `dailyMaintenance()`. This is the
“cron job” from the checklist.

1. In the Apps Script editor, open the **Triggers** page (clock icon, left sidebar).
2. **+ Add Trigger**:
   - Function: **`dailyMaintenance`**
   - Event source: **Time-driven**
   - Type: **Day timer** → pick a quiet hour (e.g. **Midnight to 1am**).
3. Save. Approve permissions if prompted.

### 1.7 Change the owner password (do this immediately)

The seeded owner account is:

| Username | Password   |
|----------|------------|
| `owner`  | `owner123` |

The system flags it as “must change password”. Sign in (Page 1) and use
**Settings → Account → Change password**, or **Home → User Control** to manage other users.

You can also edit the **Settings** tab in the spreadsheet to set shop-level values:

| Key                   | Meaning                                   | Default   |
|-----------------------|-------------------------------------------|-----------|
| `SHOP_NAME`           | Name shown on receipts / header           | Pharmacy  |
| `CURRENCY`            | Currency label                            | TZS       |
| `EXPIRY_WARNING_MONTHS` | Months ahead that trigger an expiry alert | 6       |
| `LOW_STOCK_ALERT`     | Enable low-stock alerts                   | TRUE      |
| `RECEIPTS_ENABLED`    | Enable receipt generation                 | TRUE      |

---

## Part 2 — Netlify (static site + API gateway)

The frontend in `public/` is static. The file `netlify/functions/api.js` is the **API gateway** that
sits between the browser and Apps Script, adding CORS, rate limiting, timeouts, retries, a circuit
breaker and API-version checks. It is required: Apps Script Web Apps do not send CORS headers, so
the browser cannot call them directly.

### 2.1 Option A — Deploy from Git (recommended)

1. Push this repository to GitHub/GitLab (see “Ship changes” below).
2. Go to <https://app.netlify.com> → **Add new site → Import an existing project**.
3. Pick your Git provider and the repository.
4. Netlify reads `netlify.toml`, so the build settings are already correct:
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
   - **Build command:** *(none — there is no build step)*
5. Click **Deploy site**.

### 2.2 Option B — Deploy by drag-and-drop

1. Go to <https://app.netlify.com/drop>.
2. Drag the **`public`** folder in.
3. This deploys the site, but **not** the gateway function. To add the gateway, use **Site
   configuration → Functions** and deploy via Git instead, or link the site to Git afterwards.
   **Option A is recommended** because the gateway is essential.

### 2.3 Set the required environment variable

1. In Netlify: **Site configuration → Environment variables → Add a variable**.
2. Add:

   | Key                | Value                                   | Required |
   |--------------------|-----------------------------------------|----------|
   | `APPS_SCRIPT_URL`  | the `/exec` URL copied in step 1.5      | **Yes**  |
   | `ALLOWED_ORIGIN`   | your Netlify site URL (or `*`)          | No       |
   | `RATE_LIMIT_PER_MIN` | requests per minute per client        | No       |
   | `UPSTREAM_TIMEOUT_MS` | gateway → Apps Script timeout (ms)    | No       |

3. **Trigger a redeploy** (Deploys → **Trigger deploy → Clear cache and deploy site**) so the
   function picks up the new variables. Environment variable changes do not apply to already-built
   functions until the next deploy.

### 2.4 Verify

1. Open your Netlify URL. The login page (Page 1) should load.
2. Sign in as `owner` / `owner123`.
3. Go to **Settings → System**: it shows the app version and the connection state.
4. If you see *“APPS_SCRIPT_URL is not configured”*, re-check step 2.3 and redeploy.

---

## Part 3 — Installing it on phones (PWA)

The app is a Progressive Web App. On each phone/tablet:

1. Open the Netlify URL in Chrome (Android) or Safari (iOS).
2. **Android/Chrome:** menu → **Add to Home screen**.
   **iOS/Safari:** Share → **Add to Home Screen**.
3. Launch it from the home-screen icon. After the first visit the app shell is cached, so it opens
   and records **sales, restocks and edits while offline**; the outbox syncs automatically when the
   connection returns.

---

## Part 4 — How offline sync behaves

- Every write made offline is stored in an **outbox** (IndexedDB) with a unique id, and shown as
  *pending*.
- When the device is online (or every ~20 s), the outbox is flushed in one batched call
  (`syncBatch`). Each operation is **idempotent**, so a sale is never recorded twice.
- Transient failures are retried with exponential backoff. Only **permanent** failures
  (validation / permission / conflict) go to the **dead-letter queue**, which the owner can see in
  **Alerts → Sync issues**.

---

## Part 5 — Backups & disaster recovery

Google Sheets keeps version history (**File → Version history → See version history**), which
covers accidental edits. For a stronger safety net, make a daily copy:

1. In the spreadsheet: **File → Make a copy** for a manual snapshot, or
2. Create a small Apps Script time-driven trigger that copies the file to a Drive folder daily
   (Apps Script `DriveApp`), if you want automatic snapshots.

To restore: open **File → Version history** and restore the desired revision, or replace the live
sheet with your copy and update the `SPREADSHEET_ID` if you are using a standalone script.

---

## Part 6 — Ship changes later

**Frontend / gateway change**
1. Commit and push to the tracked branch. Netlify rebuilds and publishes automatically.
2. To roll back instantly: **Netlify → Deploys →** pick a previous deploy **→ Publish deploy**.

**Backend (Apps Script) change**
1. Edit the `.gs` files in the editor and **Save**.
2. **Deploy → Manage deployments →** edit the *active* deployment **→ Version: New version →
   Deploy.** (Saving alone does not update the served `/exec` code.)
3. The URL stays the same, so Netlify needs no changes.

---

## Part 7 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `APPS_SCRIPT_URL is not configured` | Env var missing or set after last build | Set it, then redeploy (2.3) |
| `Upstream timed out` / `Service temporarily unavailable` | Apps Script slow or cold, or breaker open | Retry; offline writes queue and sync later |
| `RATE_LIMITED` | Too many requests in a minute | Wait a minute, or raise `RATE_LIMIT_PER_MIN` |
| Login fails with correct password | Password was reset, or account suspended | Owner: **User Control** to reactivate/reset |
| Reports show the wrong day | Apps Script time zone mismatch | Set the project time zone to Africa/Dar_es_Salaam (1.2) |
| Password-reset email not received | `MailApp` quota or spam folder | Check spam; owner can reset directly in User Control |
| Old code still served after editing | Deployment not re-versioned | **Manage deployments → New version** (Part 6) |

---

## Part 8 — Free-tier limits to be aware of

- **Apps Script:** ~6 minutes max execution per call, daily quotas on email and on URL fetch. The
  gateway batches writes and rate-limits to stay well inside these.
- **Netlify Functions:** generous free invocation allowance; function instances are ephemeral, so
  the gateway’s rate-limit/circuit-breaker state is best-effort per instance.
- **Google Sheets:** fine for a single pharmacy’s volume. If the **Sales History** sheet grows very
  large (tens of thousands of rows), consider archiving old rows to a second sheet yearly.
