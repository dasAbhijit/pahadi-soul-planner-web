// Loads the REAL cloud/Code.gs into a fake Google environment and exposes call(bodyString).
const fs = require('fs'), vm = require('vm'), path = require('path');
const CODE = path.join(__dirname, '..', 'cloud', 'Code.gs');
function makeEnv(token) {
  const sheets = {}, props = { PAHADI_TOKEN: token };
  const makeSheet = (name) => { const s = { name, grid: [], maxRows: 1000, maxCols: 26,
    getLastRow() { return s.grid.length; }, getMaxRows() { return s.maxRows; }, getMaxColumns() { return s.maxCols; },
    insertRowsAfter(_, n) { s.maxRows += n; }, insertColumnsAfter(_, n) { s.maxCols += n; },
    clearContents() { s.grid = []; }, setFrozenRows() {}, deleteRows(a, n) { s.grid.splice(a - 1, n); },
    getDataRange() { return { getValues: () => s.grid.map((r) => r.slice()) }; },
    getRange(r, c, nr, nc) { return { setNumberFormat() {}, setFontWeight() {},
      setValues(v) { v.forEach((row, i) => { s.grid[r - 1 + i] = s.grid[r - 1 + i] || []; row.forEach((x, j) => { s.grid[r - 1 + i][c - 1 + j] = x; }); }); } }; } }; return s; };
  const ss = { getName: () => 'Pahadi Soul Planner App', getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
  const ctx = { SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    Utilities: { formatDate: () => '2026-11-04 10:00:00' }, Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    JSON, Math, Object, Array, String, Number, isFinite, parseInt };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(CODE, 'utf8'), ctx);
  return { sheets, props, call: (body) => ctx.doPost({ postData: { contents: body } }).text };
}
module.exports = { makeEnv };
