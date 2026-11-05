import { useEffect, useState } from 'preact/hooks';
import { fmtDate, fmtDateTime } from '../../core/fmt';
import { ROLES, ROLE_SUMMARY, type Role } from '../../core/roles';
import { inviteText, type PersonRow } from '../../core/sheetsync';
import { useApp } from '../hooks';
import { AlertBox, Card, Chip, Confirm, EmptyState, Field, InfoNote, LinkButton, OutlineButton, Page, PrimaryButton, SectionLabel, Segmented, useToast } from '../kit';
import { nav } from '../router';
import { Avatar, messageOf } from './shared';
import './account.css';

/** The invite just made, held in memory only so it can be shown once. */
let lastInvite: { name: string; role: Role; text: string; expiresAt: string } | null = null;

function NotAllowed() {
  return <Page title="People"><InfoNote tone="warn">Only an Owner can manage people.</InfoNote></Page>;
}

const roleTone = (r: Role) => (r === 'Staff' ? 'neutral' as const : r === 'Manager' ? 'amber' as const : 'green' as const);

// ------------------------------------------------------------------ People

export function PeopleScreen() {
  const app = useApp();
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    app.withSession((a, s) => app.sheet.people(a, s)).then((p) => { if (live) setPeople(p); }).catch((e) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, []);

  if (!app.can('managePeople')) return <NotAllowed />;
  const me = app.account.myId;
  const active = (people ?? []).filter((p) => p.status === 'active');
  const invited = (people ?? []).filter((p) => p.status === 'invited');
  const disabled = (people ?? []).filter((p) => p.status === 'disabled');

  const row = (p: PersonRow, sub: string) => (
    <Card key={p.id} onClick={() => nav.go(`/person/${p.id}`)}>
      <div class="person-row">
        <Avatar name={p.name} />
        <div class="grow">
          <div class="bold">{p.name}{p.id === me ? ' (you)' : ''}</div>
          <div class="small muted">{sub}</div>
        </div>
        <Chip text={p.role.toUpperCase()} tone={roleTone(p.role)} />
        <span class="chev">›</span>
      </div>
    </Card>
  );

  return (
    <Page title="People" trailing={<button class="iconbtn" type="button" aria-label="Invite a person" onClick={() => nav.go('/invite')}>+</button>}>
      {error ? <InfoNote tone="err">{error}</InfoNote> : null}
      {people === null && !error ? <div class="muted">Loading…</div> : null}
      {people !== null ? (
        <>
          <SectionLabel>{`ACTIVE · ${active.length}`}</SectionLabel>
          {active.map((p) => row(p, p.lastSyncAt ? `Last sync ${fmtDateTime(p.lastSyncAt)}` : 'Not synced yet'))}
          {invited.length > 0 ? <SectionLabel>{`INVITED · ${invited.length}`}</SectionLabel> : null}
          {invited.map((p) => row(p, p.inviteExpiresAt ? `Invite waiting · expires ${fmtDate(p.inviteExpiresAt)}` : 'Invite waiting'))}
          {disabled.length > 0 ? <SectionLabel>{`DISABLED · ${disabled.length}`}</SectionLabel> : null}
          {disabled.map((p) => row(p, p.disabledAt ? `Access removed ${fmtDate(p.disabledAt)}` : 'Access removed'))}
          <div class="tiny muted">Only Owners see this screen. A disabled person is signed out the next time their phone goes online, and their phone is cleared.</div>
        </>
      ) : null}
    </Page>
  );
}

// ------------------------------------------------------------------ Invite

export function InviteScreen() {
  const app = useApp();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('Staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!app.can('managePeople')) return <NotAllowed />;

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await app.withSession((a, s) => app.sheet.invite(a, s, { name: name.trim(), role }));
      lastInvite = { name: r.person.name, role: r.person.role, text: inviteText(app.settings.syncUrl, r.code), expiresAt: r.expiresAt };
      nav.replace('/invite-ready');
    } catch (e) { setError(messageOf(e)); }
    setBusy(false);
  };

  return (
    <Page title="Invite a person" footer={<PrimaryButton text={busy ? 'Creating…' : 'Create invite'} onClick={create} disabled={busy || name.trim().length < 2} />}>
      <Field label="Name" value={name} onChange={setName} words maxLength={40} hint="Shown as “Recorded by” on everything they add. One name per person." />
      <div class="stack">
        <div class="field-label">Role</div>
        <Segmented<Role> options={ROLES.map((r) => ({ value: r, label: r }))} selected={role} onSelect={setRole} />
        <div class="small muted"><b>{role}</b> {ROLE_SUMMARY[role]}</div>
      </div>
      {error ? <InfoNote tone="err">{error}</InfoNote> : null}
      <div class="tiny muted">The invite is a one-time code. The person sets their own password when they join.</div>
    </Page>
  );
}

