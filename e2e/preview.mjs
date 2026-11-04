// Starts `vite preview` on the built app unless something already answers there.
import { spawn } from 'node:child_process';
export const URL_BASE = 'http://localhost:4173/';
export async function ensurePreview() {
  const up = async () => { try { return (await fetch(URL_BASE)).ok; } catch { return false; } };
  if (await up()) return () => {};
  const proc = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await up())) throw new Error('could not start vite preview (run npm run build first)');
  return () => proc.kill();
}
