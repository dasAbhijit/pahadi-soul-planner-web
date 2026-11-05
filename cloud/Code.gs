/**
 * Pahadi Soul Planner: cloud sync.
 *
 * Paste this into the Google Sheet (Extensions > Apps Script) and deploy it as a web app.
 * The phone apps read the sheet back (action "pull"), merge it with their own data, and write
 * the merged result (action "push"). The script does no merging itself: it stores one tab per
 * kind of record, and a version number that changes on every push. A push that was based on an
 * older version is refused, so two phones syncing at once can never overwrite each other.
 * The data tabs are rewritten on every sync, so do any analysis in other tabs of the same sheet.
 *
 * Version 2 adds people. Until the first Owner is created the script behaves exactly as above
 * (legacy mode, the secret code PAHADI_TOKEN). From the first Owner on, every call needs a
 * signed-in person's session code, roles decide who may read and write what, and a push is
 * merged record by record in the script (newer change wins) instead of replacing whole tabs.
 * People, hashes and sessions live in Script properties, never in a sheet tab.
 *
 * Setup: see README.md in this folder. The secret code lives in Project Settings > Script
 * properties as PAHADI_TOKEN. It is never written into the sheet.
 */

var TABLES = ['Treks', 'Bookings', 'Money', 'Vendors', 'Guidance'];
var LOG_SHEET = 'Sync log';
var JSON_COLUMN = 'Record (JSON)';
var VERSION_PROP = 'SYNC_VERSION';
var MAX_BODY_CHARS = 20 * 1024 * 1024;
var MAX_ROWS = 50000;
var MAX_COLS = 30;
var MAX_CELL_CHARS = 49000;
var MAX_LOG_ROWS = 500;

var V2_FLAG = 'V2_ENABLED';
var PERSON_PREFIX = 'person:';
var SESSION_PREFIX = 'session:';
var ROLES = ['Owner', 'Manager', 'Staff'];
var EXTRA_COLUMNS = ['Added by', 'Last changed by'];
var HASH_ROUNDS = 1000;
var MIN_PASSWORD = 8;
var MAX_PASSWORD = 200;
var MAX_NAME = 40;
var INVITE_DAYS = 7;
var SESSION_DAYS = 90;
var LOGIN_MAX_FAILS = 5;
var LOGIN_LOCK_SECONDS = 15 * 60;
var SETUP_MAX_FAILS = 20;
var MAX_REJECTED_REPORTED = 50;
var INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function doGet() {
  return reply_({ ok: true, app: 'Pahadi Soul Planner sync', v: 2 });
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw) return reply_({ ok: false, error: 'Empty request.' });
    if (raw.length > MAX_BODY_CHARS) return reply_({ ok: false, error: 'The request is too large.' });
    var body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply_({ ok: false, error: 'Unknown action.' });

    if (body.action === 'status') {
      return reply_({ ok: true, v: 2, setupNeeded: !v2Enabled_() });
    }
    if (v2Enabled_()) return reply_(handleV2_(body));
    if (body.session !== undefined || V2_ACTIONS_.indexOf(body.action) >= 0) {
      return reply_(handleV2NotReady_(body));
    }
    return reply_(handleLegacy_(body));
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** The original token-based protocol. Works only until the first Owner exists. */
function handleLegacy_(body) {
  var expected = PropertiesService.getScriptProperties().getProperty('PAHADI_TOKEN');
  if (!expected) {
    return { ok: false, error: 'The sheet is not set up yet: add the PAHADI_TOKEN script property.' };
  }
  if (!sameText_(String(body.token || ''), expected)) {
    return { ok: false, error: 'Wrong secret code.' };
  }
  if (body.action === 'ping') {
    return { ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName() };
  }
  if (body.action === 'pull') return pull_();
  if (body.action === 'push') return push_(body);
  return { ok: false, error: 'Unknown action.' };
}

function getVersion_() {
  return parseInt(PropertiesService.getScriptProperties().getProperty(VERSION_PROP) || '0', 10);
}

/** Every record in the sheet, as the JSON lines the apps wrote, plus the version they must send back. */
function pull_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tables = {};
    TABLES.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      tables[name] = sheet ? readRecords_(sheet) : [];
    });
    return { ok: true, version: getVersion_(), tables: tables };
  } finally {
    lock.releaseLock();
  }
}

/** The JSON column's cells. Rows without a record (typed by hand) are ignored. */
function readRecords_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var col = values[0].indexOf(JSON_COLUMN);
  if (col < 0) return [];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var cell = values[i][col];
    if (typeof cell === 'string' && cell.charAt(0) === '{') out.push(cell);
  }
  return out;
}

