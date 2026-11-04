import { launch } from './cdp.mjs';
import { ensurePreview } from './preview.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('e2e/out', { recursive: true });
const stopPreview = await ensurePreview();
const b = await launch({ url: 'http://localhost:4173/', out: 'e2e/out', port: 9341 });
const dims = await b.ev('JSON.stringify([innerWidth, innerHeight, devicePixelRatio])');
console.log('viewport', dims);
for (const t of ['chat', 'treks', 'money', 'vendors', 'settings', 'prompt', 'cloud-setup', 'duplicates', 'edit-trek/new', 'edit-vendor/new', 'entry?kind=in']) {
  await b.go('http://localhost:4173/#/' + t); await b.sleep(400);
  const txt = (await b.text()).replace(/\s+/g, ' ').slice(0, 110);
  console.log(t.padEnd(16), '|', txt);
  await b.shot('tour-' + t.replace(/[^a-z]/g, '-'));
}
console.log('page errors:', JSON.stringify(b.errors), 'console:', JSON.stringify(b.logs));
// service worker + offline
await b.go('http://localhost:4173/'); await b.sleep(1500);
console.log('sw controller after load:', await b.ev('!!navigator.serviceWorker.controller'));
await b.ev('navigator.serviceWorker.ready.then(()=>true)');
await b.go('http://localhost:4173/'); await b.sleep(800);
console.log('sw controller after 2nd load:', await b.ev('!!navigator.serviceWorker.controller'));
await b.send('Network.enable');
await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await b.go('http://localhost:4173/#/treks'); await b.sleep(800);
console.log('OFFLINE reload shows:', (await b.text()).replace(/\s+/g, ' ').slice(0, 90));
await b.shot('offline-treks');
await b.close(); stopPreview();
