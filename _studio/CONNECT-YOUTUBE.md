# Connecting a channel to YouTube

One-time, ~10 minutes, **free**. You do the Google Cloud part (steps 1–4); the Studio handles the rest.
The OAuth *app* you create here is shared across all your Studio channels — you only do steps 1–4 **once**.
Then you connect each channel (step 5) to its own YouTube account.

The Studio stores nothing on Google's side: the API key/secret live in `_studio/.secrets.json` and each
channel's login token in `<channel>/_assets/youtube.json` — **all local-only, never shared.**

---

## 1. Make a Google Cloud project
1. Go to **https://console.cloud.google.com** (sign in with the Google account that owns the channel).
2. Top bar → project dropdown → **New Project** → name it e.g. `Before Lore Studio` → **Create** → select it.

## 2. Enable the two APIs
**APIs & Services → Library**, search and **Enable** each:
- **YouTube Data API v3**  (upload, thumbnails, playlists)
- **YouTube Analytics API**  (views, retention, CTR)

## 3. Configure the consent screen
**APIs & Services → OAuth consent screen**
- User type: **External** → Create.
- App name (e.g. `Before Lore Studio`), your email for support + developer contact → Save and continue.
- Scopes screen → just **Save and continue** (the Studio requests scopes at connect time).
- Test users → **+ Add users** → add **your own Google email** → Save and continue.
- Back on the OAuth consent screen overview → **Publish app** → Confirm.
  - *Why publish:* while in "Testing" the login token **expires every 7 days**. Publishing (even unverified)
    makes it persist. You'll see a one-time "Google hasn't verified this app" notice when you connect — that's
    expected for your own personal app; click **Advanced → Continue**. (YouTube scopes are "sensitive," not
    "restricted," so an unverified personal app is allowed — capped at 100 users; you're 1.)

## 4. Create the OAuth credentials
**APIs & Services → Credentials → + Create credentials → OAuth client ID**
- Application type: **Web application**.
- Name: anything (e.g. `Studio local`).
- Under **Authorized redirect URIs → + Add URI**, paste **exactly**:
  ```
  http://localhost:4317/api/youtube/oauth-callback
  ```
- **Create.** A box shows your **Client ID** and **Client Secret** — keep it open.

## 5. Connect in the Studio
1. In the Studio, top bar → **📺** button (make sure the channel you want is selected in the channel switcher).
2. Paste the **Client ID** and **Client Secret** → **Save credentials**.
3. Click **🔗 Connect [channel] →**. A Google tab opens.
   - Pick the YouTube channel, click through the unverified-app notice (Advanced → Continue), and **Allow**.
   - You'll see "✓ Connected to [your channel]" — close that tab.
4. Back in the Studio it flips to **✓ Connected**, showing your subscriber count.

Repeat **step 5** for each additional channel (steps 1–4 are shared).

---

### Troubleshooting
- **"Access blocked … has not completed the Google verification process" / Error 403: access_denied** →
  the app is still in **Testing**. Fix: OAuth consent screen (a.k.a. Google Auth Platform → Audience) →
  **Publish app** → Confirm (it'll warn it's unverified — fine). Reconnect; you'll now get the milder
  "Google hasn't verified this app" screen → **Advanced → Continue**. (Quick alt: add your Gmail under
  **Test users** — but Testing-mode logins expire in 7 days, so publishing is better.)
- **"redirect_uri_mismatch"** → the redirect URI in step 4 must match exactly (no trailing slash), and the
  Studio must be running on port 4317.
- **"Google did not return a refresh token"** → you previously authorized this app. Go to
  **myaccount.google.com/permissions**, remove the app, and reconnect.
- **Login expires after ~7 days** → you skipped "Publish app" in step 3. Publish it and reconnect once.
