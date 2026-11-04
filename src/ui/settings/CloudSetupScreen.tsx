import { useState } from 'preact/hooks';
import { SheetSyncClient } from '../../core/sheetsync';
import { useApp, useStore } from '../hooks';
import { Card, Field, OutlineButton, Page } from '../kit';
import { Status, type StatusLine } from './Status';
import './settings.css';

const STEPS = [
  'Open the Google Sheet, then Extensions > Apps Script.',
  'Paste in the script from cloud/Code.gs and save.',
  'Project Settings > Script properties > add PAHADI_TOKEN with a long secret code of your choice.',
  'Deploy > New deployment > Web app. Run as: Me. Who has access: Anyone. Deploy and allow access.',
  'Copy the Web app address (it ends in /exec) into the field above, add the same secret code, then tap Test connection.',
];

export function CloudSetupScreen() {
  const app = useApp();
  useStore(app.settings, app.secrets);
  const [secretInput, setSecretInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<StatusLine>(null);
  const url = app.settings.syncUrl;
  const hasSecret = app.secrets.syncSecret !== null;
  const trimmed = secretInput.trim();

  const save = () => {
    app.secrets.setSyncSecret(trimmed);
    if (app.secrets.syncSecret === trimmed) { setSecretInput(''); setStatus({ text: 'Secret code saved. Tap Test connection to check it.', ok: true }); }
    else setStatus({ text: "Couldn't save the secret code in this browser. It may be in private mode.", ok: false });
  };

  const test = async () => {
    const secret = trimmed || app.secrets.syncSecret || '';
    if (secret === '') { setStatus({ text: 'Enter the secret code first.', ok: false }); return; }
    setTesting(true);
    try {
      const sheet = await new SheetSyncClient().ping(url, secret);
      setStatus({ text: `Connected to "${sheet}".`, ok: true });
    } catch (e) {
      setStatus({ text: (e instanceof Error && e.message) || 'The test failed.', ok: false });
    }
    setTesting(false);
  };

  const remove = () => {
    app.secrets.setSyncSecret(null);
    app.settings.setSyncUrl('');
    app.settings.setLastSyncAt(undefined);
    setSecretInput('');
    setStatus({ text: 'Cloud sync details removed from this device.', ok: true });
  };

  return (
    <Page title="Cloud sync setup">
      <Card>
        <div class="stack-lg">
          <Field label="Web app address" value={url} onChange={(v) => app.settings.setSyncUrl(v)} multiline rows={3} placeholder="https://script.google.com/macros/s/…/exec" />
          <Field
            label={hasSecret ? 'Replace the secret code' : 'Secret code'} value={secretInput} onChange={setSecretInput} password
            placeholder={hasSecret ? '•••••••••••••••• (saved)' : 'The PAHADI_TOKEN you chose'}
          />
          <Status s={status} fallback={hasSecret ? 'Secret code saved in this browser on this phone. Not encrypted.' : undefined} />
          <div class="btnrow">
            <button type="button" class="btn small" onClick={save} disabled={trimmed === ''}>Save</button>
            <OutlineButton text={testing ? 'Testing…' : 'Test connection'} onClick={test} disabled={testing} />
            <OutlineButton text="Remove" danger onClick={remove} disabled={!hasSecret && url === ''} />
          </div>
          <div class="tiny muted">A browser has no secure vault, so the secret code sits unencrypted in this browser's own storage. It is never in a backup and is only sent to your own script address.</div>
        </div>
      </Card>
      <Card>
        <div class="stack">
          <div class="title">One-time setup in Google Sheets</div>
          <ol class="steps">{STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          <div class="tiny muted">The full script and these steps, with pictures of the columns, are in the cloud folder of the project (cloud/Code.gs and cloud/README.md). If you change the script later, choose Deploy &gt; Manage deployments &gt; Edit &gt; New version so the same address keeps working.</div>
        </div>
      </Card>
    </Page>
  );
}