function push_(body) {
  if (typeof body.baseVersion !== 'number' || body.baseVersion % 1 !== 0) {
    throw new Error('Update the app: this version of the app does not send the sheet version.');
  }
  var tables = body.tables;
  if (!Array.isArray(tables) || tables.length === 0 || tables.length > TABLES.length) {
    throw new Error('There is no data in the request.');
  }
  // Check everything first, so a bad request changes nothing.
  var seen = {};
  tables.forEach(function (t) {
    if (!t || TABLES.indexOf(t.name) < 0 || seen[t.name]) {
      throw new Error('Unknown or repeated table: ' + (t && t.name));
    }
    seen[t.name] = true;
    if (!Array.isArray(t.headers) || t.headers.length === 0 || t.headers.length > MAX_COLS) {
      throw new Error(t.name + ' has bad headers.');
    }
    if (!Array.isArray(t.rows) || t.rows.length > MAX_ROWS) {
      throw new Error(t.name + ' has too many rows.');
    }
    t.rows.forEach(function (row, i) {
      if (!Array.isArray(row) || row.length !== t.headers.length) {
        throw new Error(t.name + ' row ' + (i + 1) + ' has the wrong number of columns.');
      }
      row.forEach(function (cell) {
        var ok = cell === null || typeof cell === 'string' || (typeof cell === 'number' && isFinite(cell));
        if (!ok) throw new Error(t.name + ' row ' + (i + 1) + ' has an unsupported value.');
        if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
          throw new Error(t.name + ' row ' + (i + 1) + ' has a cell that is too long.');
        }
      });
    });
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var current = getVersion_();
    if (body.baseVersion !== current) {
      return { ok: false, code: 'conflict', error: 'The sheet changed since it was read.' };
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var written = {};
    var kept = [];
    tables.forEach(function (t) {
      if (writeTable_(ss, t)) written[t.name] = t.rows.length;
      else kept.push(t.name);
    });
    PropertiesService.getScriptProperties().setProperty(VERSION_PROP, String(current + 1));
    writeLog_(ss, body.user, body.device, written, kept);
    return { ok: true, written: written, keptAsIs: kept, version: current + 1 };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Overwrites one tab. An empty table never replaces a tab that has rows (a reinstalled app with
 * no data must not wipe the sheet), so that tab is reported as kept.
 */
function writeTable_(ss, t) {
  var sheet = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
  var existing = Math.max(0, sheet.getLastRow() - 1);
  if (t.rows.length === 0 && existing > 0) return false;
  writeSheet_(sheet, t.headers, t.rows);
  return true;
}

/** Replaces a tab's contents with a header row and these rows. */
function writeSheet_(sheet, headers, rows) {
  sheet.clearContents();
  var width = headers.length;
  var height = rows.length + 1;
  if (sheet.getMaxRows() < height) sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  // A column of numbers stays numeric. Every other column is plain text, so Sheets never turns
  // a phone number into a number or runs a note that starts with "=" as a formula.
  for (var c = 0; c < width; c++) {
    var numeric = rows.length > 0 && rows.every(function (r) {
      return r[c] === null || r[c] === '' || typeof r[c] === 'number';
    });
    sheet.getRange(1, c + 1, height, 1).setNumberFormat(numeric ? '#,##0' : '@');
  }

  var values = [headers.map(String)];
  rows.forEach(function (r) {
    values.push(r.map(function (cell) {
      if (cell === null) return '';
      return cell;
    }));
  });
  sheet.getRange(1, 1, height, width).setValues(values);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function writeLog_(ss, user, device, written, kept) {
  var sheet = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 5).setValues([['When', 'Who', 'Device', 'Rows written', 'Left as they were (empty in the app)']]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var counts = Object.keys(written).map(function (k) { return k + ' ' + written[k]; }).join(', ');
  var when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  // Plain text first: a name typed as "=..." must not run as a formula.
  var row = sheet.getRange(sheet.getLastRow() + 1, 1, 1, 5);
  row.setNumberFormat('@');
  row.setValues([[when, String(user || '').slice(0, 40), String(device || '').slice(0, 40), counts, kept.join(', ')]]);
  var extra = sheet.getLastRow() - 1 - MAX_LOG_ROWS;
  if (extra > 0) sheet.deleteRows(2, extra);
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ======================================================================================
// Version 2: people, sessions, roles, per-record merge
// ======================================================================================

var V2_ACTIONS_ = ['setupOwner', 'signIn', 'join', 'signOut', 'changePassword', 'people', 'invite', 'setRole',
  'removePerson', 'resetSignIn'];

function props_() { return PropertiesService.getScriptProperties(); }
function nowMs_() { return new Date().getTime(); }
function iso_(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }
function v2Enabled_() { return props_().getProperty(V2_FLAG) === '1'; }

function fail_(code, error, extra) {
  var r = { ok: false, code: code, error: error };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}

/** Before the first Owner: only the first-Owner step works. */
function handleV2NotReady_(body) {
  if (body.action === 'setupOwner') return withLock_(function () { return setupOwner_(body); });
  return fail_('notSetUp', 'This sheet has no people yet. Create the first Owner first.');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function handleV2_(body) {
  var action = body.action;
  if (body.session === undefined && body.token !== undefined && !(action === 'signIn' || action === 'join' || action === 'setupOwner')) {
    return fail_('updateApp', 'Update the app: this sheet now needs people to sign in.');
  }
  switch (action) {
    case 'setupOwner': return withLock_(function () { return setupOwner_(body); });
    case 'signIn': return withLock_(function () { return signIn_(body); });
    case 'join': return withLock_(function () { return join_(body); });
    case 'signOut': return withLock_(function () { return signOut_(body); });
    case 'pull': return withLock_(function () { return pullV2_(body); });
    case 'push': return withLock_(function () { return pushV2_(body); });
    case 'changePassword': return withLock_(function () { return changePassword_(body); });
    case 'people': return withLock_(function () { return ownerAction_(body, peopleList_); });
    case 'invite': return withLock_(function () { return ownerAction_(body, inviteAction_); });
    case 'setRole': return withLock_(function () { return ownerAction_(body, setRole_); });
    case 'removePerson': return withLock_(function () { return ownerAction_(body, removePerson_); });
    case 'resetSignIn': return withLock_(function () { return ownerAction_(body, resetSignIn_); });
    case 'ping': return withLock_(function () {
      var a = auth_(body);
      if (!a.ok) return a;
      return { ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName() };
    });
    default: return fail_('badRequest', 'Unknown action.');
  }
}

// ---------------------------------------------------------------- Hashing and codes

function hex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function sha256_(text) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

/** A slow salted hash for passwords: the secret is mixed into every round. */
function passwordHash_(salt, password) {
  var h = sha256_(salt + ':' + password);
  for (var i = 0; i < HASH_ROUNDS; i++) h = sha256_(h + ':' + salt + ':' + password);
  return h;
}

function randomHex_(bytes) {
  var out = '';
  while (out.length < bytes * 2) out += Utilities.getUuid().replace(/-/g, '');
  return out.slice(0, bytes * 2);
}

function newInviteCode_() {
  var hexs = randomHex_(12);
  var code = '';
  for (var i = 0; i < 12; i++) {
    code += INVITE_ALPHABET.charAt(parseInt(hexs.substr(i * 2, 2), 16) % INVITE_ALPHABET.length);
    if (i === 3 || i === 7) code += '-';
  }
  return code;
}

function normalizeInvite_(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function inviteHash_(code) { return sha256_('invite:' + normalizeInvite_(code)); }

function cleanName_(raw) {
  var s = String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_NAME).trim();
}

function nameKey_(name) { return cleanName_(name).toLowerCase(); }

function checkPassword_(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return 'The password needs at least ' + MIN_PASSWORD + ' characters.';
  if (pw.length > MAX_PASSWORD) return 'The password is too long.';
  return null;
}

// ---------------------------------------------------------------- Rate limits

function failCount_(key) {
  return parseInt(CacheService.getScriptCache().get(key) || '0', 10);
}
function addFail_(key) {
  var n = failCount_(key) + 1;
  CacheService.getScriptCache().put(key, String(n), LOGIN_LOCK_SECONDS);
  return n;
}
function clearFails_(key) { CacheService.getScriptCache().remove(key); }

// ---------------------------------------------------------------- People and sessions

function loadPersons_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(PERSON_PREFIX) === 0) {
      try { out.push(JSON.parse(all[k])); } catch (e) { /* skip a damaged row */ }
    }
  });
  return out;
}

function savePerson_(p) { props_().setProperty(PERSON_PREFIX + p.id, JSON.stringify(p)); }

function loadPerson_(id) {
  var raw = props_().getProperty(PERSON_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

function activeOwners_(persons) {
  return persons.filter(function (p) { return p.role === 'Owner' && p.status === 'active'; });
}

function findByName_(persons, name) {
  var key = nameKey_(name);
  for (var i = 0; i < persons.length; i++) if (persons[i].nameKey === key) return persons[i];
  return null;
}

function publicPerson_(p) { return { id: p.id, name: p.name, role: p.role }; }

/** Every name, so any phone can show "Recorded by". Roles are not shared. */
function directory_(persons) {
  return persons.map(function (p) { return { id: p.id, name: p.name }; })
    .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

function newPerson_(name, role, createdBy) {
  return {
    id: Utilities.getUuid().toUpperCase(), name: cleanName_(name), nameKey: nameKey_(name), role: role,
    status: 'invited', createdAt: iso_(nowMs_()), createdBy: createdBy || null,
    salt: null, hash: null, inviteHash: null, inviteExpiresAt: null, lastSyncAt: null, devices: [], disabledAt: null,
  };
}

function issueInvite_(person) {
  var code = newInviteCode_();
  person.inviteHash = inviteHash_(code);
  person.inviteExpiresAt = iso_(nowMs_() + INVITE_DAYS * 86400000);
  person.status = 'invited';
  person.salt = null;
  person.hash = null;
  return code;
}

function newSession_(person, device) {
  purgeOldSessions_();
  var code = randomHex_(32);
  var key = sha256_('session:' + code);
  var now = iso_(nowMs_());
  props_().setProperty(SESSION_PREFIX + key, JSON.stringify({
    personId: person.id, device: String(device || '').slice(0, 40), createdAt: now, lastSeenAt: now, ended: null,
  }));
  return code;
}

function sessionKey_(code) { return SESSION_PREFIX + sha256_('session:' + String(code || '')); }

function purgeOldSessions_() {
  var all = props_().getProperties();
  var cutoff = nowMs_() - 2 * SESSION_DAYS * 86400000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    try {
      var s = JSON.parse(all[k]);
      if (Date.parse(s.lastSeenAt) < cutoff) props_().deleteProperty(k);
    } catch (e) { props_().deleteProperty(k); }
  });
}

function endSessionsOf_(personId, reason) {
  var all = props_().getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSION_PREFIX) !== 0) return;
    try {
      var s = JSON.parse(all[k]);
      if (s.personId === personId && !s.ended) {
        s.ended = reason;
        props_().setProperty(k, JSON.stringify(s));
      }
    } catch (e) { /* ignore */ }
  });
}

