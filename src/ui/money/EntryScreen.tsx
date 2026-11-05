import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp, useStore } from '../hooks';
import { nav } from '../router';
import { canEditEntry } from '../../core/roles';
import { Page } from '../kit';
import { AlertBox, ChoiceRow, Confirm, DateField, Field, FieldLabel, FormPage, InfoNote, LinkButton, PickerRow, Segmented, digitsOnly } from '../kit';
import { fmtDate, rupees } from '../../core/fmt';
import { toInstant, type Id, type Instant } from '../../core/ids';
import { LedgerStore } from '../../core/stores';
import { AppError } from '../../core/errors';
import { ENTRY_KINDS, PAYMENT_MODES, makeEntry, partySize, isCancelled, type EntryKind, type LedgerEntry, type PaymentMode } from '../../core/models';
import './money.css';

type Who = 'vendor' | 'traveller';

const sharesMismatch = (expected: number, got: number) =>
  new AppError('sharesMismatch', expected - got > 0 ? `₹${expected - got} of the amount is not assigned to a trip yet.` : `The trip amounts add up to ₹${got - expected} more than the entry.`);

/**
 * Every transaction names a trip and one counterpart: a traveller (money in, or a refund) or a vendor
 * (money out). A cost covering several trips is saved as one entry per trip.
 */
