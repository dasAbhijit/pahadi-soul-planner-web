import { createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import type { AppContainer } from '../core/app';
import type { Observable } from '../core/storage';

export const AppContext = createContext<AppContainer | null>(null);

/** The stores. Every screen starts with `const app = useApp()`. */
export function useApp(): AppContainer {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppContext missing');
  return app;
}

/** Re-renders the screen whenever any of these stores change. Returns the first one for convenience. */
export function useStore<T extends Observable>(store: T, ...more: Observable[]): T {
  const [, bump] = useState(0);
  useEffect(() => {
    const all = [store, ...more];
    const offs = all.map((s) => s.subscribe(() => bump((n) => n + 1)));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, ...more]);
  return store;
}