export function InviteReadyScreen() {
  const app = useApp();
  const [toast, say] = useToast();
  const inv = lastInvite;
  if (!app.can('managePeople')) return <NotAllowed />;
  if (!inv) return <Page title="Invite ready"><EmptyState title="That invite is no longer shown" text="Invites are shown once. Open the person and create a new one." /></Page>;

  const copy = async () => {
    try { await navigator.clipboard.writeText(inv.text); say('Copied'); } catch { say('Could not copy. Press and hold the code to copy it.'); }
  };
  const share = async () => {
    const nv = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nv.share === 'function') { try { await nv.share({ text: inv.text }); return; } catch { /* cancelled */ } }
    await copy();
  };

  return (
    <Page title="Invite ready" onBack={() => { lastInvite = null; nav.backTo('/people'); }}
      footer={<PrimaryButton text="Done" onClick={() => { lastInvite = null; nav.backTo('/people'); }} />}>
      <Card>
        <div class="stack-lg">
          <div class="title">Invite ready for {inv.name}</div>
          <div class="row"><Chip text={inv.role.toUpperCase()} tone={roleTone(inv.role)} /><span class="small muted">Expires {fmtDate(inv.expiresAt)} · works once</span></div>
          <div class="invite-box" data-testid="invite-text">{inv.text}</div>
          <div class="btnrow"><PrimaryButton text="Share" onClick={share} /><OutlineButton text="Copy" onClick={copy} /></div>
          <div class="tiny muted">Shown once. It holds the sheet address and a one-time code. Send it only to {inv.name.split(' ')[0]}, then ask them to open the app and choose “I have an invite”.</div>
        </div>
      </Card>
      <InfoNote tone="warn">If it is lost, create a new invite. The old one stops working.</InfoNote>
      {toast}
    </Page>
  );
}

// ------------------------------------------------------------------ One person

