import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useApp, useStore } from './hooks';
import { nav, useRoute, type Route } from './router';
import { ChatScreen } from './chat/ChatScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { PromptScreen } from './settings/PromptScreen';
import { CloudSetupScreen } from './settings/CloudSetupScreen';
import { TreksScreen } from './treks/TreksScreen';
import { TrekDetailScreen } from './treks/TrekDetailScreen';
import { EditTrekScreen } from './treks/EditTrekScreen';
import { DuplicateTrekScreen } from './treks/DuplicateTrekScreen';
import { ConfirmBookingScreen } from './treks/ConfirmBookingScreen';
import { MoneyScreen } from './money/MoneyScreen';
import { EntryScreen } from './money/EntryScreen';
import { DuplicatesScreen } from './money/DuplicatesScreen';
import { VendorsScreen } from './vendors/VendorsScreen';
import { VendorDetailScreen } from './vendors/VendorDetailScreen';
import { EditVendorScreen } from './vendors/EditVendorScreen';
import { Page } from './kit';
import { updateAvailable, applyUpdate, onUpdateChange } from './pwa';

const TABS = [
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/treks', label: 'Treks', icon: '⛰' },
  { path: '/money', label: 'Money', icon: '₹' },
  { path: '/vendors', label: 'Vendors', icon: '👥' },
  { path: '/settings', label: 'Settings', icon: '🔑' },
];

function screenFor(r: Route): ComponentChildren {
  const [a, b] = r.parts;
  const id = b ?? '';
  switch (a) {
    case 'chat': return <ChatScreen />;
    case 'treks': return <TreksScreen />;
    case 'money': return <MoneyScreen />;
    case 'vendors': return <VendorsScreen />;
    case 'settings': return <SettingsScreen />;
    case 'trek': return <TrekDetailScreen id={id} />;
    case 'edit-trek': return <EditTrekScreen id={id === 'new' ? undefined : id} />;
    case 'duplicate': return <DuplicateTrekScreen id={id} />;
    case 'booking': return <ConfirmBookingScreen trekID={id} />;
    case 'vendor': return <VendorDetailScreen id={id} />;
    case 'edit-vendor': return <EditVendorScreen id={id === 'new' ? undefined : id} />;
    case 'prompt': return <PromptScreen />;
    case 'cloud-setup': return <CloudSetupScreen />;
    case 'duplicates': return <DuplicatesScreen />;
    case 'entry': return <EntryScreen query={r.query} />;
    default: return <Page title="Not found"><div class="empty">That page does not exist.</div></Page>;
  }
}

/** Warns when the browser can no longer save, and offers a new version when one has been downloaded. */
function Banners() {
  const app = useApp();
  const [, bump] = useState(0);
  useEffect(() => {
    const kv = app.kv as { onChange?: (f: () => void) => () => void };
    const offs = [kv.onChange?.(() => bump((n) => n + 1)), onUpdateChange(() => bump((n) => n + 1))];
    return () => offs.forEach((o) => o?.());
  }, [app]);
  const failed = (app.kv as { writeFailed?: boolean }).writeFailed === true;
  return (
    <>
      {failed ? (
        <div class="banner err" role="alert">
          <span class="grow">This browser is not saving your changes. It may be in private mode or out of space. Use Settings &gt; Your data &gt; Export all data now.</span>
        </div>
      ) : null}
      {updateAvailable() ? (
        <div class="banner" role="status">
          <span class="grow">A new version is ready.</span>
          <button type="button" onClick={applyUpdate}>Update</button>
        </div>
      ) : null}
    </>
  );
}

export function App() {
  const app = useApp();
  const route = useRoute();
  useStore(app.treks, app.bookings);
  const tab = TABS.find((t) => t.path === route.path);
  return (
    <div class="shell">
      <Banners />
      {screenFor(route)}
      {tab ? (
        <nav class="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <a key={t.path} href={`#${t.path}`} class={t.path === route.path ? 'on' : ''} aria-current={t.path === route.path ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); if (t.path !== route.path) nav.replace(t.path); }}>
              <span class="ico" aria-hidden="true">{t.icon}</span>
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
