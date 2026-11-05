import { useApp } from '../hooks';
import type { SyncFields } from '../../core/models';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const Avatar = (p: { name: string; large?: boolean }) => <div class={`avatar ${p.large ? 'lg' : ''}`} aria-hidden="true">{initials(p.name)}</div>;

/** "by Rohit" for a record someone made, or nothing for a record from before sign-in. */
export function useBy() {
  const app = useApp();
  return {
    first: (r: SyncFields): string | undefined => { const n = app.account.firstNameOf(r.createdBy); return n === undefined ? undefined : `by ${n}`; },
    created: (r: SyncFields): string | undefined => app.account.nameOf(r.createdBy),
    changed: (r: SyncFields): string | undefined => app.account.nameOf(r.updatedBy),
  };
}

export function messageOf(e: unknown, fallback = 'Something went wrong.'): string {
  return (e instanceof Error && e.message) || fallback;
}
