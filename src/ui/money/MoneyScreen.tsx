import { useMemo, useState } from 'preact/hooks';
import { useApp, useStore } from '../hooks';
import { nav, to } from '../router';
import { Card, DateField, Field, Page, PickerRow, SectionLabel, Segmented } from '../kit';
import { EntryRow } from './EntryRow';
import { canEditEntry } from '../../core/roles';
import { InfoNote } from '../kit';
import { fmtDate, rupees, signedRupees } from '../../core/fmt';
import { addDays, startOfDay, toInstant, type Instant } from '../../core/ids';
import { duplicateGroups } from '../../core/syncmerge';
import type { EntryKind, LedgerFilter, LedgerScope } from '../../core/models';
import './money.css';

type Preset = 'all' | 'month' | 'last30' | 'custom';
const PRESETS: { value: Preset; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'month', label: 'This month' },
  { value: 'last30', label: 'Last 30 days' }, { value: 'custom', label: 'Custom' },
];
type KindFilter = 'all' | EntryKind;

export function MoneyScreen() {
  const app = useApp();
  useStore(app.ledger, app.treks, app.vendors, app.settings, app.account);

  const entries = app.ledger.entries;
  const staffView = !app.can('seeMoneyOut');
  const dupCount = useMemo(() => duplicateGroups(entries, app.settings.dismissedDuplicates).length, [entries, app.settings.dismissedDuplicates]);

  const [tripID, setTripID] = useState<string>('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [customer, setCustomer] = useState('');
  const [vendorID, setVendorID] = useState<string>('');
  const [preset, setPreset] = useState<Preset>('all');
  const [from, setFrom] = useState<Instant | undefined>(() => toInstant(addDays(new Date(), -30)));
  const [to2, setTo] = useState<Instant | undefined>(() => toInstant(new Date()));

  const scope: LedgerScope = tripID === '' ? { type: 'all' } : { type: 'trek', id: tripID };
  const filter: LedgerFilter = { scope, kind: kind === 'all' ? undefined : kind, customer, vendorID: vendorID === '' ? undefined : vendorID };
  const today = startOfDay(new Date());
  if (preset === 'month') { filter.from = toInstant(new Date(today.getFullYear(), today.getMonth(), 1)); filter.to = toInstant(new Date()); }
  else if (preset === 'last30') { filter.from = toInstant(addDays(today, -30)); filter.to = toInstant(new Date()); }
  else if (preset === 'custom') { filter.from = from; filter.to = to2; }

  const list = app.ledger.filtered(filter);
  const { credit, debit } = app.ledger.totals(list, scope);
  const balance = app.ledger.balance;

  const treks = [...app.treks.upcoming(), ...app.treks.undated(), ...app.treks.past()];
  const label = (t: { name: string; startDate?: string }) => (t.startDate ? `${t.name} · ${fmtDate(t.startDate)}` : t.name);
  const tripOptions = [{ value: '', label: 'All trips' }, ...treks.map((t) => ({ value: t.id, label: label(t) }))];
  const vendorOptions = [{ value: '', label: 'All vendors' }, ...app.vendors.vendors.map((v) => ({ value: v.id, label: v.name }))];

  if (staffView) {
    const mine = app.ledger.filtered({ type: 'all' });
    return (
      <Page title="Money" tab trailing={<button class="iconbtn" type="button" aria-label="Record payment received" onClick={() => nav.go(to.entry())}>+</button>}>
        <InfoNote>You can record payments received. Money out, totals and statements are visible to Managers and Owners.</InfoNote>
        <SectionLabel>Payments you can see · {mine.length}</SectionLabel>
        {mine.length === 0 ? <div class="small muted">No payments yet. Tap + to record one.</div> : null}
        {mine.map((e) => (
          <EntryRow key={e.id} entry={e}
            onClick={() => { if (canEditEntry(app.account.role, app.account.myId, e)) nav.go(to.entry({ entry: e.id, kind: 'in' })); }} />
        ))}
      </Page>
    );
  }

  return (
    <Page title="Money" tab trailing={<button class="iconbtn" type="button" aria-label="Add transaction" onClick={() => nav.go(to.entry())}>+</button>}>
      {dupCount > 0 && app.can('editAnyRecord') ? (
        <button class="dup-banner" type="button" onClick={() => nav.go(to.duplicates())}>
          <span style="font-size:18px;color:var(--rust)">⚠</span>
          <span class="grow stack" style="gap:2px">
            <span class="t">{dupCount} possible duplicate payment{dupCount === 1 ? '' : 's'}</span>
            <span class="s">Same amount, day, trip and person. Review before the books are off.</span>
          </span>
          <span class="muted" style="font-size:24px">›</span>
        </button>
      ) : null}

      <Card>
        <div class="stack-lg">
          <SectionLabel>Fund balance</SectionLabel>
          <div class={`fund ${balance < 0 ? 'bad' : ''}`}>{signedRupees(balance)}</div>
          <div class="row">
            <div class="grow"><div class="small muted">Money in</div><div class="title" style="color:var(--pine)">{rupees(app.ledger.totalIn)}</div></div>
            <div class="grow"><div class="small muted">Money out</div><div class="title bad">{rupees(app.ledger.totalOut)}</div></div>
          </div>
          <div class="tiny muted">All transactions, whatever the filters below.</div>
        </div>
      </Card>

      <Card>
        <div class="stack">
          <SectionLabel>Filters</SectionLabel>
          <PickerRow title="Trip" value={tripOptions.find((o) => o.value === tripID)?.label ?? 'All trips'} options={tripOptions} onSelect={setTripID} />
          <Segmented<KindFilter> options={[{ value: 'all', label: 'All' }, { value: 'Money in', label: 'In' }, { value: 'Money out', label: 'Out' }]} selected={kind} onSelect={setKind} />
          <PickerRow title="Vendor" value={vendorOptions.find((o) => o.value === vendorID)?.label ?? 'All vendors'} options={vendorOptions} onSelect={setVendorID} />
          <Field value={customer} onChange={setCustomer} placeholder="Traveller name" words />
          <PickerRow title="Dates" value={PRESETS.find((p) => p.value === preset)!.label} options={PRESETS} onSelect={setPreset} />
          {preset === 'custom' ? (
            <>
              <DateField label="From" value={from} onChange={setFrom} />
              <DateField label="To" value={to2} onChange={setTo} />
            </>
          ) : null}
        </div>
      </Card>

      <SectionLabel>Transactions · {list.length}</SectionLabel>
      {list.length === 0 ? (
        <div class="small muted">{entries.length === 0 ? 'Nothing recorded yet. Tap + to add the first credit or debit.' : 'No transactions match these filters.'}</div>
      ) : (
        <div class="totals-bar">
          <span style="color:var(--pine)">In {rupees(credit)}</span>
          <span class="bad center">Out {rupees(debit)}</span>
          <span class="right">Net {signedRupees(credit - debit)}</span>
        </div>
      )}
      {list.map((e) => <EntryRow key={e.id} entry={e} scope={scope} onClick={() => nav.go(to.entry({ entry: e.id, kind: e.kind === 'Money in' ? 'in' : 'out' }))} />)}
    </Page>
  );
}