/** Who is calling. { ok: true, person, key, session } or a refusal with code sessionEnded. */
function auth_(body) {
  var code = typeof body.session === 'string' ? body.session : '';
  if (!code) return fail_('sessionEnded', 'Please sign in again.', { reason: 'unknown' });
  var key = sessionKey_(code);
  var raw = props_().getProperty(key);
  if (!raw) return fail_('sessionEnded', 'Please sign in again.', { reason: 'unknown' });
  var s = JSON.parse(raw);
  if (s.ended) return fail_('sessionEnded', endedText_(s.ended), { reason: s.ended });
  var person = loadPerson_(s.personId);
  if (!person || person.status !== 'active') return fail_('sessionEnded', endedText_('removed'), { reason: 'removed' });
  if (nowMs_() - Date.parse(s.lastSeenAt) > SESSION_DAYS * 86400000) {
    s.ended = 'expired';
    props_().setProperty(key, JSON.stringify(s));
    return fail_('sessionEnded', endedText_('expired'), { reason: 'expired' });
  }
  return { ok: true, person: person, key: key, session: s };
}

function endedText_(reason) {
  if (reason === 'removed') return 'An Owner removed your access.';
  if (reason === 'reset') return 'An Owner reset your sign-in. Join again with a new invite.';
  if (reason === 'expired') return 'You have not synced for 90 days. Please sign in again.';
  return 'Please sign in again.';
}

