/**
 * Auth.gs — signup, login, sessions (token rotation), password reset, and the
 * permission gates used by every protected handler.
 *
 * Checklist mapping: OAuth/JWT-rotation pattern (opaque HMAC-signed token with short TTL +
 * refresh), secrets management (TOKEN_SECRET in Script Properties), audit of auth events.
 */

function getSecret() {
  var s = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!s) { s = uuid() + uuid(); PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', s); }
  return s;
}

function padB64(s) { s = String(s); while (s.length % 4) s += '='; return s; }

/* ----------------------------- tokens ----------------------------- */

function createSession(user) {
  var exp = Date.now() + SESSION_TTL_HOURS * 3600000;
  var payload = { uid: user.id, un: user.username, exp: exp, jti: uuid() };
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(payload)).replace(/=+$/, '');
  var token = body + '.' + hmacB64Url(body, getSecret());
  appendObject('Sessions', unpick(FIELDS.sessions, {
    token: token, userId: user.id, username: user.username,
    issuedAt: nowIso(), expiresAt: new Date(exp).toISOString()
  }));
  return { token: token, expiresAt: new Date(exp).toISOString() };
}

function verifyToken(token) {
  if (!token) throw appError('UNAUTHORIZED', 'Missing session token.');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw appError('UNAUTHORIZED', 'Malformed token.');
  if (!safeEq(parts[1], hmacB64Url(parts[0], getSecret()))) throw appError('UNAUTHORIZED', 'Invalid token signature.');
  var json = Utilities.newBlob(Utilities.base64DecodeWebSafe(padB64(parts[0]))).getDataAsString();
  var payload = parseJson(json, null);
  if (!payload || !payload.exp || payload.exp < Date.now()) throw appError('UNAUTHORIZED', 'Session expired.');
  return payload;
}

/** Returns { user, session } or throws UNAUTHORIZED/FORBIDDEN. */
function requireAuth(token) {
  var payload = verifyToken(token);
  var sessions = readObjects('Sessions');
  var found = null;
  for (var i = 0; i < sessions.length; i++) if (sessions[i]['Token'] === token) { found = sessions[i]; break; }
  if (!found) throw appError('UNAUTHORIZED', 'Session not found. Please sign in again.');
  var user = findUserById(payload.uid);
  if (!user) throw appError('UNAUTHORIZED', 'User no longer exists.');
  if (String(user.status) === 'suspended') throw appError('FORBIDDEN', 'This account has been suspended.');
  if (String(user.status) === 'pending') throw appError('FORBIDDEN', 'This account is awaiting approval by the first administrator.');
  return { user: user, session: found };
}

/* --------------------------- permission gates --------------------------- */

function isOwner(user) { return user && user.role === 'owner'; }

function canViewPage(user, page) {
  if (isOwner(user)) return true;
  if (OWNER_ONLY_PAGES.indexOf(page) !== -1) return false;
  return (user.pages || []).indexOf(page) !== -1;
}

/**
 * Action-level permission. Lenient by design: if the owner granted a page but configured NO
 * explicit actions for that worker, the page grant is enough. Once the owner picks any explicit
 * action, the worker is restricted to exactly those actions ("sub-action permission where fit").
 */
function canDo(user, action) {
  if (isOwner(user)) return true;
  var list = user.actions || [];
  if (list.length === 0) return true;
  return list.indexOf(action) !== -1;
}

function canViewAnyPage(user, pages) {
  for (var i = 0; i < pages.length; i++) if (canViewPage(user, pages[i])) return true;
  return false;
}

/** Route-level guard. `page` = required page number, `action` = required action key. */
function requireAccess(user, page, action) {
  if (page && !canViewPage(user, page)) throw appError('FORBIDDEN', 'You do not have access to this page.');
  if (action && !canDo(user, action)) throw appError('FORBIDDEN', 'You do not have permission: ' + action + '.');
}

function requireAnyPage(user, pages) {
  if (!canViewAnyPage(user, pages)) throw appError('FORBIDDEN', 'You do not have access to this screen.');
}

/* ----------------------------- handlers ----------------------------- */

