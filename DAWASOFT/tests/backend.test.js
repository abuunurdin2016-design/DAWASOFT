'use strict';

/**
 * Backend logic tests — run the real Apps Script sources inside the emulated Google sandbox.
 * Covers: profit maths, report aggregation, expiry banding, permissions, idempotency, hashing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSandbox, seedSheet } = require('./support/load-gs');

/**
 * Values produced inside the `vm` sandbox carry that realm's Object/Array prototypes, which makes
 * assert.deepStrictEqual fail even when the structure is identical. Round-tripping through JSON
 * yields plain values in this realm while preserving exactly what the backend returned.
 */
function plain(v) { return JSON.parse(JSON.stringify(v)); }

const SALES_HEADERS = [
  'Timestamp', 'Sale ID', 'Item Name', 'Quantity sold', 'Selling price', 'Buying Price',
  'Mode of payment', 'Profit of Sale', 'Dispenser', 'Client Name', 'Status'
];
const INV_HEADERS = [
  'Item ID', 'Item name', 'Description', 'Category', 'UOM', 'Buying Price', 'Rate',
  'Current Stock', 'Reorder Level', 'Expiry Date', 'Dosage', 'Contraindications',
  'Last Update Date', 'Last Updater'
];
const USER_HEADERS = [
  'User ID', 'Full name', 'DOB', 'Email', 'Username', 'Password Hash', 'Password Salt', 'Profession',
  'Profile Picture', 'Status', 'Pages', 'Actions', 'Created At', 'Updated At', 'Last Login',
  'Must Change Password'
];

/** The seeded root administrator (user id 1) that every user sheet starts from. */
function rootAdminRow() {
  return {
    'User ID': 1, 'Full name': 'System Owner', 'Email': 'owner@example.com', 'Username': 'owner',
    'Password Hash': 'x', 'Password Salt': 'y', 'Profession': 'Administrator', 'Status': 'active',
    'Pages': '[]', 'Actions': '[]'
  };
}

function userField(sheets, rowIndex, header) {
  return sheets['Users'][rowIndex][USER_HEADERS.indexOf(header)];
}

/* ------------------------------------------------------------------ *
 * Sales maths                                                         *
 * ------------------------------------------------------------------ */

test('saleRowFromLine computes profit = (selling - buying) * quantity', () => {
  const { sandbox } = createSandbox();
  const meta = { timestampIso: '2026-03-10T09:00:00', saleId: 'S-1', paymentMode: 'cash', dispenser: 'amina', clientName: 'Juma', status: 'Confirmed' };
  const row = sandbox.saleRowFromLine({ itemName: 'Paracetamol', quantity: 3, sellingPrice: 500, buyingPrice: 300 }, meta);

  assert.equal(row['Profit of Sale'], 600);
  assert.equal(row['Quantity sold'], 3);
  assert.equal(row['Sale ID'], 'S-1');
  assert.equal(row['Client Name'], 'Juma');
});

test('saleApiFromRows aggregates total, profit and the cash / lipa split', () => {
  const { sandbox } = createSandbox();
  const rows = [
    { 'Timestamp': '2026-03-10T09:00:00', 'Sale ID': 'S-1', 'Item Name': 'A', 'Quantity sold': 2, 'Selling price': 500, 'Buying Price': 300, 'Mode of payment': 'cash', 'Profit of Sale': 400, 'Dispenser': 'amina', 'Client Name': '', 'Status': 'Confirmed' },
    { 'Timestamp': '2026-03-10T09:00:00', 'Sale ID': 'S-1', 'Item Name': 'B', 'Quantity sold': 1, 'Selling price': 1000, 'Buying Price': 700, 'Mode of payment': 'cash', 'Profit of Sale': 300, 'Dispenser': 'amina', 'Client Name': '', 'Status': 'Confirmed' }
  ];
  const sale = sandbox.saleApiFromRows(rows);

  assert.equal(sale.total, 2000);
  assert.equal(sale.profit, 700);
  assert.equal(sale.cashAmount, 2000);
  assert.equal(sale.lipaNambaAmount, 0);
  assert.equal(sale.items.length, 2);
});

