/**
 * Alerts.gs — stock-outs, low stock, and expiry banding.
 *
 * Expiry colour bands (brief): 6 months=green, 5=yellow, 4=purple, 3=pink, 2 and 1=deep red.
 * `monthsLeft` uses whole months (see Utils.monthsUntil) and never counts the current partial month up.
 */

function expiryBand(monthsLeft) {
  if (monthsLeft === null || monthsLeft === undefined) return null;
  if (monthsLeft >= 6) return 'green';
  if (monthsLeft === 5) return 'yellow';
  if (monthsLeft === 4) return 'purple';
  if (monthsLeft === 3) return 'pink';
  return 'deepred';
}

function computeAlerts() {
  var rows = readObjects('Inventory');
  var warningMonths = num(getSetting('EXPIRY_WARNING_MONTHS', '6'));
  var now = new Date();
  var stockouts = [], expiring = [];

  for (var i = 0; i < rows.length; i++) {
    var item = itemToApi(rows[i]);
    if (item.currentStock <= item.reorderLevel) {
      stockouts.push({
        item: item,
        isOut: item.currentStock <= 0,
        message: item.currentStock <= 0
          ? item.itemName + ' is OUT OF STOCK.'
          : item.itemName + ' is LOW (stock ' + item.currentStock + ' <= reorder ' + item.reorderLevel + ').'
      });
    }
    if (item.expiryDate) {
      var m = monthsUntil(item.expiryDate, now);
      if (m !== null && m <= warningMonths) {
        expiring.push({
          item: item, expiryDate: item.expiryDate, monthsLeft: m, band: expiryBand(m),
          message: item.itemName + ' expires in ' + m + ' month(s) (' + item.expiryDate + ').'
        });
      }
    }
  }

  stockouts.sort(function (a, b) { return a.item.currentStock - b.item.currentStock; });
  expiring.sort(function (a, b) { return a.monthsLeft - b.monthsLeft; });
  return { stockouts: stockouts, expiring: expiring, generatedAt: nowIso() };
}

function handleListAlerts() {
  return computeAlerts();
}

function handleListDLQ() {
  var rows = readObjects('Sync DLQ');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    out.push({
      timestamp: toIsoDateTime(rows[i]['Timestamp']),
      userId: rows[i]['User ID'],
      operation: parseJson(rows[i]['Operation'], rows[i]['Operation']),
      attempts: num(rows[i]['Attempts']),
      lastError: rows[i]['Last Error']
    });
  }
  out.reverse();
  return { rows: out };
}
