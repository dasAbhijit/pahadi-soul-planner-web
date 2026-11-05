import { useEffect, useState } from 'preact/hooks';

/**
 * A tiny hash router (#/trek/ABC?x=1), so the app works from any address, including a GitHub Pages project page,
 * with no server rules. It remembers the pages visited so `backTo` can return to a tab in one step.
 */
export interface Route { path: string; parts: string[]; query: URLSearchParams }

function read(): Route {
  const raw = location.hash.replace(/^#/, '') || '/chat';
  const [path, qs = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

let stack: string[] = [];
const initial = () => (location.hash.replace(/^#/, '') || '/chat');
stack = [initial()];

function track() {
  const now = initial();
  if (stack.length >= 2 && stack[stack.length - 2] === now) stack.pop();
  else if (stack[stack.length - 1] !== now) stack.push(now);
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', track);

export const nav = {
  go(path: string) { location.hash = path; },
  /** Replaces the current page, so Back skips it. */
  replace(path: string) {
    stack[stack.length - 1] = path;
    history.replaceState(null, '', '#' + path);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  },
  back() {
    if (stack.length > 1) history.back(); else nav.replace('/chat');
  },
  /** Goes back to the nearest earlier visit of this page, or opens it if it was not visited. */
  backTo(path: string) {
    const i = stack.lastIndexOf(path);
    if (i >= 0 && i < stack.length - 1) history.go(-(stack.length - 1 - i));
    else nav.go(path);
  },
};

export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** The routes that screens open, so nobody builds a route string by hand. */
export const to = {
  trek: (id: string) => `/trek/${id}`,
  editTrek: (id?: string, draft?: string) => `/edit-trek/${id ?? 'new'}${draft ? `?draft=${draft}` : ''}`,
  duplicateTrek: (id: string) => `/duplicate/${id}`,
  addBooking: (trekID: string, draft?: string) => `/booking/${trekID}${draft ? `?draft=${draft}` : ''}`,
  vendor: (id: string) => `/vendor/${id}`,
  editVendor: (id?: string, draft?: string) => `/edit-vendor/${id ?? 'new'}${draft ? `?draft=${draft}` : ''}`,
  prompt: () => '/prompt',
  people: () => '/people',
  invite: () => '/invite',
  changePassword: () => '/change-password',
  duplicates: () => '/duplicates',
  /** Add or edit a transaction. `kind` is 'in' or 'out'. */
  entry: (o: { entry?: string; kind?: 'in' | 'out'; trek?: string; booking?: string; vendor?: string; draft?: string } = {}) => {
    const q = new URLSearchParams();
    if (o.entry) q.set('entry', o.entry);
    q.set('kind', o.kind ?? 'in');
    if (o.trek) q.set('trek', o.trek);
    if (o.booking) q.set('booking', o.booking);
    if (o.vendor) q.set('vendor', o.vendor);
    if (o.draft) q.set('draft', o.draft);
    return `/entry?${q.toString()}`;
  },
};
