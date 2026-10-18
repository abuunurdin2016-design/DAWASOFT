/**
 * pages/sales-management.js — Sales management panel (page 10).
 * Shows the sales history and lets a permitted user edit an already-made sale:
 * add / remove a line, increase / decrease a quantity, or change the payment mode.
 */
(function () {
  PH.app.boot({ page: 10 }, function () {
    var sales = [];
    var inventory = [];

    var el = {
      from: document.getElementById('f-from'),
      to: document.getElementById('f-to'),
      mode: document.getElementById('f-mode'),
      status: document.getElementById('f-status'),
      item: document.getElementById('f-item'),
      dispenser: document.getElementById('f-dispenser'),
      apply: document.getElementById('sm-apply'),
      clear: document.getElementById('sm-clear'),
      list: document.getElementById('sm-list'),
      count: document.getElementById('sm-count')
    };

    /* --------------------------- list --------------------------- */

    function paymentBadge(mode) {
      return mode === 'cash' ? '<span class="badge cash">Cash</span>' : '<span class="badge lipa">Lipa Namba</span>';
    }

    function statusBadge(status) {
      return status === 'Confirmed' ? '<span class="badge ok">Confirmed</span>' : '<span class="badge warn">Need review</span>';
    }

    /** A sale is identified by the item(s) it contains, not by its opaque Sale ID. */
    function saleTitle(s) {
      var names = (s.items || []).map(function (l) { return l.itemName; });
      if (!names.length) return 'Sale';
      if (names.length === 1) return names[0];
      return names[0] + ' + ' + (names.length - 1) + ' more';
    }

    function render() {
      el.count.textContent = sales.length + ' sale' + (sales.length === 1 ? '' : 's');
      if (!sales.length) { el.list.innerHTML = '<p class="muted small">No sales match these filters.</p>'; return; }
      el.list.innerHTML = sales.map(function (s) {
        return '<div class="sm-row" data-id="' + PH.format.escape(s.saleId) + '">' +
          '<div class="grow"><strong>' + PH.format.escape(saleTitle(s)) + '</strong>' +
          '<div class="muted small">' + PH.format.dateTime(s.timestamp) + ' · ' + PH.format.escape(s.dispenser || '') +
          (s.clientName ? ' · ' + PH.format.escape(s.clientName) : '') + '</div>' +
          '<div class="muted small">' + s.items.length + ' item(s) · ' + PH.format.money(s.total) +
          ' · profit ' + PH.format.money(s.profit) + ' · ' + PH.format.escape(s.saleId) + '</div></div>' +
          '<div style="text-align:right">' + paymentBadge(s.paymentMode) + '<div class="mt">' + statusBadge(s.status) + '</div></div>' +
          '</div>';
      }).join('');
    }

    function query() {
      var p = {};
      if (el.from.value) p.from = el.from.value + 'T00:00:00';
      if (el.to.value) p.to = el.to.value + 'T23:59:59';
      if (el.mode.value) p.paymentMode = el.mode.value;
      if (el.status.value) p.status = el.status.value;
      if (el.item.value.trim()) p.itemName = el.item.value.trim();
      if (el.dispenser.value.trim()) p.dispenser = el.dispenser.value.trim();
      return p;
    }

    function load() {
      PH.ui.spinner.show('Loading sales…');
      return PH.api.call('listSales', query()).then(function (data) {
        PH.ui.spinner.hide();
        sales = data.sales || [];
        render();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not load sales', 'error');
      });
    }

    function loadInventory() {
      return PH.api.withCache('inventory', 'listInventory', {}).then(function (data) {
        inventory = data.items || [];
      }).catch(function () { inventory = []; });
    }

    /* --------------------------- detail --------------------------- */

    function detailHtml(s) {
      return '<table class="data"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>' +
        s.items.map(function (l) {
          return '<tr><td>' + PH.format.escape(l.itemName) + '</td><td>' + PH.format.number(l.quantity) + '</td>' +
            '<td>' + PH.format.money(l.sellingPrice) + '</td><td>' + PH.format.money(l.sellingPrice * l.quantity) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="list mt">' +
        '<div class="list-row"><div class="grow muted small">Sale ID</div><span>' + PH.format.escape(s.saleId) + '</span></div>' +
        '<div class="list-row"><div class="grow muted small">Total</div><strong>' + PH.format.money(s.total) + '</strong></div>' +
        '<div class="list-row"><div class="grow muted small">Payment</div>' + paymentBadge(s.paymentMode) + '</div>' +
        '<div class="list-row"><div class="grow muted small">Profit</div><strong>' + PH.format.money(s.profit) + '</strong></div>' +
        '<div class="list-row"><div class="grow muted small">Dispenser</div><span>' + PH.format.escape(s.dispenser || '') + '</span></div>' +
        '<div class="list-row"><div class="grow muted small">Status</div>' + statusBadge(s.status) + '</div>' +
        '</div>';
    }

    function openDetail(s) {
      var actions = [{ label: 'Close', value: null, class: 'btn-ghost' }];
      if (PH.perm.canDo('sales.edit')) actions.unshift({ label: 'Edit sale', value: 'edit', class: 'btn-primary' });
      if (PH.perm.canDo('sales.confirm') && s.status !== 'Confirmed') {
        actions.unshift({ label: 'Confirm', value: 'confirm', class: 'btn-success' });
      }
      PH.ui.modal({ title: saleTitle(s), html: detailHtml(s), actions: actions }).then(function (v) {
        if (v === 'edit') openEditor(s);
        if (v === 'confirm') confirmSale(s);
      });
    }

    function confirmSale(s) {
      PH.ui.spinner.show('Confirming…');
      PH.api.mutation('confirmSale', { saleId: s.saleId }).then(function () {
        PH.ui.spinner.hide();
        PH.ui.toast('Sale confirmed.', 'success');
        if (PH.perm.isOwner()) PH.sync.flush();
        return load();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not confirm the sale', 'error');
      });
    }

    /* --------------------------- editor --------------------------- */

    function openEditor(s) {
      var draft = {
        saleId: s.saleId,
        paymentMode: s.paymentMode,
        clientName: s.clientName || '',
        items: s.items.map(function (l) {
          return { itemName: l.itemName, quantity: l.quantity, sellingPrice: l.sellingPrice, buyingPrice: l.buyingPrice };
        })
      };

      PH.ui.modal({
        title: 'Edit ' + s.saleId,
        html: editorHtml(draft),
        actions: [
          { label: 'Save changes', class: 'btn-primary', collect: function () {
              var c = buildChanges(draft);
              return c ? { saleId: draft.saleId, changes: c } : null;
            } },
          { label: 'Cancel', value: null, class: 'btn-ghost' }
        ]
      }).then(function (res) {
        if (res && res.changes) saveEdit(res.saleId, res.changes);
      });

      var body = document.querySelector('.ph-modal-body');
      function repaint() { body.innerHTML = editorHtml(draft); wire(); }
      function wire() {
        body.querySelectorAll('.ed-qty').forEach(function (inp) {
          inp.oninput = function () {
            var i = parseInt(inp.getAttribute('data-i'), 10);
            draft.items[i].quantity = Math.max(1, parseInt(inp.value || '1', 10));
          };
        });
        body.querySelectorAll('.ed-remove').forEach(function (b) {
          b.onclick = function () {
            draft.items.splice(parseInt(b.getAttribute('data-i'), 10), 1);
            repaint();
          };
        });
        var sel = body.querySelector('#ed-mode');
        if (sel) sel.onchange = function () { draft.paymentMode = sel.value; };
        var cl = body.querySelector('#ed-client');
        if (cl) cl.oninput = function () { draft.clientName = cl.value; };
        var search = body.querySelector('#ed-search');
        if (search) {
          search.oninput = function () { renderAdd(search.value.trim()); };
        }
      }
      function renderAdd(q) {
        var host = body.querySelector('#ed-results');
        if (!q) { host.innerHTML = ''; return; }
        var ql = q.toLowerCase();
        var matches = inventory.filter(function (it) {
          return String(it.itemName).toLowerCase().indexOf(ql) !== -1;
        }).slice(0, 6);
        if (!matches.length) { host.innerHTML = '<p class="muted small">No matches.</p>'; return; }
        host.innerHTML = matches.map(function (it) {
          return '<div class="ed-result" data-id="' + PH.format.escape(it.itemId) + '">' +
            '<span>' + PH.format.escape(it.itemName) + '</span><span class="muted small">' + PH.format.money(it.rate) + '</span></div>';
        }).join('');
        host.querySelectorAll('.ed-result').forEach(function (r) {
          r.onclick = function () {
            var it = matches.filter(function (m) { return String(m.itemId) === r.getAttribute('data-id'); })[0];
            if (!it) return;
            var existing = draft.items.filter(function (l) { return l.itemName === it.itemName; })[0];
            if (existing) existing.quantity += 1;
            else draft.items.push({ itemName: it.itemName, quantity: 1, sellingPrice: Number(it.rate || 0), buyingPrice: Number(it.buyingPrice || 0) });
            repaint();
          };
        });
      }
      wire();
    }

    function editorHtml(d) {
      var total = d.items.reduce(function (s, l) { return s + l.sellingPrice * l.quantity; }, 0);
      return '<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th></th></tr></thead><tbody>' +
        (d.items.length ? d.items.map(function (l, i) {
          return '<tr><td>' + PH.format.escape(l.itemName) + '</td>' +
            '<td><input class="input ed-qty" type="number" min="1" step="1" value="' + l.quantity + '" data-i="' + i + '"></td>' +
            '<td>' + PH.format.money(l.sellingPrice) + '</td>' +
            '<td>' + PH.format.money(l.sellingPrice * l.quantity) + '</td>' +
            '<td><button class="icon-btn ed-remove" data-i="' + i + '" aria-label="Remove">' + PH.icon('trash', 18) + '</button></td></tr>';
        }).join('') : '<tr><td colspan="5" class="muted small">No items — add one below.</td></tr>') +
        '</tbody></table></div>' +
        '<div class="row between mt"><span class="muted">New total</span><strong>' + PH.format.money(total) + '</strong></div>' +
        '<div class="grid-2 mt">' +
        '<label class="field"><span>Payment mode</span><select class="input" id="ed-mode">' +
        '<option value="cash"' + (d.paymentMode === 'cash' ? ' selected' : '') + '>Cash</option>' +
        '<option value="lipa_namba"' + (d.paymentMode === 'lipa_namba' ? ' selected' : '') + '>Lipa Namba</option></select></label>' +
        '<label class="field"><span>Client name</span><input class="input" id="ed-client" value="' + PH.format.escape(d.clientName) + '"></label>' +
        '</div>' +
        '<label class="field"><span>Add an item</span><input class="input" id="ed-search" placeholder="Type an item name…" autocomplete="off"></label>' +
        '<div id="ed-results"></div>';
    }

    function buildChanges(d) {
      if (!d.items.length) { PH.ui.toast('A sale needs at least one item.', 'error'); return null; }
      return { items: d.items, paymentMode: d.paymentMode, clientName: d.clientName };
    }

    function saveEdit(saleId, changes) {
      PH.ui.spinner.show('Saving the sale…');
      PH.api.mutation('editSale', { saleId: saleId, changes: changes }).then(function (data) {
        PH.ui.spinner.hide();
        PH.ui.toast(data && data._queued ? 'Offline — the edit will sync automatically.' : 'Sale updated.', 'success');
        return load();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not update the sale', 'error');
      });
    }

    /* --------------------------- events --------------------------- */

    el.list.addEventListener('click', function (e) {
      var row = e.target.closest('.sm-row');
      if (!row) return;
      var s = sales.filter(function (x) { return x.saleId === row.getAttribute('data-id'); })[0];
      if (s) openDetail(s);
    });

    el.apply.onclick = load;
    el.clear.onclick = function () {
      el.from.value = ''; el.to.value = ''; el.mode.value = ''; el.status.value = '';
      el.item.value = ''; el.dispenser.value = '';
      load();
    };

    /* --------------------------- start --------------------------- */

    PH.ui.spinner.show('Loading…');
    Promise.all([loadInventory(), load()]).then(function () { PH.ui.spinner.hide(); });
  });
})();
