import { useState } from 'preact/hooks';
import { RATE_UNITS, SERVICE_TYPES, makeVendor, parseTags, type RateUnit, type ServiceType, type TripAgreement, type Vendor } from '../../core/models';
import type { Id } from '../../core/ids';
import { AlertBox, Confirm, Field, FieldLabel, FormPage, LinkButton, PickerRow, SelectField } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav } from '../router';
import { optionalInt } from '../treks/shared';
import '../treks/treks.css';

function EditVendorScreenForm({ id }: { id?: string }) {
  const app = useApp();
  useStore(app.treks);
  const [existing] = useState<Vendor | undefined>(() => (id ? app.vendors.vendor(id) : undefined));
  const [name, setName] = useState(existing?.name ?? '');
  const [service, setService] = useState<ServiceType>(existing?.service ?? 'Guide');
  const [contact, setContact] = useState(existing?.contactName ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [rateText, setRateText] = useState(existing?.rate?.toString() ?? '');
  const [unit, setUnit] = useState<RateUnit>(existing?.rateUnit ?? 'per day');
  const [tagText, setTagText] = useState(existing?.tags.join(', ') ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [agreements, setAgreements] = useState<TripAgreement[]>(existing?.agreements ?? []);
  const [agreedText, setAgreedText] = useState<Record<Id, string>>(
    () => Object.fromEntries((existing?.agreements ?? []).map((a) => [a.trekID, String(a.amount)])));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const used = new Set(agreements.map((a) => a.trekID));
  const addable = [...app.treks.upcoming(), ...app.treks.undated()].filter((t) => !used.has(t.id));

  function save() {
    const rate = optionalInt(rateText);
    if (rate === null || rate === 0) return setError('The rate must be a positive number.');
    const base = existing ?? makeVendor({ name });
    const v: Vendor = {
      ...base, name, service, contactName: contact, phone, rate, rateUnit: unit, tags: parseTags(tagText), notes,
      agreements: agreements.map((a) => ({ trekID: a.trekID, trekName: a.trekName, amount: Number(agreedText[a.trekID] || 0) })),
    };
    if (v.rate === undefined) delete v.rate;
    try { app.vendors.upsert(v); nav.back(); } catch (e) { setError(e instanceof Error ? e.message : 'The vendor could not be saved.'); }
  }

  return (
    <FormPage title={existing ? 'Edit vendor' : 'Add vendor'} onSave={save}>
      <Field label="Name" value={name} onChange={setName} placeholder="Vendor or person" words />
      <PickerRow title="Service" value={service} options={SERVICE_TYPES.map((s) => ({ value: s, label: s }))} onSelect={setService} />
      <div class="two" style="align-items:end">
        <Field label="Rate (₹)" value={rateText} onChange={setRateText} placeholder="optional" numeric />
        <SelectField label="Unit" value={unit} options={RATE_UNITS.map((u) => ({ value: u, label: u }))} onSelect={setUnit} />
      </div>
      <Field label="Tags · places, seasons, anything useful (comma separated)" value={tagText} onChange={setTagText} placeholder="darjeeling, winter, hindi" />
      <div class="two">
        <Field label="Contact person" value={contact} onChange={setContact} placeholder="optional" words />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="optional" phone />
      </div>
      <Field label="Notes for the assistant" value={notes} onChange={setNotes} placeholder="optional" multiline rows={2} />

      <div class="group">
        <FieldLabel>Agreed amount per trip (optional)</FieldLabel>
        <div class="small muted">What you have promised this vendor for a trip. The balance owed is this minus what you have paid.</div>
        {agreements.map((a) => (
          <div class="agree-row" key={a.trekID}>
            <div class="grow break" style="font-size:14px">{a.trekName}</div>
            <input class="input" type="text" inputMode="numeric" pattern="[0-9]*" aria-label={`Agreed amount for ${a.trekName}`} value={agreedText[a.trekID] ?? ''}
              onInput={(e) => { const v = (e.target as HTMLInputElement).value.replace(/[^0-9]/g, ''); setAgreedText((cur) => ({ ...cur, [a.trekID]: v })); }} />
            <button class="iconbtn" type="button" aria-label={`Remove ${a.trekName}`} style="color:var(--muted)"
              onClick={() => setAgreements((cur) => cur.filter((x) => x.trekID !== a.trekID))}>✕</button>
          </div>
        ))}
        {addable.length > 0 ? (
          <SelectField value="" placeholder="+  Add a trip" options={addable.map((t) => ({ value: t.id, label: t.name }))}
            onSelect={(tid) => {
              const t = addable.find((x) => x.id === tid);
              if (t) setAgreements((cur) => [...cur, { trekID: t.id, trekName: t.name, amount: 0 }]);
            }} />
        ) : null}
      </div>
      {existing ? <LinkButton text="Delete vendor" danger onClick={() => setConfirmDelete(true)} /> : null}

      {confirmDelete ? (
        <Confirm title="Delete this vendor?" message="Past payouts stay in Money with the vendor's name." confirmLabel="Delete" cancelLabel="Keep" danger
          onConfirm={() => { if (existing) app.vendors.delete(existing.id); nav.backTo('/vendors'); }} onDismiss={() => setConfirmDelete(false)} />
      ) : null}
      {error ? <AlertBox title="Can't save" text={error} onDismiss={() => setError(null)} /> : null}
    </FormPage>
  );
}

/** Keyed by id, so opening a different record starts the form afresh. */
export function EditVendorScreen({ id }: { id?: string }) {
  return <EditVendorScreenForm key={id ?? 'new'} id={id} />;
}