/** Marks the session as seen, and the person's last sync and device, at most every 10 minutes. */
function touch_(a, body) {
  var s = a.session;
  var t = nowMs_();
  if (t - Date.parse(s.lastSeenAt) > 10 * 60000) {
    s.lastSeenAt = iso_(t);
    props_().setProperty(a.key, JSON.stringify(s));
  }
  var p = a.person;
  var device = String(body.device || s.device || '').slice(0, 40);
  var changed = false;
  if (!p.lastSyncAt || t - Date.parse(p.lastSyncAt) > 10 * 60000) { p.lastSyncAt = iso_(t); changed = true; }
  if (device && p.devices.indexOf(device) < 0) { p.devices = p.devices.concat([device]).slice(-6); changed = true; }
  if (changed) savePerson_(p);
}

// ---------------------------------------------------------------- Sign-in actions

function sessionReply_(person, code, persons) {
  return {
    ok: true, session: code, person: publicPerson_(person), directory: directory_(persons),
    spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
  };
}

function setupOwner_(body) {
  if (v2Enabled_()) return fail_('setupDone', 'This sheet already has an Owner.');
  var expected = props_().getProperty('PAHADI_TOKEN');
  if (!expected) return fail_('notSetUp', 'The sheet is not set up yet: add the PAHADI_TOKEN script property.');
  if (failCount_('setup') >= SETUP_MAX_FAILS) return fail_('locked', 'Too many wrong setup codes. Try again in 15 minutes.');
  if (!sameText_(String(body.token || ''), expected)) {
    addFail_('setup');
    return fail_('badSetup', 'Wrong setup code.');
  }
  var name = cleanName_(body.name);
  if (name.length < 2) return fail_('badRequest', 'Enter your name (at least 2 letters).');
  var bad = checkPassword_(body.password);
  if (bad) return fail_('badRequest', bad);
  clearFails_('setup');
  var p = newPerson_(name, 'Owner', null);
  p.salt = randomHex_(16);
  p.hash = passwordHash_(p.salt, body.password);
  p.status = 'active';
  savePerson_(p);
  props_().setProperty(V2_FLAG, '1');
  var code = newSession_(p, body.device);
  return sessionReply_(p, code, [p]);
}

