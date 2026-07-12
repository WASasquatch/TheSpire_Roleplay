# Google setup (Sign-in + YouTube)

Operator guide for the two env-gated Google features:

1. **Google sign-in** (OAuth) — the "Continue with Google" button.
2. **YouTube Data API** — playlist expansion + video titles for `/theater`.

Both are OFF until the matching env vars/secrets are set. Nothing lights up in
the UI without them, so a fresh deploy is safe by default. Secrets live in Fly
only and are never committed.

---

## 1. Google OAuth (sign-in)

### Configure the OAuth consent screen

1. Google Cloud Console → **APIs & Services → OAuth consent screen**.
2. User type: **External**.
3. Fill the app name, support email, and developer contact.
4. Scopes: only `openid`, `.../auth/userinfo.email`, and
   `.../auth/userinfo.profile`. These are non-sensitive — they need **no
   verification review**, so you can ship without Google's app-verification.
5. Publishing status:
   - **Testing** — only the test users you list can sign in (good for staging).
   - **Publish (In production)** — anyone can sign in. Because we only use the
     three basic scopes above, publishing does **not** trigger a verification
     review.

### Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URI (exact match required):

   ```
   https://thespire.games/auth/google/callback
   ```

   Add any extra hosts you sign in from (e.g. a staging domain, or
   `http://localhost:3001/auth/google/callback` for local dev). The server
   derives this URL per-request unless `GOOGLE_REDIRECT_URI` is set, and honors
   `CANONICAL_HOST` so a `*.fly.dev` hit still uses the canonical-domain
   callback.
4. Copy the generated **Client ID** and **Client secret**.

---

## 2. YouTube Data API v3

1. **APIs & Services → Library → YouTube Data API v3 → Enable**.
2. **APIs & Services → Credentials → Create credentials → API key**.
3. Restrict the key (recommended): under **API restrictions**, limit it to
   **YouTube Data API v3** only.
4. Copy the **API key**.

---

## 3. Set the secrets (Fly)

Secrets are set on Fly, never committed to the repo:

```
flyctl secrets set \
  GOOGLE_CLIENT_ID=your-client-id \
  GOOGLE_CLIENT_SECRET=your-client-secret \
  YOUTUBE_API_KEY=your-youtube-api-key
```

Optionally pin the callback URL:

```
flyctl secrets set GOOGLE_REDIRECT_URI=https://thespire.games/auth/google/callback
```

Setting secrets restarts the app. Once the credentials are present, the `/site`
branding payload reports `googleAuthEnabled: true` / `youtubeEnabled: true` and
the client surfaces the features automatically.

For local development, put the same keys in `apps/server/.env`
(see `apps/server/.env.example`). Never commit real values.
