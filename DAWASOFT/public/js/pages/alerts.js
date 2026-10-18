/**
 * pages/alerts.js — Alerts (page 6): stock-outs / low stock + expiry colour bands.
 * Owners additionally see the dead-letter queue (offline changes that permanently failed to sync).
 */
(function () {
  PH.app.boot({ page: 6 }, function () {
    var el = {
      stock: document.getElementById('stockouts'),
      stockCount: document.getElementById('stock-count'),
      expiring: document.getElementById('expiring'),
      expiryCount: document.getElementById('expiry-count'),
      dlqCard: document.getElementById('dlq-card'),
      dlq: document.getElementById('dlq'),
      dlqCount: document.getElementById('dlq-count'),
      generated: document.getElementById('generated-at'),
      refresh: document.getElementById('alerts-refresh')
    };

    function renderStockouts(list) {
      el.stockCount.textContent = list.length;
      if (!list.length) { el.stock.innerHTML = '<p class="muted small">Nothing is out of stock or low.</p>'; return; }
      el.stock.innerHTML = list.map(function (a) {
        var it = a.item;
        return '<div class="alert-item' + (a.isOut ? ' out' : '') + '">' +
          '<span class="lead">' + PH.icon(a.isOut ? 'alert' : 'box', 18) + '</span>' +
          '<div class="grow"><strong>' + PH.format.escape(it.itemName) + '</strong>' +
          '<div class="muted small">' + PH.format.escape(a.message) + '</div>' +
          '<div class="muted small">Reorder level ' + PH.format.number(it.reorderLevel) +
          ' · Rate ' + PH.format.money(it.rate) + '</div></div>' +
          (a.isOut ? '<span class="badge danger">Out</span>' : '<span class="badge warn">Low</span>') +
          '</div>';
      }).join('');
    }

    function renderExpiring(list) {
      el.expiryCount.textContent = list.length;
      if (!list.length) { el.expiring.innerHTML = '<p class="muted small">No items are close to expiry.</p>'; return; }
      el.expiring.innerHTML = list.map(function (a) {
        var it = a.item;
        var m = a.monthsLeft;
        var when = m <= 0 ? 'expires this month or already expired' : ('expires in ' + m + ' month' + (m === 1 ? '' : 's'));
        return '<div class="alert-item band-' + PH.format.escape(a.band) + '">' +
          '<span class="lead">' + PH.icon('bell', 18) + '</span>' +
          '<div class="grow"><strong>' + PH.format.escape(it.itemName) + '</strong>' +
          '<div class="muted small">' + PH.format.escape(when) + ' · ' + PH.format.date(a.expiryDate) + '</div>' +
          '<div class="muted small">Stock ' + PH.format.number(it.currentStock) + ' ' + PH.format.escape(it.uom || '') + '</div></div>' +
          '<span class="badge ' + (m <= 2 ? 'danger' : 'warn') + '">' + m + ' mo</span>' +
          '</div>';
      }).join('');
    }

    function renderDLQ(rows) {
      el.dlqCount.textContent = rows.length;
      if (!rows.length) { el.dlq.innerHTML = '<p class="muted small">No sync failures.</p>'; return; }
      el.dlq.innerHTML = '<div class="list">' + rows.map(function (r) {
        var op = r.operation && r.operation.action ? r.operation.action : 'operation';
        return '<div class="list-row"><span class="lead">' + PH.icon('alert', 18) + '</span>' +
          '<div class="grow"><strong>' + PH.format.escape(op) + '</strong>' +
          '<div class="muted small">' + PH.format.escape(r.lastError || '') + '</div>' +
          '<div class="muted small">' + PH.format.dateTime(r.timestamp) + ' · user ' + PH.format.escape(String(r.userId)) + '</div>' +
          '</div></div>';
      }).join('') + '</div>';
    }

    function load() {
      PH.ui.spinner.show('Loading alerts…');
      return PH.api.withCache('alerts', 'listAlerts', {}).then(function (data) {
        PH.ui.spinner.hide();
        renderStockouts(data.stockouts || []);
        renderExpiring(data.expiring || []);
        el.generated.textContent = 'Generated ' + PH.format.dateTime(data.generatedAt || new Date().toISOString()) +
          (data._fromCache ? ' (offline copy)' : '');
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not load alerts', 'error');
      });
    }

    el.refresh.onclick = load;

    /* The DLQ is owner-only on the server (page 6 access), so only owners ask for it. */
    if (PH.perm.isOwner()) {
      el.dlqCard.classList.remove('hidden');
      PH.api.call('listDLQ', {}).then(function (data) { renderDLQ(data.rows || []); })
        .catch(function () { el.dlq.innerHTML = '<p class="muted small">Could not load sync issues.</p>'; });
    }

    load();
  });
})();
