# Cloud sync to a Google Sheet

The apps keep all data on the phone and work offline. People sign in once; **Settings > Cloud sync > Sync now** reads what their role may see, merges it with the phone, and sends back what changed. This folder holds the small script that sits in the sheet. It costs nothing.

## One-time setup (about 5 minutes)

1. Open the Google Sheet. Set sharing to **Restricted** (only people you name): **Share > General access > Restricted**. The apps do not need the sheet shared, because the script runs as you. **Anyone who can open or edit the sheet can read and change everything in it**, including the people and the money, whatever role they have in the app. The roles below protect the apps, not the sheet.
2. **Extensions > Apps Script.** Delete the sample code and paste in all of `Code.gs`. Save.
3. **Project Settings** (gear icon) **> Script properties > Add script property.**
   Name `PAHADI_TOKEN`, value a long secret code of your own (30 or more random characters). Save. This is the **setup code**: it is used once, to create the first Owner. It is never written into the sheet.
4. **Deploy > New deployment > Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then allow access when Google asks. (Google shows an "unverified app" warning for your own script; choose Advanced > Go to the project.)
5. Copy the **Web app URL** (ends in `/exec`).
6. In the app, on the sign-in screen choose **Set up the first Owner**. Enter the web app address, the setup code, your name and a password (8 or more characters). **After this the setup code stops working**, for everything, for everyone.
7. Add everyone else from **Settings > People > +**: enter their name and a role, and send them the invite. They open the app, choose **I have an invite**, paste it and pick their own password.

"Anyone" only means the address can be called without a Google login. Every call after the first Owner exists must carry a signed-in person's session code, and a call without one is refused and changes nothing.

If you change `Code.gs` later: **Deploy > Manage deployments > pencil icon > Version: New version > Deploy**. The address stays the same. **Deploy the new script before using app versions that sign in.** A sheet still on the old script answers the new apps with "The sheet's script is an older version".

## People, roles and sign-in

| | Owner | Manager | Staff |
|---|---|---|---|
| Chat, see treks, see vendor names and phones | yes | yes | yes |
| Create and confirm bookings, record payments received | yes | yes | yes (change only their own) |
| Cancel bookings, change anyone's booking or payment, delete | yes | yes | no |
| Money out, trip totals, vendor rates, agreed amounts, statements | yes | yes | no, never sent to the phone |
| Add and edit treks, vendors, learned rules; export | yes | yes | no |
| Edit the base prompt, restore a backup, manage people | yes | no | no |