export function PersonDetailScreen({ id }: { id: string }) {
  const app = useApp();
  const [person, setPerson] = useState<PersonRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'reset' | 'remove' | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    app.withSession((a, s) => app.sheet.people(a, s)).then((p) => { if (live) setPerson(p.find((x) => x.id === id) ?? null); }).catch((e) => { if (live) { setError(messageOf(e)); setPerson(null); } });
    return () => { live = false; };
  }, [id, tick]);

  if (!app.can('managePeople')) return <NotAllowed />;
  if (person === undefined) return <Page title="Person"><div class="muted">Loading…</div></Page>;
  if (person === null) return <Page title="Person">{error ? <InfoNote tone="err">{error}</InfoNote> : <div class="muted">This person was not found.</div>}</Page>;

  const isMe = person.id === app.account.myId;
  const setRole = async (role: Role) => {
    setError(null);
    try { await app.withSession((a, s) => app.sheet.setRole(a, s, person.id, role)); setTick((n) => n + 1); }
    catch (e) { setError(messageOf(e)); }
  };
  const newInvite = async (kind: 'reset' | 'invite') => {
    setError(null);
    try {
      const r = await app.withSession((a, s) => (kind === 'reset' ? app.sheet.resetSignIn(a, s, person.id) : app.sheet.invite(a, s, { personId: person.id })));
      lastInvite = { name: r.person.name, role: r.person.role, text: inviteText(app.settings.syncUrl, r.code), expiresAt: r.expiresAt };
      nav.go('/invite-ready');
    } catch (e) { setError(messageOf(e)); }
  };
  const remove = async () => {
    setError(null);
    try { await app.withSession((a, s) => app.sheet.removePerson(a, s, person.id)); setTick((n) => n + 1); }
    catch (e) { setError(messageOf(e)); }
  };

  return (
    <Page title={person.name}>
      <Card>
        <div class="stack-lg">
          <div class="person-row">
            <Avatar name={person.name} large />
            <div class="grow"><div class="title">{person.name}</div><Chip text={person.role.toUpperCase()} tone={roleTone(person.role)} /></div>
          </div>
          <div class="kv"><span class="k">Added</span><span>{fmtDate(person.createdAt)}{person.addedBy ? ` by ${person.addedBy}` : ''}</span></div>
          <div class="kv"><span class="k">Status</span><span>{person.status === 'active' ? 'Active' : person.status === 'invited' ? 'Invite waiting' : 'Access removed'}</span></div>
          <div class="kv"><span class="k">Last sync</span><span>{person.lastSyncAt ? fmtDateTime(person.lastSyncAt) : 'Never'}</span></div>
          <div class="kv"><span class="k">Devices</span><span>{person.devices.length ? person.devices.join(', ') : 'None yet'}</span></div>
          <div class="kv"><span class="k">Recorded</span><span>{person.payments} payment{person.payments === 1 ? '' : 's'}, {person.bookings} booking{person.bookings === 1 ? '' : 's'}</span></div>
        </div>
      </Card>

      {error ? <InfoNote tone="err">{error}</InfoNote> : null}

      {person.status !== 'disabled' ? (
        <Card>
          <div class="stack">
            <div class="title">Role</div>
            <Segmented<Role> options={ROLES.map((r) => ({ value: r, label: r }))} selected={person.role} onSelect={(r) => { if (r !== person.role) setRole(r); }} />
            <div class="small muted"><b>{person.role}</b> {ROLE_SUMMARY[person.role]}</div>
            <div class="tiny muted">The new role applies the next time their phone syncs.</div>
          </div>
        </Card>
      ) : null}

      <Card>
        <div class="stack">
          {person.status === 'invited' ? (
            <>
              <div class="title">Invite</div>
              <div class="small muted">Waiting for them to join. Create a new invite if the old one was lost. The old one stops working.</div>
              <OutlineButton block text="Create a new invite" onClick={() => newInvite('invite')} />
            </>
          ) : (
            <>
              <div class="title">Sign-in</div>
              <OutlineButton block text={person.status === 'disabled' ? 'Restore access with a new invite' : 'Reset sign-in'} onClick={() => (person.status === 'disabled' ? newInvite('reset') : setConfirm('reset'))} />
              <div class="tiny muted">{person.status === 'disabled' ? 'Lets them join again. What they recorded already carries their name.' : 'Clears their password and signs out every device. They join again with a new invite.'}</div>
            </>
          )}
        </div>
      </Card>

      {person.status !== 'disabled' ? (
        <Card>
          <div class="stack">
            <LinkButton text="Remove access" danger onClick={() => setConfirm('remove')} />
            <div class="tiny muted">Signs them out on every device. The next time a phone goes online it is cleared of company data. What they recorded stays, with their name on it.</div>
          </div>
        </Card>
      ) : null}
      <div class="tiny muted">There is always at least one Owner. The last Owner cannot be demoted or removed.{isMe ? ' This is you.' : ''}</div>

      {confirm === 'reset' ? (
        <Confirm title={`Reset ${person.name}'s sign-in?`} message="Their password is cleared and every device is signed out. You get a new invite to give them." confirmLabel="Reset and create invite" danger
          onConfirm={() => newInvite('reset')} onDismiss={() => setConfirm(null)} />
      ) : null}
      {confirm === 'remove' ? (
        <Confirm title={`Remove ${person.name}'s access?`} message="They are signed out on every device and their phones are cleared the next time they go online. What they recorded stays." confirmLabel="Remove access" danger
          onConfirm={remove} onDismiss={() => setConfirm(null)} />
      ) : null}
    </Page>
  );
}

export function ChangePasswordScreen() {
  const app = useApp();
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ready = oldPw !== '' && newPw.length >= 8 && newPw === repeat && !busy;

  const save = async () => {
    setBusy(true); setError(null);
    try { await app.withSession((a, s) => app.sheet.changePassword(a, s, oldPw, newPw)); setDone(true); }
    catch (e) { setError(messageOf(e)); }
    setBusy(false);
  };

  return (
    <Page title="Change password" footer={<PrimaryButton text={busy ? 'Saving…' : 'Change password'} onClick={save} disabled={!ready} />}>
      <Field label="Current password" value={oldPw} onChange={setOldPw} password />
      <Field label="New password" value={newPw} onChange={setNewPw} password hint="At least 8 characters." />
      <Field label="Repeat the new password" value={repeat} onChange={setRepeat} password />
      {repeat !== '' && repeat !== newPw ? <div class="small bad">The two passwords are different.</div> : null}
      {error ? <InfoNote tone="err">{error}</InfoNote> : null}
      {done ? <AlertBox title="Password changed" text="Use the new password the next time you sign in. Other phones stay signed in." onDismiss={() => nav.back()} /> : null}
    </Page>
  );
}
