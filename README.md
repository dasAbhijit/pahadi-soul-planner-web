# Pahadi Soul Planner (web)

The Pahadi Soul Travels staff app as an installable website. It does the same things as the iPhone app (`../pahadi_soul_travels`) and the Android app (`../pahadi_soul_travels_android`): chat with Gemini using the staff member's own key, pitch upcoming treks, record bookings, keep a money ledger by trip, traveller and vendor, keep a vendor directory the assistant can suggest from, learn house rules from staff guidance, and sync through a Google Sheet.

People sign in with a name and password (Owner, Manager or Staff), and every record shows who recorded it. It runs in the phone's browser, and installs to the Home Screen like an app. Because it is not signed by Apple, it **does not expire after 7 days** like the sideloaded iPhone app.

TypeScript, Preact, Vite. No server and no database: everything is stored on the device.

- **Put it online and install it:** [`DEPLOY.md`](DEPLOY.md)
- **Set up the Google Sheet for sync:** [`cloud/README.md`](cloud/README.md) (the same script as the other two apps)

## Same rules, same files

The core in `src/core` is a port of the Android core, so the rules match: every transaction belongs to one trip and one traveller or vendor; a cost covering several trips is saved as one entry per trip; cancelled bookings are kept so refunds can name the traveller; seats left is the trek's capacity minus the seats of live bookings.

- **Backups** use the same JSON layout, so a backup moves between the web, iPhone and Android apps.
- **Cloud sync** writes the same five tabs and columns, and merges the same way (last change wins per record, deletes are kept as tombstones, seats are recomputed, lookalike payments are flagged). A phone, an Android and a web app can all sync to one sheet.
- **People and roles** are checked by the sheet's script as well as the app: Staff never receive money out or vendor rates. See [`cloud/README.md`](cloud/README.md).
- Records written by the other apps are read as they are: uppercase UUIDs, ISO 8601 dates to the second, empty optionals left out. A row the web app cannot read stops the sync and changes nothing.

## Chat actions (drafts the assistant prepares)

In chat, staff can say "Book Rohit and Anita on Gorkhey 12 Dec, ₹5,000 UPI" or "Rohit paid 14000 UPI". Gemini calls a draft tool (`draft_booking`, `draft_payment_received`) and the app shows a **card**. Only a person's tap on **Approve** writes anything, through the same code as the Add booking and Add transaction forms. **Edit** opens that form filled in; **Deny** writes nothing. Typing "yes" does nothing: there is no tool that saves.

- `src/core/chatactions.ts` holds the draft types, the tools offered per role, the checks (seats, amounts, one trip, duplicates, which traveller) and the write. `chat.ts` runs the cards; `prompt.ts` adds the CHAT ACTIONS rules and a reference (`[T3]`) to each trek line.
- Gemini names a trek by that reference, never by id. The traveller for a payment is matched on the phone. Bookings, payments and phone numbers already saved are **not** sent to Gemini; what staff type in chat is.
- Off until the person has read the notice (shown once in Chat) and on unless they switch it off in Settings. Per phone.
- Tests: `test/chatactions.test.ts` (fake Gemini), `npm run e2e:chat` (real browser, fake Gemini, including a Manager/Owner adding a vendor, paying it and adding a trek through Edit). Gemini's own choice of tool and fields has **not** been tried on real chats yet.
- Staff can draft a booking and a payment received. Managers and Owners can also draft a trek, a vendor (new ones only) and money out to a vendor or as a refund. Each tool is offered only to a role that can do the same in the forms, and checked again at Approve. Changing or deleting existing records by chat is not built.

## Differences from the phone apps

| | Phone apps | Web app |
|---|---|---|
| Gemini key and session code | Keychain / Android Keystore (encrypted) | This browser's storage, **unencrypted**. Never in backups or the sheet. Signing out removes them |
| Where data lives | App's private folder | The browser's storage for this address. The Home Screen app and Safari keep separate copies on iPhone |
| Expiry | 7 days (iPhone, free Apple ID) | None |
| Backup | File picker | Share sheet (iPhone, Android) or a download (computer) |
| Cloud sync | Native HTTP | Browser `fetch`. Needs Google to allow the browser to read the reply. **Not yet tested against a real sheet** |

## Develop

```
npm install
npm run dev          # http://localhost:5173
npm test             # vitest
npm run typecheck
npm run build        # dist/ with the offline service worker (sw.js)
npm run preview      # serve dist/ to try the offline behaviour
node cloud/test-code.js && node cloud/test-people.js   # the sheet script, against a fake Google
npm run build && npm run e2e   # three real Chrome profiles (Owner, Manager, Staff) sign in and sync through the real cloud/Code.gs (fake Google)
npm run tour              # opens every screen, checks for errors, reopens offline (needs a build first)
```

`npm run e2e` needs Google Chrome on this Mac. It checks the whole path in a browser engine: first Owner, invites, sign-in, add a trek, book from two phones at once, merge, seats, a double entry flagged, delete reaching the other phone, what Staff can and cannot see, and removing a person.

The service worker (`scripts/make-sw.mjs` writes `dist/sw.js`) keeps the app files for offline use and only touches this site's own files. Calls to Google (Gemini and the sync script) always go to the network.

## Layout

| Path | Contents |
|---|---|
| `src/core` | Models, JSON reading, stores, merge sync, sheet and Gemini clients, prompt builder, backup. No UI. Mirrors the Android `core` package |
| `src/ui` | Screens (`chat`, `treks`, `money`, `vendors`, `settings`), shared components (`kit.tsx`), router, theme |
| `test` | vitest tests, including two simulated phones syncing through a fake sheet |
| `cloud` | The Google Apps Script and its setup guide (identical in all three repos) |
| `public` | Manifest and icons |
| `scripts` | Build step that writes the service worker |
| `.github/workflows` | Test, build and publish to GitHub Pages on every push to `main` |
