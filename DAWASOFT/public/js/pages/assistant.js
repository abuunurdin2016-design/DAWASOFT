/**
 * pages/assistant.js — drug information lookup (by item or by use), sourced from the sheet.
 */
(function () {
  PH.app.boot({ page: 4 }, function () {
    var mode = 'item';
    var cache = {};

    var search = document.getElementById('assistant-search');
    var label = document.getElementById('search-label');
    var results = document.getElementById('assistant-results');
    var card = document.getElementById('detail-card');
    var title = document.getElementById('detail-title');
    var body = document.getElementById('detail-body');

    document.getElementById('mode').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      mode = b.getAttribute('data-mode');
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
      label.textContent = mode === 'item' ? 'Item name' : 'Use (e.g. malaria treatment)';
      search.value = '';
      results.innerHTML = '';
      card.classList.add('hidden');
      search.focus();
    });

    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      var q = search.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      timer = setTimeout(function () { run(q); }, 250);
    });

    function run(q) {
      var action = mode === 'item' ? 'searchItems' : 'searchByUse';
      var payload = mode === 'item' ? { query: q } : { use: q };
      PH.api.call(action, payload).then(function (data) {
        var items = data.items || [];
        cache = {};
        items.forEach(function (it) { cache[it.itemId] = it; });
        if (!items.length) { results.innerHTML = '<p class="muted small">No matches found.</p>'; return; }
        results.innerHTML = '<div class="table-wrap"><div class="list">' + items.map(function (it) {
          return '<div class="list-row" data-id="' + PH.format.escape(it.itemId) + '">' +
            '<span class="lead">' + PH.icon('pill', 18) + '</span>' +
            '<div class="grow"><strong>' + PH.format.escape(it.itemName) + '</strong>' +
            '<div class="muted small">' + PH.format.escape(it.category || '') + ' · ' + PH.format.escape(it.uom || '') + '</div></div>' +
            PH.icon('chevron', 18) + '</div>';
        }).join('') + '</div></div>';
      }).catch(function (err) { PH.ui.toast(err.message || 'Search failed', 'error'); });
    }

    results.addEventListener('click', function (e) {
      var row = e.target.closest('.list-row');
      if (!row) return;
      var it = cache[row.getAttribute('data-id')];
      if (it) showDetail(it);
    });

    function showDetail(it) {
      card.classList.remove('hidden');
      title.textContent = it.itemName;
      var rows = [
        ['Full name', it.itemName],
        ['Description', it.description],
        ['Category', it.category],
        ['UOM', it.uom],
        ['Rate', PH.format.money(it.rate)],
        ['Dosage', it.dosage],
        ['Contraindications', it.contraindications]
      ];
      body.innerHTML = '<table class="data">' + rows.map(function (r) {
        return '<tr><th>' + r[0] + '</th><td>' + PH.format.escape(r[1] || '-') + '</td></tr>';
      }).join('') + '</table>';
      if (window.innerWidth < 780) card.scrollIntoView({ behavior: 'smooth' });
    }
  });
})();
