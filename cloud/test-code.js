// Runs Code.gs against a small fake of Google's Apps Script classes.
// Usage: node cloud/test-code.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeEnv(token) {
  const sheets = {};
  const events = [];
  const props = {};
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
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    Utilities: { formatDate: () => '2026-11-04 10:00:00' },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    JSON, Math, Object, Array, String, Number, isFinite, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), ctx);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  const version = () => parseInt(props.SYNC_VERSION || '0', 10);
  return { sheets, events, props, call, ctx, version };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }

const rec = (id, extra) => JSON.stringify({ id, ...extra });
const treks = { name: 'Treks', headers: ['Trek ID', 'Name', 'Days', 'Price', 'Record (JSON)'],
  rows: [['A', 'Kuari Pass', 6, 14500, rec('A', { n: 1 })], ['B', 'Sandakphu', 5, null, rec('B', { n: 2 })]] };
const money = { name: 'Money', headers: ['Entry ID', 'Note', 'Amount', 'Record (JSON)'],
  rows: [['E1', '=HYPERLINK("http://x","y")', 5000, rec('E1', {})], ['E2', '+919876543210', 1500, rec('E2', {})]] };
const push = (env, tables, extra) => env.call({ token: 's', action: 'push', baseVersion: env.version(), tables, ...extra });

