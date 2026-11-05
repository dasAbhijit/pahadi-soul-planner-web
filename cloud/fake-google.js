// A small fake of Google's Apps Script classes, enough to run Code.gs in Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeEnv(token) {
  const sheets = {};
  const events = [];
  const props = {};
  const cache = {};
  const logs = [];
  const clock = { t: Date.parse('2026-11-05T09:00:00Z') };
  if (token !== undefined) props.PAHADI_TOKEN = token;

  function makeSheet(name) {
    const s = {
      name, grid: [], formats: {}, frozen: 0, maxRows: 1000, maxCols: 26,
      getLastRow() { return s.grid.length; },
      getMaxRows() { return s.maxRows; },
      getMaxColumns() { return s.maxCols; },
      insertRowsAfter(_, n) { s.maxRows += n; },
      insertColumnsAfter(_, n) { s.maxCols += n; },
      clearContents() { s.grid = []; events.push([name, 'clear']); },
      setFrozenRows(n) { s.frozen = n; },
      deleteRows(start, n) { s.grid.splice(start - 1, n); },
      getDataRange() { return { getValues: () => s.grid.map((r) => r.slice()) }; },
      getRange(r, c, nr, nc) {
        return {
          setNumberFormat(f) { for (let i = 0; i < nc; i++) s.formats[c + i] = f; events.push([name, 'format', c, f]); },
          setValues(v) {
            events.push([name, 'values']);
            v.forEach((row, i) => { s.grid[r - 1 + i] = s.grid[r - 1 + i] || []; row.forEach((x, j) => { s.grid[r - 1 + i][c - 1 + j] = x; }); });
          },
          setFontWeight() {},
        };
      },
    };
    return s;
  }

  const ss = {
    getName: () => 'Pahadi Soul Planner App',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => ({ ...props }),
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache && cache[k].until > clock.t ? cache[k].value : null),
      put: (k, v, sec) => { cache[k] = { value: String(v), until: clock.t + sec * 1000 }; },
      remove: (k) => { delete cache[k]; },
    }) },
    Logger: { log: (m) => logs.push(m) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: {
      formatDate: () => '2026-11-04 10:00:00',
      computeDigest: (_algo, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
    },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    JSON, Math, Object, Array, String, Number, isFinite, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), ctx);
  ctx.nowMs_ = () => clock.t;
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  const version = () => parseInt(props.SYNC_VERSION || '0', 10);
  const advance = (ms) => { clock.t += ms; };
  return { sheets, events, props, call, ctx, version, advance, clock, logs, cache };
}

module.exports = { makeEnv };
