/**
 * Sales.gs — POS sales, sales history, edit-sale, confirm-sale, plus the stock
 * side-effect (a confirmed sale reduces Current Stock so stock-out alerts stay honest).
 *
 * The Sales History sheet stores ONE ROW PER LINE ITEM, grouped by a shared "Sale ID".
 * createSale is de-duplicated by the router using the request idempotency key.
 */

function shortId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function saleRowFromLine(line, meta) {
  return {
    'Timestamp': meta.timestampIso,
    'Sale ID': meta.saleId,
    'Item Name': line.itemName,
    'Quantity sold': num(line.quantity),
    'Selling price': num(line.sellingPrice),
    'Buying Price': num(line.buyingPrice),
    'Mode of payment': meta.paymentMode,
    'Profit of Sale': (num(line.sellingPrice) - num(line.buyingPrice)) * num(line.quantity),
    'Dispenser': meta.dispenser,
    'Client Name': meta.clientName || '',
    'Status': meta.status
  };
}

function saleApiFromRows(rows) {
  if (!rows || !rows.length) return null;
  var first = rows[0];
  var items = [], total = 0, profit = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var line = {
      itemName: r['Item Name'], quantity: num(r['Quantity sold']),
      sellingPrice: num(r['Selling price']), buyingPrice: num(r['Buying Price']),
      profit: num(r['Profit of Sale'])
    };
    total += line.sellingPrice * line.quantity;
    profit += line.profit;
    items.push(line);
  }
  var paymentMode = first['Mode of payment'];
  return {
    saleId: first['Sale ID'],
    timestamp: toIsoDateTime(first['Timestamp']),
    items: items,
    total: total,
    cashAmount: paymentMode === 'cash' ? total : 0,
    lipaNambaAmount: paymentMode === 'lipa_namba' ? total : 0,
    paymentMode: paymentMode,
    dispenser: first['Dispenser'],
    clientName: first['Client Name'],
    status: first['Status'],
    profit: profit
  };
}

function allSalesGrouped() {
  var rows = readObjects('Sales History');
  var map = {};
  var order = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i]['Sale ID']);
    if (!map[id]) { map[id] = []; order.push(id); }
    map[id].push(rows[i]);
  }
  return { map: map, order: order };
}

/** Reduce (negative delta) or increase inventory stock for one item. */
function adjustStock(user, itemId, itemName, delta) {
  if (!delta) return false;
  var rows = readObjects('Inventory');
  for (var i = 0; i < rows.length; i++) {
    var match = itemId ? String(rows[i]['Item ID']) === String(itemId)
                       : String(rows[i]['Item name']) === String(itemName);
    if (match) {
      var item = itemToApi(rows[i]);
      item.currentStock = Math.max(0, num(item.currentStock) + delta);
      item.lastUpdateDate = nowIso();
      item.lastUpdater = user.username;
      writeRow('Inventory', rows[i].__row, inventoryRowFromApi(item));
      return true;
    }
  }
  return false;
}

function handleCreateSale(user, payload) {
  var items = payload.items || [];
  if (!items.length) throw appError('VALIDATION', 'A sale needs at least one item.');
  var mode = payload.paymentMode === 'lipa_namba' ? 'lipa_namba' : 'cash';

  var ts = payload.timestamp ? parseDate(payload.timestamp) : new Date();
  var tsIso = ts ? toIsoDateTime(ts) : toIsoDateTime(new Date());
  var meta = {
    saleId: payload.saleId || ('S-' + tsIso.replace(/[-:T]/g, '').slice(0, 14) + '-' + shortId()),
    timestampIso: tsIso,
    paymentMode: mode,
    dispenser: user.username,
    clientName: payload.clientName || '',
    status: 'Confirmed'
  };

  for (var i = 0; i < items.length; i++) {
    if (!trim(items[i].itemName)) throw appError('VALIDATION', 'Every line needs an item name.');
    if (num(items[i].quantity) <= 0) throw appError('VALIDATION', 'Quantity must be greater than zero for ' + items[i].itemName + '.');
    appendObject('Sales History', saleRowFromLine(items[i], meta));
    adjustStock(user, items[i].itemId, items[i].itemName, -num(items[i].quantity));
  }
  writeAudit(user, 'create_sale', 'Sale', meta.saleId, 'success', { items: items.length, mode: mode });

  var group = allSalesGrouped();
  return { sale: saleApiFromRows(group.map[meta.saleId]) };
}