function signIn_(body) {
  var name = cleanName_(body.name);
  var key = 'login:' + nameKey_(name);
  if (failCount_(key) >= LOGIN_MAX_FAILS) {
    return fail_('locked', 'Too many wrong passwords. Try again in 15 minutes.', { retryMinutes: 15 });
  }
  var persons = loadPersons_();
  var p = findByName_(persons, name);
  var pw = typeof body.password === 'string' ? body.password : '';
  var okPerson = p && p.status === 'active' && p.salt && p.hash;
  var computed = passwordHash_(okPerson ? p.salt : 'none', pw.slice(0, MAX_PASSWORD));
  if (!okPerson || !sameText_(computed, p.hash)) {
    var n = addFail_(key);
    return fail_('badLogin', 'Wrong name or password.', { triesLeft: Math.max(0, LOGIN_MAX_FAILS - n) });
  }
  clearFails_(key);
  var code = newSession_(p, body.device);
  return sessionReply_(p, code, persons);
}

function join_(body) {
  if (failCount_('join') >= SETUP_MAX_FAILS) return fail_('locked', 'Too many wrong invite codes. Try again in 15 minutes.');
  var hash = inviteHash_(body.invite);
  var persons = loadPersons_();
  var p = null;
  persons.forEach(function (x) { if (x.status === 'invited' && x.inviteHash && sameText_(x.inviteHash, hash)) p = x; });
  if (!p) {
    addFail_('join');
    return fail_('badInvite', 'That invite is not valid. It may have been used, replaced or removed.');
  }
  if (Date.parse(p.inviteExpiresAt) < nowMs_()) {
    return fail_('inviteExpired', 'That invite has expired. Ask an Owner for a new one.');
  }
  var bad = checkPassword_(body.password);
  if (bad) return fail_('badRequest', bad);
  clearFails_('join');
  p.salt = randomHex_(16);
  p.hash = passwordHash_(p.salt, body.password);
  p.status = 'active';
  p.inviteHash = null;
  p.inviteExpiresAt = null;
  p.joinedAt = iso_(nowMs_());
  savePerson_(p);
  var code = newSession_(p, body.device);
  return sessionReply_(p, code, persons);
}

function signOut_(body) {
  var code = typeof body.session === 'string' ? body.session : '';
  if (code) props_().deleteProperty(sessionKey_(code));
  return { ok: true };
}

function changePassword_(body) {
  var a = auth_(body);
  if (!a.ok) return a;
  var key = 'login:' + a.person.nameKey;
  if (failCount_(key) >= LOGIN_MAX_FAILS) return fail_('locked', 'Too many wrong passwords. Try again in 15 minutes.');
  var old = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  if (!sameText_(passwordHash_(a.person.salt, old.slice(0, MAX_PASSWORD)), a.person.hash)) {
    var n = addFail_(key);
    return fail_('badLogin', 'The current password is wrong.', { triesLeft: Math.max(0, LOGIN_MAX_FAILS - n) });
  }
  var bad = checkPassword_(body.newPassword);
  if (bad) return fail_('badRequest', bad);
  clearFails_(key);
  a.person.salt = randomHex_(16);
  a.person.hash = passwordHash_(a.person.salt, body.newPassword);
  savePerson_(a.person);
  return { ok: true };
}

// ---------------------------------------------------------------- People (Owner only)

function ownerAction_(body, fn) {
  var a = auth_(body);
  if (!a.ok) return a;
  if (a.person.role !== 'Owner') return fail_('forbidden', 'Only an Owner can do this.');
  return fn(body, a);
}

