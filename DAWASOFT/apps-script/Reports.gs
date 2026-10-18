/**
 * Reports.gs — daily / weekly / monthly / annual aggregation.
 *
 * The aggregation core (`summarizeRows`) is a pure function of the row list + a date filter, so
 * it is mirrored by the unit tests in /tests. "Sales count" = distinct Sale IDs, not row count.
 */

function summarizeRows(rows) {
  var seen = {};
  var s = { salesCount: 0, itemsSold: 0, cashAmount: 0, lipaNambaAmount: 0, totalAmount: 0, profit: 0 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var id = String(r['Sale ID']);
    if (!seen[id]) { seen[id] = true; s.salesCount++; }
    var qty = num(r['Quantity sold']);
    var amt = num(r['Selling price']) * qty;
    s.itemsSold += qty;
    s.totalAmount += amt;
    if (String(r['Mode of payment']) === 'cash') s.cashAmount += amt; else s.lipaNambaAmount += amt;
    s.profit += num(r['Profit of Sale']);
  }
  return s;
}

function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d) { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { var x = startOfDay(d); var day = (x.getDay() + 6) % 7; return addDays(x, -day); } // Monday
function startOfMonth(d) { var x = startOfDay(d); x.setDate(1); return x; }
function startOfYear(d) { var x = startOfMonth(d); x.setMonth(0); return x; }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

function rowsInRange(rows, from, to) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var t = parseDate(rows[i]['Timestamp']);
    if (!t) continue;
    if (t >= from && t <= to) out.push(rows[i]);
  }
  return out;
}

function reportRange(rows, from, to) {
  return { summary: summarizeRows(rowsInRange(rows, from, to)) };
}

function handleDailyReport(payload) {
  var rows = readObjects('Sales History');
  var day = payload.date ? parseDate(payload.date) : new Date();
  var from = startOfDay(day), to = endOfDay(day);
  var summary = summarizeRows(rowsInRange(rows, from, to));
  return { summary: summary, series: [{ label: toIsoDate(day), summary: summary }] };
}

function handleWeeklyReport(payload) {
  var rows = readObjects('Sales History');
  var ref = payload.date ? parseDate(payload.date) : new Date();
  var start = startOfWeek(ref);
  var names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var series = [], total = { salesCount: 0, itemsSold: 0, cashAmount: 0, lipaNambaAmount: 0, totalAmount: 0, profit: 0 };
  for (var i = 0; i < 7; i++) {
    var d = addDays(start, i);
    var s = summarizeRows(rowsInRange(rows, startOfDay(d), endOfDay(d)));
    series.push({ label: names[i], date: toIsoDate(d), summary: s });
    addSummary(total, s);
  }
  return { summary: total, series: series };
}

function handleMonthlyReport(payload) {
  var rows = readObjects('Sales History');
  var ref = payload.month ? parseDate(payload.month + '-01') : new Date();
  var y = ref.getFullYear(), m = ref.getMonth();
  var total = { salesCount: 0, itemsSold: 0, cashAmount: 0, lipaNambaAmount: 0, totalAmount: 0, profit: 0 };
  var series = [];
  var dim = daysInMonth(y, m);
  for (var w = 0; w < 5; w++) {
    var d1 = 1 + w * 7; if (d1 > dim) break;
    var d2 = Math.min(d1 + 6, dim);
    var from = new Date(y, m, d1, 0, 0, 0, 0), to = new Date(y, m, d2, 23, 59, 59, 999);
    var s = summarizeRows(rowsInRange(rows, from, to));
    series.push({ label: 'Week ' + (w + 1), from: toIsoDate(from), to: toIsoDate(to), summary: s });
    addSummary(total, s);
  }
  return { summary: total, series: series };
}

function handleAnnualReport(payload) {
  var rows = readObjects('Sales History');
  var year = payload.year ? num(payload.year) : new Date().getFullYear();
  var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var total = { salesCount: 0, itemsSold: 0, cashAmount: 0, lipaNambaAmount: 0, totalAmount: 0, profit: 0 };
  var series = [];
  for (var m = 0; m < 12; m++) {
    var from = new Date(year, m, 1, 0, 0, 0, 0), to = new Date(year, m + 1, 0, 23, 59, 59, 999);
    var s = summarizeRows(rowsInRange(rows, from, to));
    series.push({ label: names[m], month: m + 1, summary: s });
    addSummary(total, s);
  }
  return { summary: total, series: series };
}

function handleDashboard(payload) {
  var rows = readObjects('Sales History');
  var ref = payload.date ? parseDate(payload.date) : new Date();
  var wkStart = startOfWeek(ref), wkEnd = addDays(wkStart, 6);
  var moStart = startOfMonth(ref), moEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);
  var yrStart = startOfYear(ref), yrEnd = new Date(ref.getFullYear(), 11, 31, 23, 59, 59, 999);
  return {
    day: summarizeRows(rowsInRange(rows, startOfDay(ref), endOfDay(ref))),
    week: summarizeRows(rowsInRange(rows, wkStart, endOfDay(wkEnd))),
    month: summarizeRows(rowsInRange(rows, moStart, moEnd)),
    year: summarizeRows(rowsInRange(rows, yrStart, yrEnd))
  };
}

function addSummary(acc, s) {
  acc.salesCount += s.salesCount; acc.itemsSold += s.itemsSold;
  acc.cashAmount += s.cashAmount; acc.lipaNambaAmount += s.lipaNambaAmount;
  acc.totalAmount += s.totalAmount; acc.profit += s.profit;
  return acc;
}
