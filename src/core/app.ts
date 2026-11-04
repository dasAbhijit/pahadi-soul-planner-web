import { Chat } from './chat';
import { GeminiClient } from './gemini';
import { LocalKV, type KV } from './storage';
import { Secrets, SettingsStore } from './settings';
import { BookingStore, GuidanceStore, LedgerStore, TrekStore, VendorStore } from './stores';

/** Every store the screens use, built once at start. */
export class AppContainer {
  settings: SettingsStore;
  secrets: Secrets;
  treks: TrekStore;
  bookings: BookingStore;
  ledger: LedgerStore;
  vendors: VendorStore;
  guidance: GuidanceStore;
  chat: Chat;
  gemini = new GeminiClient();

  constructor(public kv: KV = new LocalKV()) {
    this.settings = new SettingsStore(kv);
    this.secrets = new Secrets(kv);
    this.treks = new TrekStore(kv);
    this.bookings = new BookingStore(kv);
    this.ledger = new LedgerStore(kv);
    this.vendors = new VendorStore(kv);
    this.guidance = new GuidanceStore(kv);
    this.chat = new Chat(this.settings, this.treks, this.guidance, this.vendors, this.secrets);
    // Seats left is capacity minus booked seats; settle it once at start, as a sync would.
    this.treks.reconcileSeats(this.bookings.bookings);
  }

  /** "Web (iPhone)", "Web (Android)" or "Web", shown in the sheet's Sync log. */
  get deviceName(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (/iPhone|iPad|iPod/.test(ua)) return 'Web (iPhone)';
    if (/Android/.test(ua)) return 'Web (Android)';
    return 'Web';
  }
}
