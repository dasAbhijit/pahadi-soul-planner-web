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

function doGet() {
  return reply_({ ok: true, app: 'Pahadi Soul Planner sync' });
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw) return reply_({ ok: false, error: 'Empty request.' });
    if (raw.length > MAX_BODY_CHARS) return reply_({ ok: false, error: 'The request is too large.' });

    var expected = PropertiesService.getScriptProperties().getProperty('PAHADI_TOKEN');
    if (!expected) {
      return reply_({ ok: false, error: 'The sheet is not set up yet: add the PAHADI_TOKEN script property.' });
    }

    var body = JSON.parse(raw);
    if (!sameText_(String(body.token || ''), expected)) {
      return reply_({ ok: false, error: 'Wrong secret code.' });
    }

    if (body.action === 'ping') {
      return reply_({ ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
    }
    if (body.action === 'pull') return reply_(pull_());
    if (body.action === 'push') return reply_(push_(body));
    return reply_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
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

  sheet.clearContents();
  var width = t.headers.length;
  var height = t.rows.length + 1;
  if (sheet.getMaxRows() < height) sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  // A column of numbers stays numeric. Every other column is plain text, so Sheets never turns
  // a phone number into a number or runs a note that starts with "=" as a formula.
  for (var c = 0; c < width; c++) {
    var numeric = t.rows.length > 0 && t.rows.every(function (r) {
      return r[c] === null || r[c] === '' || typeof r[c] === 'number';
    });
    sheet.getRange(1, c + 1, height, 1).setNumberFormat(numeric ? '#,##0' : '@');
  }

  var values = [t.headers.map(String)];
  t.rows.forEach(function (r) {
    values.push(r.map(function (cell) {
      if (cell === null) return '';
      return cell;
    }));
  });
  sheet.getRange(1, 1, height, width).setValues(values);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return true;
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
