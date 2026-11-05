import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useApp, useStore } from './hooks';
import { nav, useRoute, type Route } from './router';
import { ChatScreen } from './chat/ChatScreen';
import { SettingsScreen } from './settings/SettingsScreen';
import { PromptScreen } from './settings/PromptScreen';
import { AccessRemovedScreen, FirstOwnerScreen, JoinScreen, SignInScreen } from './account/AuthScreens';
import { ChangePasswordScreen, InviteReadyScreen, InviteScreen, PeopleScreen, PersonDetailScreen } from './account/PeopleScreens';
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
import type { Capability } from '../core/roles';
import { updateAvailable, applyUpdate, onUpdateChange } from './pwa';

const TABS = [
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/treks', label: 'Treks', icon: '⛰' },
  { path: '/money', label: 'Money', icon: '₹' },
  { path: '/vendors', label: 'Vendors', icon: '👥' },
  { path: '/settings', label: 'Settings', icon: '🔑' },
];

/** Shows a screen only to roles that may use it. The sheet enforces the same rules; this just keeps the screens honest. */
function Guard(p: { cap: Capability; children: ComponentChildren }) {
  const app = useApp();
  if (app.can(p.cap)) return <>{p.children}</>;
  return <Page title="Not available"><div class="empty">Your role cannot open this page.</div></Page>;
}

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
    case 'edit-trek': return <Guard cap="editTreks"><EditTrekScreen id={id === 'new' ? undefined : id} /></Guard>;
    case 'duplicate': return <Guard cap="editTreks"><DuplicateTrekScreen id={id} /></Guard>;
    case 'booking': return <ConfirmBookingScreen trekID={id} draftID={r.query.get('draft') || undefined} />;
    case 'vendor': return <VendorDetailScreen id={id} />;
    case 'edit-vendor': return <Guard cap="editVendors"><EditVendorScreen id={id === 'new' ? undefined : id} /></Guard>;
    case 'prompt': return <Guard cap="editRules"><PromptScreen /></Guard>;
    case 'people': return <PeopleScreen />;
    case 'invite': return <InviteScreen />;
    case 'invite-ready': return <InviteReadyScreen />;
    case 'person': return <PersonDetailScreen id={id} />;
    case 'change-password': return <ChangePasswordScreen />;
    case 'duplicates': return <Guard cap="seeMoneyOut"><DuplicatesScreen /></Guard>;
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

/** Before anyone is signed in, only the sign-in screens exist. */
function signedOutScreen(r: Route, ended: boolean): ComponentChildren {
  switch (r.parts[0]) {
    case 'join': return <JoinScreen />;
    case 'first-owner': return <FirstOwnerScreen />;
    case 'signin': return <SignInScreen />;
    default: return ended ? <AccessRemovedScreen /> : <SignInScreen />;
  }
}

export function App() {
  const app = useApp();
  const route = useRoute();
  useStore(app.treks, app.bookings, app.account);
  if (!app.account.signedIn) {
    return (
      <div class="shell">
        <Banners />
        {signedOutScreen(route, app.account.ended !== undefined)}
      </div>
    );
  }
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