function countRecordedBy_() {
  var counts = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [['Money', 'payments'], ['Bookings', 'bookings']].forEach(function (pair) {
    var sheet = ss.getSheetByName(pair[0]);
    if (!sheet) return;
    readRecords_(sheet).forEach(function (line) {
      var o = parseLine_(line);
      if (!o || o.deletedAt || !o.createdBy) return;
      if (pair[0] === 'Money' && o.kind !== 'Money in') return;
      var c = counts[o.createdBy] || (counts[o.createdBy] = { payments: 0, bookings: 0 });
      c[pair[1]]++;
    });
  });
  return counts;
}

function peopleList_(body, a) {
  var persons = loadPersons_();
  var names = {};
  persons.forEach(function (p) { names[p.id] = p.name; });
  var counts = countRecordedBy_();
  var list = persons.map(function (p) {
    var c = counts[p.id] || { payments: 0, bookings: 0 };
    return {
      id: p.id, name: p.name, role: p.role, status: p.status, createdAt: p.createdAt,
      addedBy: p.createdBy ? (names[p.createdBy] || '') : '', lastSyncAt: p.lastSyncAt, devices: p.devices,
      inviteExpiresAt: p.status === 'invited' ? p.inviteExpiresAt : null, disabledAt: p.disabledAt,
      payments: c.payments, bookings: c.bookings,
    };
  }).sort(function (x, y) { return x.name.toLowerCase() < y.name.toLowerCase() ? -1 : 1; });
  return { ok: true, people: list };
}

function inviteAction_(body, a) {
  var persons = loadPersons_();
  var p;
  if (body.personId) {
    p = persons.filter(function (x) { return x.id === body.personId; })[0];
    if (!p) return fail_('badRequest', 'That person was not found.');
    if (p.status === 'active') return fail_('badRequest', 'That person is already signed up. Use Reset sign-in instead.');
  } else {
    var name = cleanName_(body.name);
    if (name.length < 2) return fail_('badRequest', 'Enter the person\'s name (at least 2 letters).');
    if (ROLES.indexOf(body.role) < 0) return fail_('badRequest', 'Choose a role.');
    if (findByName_(persons, name)) {
      return fail_('nameTaken', 'Someone is already called ' + name + '. Use a different name, for example with a surname.');
    }
    p = newPerson_(name, body.role, a.person.id);
  }
  var code = issueInvite_(p);
  p.disabledAt = null;
  savePerson_(p);
  return { ok: true, code: code, expiresAt: p.inviteExpiresAt, person: publicPerson_(p) };
}

function setRole_(body, a) {
  if (ROLES.indexOf(body.role) < 0) return fail_('badRequest', 'Choose a role.');
  var persons = loadPersons_();
  var p = persons.filter(function (x) { return x.id === body.personId; })[0];
  if (!p) return fail_('badRequest', 'That person was not found.');
  if (p.role === 'Owner' && p.status === 'active' && body.role !== 'Owner' && activeOwners_(persons).length < 2) {
    return fail_('lastOwner', 'There must always be at least one Owner.');
  }
  p.role = body.role;
  savePerson_(p);
  return { ok: true, person: publicPerson_(p) };
}

function removePerson_(body, a) {
  var persons = loadPersons_();
  var p = persons.filter(function (x) { return x.id === body.personId; })[0];
  if (!p) return fail_('badRequest', 'That person was not found.');
  if (p.role === 'Owner' && p.status === 'active' && activeOwners_(persons).length < 2) {
    return fail_('lastOwner', 'There must always be at least one Owner.');
  }
  p.status = 'disabled';
  p.disabledAt = iso_(nowMs_());
  p.salt = null;
  p.hash = null;
  p.inviteHash = null;
  p.inviteExpiresAt = null;
  savePerson_(p);
  endSessionsOf_(p.id, 'removed');
  return { ok: true };
}

/** Clears the password, signs the person out everywhere and issues a new invite. Also restores a removed person. */
function resetSignIn_(body, a) {
  var persons = loadPersons_();
  var p = persons.filter(function (x) { return x.id === body.personId; })[0];
  if (!p) return fail_('badRequest', 'That person was not found.');
  var code = issueInvite_(p);
  p.disabledAt = null;
  savePerson_(p);
  endSessionsOf_(p.id, 'reset');
  clearFails_('login:' + p.nameKey);
  return { ok: true, code: code, expiresAt: p.inviteExpiresAt, person: publicPerson_(p) };
}

/**
 * Run from the script editor (Run > recoverOwner) if every Owner is locked out. It needs you to be the
 * owner of the Google Sheet. Add a script property RECOVERY_NAME with the Owner's name first (optional).
 * Read the invite code in View > Logs, then use it in the app with the sheet address.
 */