test('refuses when no secret is configured', () => {
  const r = makeEnv(undefined).call({ token: 'x', action: 'ping' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not set up/);
});

test('refuses a wrong or missing secret, for push and pull alike', () => {
  const env = makeEnv('right-secret');
  assert.match(env.call({ token: 'nope', action: 'push', baseVersion: 0, tables: [treks] }).error, /Wrong secret/);
  assert.match(env.call({ action: 'push', baseVersion: 0, tables: [treks] }).error, /Wrong secret/);
  assert.match(env.call({ token: 'nope', action: 'pull' }).error, /Wrong secret/);
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

test('ping works with the right secret and writes nothing', () => {
  const env = makeEnv('s');
  const r = env.call({ token: 's', action: 'ping' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.spreadsheet, 'Pahadi Soul Planner App');
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

test('push writes headers and rows into one tab per table and returns the new version', () => {
  const env = makeEnv('s');
  const r = push(env, [treks, money], { device: 'Android' });
  assert.deepStrictEqual(r, { ok: true, written: { Treks: 2, Money: 2 }, keptAsIs: [], version: 1 });
  assert.deepStrictEqual(env.sheets.Treks.grid[0], ['Trek ID', 'Name', 'Days', 'Price', 'Record (JSON)']);
  assert.deepStrictEqual(env.sheets.Treks.grid[2].slice(0, 4), ['B', 'Sandakphu', 5, '']);
  assert.strictEqual(env.sheets.Treks.frozen, 1);
});

test('text columns are formatted as plain text before values go in, numeric columns stay numeric', () => {
  const env = makeEnv('s');
  push(env, [money]);
  assert.strictEqual(env.sheets.Money.formats[2], '@');
  assert.strictEqual(env.sheets.Money.formats[3], '#,##0');
  const firstValues = env.events.findIndex((e) => e[0] === 'Money' && e[1] === 'values');
  const lastFormat = env.events.map((e) => e[0] + ',' + e[1]).lastIndexOf('Money,format');
  assert.ok(lastFormat < firstValues, 'formats must be applied before the values are written');
  assert.strictEqual(env.sheets.Money.grid[1][1], '=HYPERLINK("http://x","y")');
});

test('pull returns each tab\'s JSON lines and the current version', () => {
  const env = makeEnv('s');
  push(env, [treks, money]);
  const r = env.call({ token: 's', action: 'pull' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 1);
  assert.deepStrictEqual(r.tables.Treks, [rec('A', { n: 1 }), rec('B', { n: 2 })]);
  assert.deepStrictEqual(r.tables.Money, [rec('E1', {}), rec('E2', {})]);
  assert.deepStrictEqual(r.tables.Vendors, []);
  assert.deepStrictEqual(r.tables.Guidance, []);
});

test('pull on a brand-new sheet is empty at version 0 and creates nothing', () => {
  const env = makeEnv('s');
  const r = env.call({ token: 's', action: 'pull' });
  assert.deepStrictEqual(r, { ok: true, version: 0, tables: { Treks: [], Bookings: [], Money: [], Vendors: [], Guidance: [] } });
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

test('pull ignores rows typed by hand (no JSON record) and tabs with no JSON column', () => {
  const env = makeEnv('s');
  push(env, [treks]);
  env.sheets.Treks.grid.push(['C', 'Hand typed', 3, 9000, '']);
  env.sheets.Treks.grid.push(['D', 'Notes', 1, 1, 'just a note']);
  env.sheets.Money = { name: 'Money', grid: [['a', 'b'], ['1', '2']], getLastRow() { return 2; }, getDataRange() { return { getValues: () => this.grid }; } };
  const r = env.call({ token: 's', action: 'pull' });
  assert.deepStrictEqual(r.tables.Treks, [rec('A', { n: 1 }), rec('B', { n: 2 })]);
  assert.deepStrictEqual(r.tables.Money, []);
});

test('a push based on an old version is refused and changes nothing', () => {
  const env = makeEnv('s');
  push(env, [treks]);                                      // version 1
  const stale = env.call({ token: 's', action: 'push', baseVersion: 0, tables: [{ ...treks, rows: [['Z', 'Overwrite', 1, 1, rec('Z', {})]] }] });
  assert.deepStrictEqual(stale, { ok: false, code: 'conflict', error: 'The sheet changed since it was read.' });
  assert.strictEqual(env.version(), 1);
  assert.strictEqual(env.sheets.Treks.grid[1][1], 'Kuari Pass');
});

test('two phones: the second to push on the same base is refused, then succeeds after pulling again', () => {
  const env = makeEnv('s');
  const base = env.call({ token: 's', action: 'pull' }).version;           // both read version 0
  const a = env.call({ token: 's', action: 'push', baseVersion: base, tables: [treks] });
  const b = env.call({ token: 's', action: 'push', baseVersion: base, tables: [money] });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.code, 'conflict');
  const again = env.call({ token: 's', action: 'pull' }).version;
  assert.strictEqual(env.call({ token: 's', action: 'push', baseVersion: again, tables: [money] }).version, 2);
});

test('a push without a version number is refused', () => {
  const env = makeEnv('s');
  const r = env.call({ token: 's', action: 'push', tables: [treks] });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Update the app/);
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

test('a second push replaces the old rows', () => {
  const env = makeEnv('s');
  push(env, [treks]);
  push(env, [{ ...treks, rows: [['C', 'Dzongri', 7, 20000, rec('C', {})]] }]);
  assert.strictEqual(env.sheets.Treks.grid.length, 2);
  assert.strictEqual(env.sheets.Treks.grid[1][1], 'Dzongri');
});

test('an empty table never wipes a tab that has rows', () => {
  const env = makeEnv('s');
  push(env, [money]);
  const r = push(env, [{ ...money, rows: [] }, treks]);
  assert.deepStrictEqual(r, { ok: true, written: { Treks: 2 }, keptAsIs: ['Money'], version: 2 });
  assert.strictEqual(env.sheets.Money.grid.length, 3);
});

test('an empty table on an empty tab just writes the headers', () => {
  const env = makeEnv('s');
  const r = push(env, [{ ...money, rows: [] }]);
  assert.deepStrictEqual(r.written, { Money: 0 });
  assert.deepStrictEqual(env.sheets.Money.grid, [['Entry ID', 'Note', 'Amount', 'Record (JSON)']]);
});

test('bad requests change nothing and do not move the version', () => {
  const env = makeEnv('s');
  const bads = [
    { tables: [{ ...treks, name: 'Secrets' }], msg: /Unknown/ },
    { tables: [treks, treks], msg: /repeated/ },
    { tables: [{ ...treks, rows: [['only one']] }], msg: /wrong number of columns/ },
    { tables: [{ ...treks, rows: [['A', 'B', 1, 2, { x: 1 }]] }], msg: /unsupported/ },
    { tables: [{ ...treks, rows: [['A', 'B', 1, 2, 'x'.repeat(49001)]] }], msg: /too long/ },
    { tables: [{ ...treks, headers: [] }], msg: /bad headers/ },
    { tables: [], msg: /no data/ },
  ];
  for (const b of bads) {
    const r = push(env, b.tables);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, b.msg);
  }
  assert.deepStrictEqual(Object.keys(env.sheets), []);
  assert.strictEqual(env.version(), 0);
});

test('a valid table is not written when a later one is invalid', () => {
  const env = makeEnv('s');
  const r = push(env, [treks, { ...money, rows: [['x']] }]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(Object.keys(env.sheets), []);
});

test('junk bodies and unknown actions fail cleanly', () => {
  const env = makeEnv('s');
  assert.strictEqual(env.call('not json').ok, false);
  assert.strictEqual(env.ctx.doPost({}).text.includes('Empty request'), true);
  assert.match(env.call({ token: 's', action: 'delete-everything' }).error, /Unknown action/);
});

test('each push adds a line to the sync log with who sent it', () => {
  const env = makeEnv('s');
  push(env, [treks], { user: 'Meera', device: 'iPhone' });
  push(env, [treks], { user: 'Asha', device: 'Android' });
  const log = env.sheets['Sync log'].grid;
  assert.strictEqual(log.length, 3);
  assert.deepStrictEqual(log[0].slice(0, 3), ['When', 'Who', 'Device']);
  assert.deepStrictEqual(log[1].slice(1, 4), ['Meera', 'iPhone', 'Treks 2']);
  assert.deepStrictEqual(log[2].slice(1, 4), ['Asha', 'Android', 'Treks 2']);
});

test('a name that looks like a formula is logged as plain text', () => {
  const env = makeEnv('s');
  push(env, [treks], { user: '=IMPORTDATA("http://x")', device: 'iPhone' });
  const sheet = env.sheets['Sync log'];
  assert.strictEqual(sheet.formats[2], '@');
  const lastFormat = env.events.map((e) => e.slice(0, 2).join()).lastIndexOf('Sync log,format');
  const lastValues = env.events.map((e) => e.slice(0, 2).join()).lastIndexOf('Sync log,values');
  assert.ok(lastFormat < lastValues);
  assert.strictEqual(sheet.grid[1][1], '=IMPORTDATA("http://x")');
});

console.log(`\n${passed} passed`);
