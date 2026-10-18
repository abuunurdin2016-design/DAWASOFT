/**
 * format.js — display helpers (currency, dates, escaping). Pure functions, easy to unit-test.
 */
(function () {
  window.PH = window.PH || {};

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  PH.format = {
    money: function (n) {
      var v = Number(n || 0);
      return PH.config.CURRENCY + ' ' + v.toLocaleString(PH.config.LOCALE, { maximumFractionDigits: 0 });
    },
    number: function (n) {
      return Number(n || 0).toLocaleString(PH.config.LOCALE, { maximumFractionDigits: 2 });
    },
    date: function (iso) {
      if (!iso) return '-';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    },
    dateTime: function (iso) {
      if (!iso) return '-';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return PH.format.date(iso) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
    timeShort: function (iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
    escape: function (s) {
      return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    todayISO: function () {
      var d = new Date();
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    },
    monthKey: function (d) {
      d = d || new Date();
      return d.getFullYear() + '-' + pad(d.getMonth() + 1);
    },
    uuid: function () {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  };
})();
