/**
 * pages/inventory.js — Inventory update (page 5).
 *
 * The brief asks for three options: (a) Update stock, (b) Add or Remove item, (c) Edit item.
 * Every write goes through PH.api.mutation(), so it also works offline (queued in the outbox and
 * synced automatically, de-duplicated by the server). Edits use optimistic locking via the
 * item's Last Update Date.
 */
(function () {
  PH.app.boot({ page: 5 }, function () {
    var inventory = [];
    var mode = 'stock';   // stock | addremove | edit
    var sub = 'add';      // add | remove  (only for mode === 'addremove')
    var selected = null;  // the chosen inventory item

    var el = {
      mode: document.getElementById('inv-mode'),
      subSeg: document.getElementById('sub-mode'),
      picker: document.getElementById('picker-card'),
      pickerLabel: document.getElementById('picker-label'),
      search: document.getElementById('item-search'),
      results: document.getElementById('item-results'),
      selectedBox: document.getElementById('item-selected'),
      stock: document.getElementById('stock-card'),
      stockItem: document.getElementById('stock-item'),
      stockCurrent: document.getElementById('stock-current'),
      stockQty: document.getElementById('stock-qty'),
      stockBuying: document.getElementById('stock-buying'),
      stockExpiry: document.getElementById('stock-expiry'),
      add: document.getElementById('add-card'),
      addForm: document.getElementById('add-form'),
      edit: document.getElementById('edit-card'),
      editForm: document.getElementById('edit-form'),
      editItemId: document.getElementById('edit-item-id')
    };

    /* --------------------------- the shared item form --------------------------- */

    var FIELDS = [
      ['itemName', 'Item name', 'text', true, 'e.g. Paracetamol 500mg'],
      ['category', 'Category', 'text', false, 'e.g. Analgesic'],
      ['description', 'Description', 'textarea', false, 'What it is used for'],
      ['uom', 'UOM', 'text', false, 'e.g. tablet'],
      ['buyingPrice', 'Buying price', 'number', false, ''],
      ['rate', 'Rate (selling price)', 'number', false, ''],
      ['currentStock', 'Current stock', 'number', false, ''],
      ['reorderLevel', 'Reorder level', 'number', false, ''],
      ['expiryDate', 'Expiry date', 'date', false, ''],
      ['dosage', 'Dosage', 'text', false, 'e.g. 1 tablet twice daily'],
      ['contraindications', 'Contraindications', 'text', false, 'When it must not be used']
    ];

    function fieldHtml(prefix, f) {
      var id = prefix + '-' + f[0];
      var label = '<label class="field"><span>' + f[1] + (f[3] ? ' *' : '') + '</span>';
      if (f[2] === 'textarea') {
        return label + '<textarea class="input" id="' + id + '" placeholder="' + f[4] + '"></textarea></label>';
      }
      var step = f[2] === 'number' ? ' step="0.01" min="0"' : '';
      return label + '<input class="input" type="' + f[2] + '"' + step + ' id="' + id +
        '" placeholder="' + f[4] + '" autocomplete="off"></label>';
    }

    function formHtml(prefix) {
      return '<div class="grid-2">' + fieldHtml(prefix, FIELDS[0]) + fieldHtml(prefix, FIELDS[1]) + '</div>' +
        fieldHtml(prefix, FIELDS[2]) +
        '<div class="grid-3">' + fieldHtml(prefix, FIELDS[3]) + fieldHtml(prefix, FIELDS[4]) + fieldHtml(prefix, FIELDS[5]) + '</div>' +
        '<div class="grid-3">' + fieldHtml(prefix, FIELDS[6]) + fieldHtml(prefix, FIELDS[7]) + fieldHtml(prefix, FIELDS[8]) + '</div>' +
        fieldHtml(prefix, FIELDS[9]) + fieldHtml(prefix, FIELDS[10]);
    }

    var NUMERIC = ['buyingPrice', 'rate', 'currentStock', 'reorderLevel'];

    function readForm(prefix) {
      var out = {};
      FIELDS.forEach(function (f) {
        var raw = (document.getElementById(prefix + '-' + f[0]).value || '').trim();
        out[f[0]] = NUMERIC.indexOf(f[0]) !== -1 ? (raw === '' ? 0 : Number(raw)) : raw;
      });
      return out;
    }

    function fillForm(prefix, item) {
      FIELDS.forEach(function (f) {
        var v = item[f[0]];
        if (v === undefined || v === null) v = f[0] === 'currentStock' || f[0] === 'reorderLevel' ? 0 : '';
        document.getElementById(prefix + '-' + f[0]).value = v;
      });
    }

    el.addForm.innerHTML = formHtml('ad');
    el.editForm.innerHTML = formHtml('ed');

    /* --------------------------- permission-aware modes --------------------------- */

    var MODES = [
      { key: 'stock', action: 'inventory.restock' },
      { key: 'addremove', action: null },
      { key: 'edit', action: 'inventory.edit' }
    ];

    function modeAllowed(key) {
      if (key === 'stock') return PH.perm.canDo('inventory.restock');
      if (key === 'edit') return PH.perm.canDo('inventory.edit');
      if (key === 'addremove') return PH.perm.canDo('inventory.add') || PH.perm.canDo('inventory.remove');
      return true;
    }

    function applyPermissionMask() {
      MODES.forEach(function (m) {
        var b = el.mode.querySelector('[data-mode="' + m.key + '"]');
        if (b && !modeAllowed(m.key)) b.classList.add('hidden');
      });
      el.subSeg.querySelector('[data-sub="add"]').classList.toggle('hidden', !PH.perm.canDo('inventory.add'));
      el.subSeg.querySelector('[data-sub="remove"]').classList.toggle('hidden', !PH.perm.canDo('inventory.remove'));
      // choose the first permitted mode
      if (!modeAllowed(mode)) {
        var first = MODES.filter(function (m) { return modeAllowed(m.key); })[0];
        if (first) mode = first.key;
      }
      if (mode === 'addremove' && sub === 'add' && !PH.perm.canDo('inventory.add')) sub = 'remove';
      if (mode === 'addremove' && sub === 'remove' && !PH.perm.canDo('inventory.remove')) sub = 'add';
      syncModeButtons();
      if (el.mode.querySelectorAll('button:not(.hidden)').length === 0) {
        PH.ui.toast('You have no inventory permissions. Ask the owner.', 'info');
      }
    }

    function syncModeButtons() {
      Array.prototype.forEach.call(el.mode.children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
      el.subSeg.classList.toggle('hidden', mode !== 'addremove');
      Array.prototype.forEach.call(el.subSeg.children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-sub') === sub);
      });
    }

    /* --------------------------- data --------------------------- */

    function loadInventory() {
      return PH.api.withCache('inventory', 'listInventory', {}).then(function (data) {
        inventory = data.items || [];
        if (data._fromCache) PH.ui.toast('Showing offline inventory', 'info');
      });
    }

    /* --------------------------- render --------------------------- */

    function renderSelected() {
      if (!selected) { el.selectedBox.innerHTML = ''; return; }
      var isRemove = mode === 'addremove' && sub === 'remove';
      var out = selected.currentStock <= 0;
      el.selectedBox.innerHTML =
        '<div class="list-row"><span class="lead">' + PH.icon('pill', 18) + '</span>' +
        '<div class="grow"><strong>' + PH.format.escape(selected.itemName) + '</strong>' +
        '<div class="cart-line-info">' + PH.format.escape(selected.category || '') +
        ' · Stock ' + PH.format.number(selected.currentStock) + ' ' + PH.format.escape(selected.uom || '') +
        (out ? ' · <span class="badge danger">Out of stock</span>' : '') + '</div></div>' +
        (isRemove ? '<button class="btn btn-sm btn-danger" id="remove-selected">' + PH.icon('trash', 16) + ' Remove</button>' : '') +
        '</div>';
      var rb = document.getElementById('remove-selected');
      if (rb) rb.onclick = doRemove;
    }

    function render() {
      var isStock = mode === 'stock';
      var isAdd = mode === 'addremove' && sub === 'add';
      var isRemove = mode === 'addremove' && sub === 'remove';
      var isEdit = mode === 'edit';
      var needsPicker = isStock || isRemove || isEdit;

      el.picker.classList.toggle('hidden', !needsPicker);
      el.add.classList.toggle('hidden', !isAdd);
      el.stock.classList.toggle('hidden', !(isStock && !!selected));
      el.edit.classList.toggle('hidden', !(isEdit && !!selected));

      el.pickerLabel.textContent = isStock ? 'Find the item to restock'
        : isRemove ? 'Find the item to remove' : 'Find the item to edit';

      if (isStock && selected) {
        el.stockItem.textContent = selected.itemName;
        el.stockCurrent.textContent = 'Current stock: ' + PH.format.number(selected.currentStock) + ' ' +
          (selected.uom || '') + ' · Rate ' + PH.format.money(selected.rate);
      }
      if (isEdit && selected) {
        el.editItemId.textContent = selected.itemId;
        fillForm('ed', selected);
      }
      renderSelected();
    }

    function renderResults(q) {
      q = (q || '').trim().toLowerCase();
      if (!q) { el.results.classList.add('hidden'); return; }
      var matches = inventory.filter(function (it) {
        return String(it.itemName).toLowerCase().indexOf(q) !== -1 ||
          String(it.description).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 8);
      if (!matches.length) {
        el.results.innerHTML = '<p class="muted small" style="padding:.6rem">No matches.</p>';
        el.results.classList.remove('hidden');
        return;
      }
      el.results.innerHTML = matches.map(function (it) {
        return '<div class="result-item" data-id="' + PH.format.escape(it.itemId) + '">' +
          '<span>' + PH.format.escape(it.itemName) + ' <span class="cart-line-info">' +
          PH.format.escape(it.uom || '') + '</span></span>' +
          '<span class="cart-line-info">Stock ' + PH.format.number(it.currentStock) + '</span></div>';
      }).join('');
      el.results.classList.remove('hidden');
    }

    /* --------------------------- events --------------------------- */

    el.mode.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.classList.contains('hidden')) return;
      mode = b.getAttribute('data-mode');
      selected = null;
      el.search.value = '';
      el.results.classList.add('hidden');
      syncModeButtons();
      render();
    });

    el.subSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.classList.contains('hidden')) return;
      sub = b.getAttribute('data-sub');
      selected = null;
      el.search.value = '';
      el.results.classList.add('hidden');
      syncModeButtons();
      render();
    });

    el.search.addEventListener('input', function () { renderResults(el.search.value); });

    el.results.addEventListener('click', function (e) {
      var row = e.target.closest('.result-item');
      if (!row) return;
      selected = inventory.filter(function (i) { return String(i.itemId) === row.getAttribute('data-id'); })[0] || null;
      el.search.value = selected ? selected.itemName : '';
      el.results.classList.add('hidden');
      el.search.value = '';
      render();
    });

    /* --------------------------- actions --------------------------- */

    function afterWrite(msg, extra) {
      return function (data) {
        PH.ui.spinner.hide();
        if (data && data._queued) PH.ui.toast('Offline — saved and will sync automatically.', 'success');
        else PH.ui.toast(msg, 'success');
        selected = null;
        el.search.value = '';
        el.results.classList.add('hidden');
        return loadInventory().then(function () {
          render();
          PH.ui.modal({
            title: 'Done',
            html: '<p>' + PH.format.escape(msg) + '</p>' + (extra || ''),
            actions: [{ label: 'OK', value: null, class: 'btn-primary' }]
          });
        });
      };
    }

    function failOp(err) {
      PH.ui.spinner.hide();
      PH.ui.toast((err && err.message) || 'Could not save the change', 'error');
    }

    document.getElementById('stock-submit').onclick = function () {
      if (!selected) return;
      var qty = Number(el.stockQty.value);
      if (!(qty > 0)) { PH.ui.toast('Enter a quantity greater than zero.', 'error'); return; }
      var payload = { itemId: selected.itemId, quantityAdded: qty };
      if (el.stockBuying.value !== '') payload.buyingPricePerUom = Number(el.stockBuying.value);
      if (el.stockExpiry.value) payload.expiryDate = el.stockExpiry.value;
      var name = selected.itemName;
      PH.ui.spinner.show('Updating stock…');
      PH.api.mutation('restockItem', payload).then(function (data) {
        el.stockQty.value = ''; el.stockBuying.value = ''; el.stockExpiry.value = '';
        var line = data && data.item ? '<p class="small muted">New stock: ' + PH.format.number(data.item.currentStock) + '</p>' : '';
        return afterWrite('Stock updated for ' + name, line)(data);
      }).catch(failOp);
    };

    document.getElementById('add-submit').onclick = function () {
      var item = readForm('ad');
      if (!item.itemName) { PH.ui.toast('Item name is required.', 'error'); return; }
      PH.ui.spinner.show('Adding item…');
      PH.api.mutation('addItem', { item: item }).then(function (data) {
        FIELDS.forEach(function (f) { document.getElementById('ad-' + f[0]).value = ''; });
        afterWrite('Item added: ' + item.itemName)(data);
      }).catch(failOp);
    };

    function doRemove() {
      if (!selected) return;
      var it = selected;
      PH.ui.confirm('Remove "' + it.itemName + '" from inventory? This cannot be undone.', { danger: true, confirmLabel: 'Remove' })
        .then(function (yes) {
          if (!yes) return;
          PH.ui.spinner.show('Removing…');
          return PH.api.mutation('removeItem', { itemId: it.itemId }).then(afterWrite('Item removed: ' + it.itemName)).catch(failOp);
        });
    }

    document.getElementById('edit-submit').onclick = function () {
      if (!selected) return;
      var changes = readForm('ed');
      if (!changes.itemName) { PH.ui.toast('Item name is required.', 'error'); return; }
      PH.ui.spinner.show('Saving changes…');
      PH.api.mutation('editItem', {
        itemId: selected.itemId,
        changes: changes,
        expectedLastUpdate: selected.lastUpdateDate
      }).then(afterWrite('Changes saved for ' + changes.itemName)).catch(failOp);
    };

    /* --------------------------- start --------------------------- */

    applyPermissionMask();
    PH.ui.spinner.show('Loading inventory…');
    loadInventory().then(function () {
      PH.ui.spinner.hide();
      render();
    }).catch(function (err) {
      PH.ui.spinner.hide();
      PH.ui.toast(err.message || 'Could not load inventory', 'error');
    });
  });
})();
