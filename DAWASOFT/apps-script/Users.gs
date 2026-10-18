/**
 * Users.gs — user lookup + the Account/User Control Panel API (owner only).
 */

function findUserRowById(userId) {
  var users = readObjects('Users');
  for (var i = 0; i < users.length; i++) if (num(users[i]['User ID']) === num(userId)) return users[i];
  return null;
}

function findUserById(userId) {
  var row = findUserRowById(userId);
  return row ? userToApi(row) : null;
}

function handleListUsers() {
  var rows = readObjects('Users');
  var users = [];
  for (var i = 0; i < rows.length; i++) users.push(userToApi(rows[i]));
  return { users: users };
}

function handleGetUser(payload) {
  var user = findUserById(payload.userId);
  if (!user) throw appError('NOT_FOUND', 'User not found.');
  return { user: user };
}

/** Owner grants the exact set of pages and actions a worker may use. */
function handleSetPermissions(user, payload) {
  var target = findUserRowById(payload.userId);
  if (!target) throw appError('NOT_FOUND', 'User not found.');
  if (num(target['User ID']) === 1) throw appError('VALIDATION', 'The root owner always keeps full access.');

  var pages = (payload.pages || []).map(function (p) { return num(p); })
    .filter(function (p) { return ALL_PAGES.indexOf(p) !== -1 && OWNER_ONLY_PAGES.indexOf(p) === -1; });
  var actions = (payload.actions || []).filter(function (a) { return ALL_ACTIONS.indexOf(a) !== -1; });

  var headerKeyed = {};
  for (var k in target) if (k !== '__row') headerKeyed[k] = target[k];
  headerKeyed['Pages'] = JSON.stringify(pages);
  headerKeyed['Actions'] = JSON.stringify(actions);
  headerKeyed['Updated At'] = nowIso();
  writeRow('Users', target.__row, headerKeyed);
  writeAudit(user, 'set_permissions', 'User', target['User ID'], 'success', { pages: pages, actions: actions });
  return { user: userToApi(headerKeyed) };
}

function handleSuspendUser(user, payload) {
  var target = findUserRowById(payload.userId);
  if (!target) throw appError('NOT_FOUND', 'User not found.');
  if (num(target['User ID']) === 1) throw appError('VALIDATION', 'The root owner cannot be suspended.');
  var headerKeyed = {};
  for (var k in target) if (k !== '__row') headerKeyed[k] = target[k];
  headerKeyed['Status'] = payload.suspended ? 'suspended' : 'active';
  headerKeyed['Updated At'] = nowIso();
  writeRow('Users', target.__row, headerKeyed);
  writeAudit(user, payload.suspended ? 'suspend_user' : 'activate_user', 'User', target['User ID'], 'success');
  return { user: userToApi(headerKeyed) };
}

/* ------------------- administrator request approval ------------------- */

/**
 * The first administrator alone decides on Administrator (owner) requests. Until it is approved the
 * request holds no access; a rejection deletes the account outright, as the brief requires.
 */
function requireFirstAdmin(user) {
  if (num(user.id) !== 1) throw appError('FORBIDDEN', 'Only the first administrator can approve or reject administrator requests.');
}

function findPendingRow(userId) {
  var row = findUserRowById(userId);
  if (!row) throw appError('NOT_FOUND', 'User not found.');
  if (String(row['Status']) !== 'pending') throw appError('VALIDATION', 'That account is not awaiting approval.');
  return row;
}

function handleApproveUser(user, payload) {
  requireFirstAdmin(user);
  var target = findPendingRow(payload.userId);

  var headerKeyed = {};
  for (var k in target) if (k !== '__row') headerKeyed[k] = target[k];
  headerKeyed['Status'] = 'active';
  headerKeyed['Pages'] = JSON.stringify(ALL_PAGES);
  headerKeyed['Actions'] = JSON.stringify(ALL_ACTIONS);
  headerKeyed['Updated At'] = nowIso();
  writeRow('Users', target.__row, headerKeyed);
  writeAudit(user, 'approve_admin', 'User', target['User ID'], 'success', { username: target['Username'] });
  return { user: userToApi(headerKeyed) };
}

function handleRejectUser(user, payload) {
  requireFirstAdmin(user);
  var target = findPendingRow(payload.userId);
  var rejectedId = target['User ID'];

  deleteRow('Users', target.__row);
  writeAudit(user, 'reject_admin', 'User', rejectedId, 'success', { username: target['Username'] });
  return { rejected: true, userId: rejectedId };
}

/** Lets a signed-in user change their own password (used after a reset). */
function handleChangePassword(user, payload) {
  var row = findUserRowById(user.id);
  if (!row) throw appError('NOT_FOUND', 'User not found.');
  var current = String(payload.currentPassword || '');
  var next = String(payload.newPassword || '');
  if (next.length < 6) throw appError('VALIDATION', 'New password must be at least 6 characters.');
  if (!safeEq(hashPassword(current, row['Password Salt']), row['Password Hash'])) throw appError('UNAUTHORIZED', 'Current password is incorrect.');

  var salt = randomBytesB64(16);
  var headerKeyed = {};
  for (var k in row) if (k !== '__row') headerKeyed[k] = row[k];
  headerKeyed['Password Salt'] = salt;
  headerKeyed['Password Hash'] = hashPassword(next, salt);
  headerKeyed['Must Change Password'] = 'FALSE';
  headerKeyed['Updated At'] = nowIso();
  writeRow('Users', row.__row, headerKeyed);
  writeAudit(user, 'change_password', 'User', user.id, 'success');
  return { changed: true };
}
