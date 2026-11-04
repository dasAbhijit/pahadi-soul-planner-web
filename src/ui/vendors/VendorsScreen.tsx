import { useState } from 'preact/hooks';
import { rupees } from '../../core/fmt';
import { SERVICE_TYPES, vendorRateText, type ServiceType } from '../../core/models';
import { Card, Chip, Page } from '../kit';
import { useApp, useStore } from '../hooks';
import { nav, to } from '../router';
import { TagChips } from './shared';

export function VendorsScreen() {
  const app = useApp();
  useStore(app.vendors, app.ledger);
  const [query, setQuery] = useState('');
  const [service, setService] = useState<ServiceType | null>(null);
  const list = app.vendors.search(query, service ?? undefined);

  return (
    <Page tab title="Vendors" trailing={<button class="iconbtn" type="button" aria-label="Add vendor" onClick={() => nav.go(to.editVendor())}>+</button>}>
      <input class="input" type="search" value={query} placeholder="Search name, service or tag" autoComplete="off" autoCorrect="off" spellcheck={false}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      <div class="pills">
        <button type="button" class={`pill ${service === null ? 'on' : ''}`} onClick={() => setService(null)}>All</button>
        {SERVICE_TYPES.map((s) => (
          <button type="button" key={s} class={`pill ${service === s ? 'on' : ''}`} onClick={() => setService(service === s ? null : s)}>{s}</button>
        ))}
      </div>
      {app.vendors.vendors.length === 0
        ? <div class="muted" style="font-size:14px">No vendors yet. Tap + to add a guide, stay, transport or anyone you pay. The assistant will suggest from this list.</div>
        : list.length === 0 ? <div class="muted" style="font-size:14px">No vendors match.</div> : null}
      {list.map((v) => {
        const owed = app.ledger.statement(v).owed;
        return (
          <Card key={v.id} onClick={() => nav.go(to.vendor(v.id))}>
            <div class="stack">
              <div class="row">
                <div class="grow bold break" style="font-size:16px">{v.name}</div>
                <Chip text={v.service.toUpperCase()} />
              </div>
              <div class="small muted">{vendorRateText(v) ?? 'Rate not set'}</div>
              {v.tags.length > 0 ? <TagChips tags={v.tags} /> : null}
              {owed > 0 ? <div><Chip text={`${rupees(owed)} OWED`} tone="amber" /></div> : null}
            </div>
          </Card>
        );
      })}
    </Page>
  );
}