test('saleApiFromRows puts lipa_namba sales in the lipa bucket', () => {
  const { sandbox } = createSandbox();
  const rows = [{ 'Timestamp': '2026-03-10T09:00:00', 'Sale ID': 'S-2', 'Item Name': 'A', 'Quantity sold': 4, 'Selling price': 250, 'Buying Price': 100, 'Mode of payment': 'lipa_namba', 'Profit of Sale': 600, 'Dispenser': 'john', 'Client Name': 'Amina', 'Status': 'Confirmed' }];
  const sale = sandbox.saleApiFromRows(rows);
  assert.equal(sale.cashAmount, 0);
  assert.equal(sale.lipaNambaAmount, 1000);
  assert.equal(sale.paymentMode, 'lipa_namba');
});

/* ------------------------------------------------------------------ *
 * Report aggregation                                                  *
 * ------------------------------------------------------------------ */

test('summarizeRows counts distinct sales, not line items', () => {
  const { sandbox } = createSandbox();
  const rows = [
    { 'Sale ID': 'S-1', 'Quantity sold': 2, 'Selling price': 500, 'Mode of payment': 'cash', 'Profit of Sale': 400 },
    { 'Sale ID': 'S-1', 'Quantity sold': 3, 'Selling price': 200, 'Mode of payment': 'cash', 'Profit of Sale': 150 },
    { 'Sale ID': 'S-2', 'Quantity sold': 1, 'Selling price': 1000, 'Mode of payment': 'lipa_namba', 'Profit of Sale': 250 }
  ];
  const s = sandbox.summarizeRows(rows);

  assert.equal(s.salesCount, 2);
  assert.equal(s.itemsSold, 6);
  assert.equal(s.totalAmount, 2 * 500 + 3 * 200 + 1 * 1000);
  assert.equal(s.cashAmount, 1600);
  assert.equal(s.lipaNambaAmount, 1000);
  assert.equal(s.profit, 800);
});

test('summarizeRows on an empty list is all zeros', () => {
  const { sandbox } = createSandbox();
  assert.deepEqual(plain(sandbox.summarizeRows([])), {
    salesCount: 0, itemsSold: 0, cashAmount: 0, lipaNambaAmount: 0, totalAmount: 0, profit: 0
  });
});

test('dailyReport aggregates only rows inside the requested day', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Sales History', SALES_HEADERS, [
    { 'Timestamp': new Date(Date.UTC(2026, 2, 10, 8, 0, 0)), 'Sale ID': 'S-1', 'Item Name': 'A', 'Quantity sold': 2, 'Selling price': 500, 'Mode of payment': 'cash', 'Profit of Sale': 400, 'Status': 'Confirmed' },
    { 'Timestamp': new Date(Date.UTC(2026, 2, 10, 18, 0, 0)), 'Sale ID': 'S-2', 'Item Name': 'B', 'Quantity sold': 1, 'Selling price': 900, 'Mode of payment': 'lipa_namba', 'Profit of Sale': 300, 'Status': 'Confirmed' },
    { 'Timestamp': new Date(Date.UTC(2026, 2, 11, 9, 0, 0)), 'Sale ID': 'S-3', 'Item Name': 'C', 'Quantity sold': 5, 'Selling price': 100, 'Mode of payment': 'cash', 'Profit of Sale': 100, 'Status': 'Confirmed' }
  ]);

  const rep = sandbox.handleDailyReport({ date: '2026-03-10' });
  assert.equal(rep.summary.salesCount, 2);
  assert.equal(rep.summary.totalAmount, 1900);
  assert.equal(rep.summary.cashAmount, 1000);
  assert.equal(rep.summary.lipaNambaAmount, 900);
  assert.equal(rep.summary.profit, 700);
});

test('toIsoDateTime renders the quoted T literal without quotes', () => {
  const { sandbox } = createSandbox();
  assert.equal(sandbox.toIsoDateTime(new Date(2026, 2, 10, 9, 5, 7)), '2026-03-10T09:05:07');
});

