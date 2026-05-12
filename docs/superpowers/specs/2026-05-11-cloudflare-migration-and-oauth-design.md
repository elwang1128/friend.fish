# Cloudflare migration + GitHub OAuth — design

**Date:** 2026-05-11
**Status:** Approved (pending user review of this written spec)
**Topic:** Replace the hardcoded GitHub PAT in `index.html` with a server-mediated architecture: host on Cloudflare Pages, put a Cloudflare Pages Function in front of the gist, gate writes behind GitHub OAuth.

---

## Background

`friend.fish` is a single-page static site (one `index.html`) currently hosted on GitHub Pages. It uses a GitHub Gist (ID `1793476b9117a2b123ff35c0170c5705`) as its backing data store, containing three files: `tankdata.json` (feeding log), `photos.json` (base64-encoded JPEGs of fish, capped at ~8 MB), and `covers.json` (per-fish cover images).

The current code embeds a GitHub personal access token directly in the page JavaScript (lightly obfuscated by string concatenation that splits the `ghp_…` prefix from the body of the token). Any visitor can extract this token and use it to read or modify the gist. "Owner mode" is gated only by a client-side SHA-256 password check, which is cosmetic — the network requests are unauthenticated, so any visitor with the token can write.

## Goals

1. Remove the GitHub PAT from the browser entirely. It must live only as a server-side secret.
2. Replace the client-side password with **GitHub OAuth sign-in**, restricted to an allowlist.
3. Preserve current functionality bit-for-bit: same UI, same data layout, same gist as the backing store.
4. Stay on Cloudflare's free tier.

## Non-goals

- **No data migration off the gist.** Same gist ID, same JSON file names, same shape. Reverting to GitHub Pages would only require restoring the old `index.html`.
- **No photo storage changes.** Still base64 in `photos.json`, still the same in-browser JPEG compression. (R2 is the right tool eventually but not in this migration.)
- **No new features.** Pure security/architecture migration.
- **No client-side password fallback.** OAuth is the only sign-in path after this lands.

## Architecture

```
Browser ──► friend.fish (Cloudflare Pages, static index.html)
         │
         ├─ GET  /api/data       ──► Pages Function ──► GitHub Gist API (read,  public)
         ├─ POST /api/data       ──► Pages Function ──► GitHub Gist API (write, owner-only)
         ├─ GET  /api/me         ──► Pages Function (returns {login} or 401)
         ├─ GET  /auth/login     ──► redirect to GitHub OAuth
         ├─ GET  /auth/callback  ──► exchange code, set session cookie, redirect "/"
         └─ POST /auth/logout    ──► clear session cookie
```

- Single Cloudflare Pages project, deployed from the existing repo on every `git push`.
- Repo layout: `index.html` at root (unchanged location), `functions/api/*.js` and `functions/auth/*.js` for endpoints. Pages routes requests to functions automatically based on file path.
- The gist token lives only inside the Worker runtime as the `GITHUB_GIST_TOKEN` secret.
- **Reads stay public.** `GET /api/data` requires no authentication, matching today's behavior (the site is publicly viewable).
- **Writes require a valid session cookie** whose `login` claim is in the allowlist.

## Components

### `functions/api/data.js`
- `GET`: fetches the gist via GitHub API, returns `{feeds, photos, covers}` JSON to the browser.
- `POST`: verifies session cookie + allowlist, then PATCHes the gist with the body's `{feeds, photos, covers}`.
- One file, two exported handlers (`onRequestGet`, `onRequestPost`).

### `functions/api/me.js`
- `GET`: verifies session cookie, returns `{login}` (200) or empty body (401).
- The frontend calls this once on page load to determine `isOwner`.

### `functions/auth/login.js`
- `GET`: generates a 16-byte random `state`, HMAC-signs it with `SESSION_SECRET`, sets it as a 10-minute `__Host-oauth_state` cookie (HttpOnly, Secure, SameSite=Lax, Path=/), then 302-redirects to GitHub's authorize endpoint with `client_id`, `redirect_uri=https://friend.fish/auth/callback`, `scope=read:user`, and the signed state.

