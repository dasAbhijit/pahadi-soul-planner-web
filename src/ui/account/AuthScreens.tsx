import { useEffect, useState } from 'preact/hooks';
import { decodeSheetParam, parseInvite, validateAddress, type SheetSyncError } from '../../core/sheetsync';
import { useApp, useStore } from '../hooks';
import { nav, useRoute } from '../router';
import { Chip, Field, InfoNote, LinkButton, PrimaryButton } from '../kit';
import { messageOf } from './shared';
import './account.css';

const LOGO = `${import.meta.env.BASE_URL}icons/icon-192.png`;

function AuthPage(p: { title: string; sub?: string; children: preact.ComponentChildren }) {
  return (
    <main class="body">
      <div class="auth stack-lg">
        <img class="logo" src={LOGO} alt="Pahadi Soul" width="104" height="104" />
        <h1 class="big">{p.title}</h1>
        {p.sub ? <div class="sub">{p.sub}</div> : null}
        {p.children}
      </div>
    </main>
  );
}

const goHome = () => nav.replace('/chat');

// ------------------------------------------------------------------ Sign in

export function SignInScreen() {
  const app = useApp();
  useStore(app.settings);
  // A sign-in link from an Owner (#/signin?sheet=...) carries the address, so only a name and password are needed.
  const linked = decodeSheetParam(useRoute().query.get('sheet'));
  if (linked !== null && app.settings.syncUrl !== linked) app.settings.setSyncUrl(linked);
  const saved = linked ?? app.settings.syncUrl;
  const [address, setAddress] = useState(saved);
  const [showAddress, setShowAddress] = useState(validateAddress(saved) === null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== '' && password !== '' && validateAddress(address) !== null && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try { await app.signIn(address, name, password); goHome(); }
    catch (e) {
      const err = e as SheetSyncError;
      setError(err.code === 'notSetUp' ? `${err.message} If this is a new sheet, use "Set up the first Owner" below.` : messageOf(e, 'Could not sign in.'));
      setPassword('');
    }
    setBusy(false);
  };

  return (
    <AuthPage title="Sign in" sub="Use the name and password set up for you">
      <div class="stack-lg">
        {showAddress ? (
          <Field label="Sheet address" value={address} onChange={setAddress} multiline rows={3} placeholder="https://script.google.com/macros/s/…/exec" />
        ) : (
          <div class="small muted">Sheet: connected. <LinkButton text="Change" onClick={() => setShowAddress(true)} /></div>
        )}
        <Field label="Your name" value={name} onChange={setName} words placeholder="For example Rohit Sharma" onEnter={submit} />
        <Field label="Password" value={password} onChange={setPassword} password onEnter={submit} />
        {error ? <InfoNote tone="err">{error}</InfoNote> : null}
        <PrimaryButton text={busy ? 'Signing in…' : 'Sign in'} onClick={submit} disabled={!ready} />
        <div class="center-link"><LinkButton text="I have an invite" onClick={() => nav.replace('/join')} /></div>
        <div class="tiny muted">You sign in once. After that the app opens with no signal, and changes sync when you are online. Forgot the password? Ask an Owner to reset your sign-in.</div>
        <div class="center-link"><LinkButton text="New sheet? Set up the first Owner" onClick={() => nav.replace('/first-owner')} /></div>
      </div>
    </AuthPage>
  );
}

// ------------------------------------------------------------------ Join with an invite

