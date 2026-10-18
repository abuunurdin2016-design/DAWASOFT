/**
 * pages/sales.js — the point of sale.
 * Works offline: a confirmed sale while offline is queued in the outbox and synced automatically
 * (idempotent, so it can never be recorded twice).
 */
(function () {
  PH.app.boot({ page: 3 }, function (user) {
    var inventory = [];
    var cart = [];           // { itemId, itemName, quantity, sellingPrice, buyingPrice, uom, dosage, contraindications }
    var paymentMode = 'cash';

    var el = {
      search: document.getElementById('sales-search'),
      results: document.getElementById('sales-results'),
      body: document.getElementById('sales-cart-body'),
      empty: document.getElementById('cart-empty'),
      count: document.getElementById('cart-count'),
      total: document.getElementById('sales-total'),
      confirm: document.getElementById('confirm-sale'),
      client: document.getElementById('client-name')
    };

    /* ------------------------------- data ------------------------------- */
    function loadInventory() {
      return PH.api.withCache('inventory', 'listInventory', {}).then(function (data) {
        inventory = data.items || [];
        if (data._fromCache) PH.ui.toast('Showing offline inventory', 'info');
      }).catch(function (err) { PH.ui.toast(err.message || 'Could not load inventory', 'error'); });
    }

    /* ------------------------------- search ------------------------------- */
    function renderResults(q) {
      q = (q || '').trim().toLowerCase();
      if (!q) { el.results.classList.add('hidden'); return; }
      var matches = inventory.filter(function (it) {
        return it.itemName.toLowerCase().indexOf(q) !== -1 || String(it.description).toLowerCase().indexOf(q) !== -1;
      }).slice(0, 8);
      if (!matches.length) { el.results.classList.add('hidden'); return; }
      el.results.innerHTML = matches.map(function (it) {
        var out = it.currentStock <= 0;
        return '<div class="result-item" data-id="' + PH.format.escape(it.itemId) + '">' +
          '<span>' + PH.format.escape(it.itemName) + ' <span class="cart-line-info">' + PH.format.escape(it.uom || '') + '</span></span>' +
          '<span class="' + (out ? 'badge danger' : 'muted') + '">' + (out ? 'Out of stock' : PH.format.money(it.rate)) + '</span>' +
          '</div>';
      }).join('');
      el.results.classList.remove('hidden');
    }

    el.search.addEventListener('input', function () { renderResults(el.search.value); });
    el.results.addEventListener('click', function (e) {
      var row = e.target.closest('.result-item');
      if (!row) return;
      var item = inventory.filter(function (i) { return String(i.itemId) === row.getAttribute('data-id'); })[0];
      if (item) addToCart(item);
      el.search.value = '';
      el.results.classList.add('hidden');
      el.search.focus();
    });

    /* ------------------------------- cart ------------------------------- */
    function addToCart(item) {
      var existing = cart.filter(function (l) { return String(l.itemId) === String(item.itemId); })[0];
      if (existing) { existing.quantity += 1; }
      else {
        cart.push({
          itemId: item.itemId, itemName: item.itemName, quantity: 1,
          sellingPrice: Number(item.rate || 0), buyingPrice: Number(item.buyingPrice || 0),
          uom: item.uom || '', dosage: item.dosage || '', contraindications: item.contraindications || ''
        });
      }
      renderCart();
    }

    function lineTotal(l) { return l.sellingPrice * (Number(l.quantity) || 0); }

    function updateTotals() {
      var total = cart.reduce(function (s, l) { return s + lineTotal(l); }, 0);
      el.total.textContent = PH.format.money(total);
      el.confirm.disabled = cart.length === 0 || !cart.every(function (l) { return Number(l.quantity) > 0; });
    }

    function renderCart() {
      el.body.innerHTML = cart.map(function (l, i) {
        return '<tr>' +
          '<td><div>' + PH.format.escape(l.itemName) + '</div>' +
          '<div class="cart-line-info">UOM ' + PH.format.escape(l.uom || '-') + ' · Rate ' + PH.format.money(l.sellingPrice) + '</div>' +
          (l.dosage || l.contraindications ? '<div class="cart-line-info">' + PH.format.escape(l.dosage || '') +
            (l.contraindications ? ' · CI: ' + PH.format.escape(l.contraindications) : '') + '</div>' : '') + '</td>' +
          // Free-typed quantity: no stepper, and the field keeps focus while you type (see the input handler).
          '<td><input class="input qty-input" type="text" inputmode="numeric" autocomplete="off" value="' + l.quantity + '" data-i="' + i + '"></td>' +
          '<td>' + PH.format.money(l.sellingPrice) + '</td>' +
          '<td><strong data-amount="' + i + '">' + PH.format.money(lineTotal(l)) + '</strong></td>' +
          '<td><button class="icon-btn" data-remove="' + i + '" aria-label="Remove">' + PH.icon('trash', 18) + '</button></td>' +
          '</tr>';
      }).join('');

      el.empty.classList.toggle('hidden', cart.length > 0);
      el.count.textContent = cart.length + ' item' + (cart.length === 1 ? '' : 's');
      updateTotals();
    }

    /** Repaints one line's money cells without touching the input the user is typing in. */
    function refreshLine(i) {
      var cell = el.body.querySelector('[data-amount="' + i + '"]');
      if (cell) cell.textContent = PH.format.money(lineTotal(cart[i]));
      updateTotals();
    }

    el.body.addEventListener('input', function (e) {
      if (!e.target.classList.contains('qty-input')) return;
      var i = parseInt(e.target.getAttribute('data-i'), 10);
      var digits = e.target.value.replace(/\D/g, '');
      cart[i].quantity = digits === '' ? 0 : parseInt(digits, 10);
      if (digits !== e.target.value) e.target.value = digits;
      refreshLine(i);
    });
    // blur does not bubble, so listen in the capture phase to tidy up an empty/zero quantity.
    el.body.addEventListener('blur', function (e) {
      if (!e.target.classList || !e.target.classList.contains('qty-input')) return;
      var i = parseInt(e.target.getAttribute('data-i'), 10);
      if (!(Number(cart[i].quantity) > 0)) cart[i].quantity = 1;
      e.target.value = cart[i].quantity;
      refreshLine(i);
    }, true);
    el.body.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove]');
      if (!btn) return;
      cart.splice(parseInt(btn.getAttribute('data-remove'), 10), 1);
      renderCart();
    });

    /* ------------------------------- payment ------------------------------- */
    document.getElementById('payment-mode').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      paymentMode = b.getAttribute('data-mode');
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
    });

    /* ------------------------------- confirm ------------------------------- */
    el.confirm.addEventListener('click', function () {
      if (!cart.length) return;
      var payload = {
        clientName: el.client.value.trim(),
        paymentMode: paymentMode,
        items: cart.map(function (l) {
          return { itemId: l.itemId, itemName: l.itemName, quantity: l.quantity, sellingPrice: l.sellingPrice, buyingPrice: l.buyingPrice };
        })
      };
      PH.ui.spinner.show('Saving sale…');
      PH.api.mutation('createSale', payload).then(function (data) {
        PH.ui.spinner.hide();
        var receipt = {
          saleId: (data.sale && data.sale.saleId) || 'pending',
          timestamp: (data.sale && data.sale.timestamp) || new Date().toISOString(),
          items: payload.items, total: cart.reduce(function (s, l) { return s + l.sellingPrice * l.quantity; }, 0),
          paymentMode: paymentMode, clientName: payload.clientName, dispenser: user.username
        };
        cart = [];
        el.client.value = '';
        renderCart();
        if (data._queued) PH.ui.toast('Offline — sale saved and will sync automatically.', 'success');
        else PH.ui.toast('Sale recorded.', 'success');
        showReceipt(receipt);
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not save sale', 'error');
      });
    });

    /* ------------------------------- receipt ------------------------------- */
    function receiptText(r) {
      var lines = r.items.map(function (l) {
        return l.quantity + ' x ' + l.itemName + ' @ ' + PH.format.money(l.sellingPrice) + ' = ' + PH.format.money(l.sellingPrice * l.quantity);
      }).join('\n');
      return 'PHARMACY RECEIPT\n' + PH.format.dateTime(r.timestamp) + '\nSale ' + r.saleId + '\n' +
        (r.clientName ? 'Client: ' + r.clientName + '\n' : '') + '\n' + lines + '\n\nTOTAL: ' + PH.format.money(r.total) +
        '\nPayment: ' + (r.paymentMode === 'cash' ? 'Cash' : 'Lipa Namba') + '\nServed by: ' + r.dispenser;
    }

    function receiptHtml(r) {
      return '<div style="font-family:monospace"><h3 style="margin:0 0 .3rem">PHARMACY RECEIPT</h3>' +
        '<div>' + PH.format.dateTime(r.timestamp) + '</div>' +
        '<div class="muted small">Sale ' + PH.format.escape(r.saleId) + '</div>' +
        (r.clientName ? '<div>Client: ' + PH.format.escape(r.clientName) + '</div>' : '') +
        '<hr><table style="width:100%;border-collapse:collapse">' + r.items.map(function (l) {
          return '<tr><td>' + l.quantity + ' × ' + PH.format.escape(l.itemName) + '</td><td style="text-align:right">' +
            PH.format.money(l.sellingPrice * l.quantity) + '</td></tr>';
        }).join('') + '</table><hr>' +
        '<div style="display:flex;justify-content:space-between"><strong>TOTAL</strong><strong>' + PH.format.money(r.total) + '</strong></div>' +
        '<div class="small">Payment: ' + (r.paymentMode === 'cash' ? 'Cash' : 'Lipa Namba') + ' · Served by ' + PH.format.escape(r.dispenser) + '</div></div>';
    }

    function showReceipt(r) {
      document.getElementById('receipt-print').innerHTML = receiptHtml(r);
      var body = receiptHtml(r) +
        '<div class="row mt wrap">' +
        '<button class="btn btn-primary" id="r-print">' + PH.icon('print', 18) + ' Print / Save PDF</button>' +
        '<a class="btn btn-ghost" id="r-wa" target="_blank" rel="noopener">' + PH.icon('share', 18) + ' WhatsApp</a>' +
        '<a class="btn btn-ghost" id="r-mail">' + PH.icon('share', 18) + ' Email</a>' +
        '<button class="btn btn-ghost" id="r-share">' + PH.icon('share', 18) + ' Share…</button>' +
        '</div>';
      PH.ui.modal({ title: 'Receipt', html: body, actions: [{ label: 'Done', value: null, class: 'btn-ghost' }] });

      var text = receiptText(r);
      document.getElementById('r-print').onclick = function () { window.print(); };
      document.getElementById('r-wa').setAttribute('href', 'https://wa.me/?text=' + encodeURIComponent(text));
      document.getElementById('r-mail').setAttribute('href', 'mailto:?subject=' + encodeURIComponent('Pharmacy receipt ' + r.saleId) + '&body=' + encodeURIComponent(text));
      document.getElementById('r-share').onclick = function () {
        if (navigator.share) navigator.share({ title: 'Pharmacy receipt', text: text }).catch(function () {});
        else PH.ui.toast('Sharing is not supported on this device.', 'info');
      };
    }

    /* ------------------------------- start ------------------------------- */
    PH.ui.spinner.show('Loading items…');
    loadInventory().then(function () { PH.ui.spinner.hide(); renderCart(); });
  });
})();
