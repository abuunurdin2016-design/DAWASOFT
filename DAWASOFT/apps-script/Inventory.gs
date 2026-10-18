/**
 * Inventory.gs — stock CRUD, restock, restock history.
 *
 * Checklist mapping: optimistic locking (expectedLastUpdate), audit trail, restock history sheet,
 * single-read batch lookups (no N+1).
 */

function inventoryRowFromApi(item, existingRow) {
  return {
    'Item ID': item.itemId,
    'Item name': item.itemName,
    'Description': item.description || '',
    'Category': item.category || '',
    'UOM': item.uom || '',
    'Buying Price': num(item.buyingPrice),
    'Rate': num(item.rate),
    'Current Stock': num(item.currentStock),
    'Reorder Level': num(item.reorderLevel),
    'Expiry Date': item.expiryDate ? toIsoDate(item.expiryDate) : '',
    'Dosage': item.dosage || '',
    'Contraindications': item.contraindications || '',
    'Last Update Date': item.lastUpdateDate || nowIso(),
    'Last Updater': item.lastUpdater || ''
  };
}

function nextItemId(items) {
  var max = 0;
  for (var i = 0; i < items.length; i++) {
    var m = /^ITM-(\d+)$/.exec(String(items[i]['Item ID'] || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'ITM-' + ('0000' + (max + 1)).slice(-4);
}

function handleListInventory(payload) {
  var items = readObjects('Inventory');
  var q = String(payload.query || '').toLowerCase();
  var category = String(payload.category || '').toLowerCase();
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = itemToApi(items[i]);
    if (q && it.itemName.toLowerCase().indexOf(q) === -1 && String(it.description).toLowerCase().indexOf(q) === -1) continue;
    if (category && String(it.category).toLowerCase() !== category) continue;
    if (payload.lowStockOnly && !(it.currentStock <= it.reorderLevel)) continue;
    out.push(it);
  }
  out.sort(function (a, b) { return a.itemName.localeCompare(b.itemName); });
  return { items: out };
}

function handleGetItem(payload) {
  var rows = readObjects('Inventory');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i]['Item ID']) === String(payload.itemId)) return { item: itemToApi(rows[i]) };
  }
  throw appError('NOT_FOUND', 'Item not found.');
}

function handleAddItem(user, payload) {
  var item = payload.item || {};
  if (!trim(item.itemName)) throw appError('VALIDATION', 'Item name is required.');
  var items = readObjects('Inventory');
  for (var i = 0; i < items.length; i++) {
    if (String(items[i]['Item name']).toLowerCase() === String(item.itemName).toLowerCase()) {
      throw appError('CONFLICT', 'An item with this name already exists.');
    }
  }
  item.itemId = nextItemId(items);
  item.lastUpdateDate = nowIso();
  item.lastUpdater = user.username;
  appendObject('Inventory', inventoryRowFromApi(item));
  writeAudit(user, 'add_item', 'Inventory', item.itemId, 'success', { itemName: item.itemName });
  return { item: itemToApi(inventoryRowFromApi(item)) };
}

function handleRemoveItem(user, payload) {
  var rows = readObjects('Inventory');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i]['Item ID']) === String(payload.itemId)) {
      deleteRow('Inventory', rows[i].__row);
      writeAudit(user, 'remove_item', 'Inventory', payload.itemId, 'success', { itemName: rows[i]['Item name'] });
      return { removed: true };
    }
  }
  throw appError('NOT_FOUND', 'Item not found.');
}

function handleEditItem(user, payload) {
  var rows = readObjects('Inventory');
  var row = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['Item ID']) === String(payload.itemId)) { row = rows[i]; break; }
  if (!row) throw appError('NOT_FOUND', 'Item not found.');

  // Optimistic locking: reject if someone else changed the row since the client loaded it.
  if (payload.expectedLastUpdate && String(row['Last Update Date']) !== String(payload.expectedLastUpdate)) {
    throw appError('CONFLICT', 'This item was modified by someone else. Reload and try again.');
  }

  var current = itemToApi(row);
  var changes = payload.changes || {};
  for (var k in changes) if (current.hasOwnProperty(k)) current[k] = changes[k];
  current.lastUpdateDate = nowIso();
  current.lastUpdater = user.username;
  writeRow('Inventory', row.__row, inventoryRowFromApi(current));
  writeAudit(user, 'edit_item', 'Inventory', payload.itemId, 'success', { changes: changes });
  return { item: current };
}

function handleRestockItem(user, payload) {
  var qty = num(payload.quantityAdded);
  if (qty <= 0) throw appError('VALIDATION', 'Quantity must be greater than zero.');

  var rows = readObjects('Inventory');
  var row = null;
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['Item ID']) === String(payload.itemId)) { row = rows[i]; break; }
  if (!row) throw appError('NOT_FOUND', 'Item not found.');

  var item = itemToApi(row);
  item.currentStock = num(item.currentStock) + qty;
  if (payload.buyingPricePerUom !== undefined && payload.buyingPricePerUom !== '') item.buyingPrice = num(payload.buyingPricePerUom);
  if (payload.expiryDate) item.expiryDate = toIsoDate(payload.expiryDate);
  item.lastUpdateDate = nowIso();
  item.lastUpdater = user.username;
  writeRow('Inventory', row.__row, inventoryRowFromApi(item));

  var restock = {
    timestamp: nowIso(), itemId: item.itemId, item: item.itemName, quantityAdded: qty,
    resultantQuantity: item.currentStock, buyingPricePerUom: num(item.buyingPrice), updater: user.username
  };
  appendObject('Item Restock History', unpick(FIELDS.restock, restock));
  writeAudit(user, 'restock_item', 'Inventory', item.itemId, 'success', { quantityAdded: qty, resultant: item.currentStock });
  return { item: item, restock: restock };
}

function handleListRestockHistory(payload) {
  var rows = readObjects('Item Restock History');
  var from = payload.from ? parseDate(payload.from) : null;
  var to = payload.to ? parseDate(payload.to) : null;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (payload.itemId && String(r['Item ID']) !== String(payload.itemId)) continue;
    var t = parseDate(r['Timestamp']);
    if (from && t && t < from) continue;
    if (to && t && t > to) continue;
    out.push({
      timestamp: toIsoDateTime(r['Timestamp']), itemId: r['Item ID'], item: r['Item'],
      quantityAdded: num(r['Quantity Added']), resultantQuantity: num(r['Resultant Quantity']),
      buyingPricePerUom: num(r['Buying Price Per UOM']), updater: r['Updater']
    });
  }
  out.reverse();
  return { rows: out };
}