function handleSignup(payload) {
  var fullName = trim(payload.fullName);
  var email = trim(payload.email).toLowerCase();
  var username = trim(payload.username).toLowerCase();
  var password = String(payload.password || '');
  var profession = trim(payload.profession) || 'Dispenser';

  if (!fullName) throw appError('VALIDATION', 'Full name is required.');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw appError('VALIDATION', 'A valid email is required.');
  if (!username || username.length < 3) throw appError('VALIDATION', 'Username must be at least 3 characters.');
  if (password.length < 6) throw appError('VALIDATION', 'Password must be at least 6 characters.');
  if (PROFESSIONS.indexOf(profession) === -1) throw appError('VALIDATION', 'Unknown profession.');

  var users = readObjects('Users');
  var firstAdminExists = false;
  for (var i = 0; i < users.length; i++) {
    if (String(users[i]['Username']).toLowerCase() === username) throw appError('CONFLICT', 'Username already taken.');
    if (String(users[i]['Email']).toLowerCase() === email) throw appError('CONFLICT', 'Email already registered.');
    if (num(users[i]['User ID']) === 1 || String(users[i]['Profession']) === 'Administrator') firstAdminExists = true;
  }

  // Only the FIRST administrator is created outright. Anyone else asking for Administrator (= owner)
  // is held as "pending" — they can neither sign in nor reach a page until the first administrator
  // approves the request, and a rejected request deletes the account.
  var needsApproval = profession === 'Administrator' && firstAdminExists;

  var salt = randomBytesB64(16);
  var nextId = 1;
  for (var j = 0; j < users.length; j++) nextId = Math.max(nextId, num(users[j]['User ID']) + 1);
  var now = nowIso();
  var record = {
    userId: nextId, fullName: fullName, dob: payload.dob || '', email: email, username: username,
    passwordHash: hashPassword(password, salt), passwordSalt: salt, profession: profession,
    profilePicture: payload.profilePicture || '', status: needsApproval ? 'pending' : 'active',
    pages: JSON.stringify(needsApproval ? [] : [2]), actions: JSON.stringify([]),
    createdAt: now, updatedAt: now, lastLogin: '', mustChangePassword: 'FALSE'
  };
  appendObject('Users', unpick(FIELDS.users, record));
  writeAudit({ id: nextId, username: username }, 'signup', 'User', nextId, 'success',
    { profession: profession, pendingApproval: needsApproval });
  return { userId: nextId, status: record.status, pendingApproval: needsApproval };
}

function handleLogin(payload) {
  var identifier = trim(payload.identifier).toLowerCase();
  var password = String(payload.password || '');
  if (!identifier || !password) throw appError('VALIDATION', 'Username/email and password are required.');

  var cache = CacheService.getScriptCache();
  var failKey = 'loginfail:' + identifier;
  var fails = num(cache.get(failKey));
  if (fails >= MAX_LOGIN_ATTEMPTS) throw appError('RATE_LIMITED', 'Too many failed attempts. Try again later.');

  var users = readObjects('Users');
  var row = null;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (String(u['Username']).toLowerCase() === identifier || String(u['Email']).toLowerCase() === identifier) { row = u; break; }
  }
  if (!row) { cache.put(failKey, String(fails + 1), 900); throw appError('UNAUTHORIZED', 'Invalid credentials.'); }

  var okPwd = safeEq(hashPassword(password, row['Password Salt']), row['Password Hash']);
  if (!okPwd) { cache.put(failKey, String(fails + 1), 900); writeAudit({ id: row['User ID'], username: row['Username'] }, 'login', 'User', row['User ID'], 'failure'); throw appError('UNAUTHORIZED', 'Invalid credentials.'); }
  if (String(row['Status']) === 'suspended') throw appError('FORBIDDEN', 'This account has been suspended.');
  if (String(row['Status']) === 'pending') throw appError('FORBIDDEN', 'Your administrator request is still waiting for the first administrator. Please try again once it is approved.');

  cache.remove(failKey);
  var headerKeyed = {};
  for (var k in row) if (k !== '__row') headerKeyed[k] = row[k];
  headerKeyed['Last Login'] = nowIso();
  writeRow('Users', row.__row, headerKeyed);

  var user = userToApi(row);
  user.lastLogin = nowIso();
  var session = createSession(user);
  writeAudit(user, 'login', 'User', user.id, 'success');
  return { token: session.token, expiresAt: session.expiresAt, user: user, mustChangePassword: String(row['Must Change Password']) === 'TRUE' };
}

function handleRefreshToken(session) {
  // Rotation: old token removed, a brand new one issued.
  var user = findUserById(session.userId);
  if (!user) throw appError('UNAUTHORIZED', 'User no longer exists.');
  deleteRow('Sessions', session.__row);
  var s = createSession(user);
  return { token: s.token, expiresAt: s.expiresAt };
}

function handleLogout(session) {
  try { deleteRow('Sessions', session.__row); } catch (e) { /* already gone */ }
  return { loggedOut: true };
}

function handleForgotPassword(payload) {
  var identifier = trim(payload.identifier).toLowerCase();
  if (!identifier) throw appError('VALIDATION', 'Enter your username or email.');
  var users = readObjects('Users');
  var row = null;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (String(u['Username']).toLowerCase() === identifier || String(u['Email']).toLowerCase() === identifier) { row = u; break; }
  }
  // Always report success to avoid account enumeration.
  if (!row) return { sent: true };

  var temp = 'Rx-' + randomBytesB64(6);
  var salt = randomBytesB64(16);
  var headerKeyed = {};
  for (var k in row) if (k !== '__row') headerKeyed[k] = row[k];
  headerKeyed['Password Salt'] = salt;
  headerKeyed['Password Hash'] = hashPassword(temp, salt);
  headerKeyed['Must Change Password'] = 'TRUE';
  headerKeyed['Updated At'] = nowIso();
  writeRow('Users', row.__row, headerKeyed);
  writeAudit({ id: row['User ID'], username: row['Username'] }, 'forgot_password', 'User', row['User ID'], 'success');

  if (row['Email']) {
    try {
      MailApp.sendEmail({
        to: row['Email'],
        subject: 'Your temporary pharmacy password',
        body: 'Hello ' + row['Full name'] + ',\n\nYour temporary password is: ' + temp +
          '\n\nPlease sign in and change it immediately.'
      });
    } catch (e) { Logger.log('mail failed: ' + e); }
  }
  return { sent: true };
}

function trim(v) { return v === undefined || v === null ? '' : String(v).trim(); }