function recoverOwner() {
  var name = props_().getProperty('RECOVERY_NAME') || 'Recovered Owner';
  var persons = loadPersons_();
  var p = findByName_(persons, name) || newPerson_(name, 'Owner', null);
  p.role = 'Owner';
  var code = issueInvite_(p);
  p.disabledAt = null;
  savePerson_(p);
  endSessionsOf_(p.id, 'reset');
  props_().setProperty(V2_FLAG, '1');
  Logger.log('Invite for ' + p.name + ' (Owner): ' + code + '  Expires ' + p.inviteExpiresAt +
    '. In the app choose "I have an invite", paste this code and the web app address.');
  return code;
}

// ---------------------------------------------------------------- Reading, with roles

function parseLine_(line) {
  try {
    var o = JSON.parse(line);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) { return null; }
}

function canonical_(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical_).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + canonical_(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v);
}

/** What this role may read of one tab. Staff never get money out or vendor rates and agreements. */
function filterForRole_(role, name, lines) {
  if (role !== 'Staff') return lines;
  if (name === 'Money') {
    return lines.filter(function (l) { var o = parseLine_(l); return o && o.kind === 'Money in'; });
  }
  if (name === 'Vendors') {
    return lines.map(function (l) {
      var o = parseLine_(l);
      if (!o) return l;
      delete o.rate;
      o.agreements = [];
      return canonical_(o);
    });
  }
  return lines;
}

function pullV2_(body) {
  var a = auth_(body);
  if (!a.ok) return a;
  touch_(a, body);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tables = {};
  TABLES.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    tables[name] = filterForRole_(a.person.role, name, sheet ? readRecords_(sheet) : []);
  });
  return {
    ok: true, version: getVersion_(), tables: tables, person: publicPerson_(a.person),
    directory: directory_(loadPersons_()), spreadsheet: ss.getName(),
  };
}

// ---------------------------------------------------------------- Writing, with roles

var STAFF_WRITES_ = { Bookings: true, Money: true };

function changedAtOf_(o) {
  var t = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
  return isNaN(t) ? -Infinity : t;
}

function sameId_(a, b) { return String(a).toUpperCase() === String(b).toUpperCase(); }

/** Why this person may not write this record, or null. `existing` is the record in the sheet, if any. */
function roleRefusal_(person, table, incoming, existing) {
  if (person.role !== 'Staff') return null;
  if (!STAFF_WRITES_[table]) return 'Your role cannot change ' + table.toLowerCase() + '.';
  if (incoming.deletedAt) return 'Your role cannot delete records.';
  if (table === 'Bookings') {
    if (incoming.cancelledAt && !(existing && existing.cancelledAt)) return 'Your role cannot cancel bookings.';
    if (existing && existing.createdBy !== person.id) return 'You can only change bookings you added.';
    return null;
  }
  if (incoming.kind !== 'Money in') return 'Your role can only record payments received.';
  if (existing && (existing.kind !== 'Money in' || existing.createdBy !== person.id)) {
    return 'You can only change payments you recorded.';
  }
  return null;
}

function validateTables_(tables) {
  if (!Array.isArray(tables) || tables.length > TABLES.length) throw new Error('There is no data in the request.');
  var seen = {};
  tables.forEach(function (t) {
    if (!t || TABLES.indexOf(t.name) < 0 || seen[t.name]) throw new Error('Unknown or repeated table: ' + (t && t.name));
    seen[t.name] = true;
    if (!Array.isArray(t.headers) || t.headers.length === 0 || t.headers.length > MAX_COLS - EXTRA_COLUMNS.length) {
      throw new Error(t.name + ' has bad headers.');
    }
    if (t.headers.indexOf(JSON_COLUMN) < 0) throw new Error(t.name + ' has no ' + JSON_COLUMN + ' column.');
    if (!Array.isArray(t.rows) || t.rows.length > MAX_ROWS) throw new Error(t.name + ' has too many rows.');
    t.rows.forEach(function (row, i) {
      if (!Array.isArray(row) || row.length !== t.headers.length) {
        throw new Error(t.name + ' row ' + (i + 1) + ' has the wrong number of columns.');
      }
      row.forEach(function (cell) {
        var ok = cell === null || typeof cell === 'string' || (typeof cell === 'number' && isFinite(cell));
        if (!ok) throw new Error(t.name + ' row ' + (i + 1) + ' has an unsupported value.');
        if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
          throw new Error(t.name + ' row ' + (i + 1) + ' has a cell that is too long.');
        }
      });
    });
  });
}

