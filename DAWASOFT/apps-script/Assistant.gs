/**
 * Assistant.gs — drug lookup from the sheet (NO online AI, exactly as the brief requires).
 * Two search modes: by item name, and by "use" (description, e.g. "malaria treatment").
 */

function handleSearchItems(payload) {
  var q = String(payload.query || '').toLowerCase().trim();
  var rows = readObjects('Inventory');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var it = itemToApi(rows[i]);
    if (!q || it.itemName.toLowerCase().indexOf(q) !== -1) out.push(assistantItemToApi(rows[i]));
  }
  out.sort(function (a, b) { return a.itemName.localeCompare(b.itemName); });
  return { items: out.slice(0, 50) };
}

function handleSearchByUse(payload) {
  var use = String(payload.use || '').toLowerCase().trim();
  var rows = readObjects('Inventory');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var it = itemToApi(rows[i]);
    var haystack = (String(it.description) + ' ' + String(it.itemName)).toLowerCase();
    if (!use || haystack.indexOf(use) !== -1) out.push(assistantItemToApi(rows[i]));
  }
  out.sort(function (a, b) { return a.itemName.localeCompare(b.itemName); });
  return { items: out.slice(0, 50) };
}