function handleListSales(payload) {
  var group = allSalesGrouped();
  var from = payload.from ? parseDate(payload.from) : null;
  var to = payload.to ? parseDate(payload.to) : null;
  var out = [];
  for (var i = 0; i < group.order.length; i++) {
    var sale = saleApiFromRows(group.map[group.order[i]]);
    var t = parseDate(sale.timestamp);
    if (from && t && t < from) continue;
    if (to && t && t > to) continue;
    if (payload.paymentMode && sale.paymentMode !== payload.paymentMode) continue;
    if (payload.userId && sale.dispenser !== payload.userId) continue;
    if (payload.dispenser && String(sale.dispenser || '').toLowerCase().indexOf(String(payload.dispenser).toLowerCase()) === -1) continue;
    if (payload.status && sale.status !== payload.status) continue;
    if (payload.itemName) {
      var has = false;
      for (var j = 0; j < sale.items.length; j++) if (sale.items[j].itemName.toLowerCase().indexOf(String(payload.itemName).toLowerCase()) !== -1) has = true;
      if (!has) continue;
    }
    out.push(sale);
  }
  out.sort(function (a, b) { return a.timestamp < b.timestamp ? 1 : -1; });
  return { sales: out };
}

function handleGetSale(payload) {
  var group = allSalesGrouped();
  var rows = group.map[String(payload.saleId)];
  if (!rows) throw appError('NOT_FOUND', 'Sale not found.');
  return { sale: saleApiFromRows(rows) };
}

function handleEditSale(user, payload) {
  var group = allSalesGrouped();
  var saleId = String(payload.saleId);
  var rows = group.map[saleId];
  if (!rows) throw appError('NOT_FOUND', 'Sale not found.');

  var existing = saleApiFromRows(rows);
  var changes = payload.changes || {};

  // Reverse the old stock effect, then re-apply the new one (net adjustment).
  for (var i = 0; i < rows.length; i++) {
    adjustStock(user, null, rows[i]['Item Name'], num(rows[i]['Quantity sold']));
  }

  var newItems = changes.items || existing.items;
  var newMode = changes.paymentMode || existing.paymentMode;
  var newClient = changes.clientName !== undefined ? changes.clientName : existing.clientName;
  var newStatus = changes.status || 'Need Review';

  var meta = {
    saleId: saleId, timestampIso: existing.timestamp, paymentMode: newMode,
    dispenser: existing.dispenser, clientName: newClient, status: newStatus
  };

  // Rewrite the block: delete old rows (bottom-up) then append the new lines.
  for (var r = rows.length - 1; r >= 0; r--) deleteRow('Sales History', rows[r].__row);
  for (var n = 0; n < newItems.length; n++) {
    appendObject('Sales History', saleRowFromLine(newItems[n], meta));
    adjustStock(user, newItems[n].itemId, newItems[n].itemName, -num(newItems[n].quantity));
  }
  writeAudit(user, 'edit_sale', 'Sale', saleId, 'success', { changes: changes });

  var updated = allSalesGrouped();
  return { sale: saleApiFromRows(updated.map[saleId]) };
}

function handleConfirmSale(user, payload) {
  var group = allSalesGrouped();
  var saleId = String(payload.saleId);
  var rows = group.map[saleId];
  if (!rows) throw appError('NOT_FOUND', 'Sale not found.');
  for (var i = 0; i < rows.length; i++) {
    var hk = {};
    for (var k in rows[i]) if (k !== '__row') hk[k] = rows[i][k];
    hk['Status'] = 'Confirmed';
    writeRow('Sales History', rows[i].__row, hk);
  }
  writeAudit(user, 'confirm_sale', 'Sale', saleId, 'success');
  var updated = allSalesGrouped();
  return { sale: saleApiFromRows(updated.map[saleId]) };
}