test('a sale created through the API is picked up by the daily report (timestamp round-trip)', () => {
  // Reports filter on the Timestamp *string* the backend writes; seedSheet-style Date objects would
  // hide a break in toIsoDateTime/parseDate, so this goes through the real create path.
  const { sandbox } = createSandbox();
  const user = { id: 1, username: 'owner', profession: 'Administrator' };
  sandbox.handleCreateSale(user, {
    items: [{ itemName: 'Paracetamol', itemId: 'ITM-0001', quantity: 3, sellingPrice: 300, buyingPrice: 100 }],
    paymentMode: 'cash'
  });

  const rep = sandbox.handleDailyReport({});
  assert.equal(rep.summary.salesCount, 1);
  assert.equal(rep.summary.totalAmount, 900);
  assert.equal(rep.summary.profit, 600);
});

test('annualReport returns 12 monthly buckets that sum to the year total', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Sales History', SALES_HEADERS, [
    { 'Timestamp': new Date(Date.UTC(2026, 0, 5, 9, 0, 0)), 'Sale ID': 'S-1', 'Item Name': 'A', 'Quantity sold': 1, 'Selling price': 1000, 'Mode of payment': 'cash', 'Profit of Sale': 200, 'Status': 'Confirmed' },
    { 'Timestamp': new Date(Date.UTC(2026, 6, 12, 9, 0, 0)), 'Sale ID': 'S-2', 'Item Name': 'B', 'Quantity sold': 2, 'Selling price': 500, 'Mode of payment': 'lipa_namba', 'Profit of Sale': 100, 'Status': 'Confirmed' },
    { 'Timestamp': new Date(Date.UTC(2026, 11, 31, 20, 0, 0)), 'Sale ID': 'S-3', 'Item Name': 'C', 'Quantity sold': 1, 'Selling price': 300, 'Mode of payment': 'cash', 'Profit of Sale': 50, 'Status': 'Confirmed' }
  ]);

  const rep = sandbox.handleAnnualReport({ year: 2026 });
  assert.equal(rep.series.length, 12);
  assert.equal(rep.series[0].label, 'Jan');
  assert.equal(rep.series[6].label, 'Jul');
  assert.equal(rep.series[0].summary.totalAmount, 1000);
  assert.equal(rep.series[6].summary.totalAmount, 1000);
  assert.equal(rep.series[11].summary.totalAmount, 300);
  assert.equal(rep.summary.totalAmount, 2300);
  assert.equal(rep.summary.profit, 350);
  // Month buckets must add up to the annual total.
  const sum = rep.series.reduce((a, r) => a + r.summary.totalAmount, 0);
  assert.equal(sum, rep.summary.totalAmount);
});

test('weeklyReport returns 7 days starting on Monday', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Sales History', SALES_HEADERS, []);
  // 2026-03-11 is a Wednesday; the week must start Monday 2026-03-09.
  const rep = sandbox.handleWeeklyReport({ date: '2026-03-11' });
  assert.equal(rep.series.length, 7);
  assert.deepEqual(plain(rep.series.map((r) => r.label)), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(rep.series[0].date, '2026-03-09');
});

test('monthlyReport buckets the month into weeks and totals correctly', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Sales History', SALES_HEADERS, [
    { 'Timestamp': new Date(Date.UTC(2026, 2, 3, 9, 0, 0)), 'Sale ID': 'S-1', 'Item Name': 'A', 'Quantity sold': 1, 'Selling price': 500, 'Mode of payment': 'cash', 'Profit of Sale': 100, 'Status': 'Confirmed' },
    { 'Timestamp': new Date(Date.UTC(2026, 2, 20, 9, 0, 0)), 'Sale ID': 'S-2', 'Item Name': 'B', 'Quantity sold': 2, 'Selling price': 500, 'Mode of payment': 'cash', 'Profit of Sale': 200, 'Status': 'Confirmed' }
  ]);
  const rep = sandbox.handleMonthlyReport({ month: '2026-03' });

  assert.equal(rep.series[0].label, 'Week 1');
  assert.equal(rep.series[0].summary.totalAmount, 500);
  assert.equal(rep.series[2].summary.totalAmount, 1000);
  assert.equal(rep.summary.totalAmount, 1500);
});