export function JoinScreen() {
  const app = useApp();
  const [pasted, setPasted] = useState('');
  const [address, setAddress] = useState(app.settings.syncUrl);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<{ name: string; role: string; invitedBy: string } | null>(null);
  const parsed = parseInvite(pasted);
  const useAddress = parsed?.address ?? address;
  const addressOk = validateAddress(useAddress) !== null;

  // Check the invite as soon as it can be read, so the person sees who it is for before choosing a password.
  useEffect(() => {
    setWho(null);
    if (!parsed || !addressOk) return;
    let live = true;
    app.sheet.previewInvite(useAddress, parsed.code).then((w) => { if (live) { setWho(w); setError(null); } })
      .catch((e) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [parsed?.code, useAddress]);

  const mismatch = repeat !== '' && repeat !== password;
  const ready = parsed !== null && addressOk && password.length >= 8 && password === repeat && !busy;

  const submit = async () => {
    if (!ready || !parsed) return;
    setBusy(true); setError(null);
    try { await app.join(useAddress, parsed.code, password); goHome(); }
    catch (e) { setError(messageOf(e, 'Could not join.')); }
    setBusy(false);
  };

  return (
    <AuthPage title="Join with an invite">
      <div class="stack-lg">
        <Field label="Invite" value={pasted} onChange={setPasted} multiline rows={3} placeholder="PSP1.…" hint="Paste the whole invite message you were sent." />
        {parsed && !parsed.address ? (
          <Field label="Sheet address" value={address} onChange={setAddress} multiline rows={2} placeholder="https://script.google.com/macros/s/…/exec" />
        ) : null}
        {who ? (
          <div class="card"><div class="person-row">
            <div class="grow">
              <div class="bold">{who.name}</div>
              <div class="small muted">Invited by {who.invitedBy || 'an Owner'}</div>
            </div>
            <Chip text={who.role.toUpperCase()} tone={who.role === 'Staff' ? 'neutral' : 'green'} />
          </div></div>
        ) : null}
        <Field label="Choose a password" value={password} onChange={setPassword} password hint="At least 8 characters. Only you will know it." />
        <Field label="Repeat the password" value={repeat} onChange={setRepeat} password onEnter={submit} />
        {mismatch ? <div class="small bad">The two passwords are different.</div> : null}
        {error ? <InfoNote tone="err">{error}</InfoNote> : null}
        <PrimaryButton text={busy ? 'Joining…' : 'Join'} onClick={submit} disabled={!ready} />
        <div class="center-link"><LinkButton text="Back to sign in" onClick={() => nav.replace('/signin')} /></div>
        <div class="tiny muted">An invite works once and expires after 7 days. Your name and role were set by the Owner.</div>
      </div>
    </AuthPage>
  );
}

// ------------------------------------------------------------------ First Owner

export function FirstOwnerScreen() {
  const app = useApp();
  const [address, setAddress] = useState(app.settings.syncUrl);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = repeat !== '' && repeat !== password;
  const ready = validateAddress(address) !== null && code.trim() !== '' && name.trim().length >= 2 && password.length >= 8 && password === repeat && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try { await app.setupOwner(address, code.trim(), name, password); goHome(); }
    catch (e) { setError(messageOf(e, 'Could not set up the Owner.')); }
    setBusy(false);
  };

  return (
    <AuthPage title="Set up the first Owner" sub="This sheet has no people yet. Create the first Owner. You need the secret code from the script setup (PAHADI_TOKEN).">
      <div class="stack-lg">
        <Field label="Web app address" value={address} onChange={setAddress} multiline rows={3} placeholder="https://script.google.com/macros/s/…/exec" />
        <Field label="Setup code" value={code} onChange={setCode} password hint="The secret code you set in Script properties. It works once, for this step." />
        <Field label="Your name" value={name} onChange={setName} words />
        <Field label="Choose a password" value={password} onChange={setPassword} password hint="At least 8 characters." />
        <Field label="Repeat the password" value={repeat} onChange={setRepeat} password onEnter={submit} />
        {mismatch ? <div class="small bad">The two passwords are different.</div> : null}
        {error ? <InfoNote tone="err">{error}</InfoNote> : null}
        <PrimaryButton text={busy ? 'Creating…' : 'Create Owner account'} onClick={submit} disabled={!ready} />
        <div class="tiny muted">After this, the setup code stops working for everyone. Anyone else joins by invite. If every Owner is locked out, the person who owns the Google Sheet can create a new Owner invite from the script editor (cloud/README.md).</div>
        <div class="center-link"><LinkButton text="Back to sign in" onClick={() => nav.replace('/signin')} /></div>
      </div>
    </AuthPage>
  );
}

// ------------------------------------------------------------------ Access removed

export function AccessRemovedScreen() {
  const app = useApp();
  useStore(app.account);
  const reason = app.account.ended;
  const text = reason === 'reset'
    ? 'An Owner reset your sign-in. The treks, bookings, money and vendors have been cleared from this phone. Ask the Owner for a new invite to join again.'
    : reason === 'expired'
      ? 'You had not synced for 90 days, so this phone was signed out. The treks, bookings, money and vendors have been cleared from it. Sign in again to get them back.'
      : 'An Owner removed your access to Pahadi Soul Planner. The treks, bookings, money and vendors have been cleared from this phone.';
  return (
    <AuthPage title={reason === 'removed' ? 'Your access was removed' : reason === 'reset' ? 'Your sign-in was reset' : 'You were signed out'}>
      <div class="stack-lg">
        <div class="center-link muted">{text}</div>
        {reason !== 'expired' ? <InfoNote tone="warn">Changes you made while offline were not sent. If you think this is a mistake, ask an Owner.</InfoNote> : null}
        <PrimaryButton text="Back to sign in" onClick={() => { app.account.clearEnded(); nav.replace('/signin'); }} />
      </div>
    </AuthPage>
  );
}
