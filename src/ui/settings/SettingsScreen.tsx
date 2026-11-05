import { useEffect, useState } from 'preact/hooks';
import { backupFilename, decodeBackup, encodeBackup, ledgerCsv, restoreBackup, snapshot, type Backup } from '../../core/backup';
import { syncSummary } from '../../core/cloudsync';
import { fmtDate, fmtDateTime } from '../../core/fmt';
import { encodeSheetParam } from '../../core/sheetsync';
import { nowSecond } from '../../core/ids';
import { useApp, useStore } from '../hooks';
import { AlertBox, Card, Confirm, Field, InfoNote, OutlineButton, Page, PrimaryButton, pickTextFile, saveFile } from '../kit';
import { nav, to } from '../router';
import { Avatar } from '../account/shared';
import { Chip } from '../kit';
import { APP_VERSION } from '../version';
import { Status, type StatusLine } from './Status';
import './settings.css';

export function SettingsScreen() {
  const app = useApp();
  useStore(app.settings, app.secrets, app.guidance);
  const [keyInput, setKeyInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusLine>(null);
  const trimmed = keyInput.trim();
  const hasKey = app.secrets.geminiKey !== null;
  const rules = app.guidance.rules.length;

  const saveKey = () => {
    app.secrets.setGeminiKey(trimmed);
    if (app.secrets.geminiKey === trimmed) { setKeyInput(''); setStatus({ text: 'Key saved. Tap Test key to check it works.', ok: true }); }
    else setStatus({ text: "Couldn't save the key in this browser. It may be in private mode.", ok: false });
  };
  const testKey = async () => {
    setTesting(true);
    const key = trimmed || app.secrets.geminiKey || '';
    try { await app.gemini.testKey(key); setStatus({ text: 'Key works.', ok: true }); }
    catch (e) { setStatus({ text: (e instanceof Error && e.message) || 'The test failed.', ok: false }); }
    setTesting(false);
  };

  return (
    <Page title="Settings" tab>
      <AccountCard />

      {app.can('managePeople') ? (
        <Card onClick={() => nav.go(to.people())}>
          <div class="row">
            <div class="grow">
              <div class="title">People</div>
              <div class="small muted">Invite people, change roles, remove access</div>
            </div>
            <span class="chev">›</span>
          </div>
        </Card>
      ) : null}

      <CloudSyncSection />

      <Card>
        <div class="stack-lg">
          <div class="title">Gemini API key</div>
          <Field
            label={hasKey ? 'Replace your key' : 'Paste your key'} value={keyInput} onChange={setKeyInput} password
            placeholder={hasKey ? '•••••••••••••••• (saved)' : 'AIza…'}
          />
          <Status s={status} fallback={hasKey ? 'Saved in this browser on this phone. Not encrypted.' : undefined} />
          <div class="btnrow">
            <button type="button" class="btn small" onClick={saveKey} disabled={trimmed === ''}>Save</button>
            <OutlineButton text={testing ? 'Testing…' : 'Test key'} onClick={testKey} disabled={testing || (trimmed === '' && !hasKey)} />
            <OutlineButton text="Remove" danger disabled={!hasKey} onClick={() => { app.secrets.setGeminiKey(null); setKeyInput(''); setStatus({ text: 'Key removed from this browser.', ok: true }); }} />
          </div>
          <div class="tiny muted">
            A browser has no secure vault like the phone apps do, so the key sits unencrypted in this browser's own storage. It is never put in a backup or the sheet, and is sent nowhere except to Google when you chat. Signing out removes it. Anyone who can open this browser on an unlocked phone could read it.
          </div>
          <div><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" class="bold small">Get a key from Google AI Studio</a></div>
        </div>
      </Card>

      {app.can('editRules') ? (
        <>
          <Card>
            <div class="stack-lg">
              <div class="title">Model</div>
              <Field label="Gemini model name" value={app.settings.model} onChange={(v) => app.settings.setModel(v)} placeholder="gemini-flash-latest" />
              <div class="small muted">Change this when Google retires or releases a model. No app update needed. If the model is busy or retired, the app tries gemini-flash-lite-latest instead.</div>
            </div>
          </Card>

          <Card onClick={() => nav.go(to.prompt())}>
            <div class="row">
              <div class="grow">
                <div class="title">Assistant prompt</div>
                <div class="small muted">Base instructions and {rules} learned rule{rules === 1 ? '' : 's'}</div>
              </div>
              <span class="chev">›</span>
            </div>
          </Card>
        </>
      ) : null}

      {app.can('exportData') ? <DataSection /> : null}

      <InfoNote>Messages go straight from this phone to Google. Free-tier keys may be used by Google to improve its models, so avoid putting client phone numbers or ID details in chats.</InfoNote>

      <WebAppCard />
    </Page>
  );
}

// ------------------------------------------------------------------- Account

function AccountCard() {
  const app = useApp();
  useStore(app.account, app.settings);
  const [confirmOut, setConfirmOut] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const p = app.account.person;
  if (!p) return null;
  const since = app.account.signedInAt;
  const last = app.settings.lastSyncAt;
  return (
    <Card>
      <div class="stack-lg">
        <div class="row">
          <Avatar name={p.name} large />
          <div class="grow">
            <div class="title">{p.name}</div>
            <div class="row" style="gap:8px"><Chip text={p.role.toUpperCase()} tone={p.role === 'Staff' ? 'neutral' : p.role === 'Manager' ? 'amber' : 'green'} /><span class="small ok">Signed in</span></div>
          </div>
        </div>
        <div class="stack">
          {since ? <div class="kv"><span class="k">Since</span><span>{fmtDate(since)}</span></div> : null}
          <div class="kv"><span class="k">Sheet</span><span>{app.account.sheetName ?? 'Connected'}</span></div>
          <div class="kv"><span class="k">Last sync</span><span>{last ? fmtDateTime(last) : 'Not synced yet'}</span></div>
        </div>
        <div class="btnrow">
          <OutlineButton text="Change password" onClick={() => nav.go(to.changePassword())} />
          <OutlineButton text="Sign out" danger onClick={() => setConfirmOut(true)} />
        </div>
        {app.can('managePeople') ? (
          <div class="stack">
            <OutlineButton text={linkCopied ? 'Link copied' : 'Copy sign-in link'} onClick={async () => {
              const link = `${location.origin}${location.pathname}#/signin?sheet=${encodeSheetParam(app.settings.syncUrl)}`;
              try { await navigator.clipboard.writeText(link); setLinkCopied(true); } catch { window.prompt('Copy this sign-in link', link); }
            }} />
            <div class="tiny muted">Open it on a new phone or browser and the sheet address is already filled in. It holds the sheet address, so send it only to your team.</div>
          </div>
        ) : null}
        <div class="tiny muted">Signing out clears the bookings, money and vendors from this phone, so sync first. Your Gemini key is removed too.</div>
      </div>
      {confirmOut ? (
        <Confirm
          title="Sign out?" confirmLabel="Sign out and clear this phone" danger onDismiss={() => setConfirmOut(false)}
          message="The treks, bookings, money, vendors and your Gemini key are removed from this phone. Anything not synced yet is lost. Sync first if you are online."
          onConfirm={() => { app.signOut(); }}
        />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- Cloud sync

/** Everything stays on this phone and works offline; this button swaps changes with the Google Sheet when online. */
function CloudSyncSection() {
  const app = useApp();
  useStore(app.settings, app.account);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<StatusLine>(null);
  const last = app.settings.lastSyncAt;

  const sync = async () => {
    setSyncing(true);
    try {
      const report = await app.sync();
      setStatus({ text: syncSummary(report), ok: report.overbooked.length === 0 && report.refused.length === 0 });
    } catch (e) {
      setStatus({ text: (e instanceof Error && e.message) || 'The sync failed.', ok: false });
    }
    setSyncing(false);
  };

  return (
    <Card>
      <div class="stack-lg">
        <div class="title">Cloud sync</div>
        <div class="kv"><span class="k">Signed in as</span><span>{app.account.person?.name}</span></div>
        <Status
          s={status ?? (last ? { text: `Last sync ${fmtDateTime(last)}`, ok: true } : null)}
          fallback="Not synced yet"
        />
        <PrimaryButton text={syncing ? 'Syncing…' : 'Sync now'} disabled={syncing} onClick={sync} />
        <div class="tiny muted">Your data lives on this phone and works offline. Sync swaps changes with the Google Sheet: what others added comes here, your changes go there, and the latest edit of a record wins. Your name comes from your account. The sheet holds traveller names, phone numbers and payments, so keep it private. Your Gemini key is never sent.</div>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- Your data

function describeBackup(b: Backup) {
  return `${b.treks.length} treks, ${b.bookings.length} bookings, ${b.ledger.length} transactions, ${b.vendors.length} vendors, ${b.guidance.length} rules`;
}

function DataSection() {
  const app = useApp();
  useStore(app.treks, app.bookings, app.ledger, app.vendors, app.guidance, app.settings);
  const [notice, setNotice] = useState<{ title: string; text: string } | null>(null);
  const [pending, setPending] = useState<Backup | null>(null);
  const lastBackup = app.settings.lastBackupAt;
  const parts = { treks: app.treks, bookings: app.bookings, ledger: app.ledger, vendors: app.vendors, guidance: app.guidance, settings: app.settings };

  const exportAll = async () => {
    try {
      const result = await saveFile(backupFilename(), 'application/json', encodeBackup(snapshot(parts)));
      if (result === 'cancelled') return;
      app.settings.setLastBackupAt(nowSecond());
      setNotice({
        title: result === 'shared' ? 'Backup shared' : 'Backup downloaded',
        text: result === 'shared'
          ? 'If you chose Save to Files or Google Drive, keep that file somewhere safe. Restore it from this screen if you clear this browser or move to another phone.'
          : 'Look in your Downloads folder and keep the file somewhere safe, such as Google Drive. Restore it from this screen if you clear this browser or move to another phone.',
      });
    } catch (e) {
      setNotice({ title: "Couldn't save the backup", text: e instanceof Error ? e.message : 'The file could not be written.' });
    }
  };

  const exportCsv = async () => {
    try { await saveFile('PahadiSoul-transactions.csv', 'text/csv', ledgerCsv(app.ledger.entries, (id) => app.account.nameOf(id))); }
    catch (e) { setNotice({ title: "Couldn't save the file", text: e instanceof Error ? e.message : 'The file could not be written.' }); }
  };

  const restore = async () => {
    const file = await pickTextFile('application/json,.json,text/*');
    if (!file) return;
    try { setPending(decodeBackup(file.text)); }
    catch (e) { setNotice({ title: "Can't restore this file", text: e instanceof Error ? e.message : 'The file could not be read.' }); }
  };

  return (
    <Card>
      <div class="stack-lg">
        <div class="title">Your data</div>
        <div class="small muted">
          {app.treks.treks.length} treks · {app.bookings.bookings.length} bookings · {app.ledger.entries.length} transactions · {app.vendors.vendors.length} vendors · {app.guidance.rules.length} rules
        </div>
        {lastBackup
          ? <div class="status ok">✓ Last backup {fmtDate(lastBackup)}</div>
          : <div class="status bad">⚠ No backup yet. Clearing this browser's data erases everything.</div>}
        <PrimaryButton text="Export all data" onClick={exportAll} />
        <div class="btnrow">
          {app.can('restoreBackup') ? <OutlineButton text="Restore" onClick={restore} /> : null}
          <OutlineButton text="Transactions CSV" onClick={exportCsv} />
        </div>
        <div class="tiny muted">The backup holds treks, bookings, payments, vendors, learned rules and the prompt, including traveller names and phone numbers. It never holds your Gemini key or sync secret. Keep it private. The file also opens on the iPhone and Android apps.</div>
      </div>
      {notice ? <AlertBox title={notice.title} text={notice.text} onDismiss={() => setNotice(null)} /> : null}
      {pending ? (
        <Confirm
          title="Replace everything in this app?"
          message={`Backup from ${fmtDate(pending.createdAt)}: ${describeBackup(pending)}. Everything now in the app is replaced. Export first if you may need the current data.`}
          confirmLabel="Replace with this backup" danger onDismiss={() => setPending(null)}
          onConfirm={() => {
            try { restoreBackup(pending, parts); setNotice({ title: 'Restored', text: describeBackup(pending) + '.' }); }
            catch (e) { setNotice({ title: "Can't restore this file", text: e instanceof Error ? e.message : '' }); }
          }}
        />
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ Web app

function isInstalled(): boolean {
  const nv = navigator as Navigator & { standalone?: boolean };
  return nv.standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

function WebAppCard() {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const installed = isInstalled();
  const canAsk = typeof navigator.storage?.persist === 'function';

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);

  const ask = async () => {
    try { setPersisted(await navigator.storage.persist()); } catch { setPersisted(false); }
  };

  return (
    <Card>
      <div class="stack-lg">
        <div class="title">Web app</div>
        <div class="stack">
          <div class="kv"><span class="k">Version</span><span>{APP_VERSION}</span></div>
          <div class="kv"><span class="k">Running as</span><span class={installed ? 'ok bold' : ''}>{installed ? 'Installed app' : 'In the browser (not installed)'}</span></div>
          <div class="kv">
            <span class="k">Data kept</span>
            <span>{persisted === null ? 'Not known on this browser' : persisted ? 'Protected from clean-up' : 'May be cleared if the phone runs low on space'}</span>
          </div>
        </div>
        {persisted === false && canAsk ? <div><OutlineButton small text="Ask the browser to keep my data" onClick={ask} /></div> : null}
        {!installed ? (
          <InfoNote tone="warn">
            This is not installed yet. Install it first and then use only the Home Screen icon, because the installed app and the browser tab keep separate data.
          </InfoNote>
        ) : null}
        <div class="stack">
          <div class="bold small">Install on iPhone</div>
          <div class="small muted">In Safari, tap Share, then Add to Home Screen. Open the app only from that Home Screen icon from then on. Anything entered in a Safari tab stays in the tab and does not move into the installed app, so export a backup and restore it there if you already entered data.</div>
          <div class="bold small">Install on Android</div>
          <div class="small muted">In Chrome, open the menu (three dots) and tap Install app (or Add to Home screen).</div>
        </div>
        <div class="tiny muted">It works offline once opened. When a new version is ready a bar appears at the top; tap Update.</div>
      </div>
    </Card>
  );
}
