/**
 * pages/reports.js — Reports / Dashboard (page 7).
 * Daily / Weekly / Monthly / Annual summaries: items sold, amount collected, sales count,
 * cash vs Lipa Namba and profit, with a compound (grouped) bar chart.
 */
(function () {
  PH.app.boot({ page: 7 }, function () {
    var mode = 'daily';
    var lastReport = null;

    var el = {
      mode: document.getElementById('rep-mode'),
      date: document.getElementById('rep-date'),
      month: document.getElementById('rep-month'),
      year: document.getElementById('rep-year'),
      run: document.getElementById('rep-run'),
      dashKpis: document.getElementById('dash-kpis'),
      dashDate: document.getElementById('dash-date'),
      title: document.getElementById('rep-title'),
      kpis: document.getElementById('rep-kpis'),
      chart: document.getElementById('rep-chart'),
      table: document.getElementById('rep-table')
    };

    /* --------------------------- rendering --------------------------- */

    function kpiHtml(label, value, cls) {
      return '<div class="kpi ' + (cls || '') + '"><div class="label">' + PH.format.escape(label) + '</div>' +
        '<div class="value">' + value + '</div></div>';
    }

    function summaryKpis(s, cls) {
      return kpiHtml('Sales', PH.format.number(s.salesCount), cls) +
        kpiHtml('Items sold', PH.format.number(s.itemsSold), cls) +
        kpiHtml('Cash', PH.format.money(s.cashAmount)) +
        kpiHtml('Lipa Namba', PH.format.money(s.lipaNambaAmount)) +
        kpiHtml('Total collected', PH.format.money(s.totalAmount), 'accent') +
        kpiHtml('Profit', PH.format.money(s.profit), 'success');
    }

    function renderDashboard(d) {
      el.dashDate.textContent = PH.format.date(new Date().toISOString());
      el.dashKpis.innerHTML =
        '<div class="kpi accent" style="grid-column:1/-1"><div class="label">Today — total / profit</div>' +
        '<div class="value">' + PH.format.money(d.day.totalAmount) + ' <span class="muted small">· profit ' +
        PH.format.money(d.day.profit) + '</span></div></div>' +
        '<div class="kpi"><div class="label">This week</div><div class="value">' + PH.format.money(d.week.totalAmount) +
        '</div><div class="muted small">profit ' + PH.format.money(d.week.profit) + '</div></div>' +
        '<div class="kpi"><div class="label">This month</div><div class="value">' + PH.format.money(d.month.totalAmount) +
        '</div><div class="muted small">profit ' + PH.format.money(d.month.profit) + '</div></div>' +
        '<div class="kpi"><div class="label">This year</div><div class="value">' + PH.format.money(d.year.totalAmount) +
        '</div><div class="muted small">profit ' + PH.format.money(d.year.profit) + '</div></div>';
    }

    function renderReport(data, title) {
      lastReport = data;
      el.title.textContent = title;
      el.kpis.innerHTML = summaryKpis(data.summary || {});
      PH.charts.groupedBars(el.chart, data.series || [], { height: 240 });

      var rows = data.series || [];
      el.table.innerHTML = '<thead><tr><th>Period</th><th>Sales</th><th>Items</th><th>Cash</th>' +
        '<th>Lipa Namba</th><th>Total</th><th>Profit</th></tr></thead><tbody>' +
        rows.map(function (r) {
          var s = r.summary || {};
          return '<tr><td>' + PH.format.escape(r.label) + '</td>' +
            '<td>' + PH.format.number(s.salesCount) + '</td>' +
            '<td>' + PH.format.number(s.itemsSold) + '</td>' +
            '<td>' + PH.format.money(s.cashAmount) + '</td>' +
            '<td>' + PH.format.money(s.lipaNambaAmount) + '</td>' +
            '<td><strong>' + PH.format.money(s.totalAmount) + '</strong></td>' +
            '<td>' + PH.format.money(s.profit) + '</td></tr>';
        }).join('') +
        '</tbody><tfoot><tr><th>Total</th><th>' + PH.format.number((data.summary || {}).salesCount) + '</th><th>' +
        PH.format.number((data.summary || {}).itemsSold) + '</th><th>' + PH.format.money((data.summary || {}).cashAmount) +
        '</th><th>' + PH.format.money((data.summary || {}).lipaNambaAmount) + '</th><th>' +
        PH.format.money((data.summary || {}).totalAmount) + '</th><th>' +
        PH.format.money((data.summary || {}).profit) + '</th></tr></tfoot>';
    }

    /* --------------------------- data --------------------------- */

    function loadDashboard() {
      return PH.api.withCache('dashboard:' + PH.format.todayISO(), 'dashboard', {})
        .then(renderDashboard)
        .catch(function (err) { PH.ui.toast(err.message || 'Could not load dashboard', 'error'); });
    }

    function run() {
      var action, payload, title;
      if (mode === 'daily') {
        var d = el.date.value || PH.format.todayISO();
        action = 'dailyReport'; payload = { date: d }; title = 'Daily report — ' + PH.format.date(d + 'T00:00:00');
      } else if (mode === 'weekly') {
        var wd = el.date.value || PH.format.todayISO();
        action = 'weeklyReport'; payload = { date: wd }; title = 'Weekly report (Mon–Sun) from ' + PH.format.date(wd + 'T00:00:00');
      } else if (mode === 'monthly') {
        var m = el.month.value || PH.format.monthKey();
        action = 'monthlyReport'; payload = { month: m }; title = 'Monthly report — ' + m;
      } else {
        var y = el.year.value || String(new Date().getFullYear());
        action = 'annualReport'; payload = { year: Number(y) }; title = 'Annual report — ' + y;
      }
      PH.ui.spinner.show('Building report…');
      PH.api.withCache('report:' + mode + ':' + JSON.stringify(payload), action, payload).then(function (data) {
        PH.ui.spinner.hide();
        renderReport(data, title);
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not build the report', 'error');
      });
    }

    /* --------------------------- events --------------------------- */

    el.mode.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      mode = b.getAttribute('data-mode');
      Array.prototype.forEach.call(this.children, function (c) { c.classList.toggle('active', c === b); });
      el.date.classList.toggle('hidden', mode === 'monthly' || mode === 'annual');
      el.month.classList.toggle('hidden', mode !== 'monthly');
      el.year.classList.toggle('hidden', mode !== 'annual');
      run();
    });

    el.run.onclick = run;
    window.addEventListener('resize', function () {
      if (lastReport) PH.charts.groupedBars(el.chart, lastReport.series || [], { height: 240 });
    });

    /* --------------------------- start --------------------------- */

    el.date.value = PH.format.todayISO();
    el.month.value = PH.format.monthKey();
    el.year.value = String(new Date().getFullYear());

    PH.ui.spinner.show('Loading…');
    loadDashboard().then(function () {
      PH.ui.spinner.hide();
      run();
    });
  });
})();
