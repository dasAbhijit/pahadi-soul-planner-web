// Minimal Chrome DevTools driver: launches headless Chrome, emulates a phone, runs steps, saves screenshots.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export async function launch({ url, width = 390, height = 844, out = '.', port = 9333 }) {
  const dir = mkdtempSync(join(tmpdir(), 'chr-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const handlers = {}; let id = 0; const pending = new Map(); const errors = []; const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method && handlers[d.method]) handlers[d.method](d.params);
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = {
    errors, logs, send, sleep,
    // Answer requests to script.google.com from `call(bodyText) -> responseText` (a fake Google).
    async fakeGoogle(call, seen = []) {
      handlers['Fetch.requestPaused'] = (p) => {
        const body = p.request.postData || '';
        seen.push(JSON.parse(body || '{}').action);
        const text = call(body);
        send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(text).toString('base64') });
      };
      await send('Fetch.enable', { patterns: [{ urlPattern: 'https://script.google.com/*' }] });
    },
    async go(u) { await send('Page.navigate', { url: u }); await sleep(900); },
    async ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed: ' + expr); return r.result.result.value; },
    async shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); },
    async text() { return api.ev('document.body.innerText'); },
    // click the first element (button, a, role=button, label) whose text contains `t`
    async click(t, sel = 'button,a,[role=button],.card.tap,label') {
      const ok = await api.ev(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.offsetParent!==null||e.getClientRects().length);const el=els.find(e=>(e.innerText||e.getAttribute('aria-label')||'').trim().includes(${JSON.stringify(t)}));if(!el)return false;el.scrollIntoView({block:'center'});el.click();return true})()`);
      if (!ok) throw new Error('nothing to click: ' + t);
      await sleep(250);
    },
    async type(selector, text, index = 0) {
      await api.ev(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!el)throw new Error('no field ${selector}');el.scrollIntoView({block:'center'});el.focus();if(el.select)el.select();})()`);
      await send('Input.insertText', { text }); await sleep(120);
    },
    async setSelect(selector, label, index = 0) {
      await api.ev(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];const o=[...el.options].find(o=>o.text.includes(${JSON.stringify(label)}));if(!o)throw new Error('no option ${label}');el.value=o.value;el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await sleep(200);
    },
    async close() { try { await send('Browser.close'); } catch {} ws.close(); proc.kill(); },
  };
  await api.go(url);
  return api;
}