### `functions/auth/callback.js`
- `GET`:
  1. Verify `state` query param against signed `__Host-oauth_state` cookie. Reject 400 on mismatch.
  2. POST to `https://github.com/login/oauth/access_token` with `{client_id, client_secret, code}`.
  3. GET `https://api.github.com/user` with the returned access token.
  4. If `login` is **not** in `OWNER_GITHUB_LOGINS` → 403 with a friendly HTML page listing who is allowed, no cookie set. (Discard the access token immediately — we don't keep it.)
  5. Else mint session cookie: `base64url(JSON.stringify({login, exp: now + 30d}))` + `.` + `base64url(hmacSHA256(payload, SESSION_SECRET))`. Set as `__Host-session`, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=2592000.
  6. Clear `__Host-oauth_state` cookie.
  7. 302 → `/`.

### `functions/auth/logout.js`
- `POST`: clears `__Host-session` cookie (Set-Cookie with Max-Age=0). Returns 204.

### `index.html` (frontend changes)
- **Remove:** `GITHUB_TOKEN` constant, `OWNER_HASH` constant, `checkPassword()` function, auth modal HTML, `handleLockClick`/`closeAuth`/`submitAuth` handlers.
- **Replace data layer:**
  ```js
  async function gistGet() {
    const res = await fetch('/api/data');
    if (!res.ok) { console.error('load failed'); return; }
    const data = await res.json();
    feedEntries = data.feeds || [];
    photoStore = data.photos || {};
    coverStore = data.covers || {};
  }

  async function gistSave() {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ feeds: feedEntries, photos: photoStore, covers: coverStore }),
    });
    if (res.status === 401) {
      isOwner = false;
      applyOwnerState();
      alert("session expired — sign in again");
    } else if (!res.ok) {
      alert("couldn't save");
    }
  }
  ```
- **Replace owner-state bootstrap:**
  ```js
  async function checkSession() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    isOwner = res.ok;
  }
  ```
  Called on page load instead of reading `sessionStorage.tankOwner`.
- **Lock-button click:** if `isOwner` → `POST /auth/logout` then reload; else `window.location = '/auth/login'`.

## Data flow

### Read (anyone)
```
Browser  GET /api/data
       → Function  GET https://api.github.com/gists/{GIST_ID}
                   with `Authorization: Bearer ${GITHUB_GIST_TOKEN}`
       ← {feeds, photos, covers}
Browser ← {feeds, photos, covers}
```

### Write (owner)
```
Browser  POST /api/data + cookie __Host-session=<payload.sig>
       → Function: verify HMAC sig, verify exp > now, verify login ∈ OWNER_GITHUB_LOGINS
       → PATCH https://api.github.com/gists/{GIST_ID}
                with `Authorization: Bearer ${GITHUB_GIST_TOKEN}` and body
                  {files: {"tankdata.json":{content:...}, "photos.json":..., "covers.json":...}}
       ← 200
Browser ← 200
```

### Sign-in
```
User clicks "Sign in"
  → GET /auth/login
    sets __Host-oauth_state cookie (signed, 10-min)
    302 → github.com/login/oauth/authorize?...&state=<signed>
  → user approves on GitHub
    302 → /auth/callback?code=<x>&state=<signed>
  → Function: verify state, exchange code, fetch user, check allowlist
    sets __Host-session cookie (signed, 30-day), clears __Host-oauth_state
    302 → /
  → Page loads, calls /api/me, sees 200, sets isOwner=true
```

## Secrets and configuration

All set on the Cloudflare Pages project (**Settings → Environment variables**, Production environment):

| Name | Encrypted? | Value source |
|---|---|---|
| `GITHUB_GIST_TOKEN` | yes | new fine-grained PAT, gist read+write scope, owner is the GitHub account that owns the gist |
| `GITHUB_OAUTH_CLIENT_SECRET` | yes | from the OAuth App's "Generate a new client secret" |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` |
| `GITHUB_OAUTH_CLIENT_ID` | no | from the OAuth App (public) |
| `OWNER_GITHUB_LOGINS` | no | `elwang1128,nicolaschan` |
| `GIST_ID` | no | `1793476b9117a2b123ff35c0170c5705` |

**OAuth App config** (https://github.com/settings/developers):
- Application name: `friend.fish`
- Homepage URL: `https://friend.fish`
- Authorization callback URL: `https://friend.fish/auth/callback`
- Type: OAuth App (not GitHub App)

## Error handling

| Failure | Worker response | Frontend behavior |
|---|---|---|
| `GET /api/data` gist fetch fails (network / 5xx / 404) | 502 `{error: "gist unavailable"}` | console.error, leave existing state |
| `POST /api/data` missing/expired/invalid session cookie | 401 | drop owner state, alert re-login |
| `POST /api/data` login not in allowlist (cookie issued before tightening) | 403 | "your account isn't authorized" alert |
| `POST /api/data` gist PATCH fails | 502 `{error}` | "couldn't save" alert |
| `/auth/callback` state mismatch or missing | 400 friendly HTML | user sees error, retry link |
| `/auth/callback` login not in allowlist | 403 friendly HTML naming who is allowed | clear failure, no retry |
| `/auth/callback` OAuth code exchange fails | 502 friendly HTML | retry link |

All Worker errors log to `console.error`, visible via `wrangler pages deployment tail` or the Cloudflare dashboard.

## Testing

**Local dev:** `wrangler pages dev .` serves static assets + functions on `localhost:8788`. Requires either a second OAuth App pointed at `http://localhost:8788/auth/callback` or running smoke tests against a `*.pages.dev` preview deploy (with that hostname added as an allowed callback on the production OAuth App).

**Manual smoke test plan** (run after each significant deploy, and as the final acceptance check):
1. Visit site logged out → feed entries + photos render. No edit UI visible. View source: no token, no password hash present.
2. Click sign-in → GitHub consent → land on `/` → edit UI visible. Test with both `nicolaschan` and `elwang1128`.
3. Sign in as a third GitHub user → see 403 page, no session cookie issued.
4. Add a feed entry → reload page → entry persists.
5. Upload a photo → reload → photo persists.
6. Log out → edit UI disappears. Confirm in devtools that `POST /api/data` now returns 401.
7. Manually expire the session cookie (devtools) → attempt to save → frontend shows "session expired" and clears owner UI.

Unit tests are not part of scope — the function surface is small and the value/cost ratio is poor.

## Migration / deployment sequence (high-level)

Detailed step-by-step belongs in the implementation plan; this is just the shape:

1. **Revoke the leaked PAT immediately** — independent of everything else. Assume it has been harvested.
2. Create new fine-grained PAT (gist read+write only).
3. Create GitHub OAuth App; save client ID + secret.
4. Create Cloudflare Pages project connected to the repo; deploy stub `functions/api/health.js` so env vars become configurable.
5. Configure custom domain `friend.fish` on the Pages project, but do not cut DNS yet. Verify on `*.pages.dev` first.
6. Add the env vars + secrets listed above.
7. Implement and deploy the real `/auth/*` and `/api/*` functions. Smoke-test on `*.pages.dev`.
8. Rewrite `index.html` data layer; deploy; smoke-test on `*.pages.dev`.
9. Cut DNS: point `friend.fish` to Cloudflare Pages, disable GitHub Pages, delete the `CNAME` file from the repo.

## Risks and rollback

- **Bad cutover** — if Cloudflare Pages doesn't work right at switchover time, re-enable GitHub Pages and restore the old `index.html` from git. The gist is untouched throughout. Rollback is fully reversible until step 9; after step 9, rollback requires flipping DNS back, which takes minutes.
- **OAuth misconfig** — caught during step 7 smoke tests on `*.pages.dev`, before any DNS change.
- **Leaked PAT abuse before revocation** — possible. Revoking at step 1 (and rotating the gist contents from a known-good state if anything looks tampered) bounds the blast radius.

## Open questions

None — design is ready to implement.