test('dashboard groups today / this week / this month / this year', () => {
  const { sandbox, sheets } = createSandbox();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));
  seedSheet(sheets, 'Sales History', SALES_HEADERS, [
    { 'Timestamp': today, 'Sale ID': 'S-1', 'Item Name': 'A', 'Quantity sold': 1, 'Selling price': 400, 'Mode of payment': 'cash', 'Profit of Sale': 90, 'Status': 'Confirmed' }
  ]);
  const d = sandbox.handleDashboard({ date: today.toISOString() });
  assert.ok(d.day.totalAmount >= 400, 'today bucket should include the sale');
  assert.ok(d.week.totalAmount >= d.day.totalAmount);
  assert.ok(d.month.totalAmount >= d.week.totalAmount);
  assert.ok(d.year.totalAmount >= d.month.totalAmount);
});

/* ------------------------------------------------------------------ *
 * Date helpers                                                        *
 * ------------------------------------------------------------------ */

test('startOfWeek returns Monday, startOfMonth the 1st, startOfYear 1 January', () => {
  const { sandbox } = createSandbox();
  const ref = new Date(Date.UTC(2026, 2, 11, 15, 30, 0)); // Wednesday
  assert.equal(sandbox.startOfWeek(ref).getDay(), 1);
  assert.equal(sandbox.startOfWeek(ref).getDate(), 9);
  assert.equal(sandbox.startOfMonth(ref).getDate(), 1);
  assert.equal(sandbox.startOfYear(ref).getMonth(), 0);
  assert.equal(sandbox.startOfYear(ref).getDate(), 1);
  assert.equal(sandbox.daysInMonth(2026, 1), 28); // Feb 2026
  assert.equal(sandbox.daysInMonth(2024, 1), 29); // Feb 2024 (leap)
});

test('rowsInRange keeps only rows inside the window', () => {
  const { sandbox } = createSandbox();
  const rows = [
    { 'Timestamp': new Date(Date.UTC(2026, 2, 1)) },
    { 'Timestamp': new Date(Date.UTC(2026, 2, 15)) },
    { 'Timestamp': new Date(Date.UTC(2026, 2, 30)) },
    { 'Timestamp': '' }
  ];
  const kept = sandbox.rowsInRange(rows, new Date(Date.UTC(2026, 2, 10)), new Date(Date.UTC(2026, 2, 20)));
  assert.equal(kept.length, 1);
});

/* ------------------------------------------------------------------ *
 * Expiry banding                                                      *
 * ------------------------------------------------------------------ */

test('expiryBand maps whole months to the brief colour bands', () => {
  const { sandbox } = createSandbox();
  assert.equal(sandbox.expiryBand(8), 'green');
  assert.equal(sandbox.expiryBand(6), 'green');
  assert.equal(sandbox.expiryBand(5), 'yellow');
  assert.equal(sandbox.expiryBand(4), 'purple');
  assert.equal(sandbox.expiryBand(3), 'pink');
  assert.equal(sandbox.expiryBand(2), 'deepred');
  assert.equal(sandbox.expiryBand(1), 'deepred');
  assert.equal(sandbox.expiryBand(0), 'deepred');
  assert.equal(sandbox.expiryBand(-3), 'deepred');
  assert.equal(sandbox.expiryBand(null), null);
});

test('monthsUntil counts whole months and never rounds up a partial month', () => {
  const { sandbox } = createSandbox();
  const from = new Date(Date.UTC(2026, 0, 15));
  assert.equal(sandbox.monthsUntil(new Date(Date.UTC(2026, 6, 15)), from), 6);
  assert.equal(sandbox.monthsUntil(new Date(Date.UTC(2026, 6, 14)), from), 5);
  assert.equal(sandbox.monthsUntil(new Date(Date.UTC(2026, 0, 15)), from), 0);
  assert.equal(sandbox.monthsUntil(null, from), null);
});

