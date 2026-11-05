import { AccountStore } from './account';
import { Chat } from './chat';
import { runCloudSync, type CloudSyncReport } from './cloudsync';
import { GeminiClient } from './gemini';
import { nowSecond } from './ids';
import { can, type Capability } from './roles';
import { SheetSyncClient, SheetSyncError, validateAddress, type SessionReply } from './sheetsync';

/**
 * A sheet address built into this copy of the app (set as VITE_SHEET_URL when building), so people only type a name and
 * password. Empty unless the build was given one.
 */
export const BUILT_IN_SHEET_URL: string = (import.meta.env.VITE_SHEET_URL as string | undefined)?.trim() ?? '';
import { LocalKV, type KV } from './storage';
import { Secrets, SettingsStore } from './settings';
import { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from './stores';

/** Every store the screens use, built once at start. */
export class AppContainer {
  settings: SettingsStore;
  secrets: Secrets;
  account: AccountStore;
  treks: TrekStore;
  bookings: BookingStore;
  ledger: LedgerStore;
  vendors: VendorStore;
  guidance: GuidanceStore;
  chat: Chat;
  gemini = new GeminiClient();
  sheet: SheetSyncClient;

  constructor(public kv: KV = new LocalKV(), sheet: SheetSyncClient = new SheetSyncClient()) {
    this.sheet = sheet;
    this.settings = new SettingsStore(kv);
    this.secrets = new Secrets(kv);
    this.account = new AccountStore(kv);
    this.treks = new TrekStore(kv);
    this.bookings = new BookingStore(kv);
    this.ledger = new LedgerStore(kv);
    this.vendors = new VendorStore(kv);
    this.guidance = new GuidanceStore(kv);
    this.chat = new Chat(this.settings, this.treks, this.guidance, this.vendors, this.secrets);
    // Seats left is capacity minus booked seats; settle it once at start, as a sync would.
    this.treks.reconcileSeats(this.bookings.bookings);
    // A browser that has never been given an address starts with the one built into the app, if any.
    if (this.settings.syncUrl === '' && validateAddress(BUILT_IN_SHEET_URL)) this.settings.setSyncUrl(BUILT_IN_SHEET_URL);
    // The sync secret an earlier version kept is not used any more.
    if (this.secrets.syncSecret !== null) this.secrets.setSyncSecret(null);
  }

  /** "Web (iPhone)", "Web (Android)" or "Web", shown in the sheet's Sync log. */
  get deviceName(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/iPhone|iPad|iPod/.test(ua)) return 'Web (iPhone)';
    if (/Android/.test(ua)) return 'Web (Android)';
    return 'Web';
  }

  /** Whether the signed-in person's role allows something. Nobody signed in can do nothing. */
  can(what: Capability): boolean { return can(this.account.role, what); }

  // ------------------------------------------------------------ Signing in

  private begin(r: SessionReply) {
    this.account.signIn(r, nowSecond());
    this.secrets.setSyncSecret(null);
    this.treks.dropPlaceholder();
  }

  async signIn(address: string, name: string, password: string) {
    this.settings.setSyncUrl(address.trim());
    this.begin(await this.sheet.signIn(address, name, password, this.deviceName));
  }

  async join(address: string, invite: string, password: string) {
    this.settings.setSyncUrl(address.trim());
    this.begin(await this.sheet.join(address, invite, password, this.deviceName));
  }

  async setupOwner(address: string, setupCode: string, name: string, password: string) {
    this.settings.setSyncUrl(address.trim());
    this.begin(await this.sheet.setupOwner(address, setupCode, name, password, this.deviceName));
  }

  /** Ends this phone's session at the sheet (best effort) and clears company data from the phone. */
  async signOut() {
    const session = this.account.session;
    if (session !== null && validateAddress(this.settings.syncUrl)) {
      try { await this.sheet.signOut(this.settings.syncUrl, session); } catch { /* the phone is cleared either way */ }
    }
    this.clearCompanyData();
    this.account.end();
  }

  /**
   * Removes the bookings, money, vendors, treks, rules, chat and Gemini key from this phone. The sheet address and the
   * model name stay, so signing in again is quick. Nothing is marked deleted: the records belong to the sheet.
   */
  clearCompanyData() {
    this.treks.clearAll();
    this.bookings.clearAll();
    this.ledger.clearAll();
    this.vendors.clearAll();
    this.guidance.clearAll();
    this.secrets.setGeminiKey(null);
    this.settings.clearPersonal();
    this.chat.newChat();
  }

  // ---------------------------------------------------------------- Syncing

  /**
   * Syncs with the sheet. If the sheet has ended this phone's session (access removed, sign-in reset, or 90 days
   * without a sync), the phone is cleared and signed out before the error is passed on.
   */
  async sync(): Promise<CloudSyncReport> {
    const session = this.account.session;
    if (session === null) throw new SheetSyncError('notSignedIn');
    try {
      const report = await runCloudSync({
        client: this.sheet, address: this.settings.syncUrl, session, device: this.deviceName,
        treks: this.treks, bookings: this.bookings, ledger: this.ledger, vendors: this.vendors, guidance: this.guidance,
        dismissedDuplicates: this.settings.dismissedDuplicates,
      });
      this.account.refresh(report.person, report.directory);
      this.settings.setLastSyncAt(nowSecond());
      return report;
    } catch (e) {
      if (e instanceof SheetSyncError && e.code === 'sessionEnded') this.sessionEnded(e.reason);
      throw e;
    }
  }

  /** Runs a request that needs the signed-in session. If the sheet says the session is over, the phone is cleared first. */
  async withSession<T>(fn: (address: string, session: string) => Promise<T>): Promise<T> {
    const session = this.account.session;
    if (session === null) throw new SheetSyncError('notSignedIn');
    try { return await fn(this.settings.syncUrl, session); } catch (e) {
      if (e instanceof SheetSyncError && e.code === 'sessionEnded') this.sessionEnded(e.reason);
      throw e;
    }
  }

  /** The sheet said this session is over. `unknown` (a damaged or unknown code) signs out without the explanation screen. */
  sessionEnded(reason: SheetSyncError['reason']) {
    this.clearCompanyData();
    this.account.end(reason === 'removed' || reason === 'reset' || reason === 'expired' ? reason : undefined);
  }
}
