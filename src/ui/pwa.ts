/** Installing the app for offline use, and noticing when a newer version has been downloaded. */

let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

export const updateAvailable = () => waiting !== null;
export function onUpdateChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }

/** Switches to the new version. The page reloads once it takes over. */
export function applyUpdate() {
  waiting?.postMessage({ type: 'SKIP_WAITING' });
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      const watch = (w: ServiceWorker | null) => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          // A new worker is waiting and an old one is in charge: offer the update. (First install has no controller.)
          if (w.state === 'installed' && navigator.serviceWorker.controller) { waiting = w; changed(); }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; changed(); }
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Look for a new version whenever the app is opened again.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => { /* offline use just will not be available */ });
  });
  // Ask the browser to keep this app's data even when space runs low.
  navigator.storage?.persist?.().catch(() => {});
}