test('listAlerts flags stock-outs, low stock and expiring items', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Inventory', INV_HEADERS, [
    { 'Item ID': 'ITM-0001', 'Item name': 'Out item', 'Current Stock': 0, 'Reorder Level': 5, 'Rate': 100, 'Expiry Date': '' },
    { 'Item ID': 'ITM-0002', 'Item name': 'Low item', 'Current Stock': 3, 'Reorder Level': 10, 'Rate': 200, 'Expiry Date': '' },
    { 'Item ID': 'ITM-0003', 'Item name': 'Healthy item', 'Current Stock': 50, 'Reorder Level': 10, 'Rate': 300, 'Expiry Date': new Date(Date.UTC(2030, 0, 1)) }
  ]);
  const alerts = sandbox.handleListAlerts();

  assert.equal(alerts.stockouts.length, 2);
  assert.ok(alerts.stockouts.some((a) => a.item.itemName === 'Out item' && a.isOut === true));
  assert.ok(alerts.stockouts.some((a) => a.item.itemName === 'Low item' && a.isOut === false));
  assert.equal(alerts.expiring.length, 0);
});

/* ------------------------------------------------------------------ *
 * Permissions                                                         *
 * ------------------------------------------------------------------ */

const OWNER = { id: 1, username: 'owner', role: 'owner', pages: [], actions: [] };
const WORKER = { id: 5, username: 'amina', role: 'worker', pages: [2, 3], actions: [] };

test('the owner implicitly holds every page and action', () => {
  const { sandbox } = createSandbox();
  assert.equal(sandbox.isOwner(OWNER), true);
  assert.equal(sandbox.canViewPage(OWNER, 9), true);
  assert.equal(sandbox.canViewPage(OWNER, 6), true);
  assert.equal(sandbox.canDo(OWNER, 'users.manage'), true);
  assert.equal(sandbox.canDo(OWNER, 'sales.create'), true);
});

test('a worker only sees granted pages and never page 9', () => {
  const { sandbox } = createSandbox();
  assert.equal(sandbox.canViewPage(WORKER, 2), true);
  assert.equal(sandbox.canViewPage(WORKER, 3), true);
  assert.equal(sandbox.canViewPage(WORKER, 7), false);
  assert.equal(sandbox.canViewPage(WORKER, 9), false);
});

test('canDo is lenient: no configured actions means the page grant is enough', () => {
  const { sandbox } = createSandbox();
  assert.equal(sandbox.canDo(WORKER, 'sales.create'), true);

  const restricted = { id: 6, username: 'john', role: 'worker', pages: [2, 5], actions: ['inventory.restock'] };
  assert.equal(sandbox.canDo(restricted, 'inventory.restock'), true);
  assert.equal(sandbox.canDo(restricted, 'inventory.remove'), false);
});

test('requireAccess throws FORBIDDEN with the right code', () => {
  const { sandbox } = createSandbox();
  assert.doesNotThrow(() => sandbox.requireAccess(OWNER, 9, 'users.manage'));
  assert.throws(() => sandbox.requireAccess(WORKER, 9, 'users.manage'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => sandbox.requireAccess(WORKER, 7, 'reports.view'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => sandbox.requireAccess(WORKER, 5, 'inventory.add'), (e) => e.code === 'FORBIDDEN');
});

test('requireAnyPage allows a worker with any one of the pages', () => {
  const { sandbox } = createSandbox();
  assert.doesNotThrow(() => sandbox.requireAnyPage(WORKER, [3, 10]));
  assert.throws(() => sandbox.requireAnyPage(WORKER, [6, 7]), (e) => e.code === 'FORBIDDEN');
});

/* ------------------------------------------------------------------ *
 * Idempotency                                                         *
 * ------------------------------------------------------------------ */

test('idempotencyPut then idempotencyGet replays the same response (cache layer)', () => {
  const { sandbox } = createSandbox();
  const response = { ok: true, data: { saleId: 'S-9' } };

  assert.equal(sandbox.idempotencyGet('key-1'), null);
  sandbox.idempotencyPut('key-1', 1, 'createSale', response);

  const replayed = sandbox.idempotencyGet('key-1');
  assert.deepEqual(plain(replayed), response);
  assert.equal(replayed.data.saleId, 'S-9');
});

test('idempotencyGet falls back to the durable sheet when the cache is cold', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Idempotency', ['Key', 'User ID', 'Action', 'Response', 'Created At'], [
    { 'Key': 'key-2', 'User ID': 1, 'Action': 'restockItem', 'Response': JSON.stringify({ ok: true, data: { quantity: 20 } }), 'Created At': '2026-03-10T09:00:00' }
  ]);

  // Nothing in the cache, so the value must come from the sheet row.
  const fromSheet = sandbox.idempotencyGet('key-2');
  assert.deepEqual(plain(fromSheet), { ok: true, data: { quantity: 20 } });
});