function pushV2_(body) {
  var a = auth_(body);
  if (!a.ok) return a;
  touch_(a, body);
  var tables = body.tables;
  validateTables_(tables);
  var person = a.person;
  var names = {};
  loadPersons_().forEach(function (p) { names[p.id] = p.name; });
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var accepted = {};
  var rejected = [];
  var any = false;
  tables.forEach(function (t) {
    var r = mergeTable_(ss, t, person, names);
    accepted[t.name] = r.accepted;
    r.rejected.forEach(function (x) { if (rejected.length < MAX_REJECTED_REPORTED) rejected.push(x); });
    if (r.accepted > 0) any = true;
  });
  var version = getVersion_();
  if (any) {
    version += 1;
    props_().setProperty(VERSION_PROP, String(version));
    writeLog_(ss, person.name, body.device, accepted, []);
  }
  return { ok: true, accepted: accepted, rejected: rejected, version: version };
}

/** Merges one pushed tab into the sheet, record by record. Returns how many were taken and which were refused. */
function mergeTable_(ss, t, person, names) {
  var sheet = ss.getSheetByName(t.name);
  var jsonCol = t.headers.indexOf(JSON_COLUMN);
  var width = t.headers.length;
  var rows = [];
  if (sheet && sheet.getLastRow() >= 1) {
    var values = sheet.getDataRange().getValues();
    var header = values[0];
    for (var h = 0; h < width; h++) {
      if (String(header[h]) !== String(t.headers[h])) {
        throw new Error('The sheet\'s ' + t.name + ' columns do not match this app. Update the app.');
      }
    }
    rows = values.slice(1);
  }
  var index = {};
  rows.forEach(function (row, i) {
    var cell = row[jsonCol];
    var o = typeof cell === 'string' && cell.charAt(0) === '{' ? parseLine_(cell) : null;
    if (o && typeof o.id === 'string') index[o.id.toUpperCase()] = { i: i, o: o };
  });

  var accepted = 0;
  var rejected = [];
  t.rows.forEach(function (row) {
    var o = parseLine_(row[jsonCol]);
    if (!o || typeof o.id !== 'string') {
      rejected.push({ table: t.name, id: '', reason: 'Unreadable record.' });
      return;
    }
    var key = o.id.toUpperCase();
    var found = index[key];
    var ex = found ? found.o : null;
    var why = roleRefusal_(person, t.name, o, ex);
    if (why) { rejected.push({ table: t.name, id: o.id, reason: why }); return; }

    var incoming = changedAtOf_(o);
    var existing = ex ? changedAtOf_(ex) : -Infinity;
    var take;
    if (!ex) take = 'new';
    else if (incoming > existing) take = 'newer';
    else if (incoming === existing) {
      if (!!o.deletedAt !== !!ex.deletedAt) take = o.deletedAt ? 'newer' : null;
      else take = canonical_(stripAuthors_(o)) === canonical_(stripAuthors_(ex)) ? null : 'refresh';
    } else take = null;
    if (!take) return;

    if (take === 'new') {
      if (o.createdBy !== undefined && o.createdBy !== person.id) {
        rejected.push({ table: t.name, id: o.id, reason: 'The record names someone else as its author.' });
        return;
      }
      if (o.createdBy !== undefined) o.updatedBy = person.id; else delete o.updatedBy;
    } else if (take === 'newer') {
      if (ex.createdBy !== undefined) o.createdBy = ex.createdBy; else delete o.createdBy;
      o.updatedBy = person.id;
    } else {
      if (ex.createdBy !== undefined) o.createdBy = ex.createdBy; else delete o.createdBy;
      if (ex.updatedBy !== undefined) o.updatedBy = ex.updatedBy; else delete o.updatedBy;
    }
    var newRow = row.slice();
    newRow[jsonCol] = canonical_(o);
    if (found) { rows[found.i] = newRow; found.o = o; } else {
      rows.push(newRow);
      index[key] = { i: rows.length - 1, o: o };
    }
    accepted++;
  });

  if (accepted === 0) return { accepted: 0, rejected: rejected };

  var headers = t.headers.concat(EXTRA_COLUMNS);
  var out = rows.map(function (row) {
    var cells = row.slice(0, width);
    while (cells.length < width) cells.push('');
    var cell = row[jsonCol];
    var o = typeof cell === 'string' && cell.charAt(0) === '{' ? parseLine_(cell) : null;
    cells.push(o && o.createdBy ? (names[o.createdBy] || '') : '');
    cells.push(o && o.updatedBy ? (names[o.updatedBy] || '') : '');
    return cells;
  });
  writeSheet_(sheet || ss.insertSheet(t.name), headers, out);
  return { accepted: accepted, rejected: rejected };
}

function stripAuthors_(o) {
  var c = {};
  Object.keys(o).forEach(function (k) { if (k !== 'createdBy' && k !== 'updatedBy') c[k] = o[k]; });
  return c;
}