export function EntryScreen({ query }: { query: URLSearchParams }) {
  const app = useApp();
  useStore(app.ledger, app.treks, app.bookings, app.vendors);

  const entryID = query.get('entry') || undefined;
  // Staff can only record payments received.
  const moneyInOnly = !app.can('seeMoneyOut');
  const presetKind: EntryKind = query.get('kind') === 'out' && !moneyInOnly ? 'Money out' : 'Money in';
  const presetTrek = query.get('trek') || undefined;
  const presetBooking = query.get('booking') || undefined;
  const presetVendor = query.get('vendor') || undefined;

  const existing = useMemo(() => (entryID ? app.ledger.entries.find((e) => e.id === entryID) : undefined), [entryID]);
  // Opened with Edit on a chat card: start from what the assistant drafted.
  const draftID = query.get('draft') || undefined;
  const pre = useMemo(() => {
    const d = draftID ? app.chat.findDraft(draftID) : undefined;
    return d && d.state === 'pending' && d.data.kind === 'paymentIn' ? d.data : undefined;
  }, [draftID]);

  const vendor0 = existing?.vendorID ?? presetVendor;
  const booking0 = existing?.bookingID ?? presetBooking;
  const kind0 = existing?.kind ?? presetKind;

  const [kind, setKind] = useState<EntryKind>(kind0);
  const [amountText, setAmountText] = useState(existing ? String(existing.amount) : pre?.amount !== undefined ? String(pre.amount) : '');
  const [date, setDate] = useState<Instant | undefined>(existing?.date ?? pre?.date ?? toInstant(new Date()));
  const [mode, setMode] = useState<PaymentMode>(existing?.mode ?? pre?.mode ?? 'UPI');
  const [note, setNote] = useState(existing?.note ?? pre?.note ?? '');
  const [who, setWho] = useState<Who>(kind0 === 'Money in' ? 'traveller' : vendor0 === undefined && booking0 !== undefined ? 'traveller' : 'vendor');
  const [selected, setSelected] = useState<Id[]>(existing ? existing.shares.map((s) => s.trekID) : presetTrek ? [presetTrek] : []);
  const [shareText, setShareText] = useState<Record<string, string>>({});
  const [splitEdited, setSplitEdited] = useState(false);
  const [bookingID, setBookingID] = useState<Id | undefined>(booking0);
  const [vendorID, setVendorID] = useState<Id | undefined>(vendor0);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const blocked = existing !== undefined && !canEditEntry(app.account.role, app.account.myId, existing);
  const isCredit = kind === 'Money in';
  const multi = !isCredit && !existing; // tick several trips: one entry each
  const allTreks = [...app.treks.upcoming(), ...app.treks.undated(), ...app.treks.past()];
  const amount = Number(digitsOnly(amountText)) || 0;
  const ordered = allTreks.filter((t) => selected.includes(t.id));
  const assigned = ordered.reduce((s, t) => s + (Number(shareText[t.id]) || 0), 0);
  const singleTrek = selected.length === 1 ? selected[0] : undefined;

  // Keep the per-trip amounts even until staff type their own.
  const selKey = selected.join(',');
  useEffect(() => {
    if (splitEdited) return;
    const split = LedgerStore.evenSplit(amount, ordered.map((t) => ({ id: t.id, name: t.name })));
    setShareText(Object.fromEntries(split.map((s) => [s.trekID, String(s.amount)])));
  }, [amount, selKey, splitEdited]);

  /** A chosen traveller must belong to the chosen trip; otherwise the choice is dropped. */
  function traveller(nextSelected: Id[], current: Id | undefined): Id | undefined {
    if (current === undefined) return undefined;
    if (nextSelected.length !== 1) return undefined;
    const b = app.bookings.booking(current);
    if (b) return b.trekID === nextSelected[0] ? current : undefined;
    return existing?.bookingID === current && existing.shares[0]?.trekID === nextSelected[0] ? current : undefined;
  }

  function choose(next: Id[]) {
    setSelected(next);
    setBookingID(traveller(next, bookingID));
    setSplitEdited(false);
  }

  function toggle(id: Id) {
    if (!multi) choose(selected.length === 1 && selected[0] === id ? [] : [id]);
    else choose(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  function changeKind(k: EntryKind) {
    setKind(k);
    let next = selected;
    if (k === 'Money in') { setWho('traveller'); setVendorID(undefined); if (selected.length > 1) next = selected.slice(0, 1); }
    choose(next);
  }

  function save() {
    if (selected.length === 0) { setError(new AppError('tripRequired', 'Choose the trip this belongs to.').message); return; }
    const useBooking = isCredit || who === 'traveller';
    if (useBooking && bookingID === undefined) { setError(isCredit ? 'Choose the traveller this money came from.' : 'Choose the vendor, or the traveller being refunded.'); return; }
    if (!useBooking && vendorID === undefined) { setError('Choose the vendor, or the traveller being refunded.'); return; }

    const order = allTreks.map((t) => t.id);
    const ids = [...selected].sort((a, b) => (order.indexOf(a) < 0 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 1e9 : order.indexOf(b)));
    const customerName = useBooking ? (bookingID !== undefined ? app.bookings.booking(bookingID)?.travellers[0] : undefined) ?? existing?.customerName : undefined;
    const vendorName = useBooking ? undefined : (vendorID !== undefined ? app.vendors.vendor(vendorID)?.name : undefined) ?? existing?.vendorName;

    const make = (base: LedgerEntry, trek: Id, value: number): LedgerEntry => {
      const name = allTreks.find((t) => t.id === trek)?.name ?? existing?.shares.find((s) => s.trekID === trek)?.trekName ?? 'Trip';
      return {
        ...base, date: date ?? base.date, kind, amount: value, mode, note, party: vendorName ?? customerName ?? '',
        bookingID: useBooking ? bookingID : undefined, customerName,
        vendorID: useBooking ? undefined : vendorID, vendorName,
        shares: [{ trekID: trek, trekName: name, amount: value }],
      };
    };
    try {
      if (existing) app.ledger.update(make(existing, ids[0], amount));
      else {
        const values = ids.map((id) => (ids.length === 1 ? amount : Number(shareText[id]) || 0));
        const total = values.reduce((s, v) => s + v, 0);
        if (total !== amount) throw sharesMismatch(amount, total);
        const day = date ?? toInstant(new Date());
        const saved = app.ledger.addAll(ids.map((id, i) => make(makeEntry({ date: day, kind, amount: values[i] }), id, values[i])));
        if (pre && draftID && saved.length === 1) app.chat.draftSavedFromForm(draftID, `Payment recorded · ${rupees(saved[0].amount)} by ${saved[0].mode} · ${saved[0].customerName ?? saved[0].party}`);
      }
      nav.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  }

  // ---- Pieces

  const tripLabel = (t: { name: string; startDate?: string }) => (t.startDate ? fmtDate(t.startDate) : undefined);
  const trekRemoved = selected.length > 0 && selected.some((id) => !allTreks.some((t) => t.id === id));

  const bookingOptions = () => {
    if (singleTrek === undefined) return null;
    // Cancelled bookings can still be refunded; new money in only comes from live ones.
    const list = app.bookings.bookings.filter((b) => b.trekID === singleTrek && (!isCredit || !isCancelled(b)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const orphan = existing?.bookingID && !list.some((b) => b.id === existing.bookingID) ? { id: existing.bookingID, name: existing.customerName ?? 'Traveller' } : undefined;
    if (list.length === 0 && !orphan) return <div class="small muted">No bookings on this trip yet. Add the booking first, then record the payment.</div>;
    const options = [
      { value: '', label: 'Choose…' },
      ...list.map((b) => ({ value: b.id, label: `${b.travellers[0]} · ${partySize(b)} traveller${partySize(b) === 1 ? '' : 's'}${isCancelled(b) ? ' (cancelled)' : ''}` })),
      ...(orphan ? [{ value: orphan.id, label: `${orphan.name} (removed)` }] : []),
    ];
    return <PickerRow title="Traveller" value={options.find((o) => o.value === (bookingID ?? ''))?.label ?? 'Choose…'} options={options} onSelect={(v) => setBookingID(v === '' ? undefined : v)} />;
  };

  const vendorOptions = () => {
    const vendors = app.vendors.vendors;
    const orphan = existing?.vendorID && !vendors.some((v) => v.id === existing.vendorID) ? { id: existing.vendorID, name: existing.vendorName ?? 'Vendor' } : undefined;
    if (vendors.length === 0 && !orphan) return <div class="small muted">No vendors yet. Add one in the Vendors tab, then record the payout.</div>;
    const options = [
      { value: '', label: 'Choose…' },
      ...vendors.map((v) => ({ value: v.id, label: `${v.name} · ${v.service}` })),
      ...(orphan ? [{ value: orphan.id, label: `${orphan.name} (removed)` }] : []),
    ];
    return <PickerRow title="Vendor" value={options.find((o) => o.value === (vendorID ?? ''))?.label ?? 'Choose…'} options={options} onSelect={(v) => setVendorID(v === '' ? undefined : v)} />;
  };

  const left = amount - assigned;

  if (blocked) return <Page title="Transaction"><InfoNote tone="warn">You can only change payments you recorded yourself. Ask a Manager or an Owner.</InfoNote></Page>;

  return (
    <FormPage title={existing ? 'Edit transaction' : moneyInOnly ? 'Record payment received' : 'Add transaction'} onSave={save}>
      {pre ? <InfoNote>From chat. Check it, change anything, then save. If you leave without saving, nothing is saved.</InfoNote> : null}
      {moneyInOnly ? null : <Segmented<EntryKind> options={ENTRY_KINDS.map((k) => ({ value: k, label: k }))} selected={kind} onSelect={changeKind} />}
      <Field label="Amount (₹)" value={amountText} onChange={(v) => setAmountText(digitsOnly(v))} placeholder="0" numeric />
      <DateField label="Date" value={date} onChange={(v) => v && setDate(v)} />
      <PickerRow title="Paid by" value={mode} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} onSelect={setMode} />

      <div class="group">
        <FieldLabel>{multi ? 'Trips (tick every trip this covers)' : 'Trip'}</FieldLabel>
        {multi ? <LinkButton text="Select all upcoming trips" onClick={() => choose(app.treks.upcoming().map((t) => t.id))} /> : null}
        {allTreks.map((t) => <ChoiceRow key={t.id} label={t.name} sub={tripLabel(t)} selected={selected.includes(t.id)} multi={multi} onClick={() => toggle(t.id)} />)}
        {trekRemoved ? <div style="font-size:14px">Trip: {existing?.shares[0]?.trekName ?? 'removed trip'}</div> : null}
        {allTreks.length === 0 ? <div class="small muted">Add a trek first. Every transaction belongs to a trip.</div> : null}
        {multi && selected.length > 1 ? (
          <>
            <div class="row">
              <FieldLabel>Amount for each trip</FieldLabel>
              <span class="spacer" />
              <LinkButton text="Split evenly" onClick={() => setSplitEdited(false)} />
            </div>
            {ordered.map((t) => (
              <div class="share-row" key={t.id}>
                <span class="nm">{t.name}</span>
                <input class="input" type="text" inputMode="numeric" pattern="[0-9]*" aria-label={`Amount for ${t.name}`} value={shareText[t.id] ?? ''}
                  onInput={(e) => { setShareText({ ...shareText, [t.id]: digitsOnly((e.target as HTMLInputElement).value) }); setSplitEdited(true); }} />
              </div>
            ))}
            <div class={`small bold ${left === 0 ? '' : 'bad'}`} style={left === 0 ? 'color:var(--pine)' : ''}>
              {left === 0 ? `All ${rupees(amount)} assigned. Saved as ${selected.length} entries, one per trip.` : left > 0 ? `${rupees(left)} still to assign` : `${rupees(-left)} over`}
            </div>
          </>
        ) : null}
      </div>

      <div class="group">
        <FieldLabel>{isCredit ? 'Traveller' : 'Paid to'}</FieldLabel>
        {!isCredit ? (
          <Segmented<Who> options={[{ value: 'vendor', label: 'Vendor' }, { value: 'traveller', label: 'Traveller (refund)' }]} selected={who}
            onSelect={(w) => { setWho(w); if (w === 'vendor') setBookingID(undefined); else setVendorID(undefined); }} />
        ) : null}
        {isCredit || who === 'traveller'
          ? (singleTrek !== undefined ? bookingOptions() : <div class="small muted">{selected.length === 0 ? 'Choose the trip first.' : 'A traveller can be tagged on one trip at a time.'}</div>)
          : vendorOptions()}
      </div>

      <Field label="Note" value={note} onChange={setNote} placeholder="optional" />
      <InfoNote>Every transaction needs a trip and a traveller or vendor. A cost for several trips is saved as one entry per trip.</InfoNote>
      {existing && app.can('editAnyRecord') ? <LinkButton text="Delete transaction" danger onClick={() => setConfirmDelete(true)} /> : null}

      {confirmDelete ? (
        <Confirm title="Delete this transaction?" message="The fund balance, trip totals and vendor balance will change." confirmLabel="Delete" cancelLabel="Keep" danger
          onConfirm={() => { if (existing) app.ledger.remove(existing.id); nav.back(); }} onDismiss={() => setConfirmDelete(false)} />
      ) : null}
      {error ? <AlertBox title="Can't save" text={error} onDismiss={() => setError(null)} /> : null}
    </FormPage>
  );
}
