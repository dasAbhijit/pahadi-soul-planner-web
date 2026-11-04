// Runs after `vite build`: writes dist/sw.js with the list of files to keep for offline use and a version that
// changes whenever any of them changes (so phones notice there is a new version).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(relative(dist, full).split(sep).join('/'));
  }
})(dist);

const precache = files.filter((f) => f !== 'sw.js' && !f.endsWith('.map') && f !== '.nojekyll').sort();
const hash = createHash('sha256');
for (const f of precache) { hash.update(f); hash.update(readFileSync(join(dist, f))); }
const version = hash.digest('hex').slice(0, 12);

const urls = ['./', ...precache.map((f) => './' + f)];
const template = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
writeFileSync(join(dist, 'sw.js'), template.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(urls, null, 2)));
// GitHub Pages: do not run the files through Jekyll.
writeFileSync(join(dist, '.nojekyll'), '');
console.log(`sw.js written: ${urls.length} files, version ${version}`);
