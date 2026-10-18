/**
 * pages/users.js — Account / User Control Panel (page 9, owner only).
 * The owner sees every sign-up and grants the exact pages + actions each worker may use.
 * Page 9 is never grantable, and the root owner always keeps full access (server-enforced too).
 */
(function () {
  PH.app.boot({ page: 9 }, function () {
    if (!PH.perm.guardPage(9)) return;

    var users = [];
    var el = {
      list: document.getElementById('users-list'),
      refresh: document.getElementById('users-refresh'),
      requests: document.getElementById('users-requests'),
      requestsCard: document.getElementById('users-requests-card'),
      reqCount: document.getElementById('req-count')
    };

    var GRANTABLE_PAGES = [2, 3, 4, 5, 6, 7, 8, 10];

    function pageLabel(n) { return (PH.config.PAGES[n] || {}).title || ('Page ' + n); }

    function roleBadge(u) {
      if (u.status === 'pending') return '<span class="badge warn">Awaiting approval</span>';
      if (u.role === 'owner') return '<span class="badge ok">Owner</span>';
      return u.status === 'suspended' ? '<span class="badge danger">Suspended</span>' : '<span class="badge muted">Worker</span>';
    }

    /** Administrator sign-ups wait here until the first administrator decides. */
    function renderRequests(pending) {
      el.requestsCard.hidden = pending.length === 0;
      el.reqCount.textContent = pending.length ? pending.length + ' waiting' : '';
      el.requests.innerHTML = pending.map(function (u) {
        return '<div class="list-row">' +
          '<span class="lead">' + PH.icon('users', 18) + '</span>' +
          '<div class="grow"><strong>' + PH.format.escape(u.fullName || u.username) + '</strong>' +
          '<div class="muted small">' + PH.format.escape(u.profession || '') + ' · @' + PH.format.escape(u.username) + '</div>' +
          (u.email ? '<div class="muted small">' + PH.format.escape(u.email) + '</div>' : '') + '</div>' +
          '<button class="btn btn-sm btn-primary" data-approve="' + PH.format.escape(String(u.id)) + '">Approve</button>' +
          '<button class="btn btn-sm btn-ghost" data-reject="' + PH.format.escape(String(u.id)) + '">Reject</button>' +
          '</div>';
      }).join('');
    }

    function render() {
      var pending = users.filter(function (u) { return u.status === 'pending'; });
      var others = users.filter(function (u) { return u.status !== 'pending'; });
      renderRequests(pending);

      if (!others.length) { el.list.innerHTML = '<p class="muted small">No users yet.</p>'; return; }
      el.list.innerHTML = '<div class="list">' + others.map(function (u) {
        var detail = u.role === 'owner'
          ? 'Full access to every page'
          : (u.pages || []).length + ' page(s) · ' + (u.actions || []).length + ' action(s)';
        return '<div class="list-row" data-id="' + PH.format.escape(String(u.id)) + '" style="cursor:pointer">' +
          '<span class="lead">' + PH.icon('users', 18) + '</span>' +
          '<div class="grow"><strong>' + PH.format.escape(u.fullName || u.username) + '</strong>' +
          '<div class="muted small">' + PH.format.escape(u.profession || '') + ' · @' + PH.format.escape(u.username) + '</div>' +
          '<div class="muted small">' + PH.format.escape(detail) + '</div></div>' +
          roleBadge(u) + PH.icon('chevron', 18) + '</div>';
      }).join('') + '</div>';
    }

    function load() {
      PH.ui.spinner.show('Loading users…');
      return PH.api.call('listUsers', {}).then(function (data) {
        PH.ui.spinner.hide();
        users = data.users || [];
        render();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not load users', 'error');
      });
    }

    /* --------------------------- administrator requests --------------------------- */

    function decideRequest(u, approve) {
      var name = u.fullName || u.username;
      var run = function () {
        PH.ui.spinner.show(approve ? 'Approving…' : 'Rejecting…');
        PH.api.mutation(approve ? 'approveUser' : 'rejectUser', { userId: u.id }).then(function () {
          PH.ui.spinner.hide();
          PH.ui.toast(approve ? name + ' is now an administrator.' : name + '\u2019s request was rejected and the account removed.', 'success');
          return load();
        }).catch(function (err) {
          PH.ui.spinner.hide();
          PH.ui.toast(err.message || 'Could not save the decision', 'error');
        });
      };
      if (approve) return run();
      PH.ui.confirm('Reject ' + name + '? The account is deleted permanently.', { title: 'Reject request', confirmLabel: 'Reject and delete', danger: true })
        .then(function (ok) { if (ok) run(); });
    }

    /* --------------------------- permission editor --------------------------- */

    function editorHtml(u) {
      var pages = (u.pages || []).map(Number);
      var actions = u.actions || [];
      var pageBoxes = GRANTABLE_PAGES.map(function (n) {
        return '<label class="perm-row"><input type="checkbox" class="perm-page" value="' + n + '"' +
          (pages.indexOf(n) !== -1 ? ' checked' : '') + '> ' + PH.format.escape(pageLabel(n)) + '</label>';
      }).join('');
      var actionBoxes = PH.config.ALL_ACTIONS.map(function (a) {
        return '<label class="perm-row"><input type="checkbox" class="perm-action" value="' + PH.format.escape(a) + '"' +
          (actions.indexOf(a) !== -1 ? ' checked' : '') + '> ' + PH.format.escape(PH.config.ACTION_LABELS[a] || a) + '</label>';
      }).join('');
      return '<p class="muted small">' + PH.format.escape(u.fullName || u.username) + ' · ' + PH.format.escape(u.email || '') + '</p>' +
        (u.status === 'suspended' ? '<p class="badge danger">This account is suspended.</p>' : '') +
        '<div class="perm-head">Pages</div><div class="grid-2">' + pageBoxes + '</div>' +
        '<div class="perm-head">Actions</div><div class="grid-2">' + actionBoxes + '</div>' +
        '<p class="muted small mt">Tip: if you tick no actions, a worker can use every action on the pages you granted.</p>';
    }

    function readEditor(wrap) {
      var pages = [], actions = [];
      Array.prototype.forEach.call(wrap.querySelectorAll('.perm-page:checked'), function (c) { pages.push(Number(c.value)); });
      Array.prototype.forEach.call(wrap.querySelectorAll('.perm-action:checked'), function (c) { actions.push(c.value); });
      return { pages: pages, actions: actions };
    }

    function openEditor(u) {
      if (u.role === 'owner') {
        PH.ui.modal({
          title: u.fullName || u.username,
          html: '<p>The administrator (owner) always has full access to every page and action.</p>',
          actions: [{ label: 'Close', value: null, class: 'btn-ghost' }]
        });
        return;
      }
      var suspended = u.status === 'suspended';
      PH.ui.modal({
        title: 'Access — ' + (u.fullName || u.username),
        html: editorHtml(u),
        actions: [
          { label: suspended ? 'Activate' : 'Suspend', value: 'toggle', class: suspended ? 'btn-success' : 'btn-danger' },
          { label: 'Save access', collect: readEditor, class: 'btn-primary' },
          { label: 'Cancel', value: null, class: 'btn-ghost' }
        ]
      }).then(function (res) {
        if (!res) return;
        if (res === 'toggle') return setSuspended(u, !suspended);
        if (res.pages) return savePermissions(u, res);
      });
    }

    function savePermissions(u, perm) {
      PH.ui.spinner.show('Saving access…');
      PH.api.mutation('setPermissions', { userId: u.id, pages: perm.pages, actions: perm.actions }).then(function () {
        PH.ui.spinner.hide();
        PH.ui.toast('Access updated for ' + (u.fullName || u.username), 'success');
        return load();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not save access', 'error');
      });
    }

    function setSuspended(u, suspended) {
      PH.ui.spinner.show(suspended ? 'Suspending…' : 'Activating…');
      PH.api.mutation('suspendUser', { userId: u.id, suspended: suspended }).then(function () {
        PH.ui.spinner.hide();
        PH.ui.toast(suspended ? 'User suspended.' : 'User activated.', 'success');
        return load();
      }).catch(function (err) {
        PH.ui.spinner.hide();
        PH.ui.toast(err.message || 'Could not change the status', 'error');
      });
    }

    /* --------------------------- events --------------------------- */

    el.list.addEventListener('click', function (e) {
      var row = e.target.closest('.list-row');
      if (!row) return;
      var u = users.filter(function (x) { return String(x.id) === row.getAttribute('data-id'); })[0];
      if (u) openEditor(u);
    });

    el.requests.addEventListener('click', function (e) {
      var approve = e.target.closest('[data-approve]');
      var reject = e.target.closest('[data-reject]');
      var btn = approve || reject;
      if (!btn) return;
      var id = btn.getAttribute(approve ? 'data-approve' : 'data-reject');
      var u = users.filter(function (x) { return String(x.id) === id; })[0];
      if (u) decideRequest(u, !!approve);
    });

    el.refresh.onclick = load;

    load();
  });
})();
