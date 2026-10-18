/**
 * pages/login.js — sign in, sign up and forgot-password.
 */
(function () {
  // Already signed in? Go straight home.
  if (PH.auth.isLoggedIn()) { window.location.href = 'home.html'; return; }

  document.getElementById('brand-logo').innerHTML = PH.icon('pill', 30);

  // profession dropdown
  var prof = document.getElementById('signup-profession');
  prof.innerHTML = PH.config.PROFESSIONS.map(function (p) {
    return '<option value="' + p + '">' + p + (p === 'Administrator' ? ' (Owner)' : '') + '</option>';
  }).join('');

  function show(tab) {
    ['login', 'signup', 'forgot'].forEach(function (t) {
      document.getElementById('tab-' + t).classList.toggle('active', t === tab);
      document.getElementById('form-' + t).classList.toggle('hidden', t !== tab);
    });
  }
  document.getElementById('tab-login').onclick = function () { show('login'); };
  document.getElementById('tab-signup').onclick = function () { show('signup'); };
  document.getElementById('tab-forgot').onclick = function () { show('forgot'); };

  function busy(p) { PH.ui.spinner.show(); return p.finally(function () { PH.ui.spinner.hide(); }); }

  /* -------------------------------- login -------------------------------- */
  document.getElementById('form-login').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    busy(PH.auth.login(f.identifier.value.trim(), f.password.value))
      .then(function (data) {
        PH.ui.toast('Welcome back, ' + (data.user.fullName || data.user.username), 'success');
        setTimeout(function () { window.location.href = 'home.html'; }, 400);
      })
      .catch(function (err) { PH.ui.toast(err.message || 'Sign in failed', 'error'); });
  });

  /* -------------------------------- sign up -------------------------------- */
  var photoData = '';
  document.getElementById('signup-photo').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) { photoData = ''; return; }
    if (file.size > 200 * 1024) { PH.ui.toast('Please pick an image smaller than 200 KB.', 'error'); e.target.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () { photoData = String(reader.result); };
    reader.readAsDataURL(file);
  });

  document.getElementById('form-signup').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var payload = {
      fullName: f.fullName.value.trim(),
      dob: f.dob.value,
      email: f.email.value.trim(),
      username: f.username.value.trim(),
      password: f.password.value,
      profession: f.profession.value,
      profilePicture: photoData
    };
    busy(PH.api.call('signup', payload, { public: true }))
      .then(function (data) {
        if (data && data.pendingApproval) {
          PH.ui.toast('Request sent to the administrator.', 'success');
          PH.ui.modal({
            title: 'Waiting for approval',
            html: '<p>You asked for Administrator (owner) access. The first administrator must approve your request before you can sign in.</p>' +
              '<p class="muted small">If the request is rejected, the account is deleted automatically.</p>',
            actions: [{ label: 'OK', value: true, class: 'btn-primary' }]
          });
        } else {
          PH.ui.toast('Account created. Please sign in.', 'success');
          PH.ui.modal({ title: 'Account created', html: '<p>Your account is ready. Sign in to continue. The owner must grant you access to more pages.</p>', actions: [{ label: 'Go to sign in', value: true, class: 'btn-primary' }] });
        }
        f.reset(); photoData = '';
        show('login');
      })
      .catch(function (err) { PH.ui.toast(err.message || 'Sign up failed', 'error'); });
  });

  /* -------------------------------- forgot -------------------------------- */
  document.getElementById('form-forgot').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    busy(PH.api.call('forgotPassword', { identifier: f.identifier.value.trim() }, { public: true }))
      .then(function () {
        PH.ui.toast('If that account exists, a temporary password is on its way.', 'success');
        f.reset(); show('login');
      })
      .catch(function (err) { PH.ui.toast(err.message || 'Request failed', 'error'); });
  });
})();
