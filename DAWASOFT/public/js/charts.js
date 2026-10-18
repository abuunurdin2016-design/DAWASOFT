/**
 * charts.js — dependency-free canvas bar chart.
 * Draws grouped bars (Cash vs Lipa Namba) per label with a total line on top.
 * Colours come from CSS variables so the chart follows the active theme.
 */
(function () {
  window.PH = window.PH || {};

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  PH.charts = {
    groupedBars: function (canvas, series, opts) {
      opts = opts || {};
      if (!canvas) return;
      var dpr = window.devicePixelRatio || 1;
      var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
      var cssH = opts.height || 240;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.height = cssH + 'px';
      var ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      var fg = cssVar('--ph-text', '#e5e7eb');
      var grid = cssVar('--ph-border', '#334155');
      var cashColor = cssVar('--ph-accent', '#38bdf8');
      var lipaColor = cssVar('--ph-accent-2', '#a78bfa');

      if (!series || !series.length) {
        ctx.fillStyle = fg; ctx.font = '13px system-ui'; ctx.textAlign = 'center';
        ctx.fillText('No data for this period', cssW / 2, cssH / 2);
        return;
      }

      var padL = 46, padR = 12, padT = 18, padB = 34;
      var plotW = cssW - padL - padR;
      var plotH = cssH - padT - padB;

      var maxVal = 0;
      series.forEach(function (s) {
        var sum = (s.summary && s.summary.totalAmount) || 0;
        if (sum > maxVal) maxVal = sum;
      });
      if (maxVal <= 0) maxVal = 1;

      // axes + gridlines
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
      ctx.fillStyle = fg; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
      for (var g = 0; g <= 4; g++) {
        var y = padT + plotH - (plotH * g / 4);
        ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillText(shortNum(maxVal * g / 4), padL - 6, y + 3);
      }

      var slot = plotW / series.length;
      var barW = Math.min(16, (slot - 10) / 2);
      series.forEach(function (s, i) {
        var cx = padL + slot * i + slot / 2;
        var cash = (s.summary && s.summary.cashAmount) || 0;
        var lipa = (s.summary && s.summary.lipaNambaAmount) || 0;
        var hCash = plotH * (cash / maxVal);
        var hLipa = plotH * (lipa / maxVal);
        var base = padT + plotH;

        ctx.fillStyle = cashColor;
        roundRect(ctx, cx - barW - 2, base - hCash, barW, hCash, 3);
        ctx.fillStyle = lipaColor;
        roundRect(ctx, cx + 2, base - hLipa, barW, hLipa, 3);

        ctx.fillStyle = fg; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(shortNum(cash + lipa), cx, padT + plotH * (1 - (cash + lipa) / maxVal) - 5);
        ctx.fillText(s.label, cx, cssH - 12);
      });

      // legend
      ctx.textAlign = 'left'; ctx.font = '11px system-ui';
      ctx.fillStyle = cashColor; ctx.fillRect(padL, 4, 10, 10);
      ctx.fillStyle = fg; ctx.fillText(' Cash', padL + 12, 13);
      ctx.fillStyle = lipaColor; ctx.fillRect(padL + 70, 4, 10, 10);
      ctx.fillStyle = fg; ctx.fillText(' Lipa Namba', padL + 82, 13);
    }
  };

  function shortNum(n) {
    n = Math.round(n);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
    return String(n);
  }

  function roundRect(ctx, x, y, w, h, r) {
    h = Math.max(0, h);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
})();