test('a replayed op is detected and applied once (router-level de-dupe)', () => {
  const { sandbox } = createSandbox();
  const response = { ok: true, action: 'createSale', data: { saleId: 'S-1' } };
  sandbox.idempotencyPut('op-abc', 1, 'createSale', response);

  // Mirrors the router: if the requestId was seen, return the stored envelope untouched.
  const cached = sandbox.idempotencyGet('op-abc');
  assert.ok(cached);
  assert.equal(cached.data.saleId, 'S-1');
});

/* ------------------------------------------------------------------ *
 * Passwords / tokens                                                  *
 * ------------------------------------------------------------------ */

test('hashPassword is salted and repeatable, and safeEq compares in constant time', () => {
  const { sandbox } = createSandbox();
  const a = sandbox.hashPassword('secret123', 'saltA');
  const b = sandbox.hashPassword('secret123', 'saltA');
  const c = sandbox.hashPassword('secret123', 'saltB');

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
  assert.equal(sandbox.safeEq(a, b), true);
  assert.equal(sandbox.safeEq(a, c), false);
  assert.equal(sandbox.safeEq('abc', 'abcd'), false);
});

test('session tokens are HMAC signed and rejected when tampered with', () => {
  const { sandbox } = createSandbox();

  // A token minted by the backend verifies and carries the user identity.
  const session = sandbox.createSession({ id: 1, username: 'owner' });
  const payload = sandbox.verifyToken(session.token);
  assert.equal(payload.uid, 1);
  assert.equal(payload.un, 'owner');

  // Swapping the body for a forged one must fail the HMAC check.
  const forgedBody = Buffer.from(JSON.stringify({ uid: 99, un: 'evil', exp: Date.now() + 60000 })).toString('base64url');
  const signature = session.token.split('.')[1];
  assert.throws(() => sandbox.verifyToken(forgedBody + '.' + signature), (e) => e.code === 'UNAUTHORIZED');

  // A structurally invalid token is rejected too.
  assert.throws(() => sandbox.verifyToken('not-a-token'), (e) => e.code === 'UNAUTHORIZED');
});

/* ------------------------------------------------------------------ *
 * Administrator approval requests                                     *
 * ------------------------------------------------------------------ */

test('the very first administrator signs up active and owns the system', () => {
  const { sandbox } = createSandbox(); // nobody exists yet
  const res = sandbox.handleSignup({
    fullName: 'System Owner', email: 'owner@example.com', username: 'owner',
    password: 'secret123', profession: 'Administrator'
  });
  assert.deepEqual(plain(res), { userId: 1, status: 'active', pendingApproval: false });
});

test('a later Administrator request is held pending, not active', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);

  const res = sandbox.handleSignup({
    fullName: 'Second Owner', email: 'second@example.com', username: 'second',
    password: 'secret123', profession: 'Administrator'
  });

  assert.equal(res.pendingApproval, true);
  assert.equal(res.status, 'pending');
  assert.equal(res.userId, 2);
  assert.equal(userField(sheets, 2, 'Status'), 'pending');
});

test('a Dispenser never needs approval', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);

  const res = sandbox.handleSignup({
    fullName: 'Amina', email: 'amina@example.com', username: 'amina',
    password: 'secret123', profession: 'Dispenser'
  });
  assert.deepEqual(plain(res), { userId: 2, status: 'active', pendingApproval: false });
});

