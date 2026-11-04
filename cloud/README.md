# Cloud sync to a Google Sheet

The iPhone and Android apps keep all data on the phone and work offline. **Settings > Cloud sync > Sync to cloud** reads the sheet, merges it with the phone, and writes the merged result back. This folder holds the small script that sits in the sheet. It costs nothing.

## One-time setup (about 5 minutes)

1. Open the Google Sheet. Set sharing to **Restricted** (only people you name): **Share > General access > Restricted**. The apps do not need the sheet shared, because the script runs as you. Anyone who can open the sheet can read the traveller names, phone numbers and payments in it.
2. **Extensions > Apps Script.** Delete the sample code and paste in all of `Code.gs`. Save.
3. **Project Settings** (gear icon) **> Script properties > Add script property.**
   Name `PAHADI_TOKEN`, value a long secret code of your own (30 or more random characters). Save. This is the password the apps use. It is never written into the sheet.
4. **Deploy > New deployment > Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then allow access when Google asks. (Google shows an "unverified app" warning for your own script; choose Advanced > Go to the project.)
5. Copy the **Web app URL** (ends in `/exec`).
6. In each app: **Settings > Cloud sync.** Enter **Your name**, open **Sheet address and secret code**, paste the URL and the secret, tap **Save**, then **Test connection**. It should say it connected to your sheet.

"Anyone" only means the address can be called without a Google login. Every call must carry the secret code, and a call without it is refused and changes nothing.

If you change `Code.gs` later: **Deploy > Manage deployments > pencil icon > Version: New version > Deploy**. The address stays the same. Update the script before updating the apps to a version that needs it (a push from an app that does not send the sheet's version number is refused with "Update the app").

## How merging works

Every trek, booking, payment, vendor and rule has a **last changed** time. A deleted record is kept, marked with a **deleted** time, so the deletion reaches every phone. On each sync the app:

1. **Reads** everything in the sheet (the `Record (JSON)` column) and the sheet's version number.
2. **Merges** it with the phone's data, record by record, by id:
   - A record only one side has is kept (entries added on different phones are all kept).
   - The same record on both sides: the one changed last wins. A deletion as new as an edit wins.
3. **Recomputes seats** for every dated trek: seats left = the trek's total seats minus the seats of live bookings. If more seats were booked than exist, the trek shows 0 and the sync tells you which trek is overbooked and by how many. No booking is dropped.
4. **Flags possible duplicates**: payments with the same type, amount, day, trip and traveller or vendor but different ids (the same payment typed on two phones). They show in the Money tab for you to keep or delete. Nothing is deleted automatically.
5. **Writes** the merged result to the sheet, but only if nobody else wrote since step 1. If someone did, the sheet refuses, the app reads again, merges again and retries (up to 3 times), so two people syncing at the same moment never overwrite each other.

If the sheet holds a row this version of the app cannot read (for example from a newer app), the sync stops and changes nothing, because writing back would erase that row.

## What lands in the sheet

One tab per kind of record, plus a log. The apps rewrite the data tabs on every sync, so put your own analysis in other tabs.

| Tab | Columns |
|---|---|
| Treks | Trek ID, Name, Region, Days, Difficulty, Max altitude (ft), Price per person (INR), Start date, Seats left, Highlights, Notes, Updated at, Deleted at, Record (JSON) |
| Bookings | Booking ID, Trek ID, Trek, Contact, All travellers, Party size, Phone, Payment, Amount received (INR), Booked on, Cancelled on, Updated at, Deleted at, Record (JSON) |
| Money | Entry ID, Date, Type, Amount (INR), Signed amount (INR), Trip ID, Trip, Traveller, Booking ID, Vendor, Vendor ID, Paid by, Note, Recorded on, Updated at, Deleted at, Record (JSON) |
| Vendors | Vendor ID, Name, Service, Contact, Phone, Rate (INR), Rate unit, Tags, Notes, Total agreed (INR), Agreed per trip, Added on, Updated at, Deleted at, Record (JSON) |
| Guidance | Rule ID, Rule, Added on, Updated at, Deleted at, Record (JSON) |
| Sync log | When, Who, Device, Rows written, Left as they were |

- **Do not edit the `Record (JSON)` column.** It is what the apps read back. Editing the readable columns (Name, Amount...) in the sheet does nothing: the next sync overwrites them from the JSON. Make changes in the apps.
- **Deleted records stay in the sheet** with `Deleted at` filled in. Filter that column to hide them. Fund balance in the sheet: `=SUMIF(Money!P:P,"",Money!E:E)` sums only entries that are not deleted (in the Money tab, Signed amount is column E and Deleted at is column P).
- `Signed amount (INR)` is positive for money in and negative for money out.
- Amount columns are numbers; all other columns are plain text (so phone numbers keep their format and a note starting with `=` is never run as a formula). Dates are written as text like `2026-11-04`, which sorts correctly.
- The Gemini key and the secret code are never sent.

## Things to know

- **Offline is fine.** There is no queue. A sync sends and receives everything as it is at that moment, so there is nothing to lose while offline.
- **The first sync on a new phone downloads everything** the team has entered.
- **The starter trek is shared.** A fresh install has the same placeholder trek on every phone, with the oldest possible stamp, so any real edit or deletion beats it and a reinstall never overwrites your real trek details.
- **Restoring a backup** counts as an edit of everything that differs from the phone's data now, and as a deletion of what the backup does not contain. The next sync passes that on.
- **Deleted records are kept forever** in the sheet and the apps. At this size that costs nothing, and it means a phone that was offline for months cannot bring a deleted record back.
- **Two people editing the same record offline:** the later edit wins as a whole record; the other edit is not kept. Different records never conflict.
- Google keeps history: **File > Version history** restores an earlier copy of the sheet.
- The sheet holds traveller names, phone numbers and payments. Keep it restricted.

## Testing the script

`node cloud/test-code.js` runs the script against a fake of Google's classes (secret checks, the read-back, version conflicts, empty-table protection, text formatting, bad requests, the log). It cannot prove Google's own behaviour, so the first real sync from a phone is the final check.
