import './settings.css';

/** A one-line result under a button: green tick when it worked, rust warning when it did not. */
export type StatusLine = { text: string; ok: boolean } | null;

export function Status(p: { s: StatusLine; fallback?: string }) {
  if (p.s) return <div class={`status ${p.s.ok ? 'ok' : 'bad'}`} role="status">{(p.s.ok ? '✓ ' : '⚠ ') + p.s.text}</div>;
  return p.fallback ? <div class="status muted">{p.fallback}</div> : null;
}