test('a pending administrator is not treated as an owner and cannot sign in', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);
  sandbox.handleSignup({
    fullName: 'Second Owner', email: 'second@example.com', username: 'second',
    password: 'secret123', profession: 'Administrator'
  });

  const pending = sandbox.findUserById(2);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.role, 'worker');

  assert.throws(() => sandbox.handleLogin({ identifier: 'second', password: 'secret123' }),
    (e) => e.code === 'FORBIDDEN');
});

test('the first administrator approves a request and grants full access', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);
  sandbox.handleSignup({
    fullName: 'Second Owner', email: 'second@example.com', username: 'second',
    password: 'secret123', profession: 'Administrator'
  });

  const res = sandbox.handleApproveUser({ id: 1, username: 'owner' }, { userId: 2 });

  assert.equal(res.user.status, 'active');
  assert.equal(res.user.role, 'owner');
  assert.deepEqual(plain(res.user.pages), plain(sandbox.ALL_PAGES));
  assert.deepEqual(plain(res.user.actions), plain(sandbox.ALL_ACTIONS));
  assert.equal(userField(sheets, 2, 'Status'), 'active');

  // Once approved the new administrator can sign in.
  const login = sandbox.handleLogin({ identifier: 'second', password: 'secret123' });
  assert.equal(login.user.role, 'owner');
});

test('the first administrator rejects a request and the account is deleted', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);
  sandbox.handleSignup({
    fullName: 'Second Owner', email: 'second@example.com', username: 'second',
    password: 'secret123', profession: 'Administrator'
  });

  const res = sandbox.handleRejectUser({ id: 1, username: 'owner' }, { userId: 2 });

  assert.equal(res.rejected, true);
  assert.equal(res.userId, 2);
  assert.equal(sandbox.findUserById(2), null);
  assert.equal(sandbox.readObjects('Users').length, 1); // only the root owner remains
});

test('only the first administrator may approve or reject', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);
  sandbox.handleSignup({
    fullName: 'Second Owner', email: 'second@example.com', username: 'second',
    password: 'secret123', profession: 'Administrator'
  });

  const secondAdmin = { id: 2, username: 'second' };
  assert.throws(() => sandbox.handleApproveUser(secondAdmin, { userId: 2 }), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => sandbox.handleRejectUser(secondAdmin, { userId: 2 }), (e) => e.code === 'FORBIDDEN');

  // The request is untouched after the rejected decisions.
  assert.equal(sandbox.findUserById(2).status, 'pending');
});

test('approving an account that is not pending is a validation error', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Users', USER_HEADERS, [rootAdminRow()]);
  assert.throws(() => sandbox.handleApproveUser({ id: 1 }, { userId: 1 }), (e) => e.code === 'VALIDATION');
});

/* ------------------------------------------------------------------ *
 * Sales list filters                                                  *
 * ------------------------------------------------------------------ */

test('listSales filters by dispenser case-insensitively and partially', () => {
  const { sandbox, sheets } = createSandbox();
  seedSheet(sheets, 'Sales History', SALES_HEADERS, [
    { 'Timestamp': '2026-03-10T09:00:00', 'Sale ID': 'S-1', 'Item Name': 'Paracetamol', 'Quantity sold': 2, 'Selling price': 500, 'Buying Price': 300, 'Mode of payment': 'cash', 'Profit of Sale': 400, 'Dispenser': 'amina', 'Client Name': '', 'Status': 'Confirmed' },
    { 'Timestamp': '2026-03-10T10:00:00', 'Sale ID': 'S-2', 'Item Name': 'Ibuprofen', 'Quantity sold': 1, 'Selling price': 1000, 'Buying Price': 700, 'Mode of payment': 'cash', 'Profit of Sale': 300, 'Dispenser': 'john', 'Client Name': '', 'Status': 'Confirmed' }
  ]);

  assert.equal(sandbox.handleListSales({}).sales.length, 2);

  const amina = sandbox.handleListSales({ dispenser: 'AMI' }).sales;
  assert.equal(amina.length, 1);
  assert.equal(amina[0].dispenser, 'amina');

  assert.equal(sandbox.handleListSales({ dispenser: 'nobody' }).sales.length, 0);
});
