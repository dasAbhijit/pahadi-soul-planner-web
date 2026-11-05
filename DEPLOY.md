# Putting the web app online (free) and installing it on phones

The app is a static website: a folder of files, with no server and no database. GitHub Pages hosts it for free and rebuilds it every time you push. Nothing here costs money.

You need: a free GitHub account, Git on your Mac (already there), and the phones.

## 1. Create the GitHub repository

1. Sign in at github.com and choose **New repository**.
2. Name it `pahadi-soul-planner-web`. Choose **Public**.
   - Public is required: GitHub Pages is free only for public repositories.
   - Nothing private is in the repository. It holds the app's code only. Your treks, bookings and money stay on each phone and in your Google Sheet. Your Gemini key and sheet secret are typed into the app on each phone and never go into the code. Anyone who finds the address can open the app, and they will see an empty app.
3. Leave "Add a README" and the other boxes **unticked**. Create the repository.

## 2. Push this folder to it

In Terminal (this project lives only under the `dasAbhijit` account):

```
cd ~/Documents/personal/pahadi_soul_travels_web
git remote add origin https://github.com/dasAbhijit/pahadi-soul-planner-web.git
git push -u origin main
```

GitHub asks you to sign in. The easiest way is `brew install gh`, then `gh auth login`, then run the push again.

## 3. Turn on GitHub Pages

1. In the repository: **Settings > Pages**.
2. Under **Build and deployment > Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. The workflow **Deploy to GitHub Pages** runs by itself on every push to `main`. If the first run failed because Pages was not on yet, open it and choose **Re-run all jobs**.
4. When it shows a green tick (about 1 to 2 minutes), the site is at:

   `https://dasabhijit.github.io/pahadi-soul-planner-web/`

The workflow runs the tests first. If a test fails, nothing is published.

## 4. Check it before you hand it out

1. Open the address on your computer. You should see the Chat tab and the five tabs at the bottom.
2. Open it on a phone and add a trek.
3. Turn on airplane mode and reopen the app. It should still open and show your trek. (The first visit needs a connection, because that visit saves the app for offline use.)

## 5. Install it on each phone

**iPhone** (use Safari, not Chrome)
1. Open the address in Safari.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. **From now on open it only from the new Home Screen icon.** The installed app and Safari keep separate storage. Anything you typed into a Safari tab is not in the installed app. To move it, use **Settings > Your data > Export all data** in the Safari tab, then **Restore** in the installed app.
4. In the installed app: **Settings**, paste your Gemini key, tap **Test key**.

**Android** (Chrome)
1. Open the address in Chrome.
2. Tap the **three dots menu**, then **Install app** (or **Add to Home screen**).
3. Open it from the new icon and paste your Gemini key in **Settings**.

Unlike the sideloaded iPhone app, this install does not expire after 7 days.

## 6. Connect the Google Sheet and sign in

Follow `cloud/README.md` (the same script as the iPhone and Android apps): paste `Code.gs`, add the `PAHADI_TOKEN` setup code, deploy as a web app, then in the app choose **Set up the first Owner**. Add everyone else from **Settings > People**; they join with an invite and choose their own password.

**Test this on each kind of phone before you rely on it.** A web page can read Google's reply only if Google allows it, and this has not been tried against your sheet yet. If signing in says it could not reach Google even though the address is right, cloud sync does not work from that browser. The rest of the app still works only for people who are already signed in on that phone, and **Export all data** is your backup. Tell me and I will look at a fix.

Deploy the script with **Anyone** for "Who has access", as the setup steps say. A browser has no Google login to offer, so any other setting leaves it unable to read the reply.

**Deploy the new `Code.gs` before the new web app reaches people**, or the app says the sheet's script is too old. Until the first Owner is created, old app versions keep working with the old secret code.

### Not typing the sheet address on every new browser

A browser remembers the sheet address after the first sign-in, and signing out keeps it. A **new** browser, a private window, another device, or the live site versus `localhost` each start empty, so they ask for it once. Two ways around that:

- **Sign-in link (nothing is published):** an Owner opens **Settings > Copy sign-in link** and sends it to the team. Opening it fills in the address, and only a name and password are asked for. The link holds the sheet address, so send it only to your team.
- **Built into the site (optional):** in the GitHub repository, **Settings > Secrets and variables > Actions > Variables**, add `SHEET_URL` with the web app address, then re-run the deploy. Every browser then starts with it. This puts the address in the public site's code, so anyone who reads it could call your script. Sign-in, lockout and roles still protect the data, but it removes one layer of obscurity. Leave it unset to avoid that.

## 7. Sending an update later

Change the code, then:

```
git add -A
git commit -m "What changed"
git push
```

GitHub rebuilds and publishes in a minute or two. A phone that opens the app, or comes back to it, downloads the new version in the background and shows **A new version is ready. Update**. Tap Update. Your data stays.

## Your data

- It lives in each phone's browser storage, in the installed app. Clearing the browser's site data for the address, or deleting the Home Screen app on iPhone, erases it. Sync to the sheet and export a backup now and then.
- The app asks the browser to keep its data even when the phone is short of space. Browsers may say no.
- The Gemini key and the session code sit in that same storage, unencrypted. They are left out of backups and never go into the sheet. Anyone who can unlock the phone and open the browser's developer tools could read them. Signing out removes them and the company data. Use a Gemini key limited to this use, and delete it in Google AI Studio if a phone is lost.
- A backup file from the web app restores into the iPhone and Android apps, and the other way round.

## Other free hosts

Any static host works. Build with `npm install` then `npm run build`, and publish the `dist` folder.

- **Cloudflare Pages** or **Netlify**: connect the repository, build command `npm run build`, output folder `dist`. Both have free plans that, as far as I know, also accept private repositories. Check their current terms.
- Anything else: copy the contents of `dist` to any web server that uses https.

The app uses relative addresses, so it works at any path.

## If something goes wrong

| What you see | What to do |
|---|---|
| The Actions run fails at "Run tests" | Open the run and read the failing test. Nothing was published. |
| The Pages address shows a 404 | Settings > Pages > Source must be **GitHub Actions**. Re-run the workflow. |
| The phone keeps showing the old version | Close the app fully and open it again. It checks for a new version each time it opens. |
| "This browser is not saving your changes" (red bar) | Private mode or full storage. Export all data now, then open the app in a normal window. |
| iPhone app has no data after adding to the Home Screen | It is a separate store from Safari. Use Export in Safari, Restore in the installed app. |