- **Names** are the sign-in and the "Recorded by" shown on everything a person adds. One name per person, not case sensitive.
- **Passwords** are chosen by the person (8 or more characters). The script keeps only a salted hash, in Script properties, never in a sheet tab. Session codes are kept as hashes too.
- **5 wrong passwords** lock that name for 15 minutes. A wrong setup code or invite code can be tried 20 times per 15 minutes.
- **A session** ends on sign out, when an Owner removes the person or resets their sign-in, or after 90 days without a sync. The phone is then cleared of company data and the Gemini key the next time it goes online. What the person recorded stays, with their name on it.
- **Invites** work once, expire after 7 days, and carry the sheet address. Creating a new invite cancels the old one.
- There is **always at least one Owner**. The last one cannot be demoted or removed.
- **If every Owner is locked out:** open the script in Apps Script, optionally add a script property `RECOVERY_NAME` (the Owner's name), then **Run > recoverOwner**. Read the invite code under **Execution log**. In the app choose **I have an invite**, paste the code and the web app address. You must be the owner of the Google Sheet to do this.
- **Old apps** (before sign-in) are refused with "Update the app" once the first Owner exists. Until then the old setup-code protocol keeps working, so you can roll the new apps out first.

## How merging works

Every trek, booking, payment, vendor and rule has a **last changed** time. A deleted record is kept, marked with a **deleted** time, so the deletion reaches every phone. On each sync the app:

1. **Reads** everything this person's role may see (the `Record (JSON)` column).
2. **Merges** it with the phone's data, record by record, by id:
   - A record only one side has is kept (entries added on different phones are all kept).
   - The same record on both sides: the one changed last wins. A deletion as new as an edit wins.
3. **Recomputes seats** for every dated trek: seats left = the trek's total seats minus the seats of live bookings. If more seats were booked than exist, the trek shows 0 and the sync tells you which trek is overbooked and by how many. No booking is dropped.
4. **Flags possible duplicates**: payments with the same type, amount, day, trip and traveller or vendor but different ids (the same payment typed on two phones). They show in the Money tab for you to keep or delete. Nothing is deleted automatically.
5. **Sends** only the records the sheet does not already have in that form. The script merges each record into the sheet itself, by id: the newer change wins, a deletion as new as an edit wins. Two people syncing at the same moment never overwrite each other, and nothing needs to be retried.

The script also checks every record against the sender's role, and stamps who made and who last changed it. Records from before sign-in have no name.

If the sheet holds a row this version of the app cannot read (for example from a newer app), the sync stops and changes nothing, because writing back would erase that row.

## What lands in the sheet

One tab per kind of record, plus a log. The script rewrites the data tabs when records change, so put your own analysis in other tabs. Rows you type by hand into a data tab are left alone.

| Tab | Columns |
|---|---|
| Treks | Trek ID, Name, Region, Days, Difficulty, Max altitude (ft), Price per person (INR), Start date, Seats left, Highlights, Notes, Updated at, Deleted at, Record (JSON), Added by, Last changed by |
| Bookings | Booking ID, Trek ID, Trek, Contact, All travellers, Party size, Phone, Payment, Amount received (INR), Booked on, Cancelled on, Updated at, Deleted at, Record (JSON), Added by, Last changed by |
| Money | Entry ID, Date, Type, Amount (INR), Signed amount (INR), Trip ID, Trip, Traveller, Booking ID, Vendor, Vendor ID, Paid by, Note, Recorded on, Updated at, Deleted at, Record (JSON), Added by, Last changed by |
| Vendors | Vendor ID, Name, Service, Contact, Phone, Rate (INR), Rate unit, Tags, Notes, Total agreed (INR), Agreed per trip, Added on, Updated at, Deleted at, Record (JSON), Added by, Last changed by |
| Guidance | Rule ID, Rule, Added on, Updated at, Deleted at, Record (JSON), Added by, Last changed by |
| Sync log | When, Who, Device, Rows written, Left as they were |

- **Do not edit the `Record (JSON)` column.** It is what the apps read back. Editing the readable columns (Name, Amount...) in the sheet does nothing: the next sync overwrites them from the JSON. Make changes in the apps.
- **Deleted records stay in the sheet** with `Deleted at` filled in. Filter that column to hide them. Fund balance in the sheet: `=SUMIF(Money!P:P,"",Money!E:E)` sums only entries that are not deleted (in the Money tab, Signed amount is column E and Deleted at is column P; Added by and Last changed by follow the JSON column).
- `Signed amount (INR)` is positive for money in and negative for money out.
- Amount columns are numbers; all other columns are plain text (so phone numbers keep their format and a note starting with `=` is never run as a formula). Dates are written as text like `2026-11-04`, which sorts correctly.
- **Added by** and **Last changed by** show the person's name. They are filled in by the script.
- The Gemini key and passwords are never written to the sheet. Passwords reach the script only when someone signs in, and are stored as hashes in Script properties.

## Things to know

- **Offline is fine.** There is no queue. A sync sends and receives everything as it is at that moment, so there is nothing to lose while offline.
- **The first sync on a new phone downloads everything** the team has entered.
- **The starter trek is shared.** A fresh install has the same placeholder trek on every phone, with the oldest possible stamp, so any real edit or deletion beats it and a reinstall never overwrites your real trek details.
- **Signing out clears the phone.** Sync first: anything not yet synced is lost.
- **Restoring a backup** (Owner only) counts as an edit of everything that differs from the phone's data now, and as a deletion of what the backup does not contain. The next sync passes that on.
- **Deleted records are kept forever** in the sheet and the apps. At this size that costs nothing, and it means a phone that was offline for months cannot bring a deleted record back.
- **Two people editing the same record offline:** the later edit wins as a whole record; the other edit is not kept. Different records never conflict.
- Google keeps history: **File > Version history** restores an earlier copy of the sheet.
- The sheet holds traveller names, phone numbers and payments. Keep it restricted.

## Testing the script

`node cloud/test-code.js` (the old setup-code protocol) and `node cloud/test-people.js` (sign-in, invites, lockout, roles, per-record merge, authorship, recovery) run the script against a fake of Google's classes. They cannot prove Google's own behaviour: how fast hashing runs inside Apps Script, its quotas, and locking under real load are **not tested**. The first real sign-in and sync from a phone is the final check.
