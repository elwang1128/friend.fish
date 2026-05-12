# Cloudflare migration + GitHub OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hardcoded GitHub PAT from `index.html` by moving all gist reads/writes behind a Cloudflare Pages Function, gated by GitHub OAuth sign-in restricted to an allowlist.

**Architecture:** Single Cloudflare Pages project, deployed from this repo on every push. Static `index.html` stays at root. Pages Functions under `functions/` mediate access to the existing GitHub Gist (`tankdata.json`, `photos.json`, `covers.json`). Sessions are stateless HMAC-signed cookies; no KV/D1/R2 needed. The gist remains the only data store.

**Tech Stack:** Cloudflare Pages, Cloudflare Pages Functions (Workers runtime), Web Crypto API (HMAC-SHA256), GitHub OAuth (OAuth App), GitHub Gist API.

**Spec:** `docs/superpowers/specs/2026-05-11-cloudflare-migration-and-oauth-design.md`

---

## File structure

After this plan completes, the repo will look like:

```
/
├── index.html                       (modified — data layer rewritten, auth modal removed)
├── CNAME                            (deleted at cutover)
├── functions/
│   ├── _lib/
│   │   ├── session.js               (HMAC sign/verify, cookie helpers)
│   │   └── github.js                (gist read/write, OAuth helpers)
│   ├── api/
│   │   ├── health.js                (stub — used to bootstrap env-var configurability)
│   │   ├── data.js                  (GET reads gist; POST writes gist, owner-only)
│   │   └── me.js                    (returns {login} or 401)
│   └── auth/
│       ├── login.js                 (302 → GitHub OAuth)
│       ├── callback.js              (exchange code, check allowlist, set session cookie)
│       └── logout.js                (clear session cookie)
└── docs/superpowers/...             (spec + this plan)
```

Files under `functions/_lib/` are not routed (Cloudflare Pages Functions skips paths starting with `_`). All shared logic lives there.

---

## Testing strategy

Two practical paths:

- **(Recommended) Test the auth flow only after DNS cutover.** Before cutover, smoke-test only the non-OAuth surface on `*.pages.dev` (the stub, then `GET /api/data` returning real gist content, then static rendering). The OAuth callback URL must match the request host, so without a separate OAuth App it won't work on `*.pages.dev`. DNS cutover is reversible in minutes; if OAuth breaks on the live URL, restoring `index.html` and re-enabling GitHub Pages is the rollback.
- **(Alternative) Create a second test OAuth App** pointed at `https://main.friend-fish.pages.dev/auth/callback` and a separate set of Pages env vars (preview environment) so the full auth flow can be verified before DNS cutover. More setup, lower-risk cutover.

The plan below assumes the recommended path. If you want the alternative, add a step before Task 4 to create the test OAuth App and configure preview-environment vars.

There are no unit tests. The function surface is small, the value-to-cost ratio is poor, and the spec explicitly excludes them. Verification at every step is by hand: `curl`, browser, dashboard. Each task spells out the exact verification.

---

## Out-of-band prep (Phase A)

These tasks are GitHub/Cloudflare dashboard work. They unblock everything that follows.

### Task A1: Revoke the leaked PAT

**Why first:** The current token is hard-coded in `index.html` (around line 788) in two `ghp_…`-prefixed string fragments concatenated with `+`. It is therefore public. Assume it has been harvested. Do this before anything else.

- [ ] **Step 1: Open GitHub token settings**

Go to https://github.com/settings/tokens (as the account that owns the gist — `elwang1128`).

- [ ] **Step 2: Locate the token and delete it**

Find the token referenced from the friend.fish site (the one currently used to PATCH the gist). Click **Delete**. Confirm. (If you're not sure which token it is, open `index.html` on the live `main` branch at the line where the `GITHUB_TOKEN` constant is concatenated — the `ghp_…` prefix in that source identifies it.)

- [ ] **Step 3: Verify the gist is intact**

Open https://gist.github.com/1793476b9117a2b123ff35c0170c5705. Confirm `tankdata.json`, `photos.json`, `covers.json` all exist and look intact. If anything looks tampered with, restore from the gist revision history (gists are versioned).

### Task A2: Create a new fine-grained PAT for the gist

- [ ] **Step 1: Open fine-grained token page**

Go to https://github.com/settings/tokens?type=beta. Click **Generate new token**.

- [ ] **Step 2: Configure the token**

- Token name: `friend.fish gist`
- Resource owner: the account that owns the gist (`elwang1128`)
- Expiration: 1 year
- Repository access: **Public repositories (read-only)** — gists aren't repos, this setting is mostly inert
- Permissions → Account permissions → **Gists: Read and write**

If the fine-grained UI doesn't expose `Gists: Read and write` cleanly, fall back to a classic PAT (https://github.com/settings/tokens/new) with the single `gist` scope.

- [ ] **Step 3: Save the token value**

Copy the token string. Save it somewhere temporary (you'll paste it into Cloudflare in Task C2). Do NOT commit it anywhere.

### Task A3: Create the GitHub OAuth App

- [ ] **Step 1: Open OAuth Apps page**

Go to https://github.com/settings/developers. Click **OAuth Apps** → **New OAuth App**.

- [ ] **Step 2: Fill in the form**

- Application name: `friend.fish`
- Homepage URL: `https://friend.fish`
- Authorization callback URL: `https://friend.fish/auth/callback`
- Click **Register application**

- [ ] **Step 3: Generate client secret**

On the OAuth App page, click **Generate a new client secret**. Copy both the **Client ID** (public, shown at top) and the **Client secret** (only shown once). Save both temporarily — you'll paste them into Cloudflare in Task C2.

---

## Cloudflare Pages bootstrap (Phase B)

### Task B1: Add the stub Pages Function

Cloudflare Pages won't let you set env vars on a project that has only static assets. The fix is to deploy one trivial Pages Function first so the project gets a Worker runtime attached.

**Files:**
- Create: `functions/api/health.js`

- [ ] **Step 1: Create the stub function**

```js
export const onRequestGet = () => new Response('ok', {
  headers: { 'Content-Type': 'text/plain' }
});
```

- [ ] **Step 2: Commit and push**

```bash
git add functions/api/health.js
git commit -m "Add health stub to bootstrap Pages Functions runtime"
git push
```

(This commit goes to `main` directly. The site is still GitHub Pages-hosted at this point; adding files outside `index.html` is a no-op for the live site.)

### Task B2: Create the Cloudflare Pages project

This is dashboard work — there's no CLI equivalent that's simpler than clicking through it once.

- [ ] **Step 1: Connect Git**

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**. Authorize Cloudflare's GitHub app on `elwang1128/friend.fish` if it isn't already.

- [ ] **Step 2: Configure build**

- Project name: `friend-fish` (this becomes the `*.pages.dev` subdomain)
- Production branch: `main`
- Framework preset: **None**
- Build command: *(leave blank)*
- Build output directory: `/`
- Root directory: *(leave blank — the repo root is the deploy root)*

Click **Save and Deploy**.

- [ ] **Step 3: Verify the stub deploys**

Wait for the build to go green (usually < 1 minute). Open `https://friend-fish.pages.dev/api/health` (substitute your actual subdomain — Cloudflare will show it).

Expected: response body is `ok`, status 200.

Also verify `https://friend-fish.pages.dev/` shows the existing site (no auth flow yet, still uses the old in-page token — but the token is revoked, so save/load will fail silently; that's expected and temporary).

---

## Environment variables and custom domain (Phase C)

### Task C1: Add the custom domain (but do not cut DNS)

- [ ] **Step 1: Add domain to Pages project**

In the Pages project → **Custom domains** → **Set up a custom domain** → enter `friend.fish`.

- [ ] **Step 2: Note the DNS instructions**

Cloudflare will show DNS records to add. **Do not change DNS yet.** The current `friend.fish` DNS still points at GitHub Pages, and we want it to stay that way until everything is tested. The custom domain is registered on the Pages side; the cutover happens in Task G.

If `friend.fish` is on a registrar other than Cloudflare DNS, write down the CNAME/A records they show — you'll apply them in Task G.

If `friend.fish` is already on Cloudflare DNS, the custom-domain wizard may try to add records automatically — cancel that step. Add it manually at cutover.

### Task C2: Add environment variables and secrets

- [ ] **Step 1: Open the env vars page**

Pages project → **Settings** → **Environment variables** → **Production** tab.

- [ ] **Step 2: Add plaintext variables**

For each, click **Add variable**, leave **Encrypt** unchecked:

| Name | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | (Client ID from Task A3) |
| `OWNER_GITHUB_LOGINS` | `elwang1128,nicolaschan` |
| `GIST_ID` | `1793476b9117a2b123ff35c0170c5705` |

- [ ] **Step 3: Add encrypted secrets**

For each, click **Add variable**, check **Encrypt**:

| Name | Value |
|---|---|
| `GITHUB_GIST_TOKEN` | (PAT from Task A2) |
| `GITHUB_OAUTH_CLIENT_SECRET` | (Client secret from Task A3) |
| `SESSION_SECRET` | run `openssl rand -hex 32` locally, paste the output |

- [ ] **Step 4: Save and redeploy**

Click **Save**. Env var changes don't redeploy automatically — go to **Deployments** → click **...** on the latest deploy → **Retry deployment**. Wait for green.

- [ ] **Step 5: Verify env vars are present**

The stub function doesn't read env, so the only way to verify is via the next task's code. Move on.

---

## Session helpers (Phase D)

### Task D1: Implement session/cookie helpers

**Files:**
- Create: `functions/_lib/session.js`

- [ ] **Step 1: Write `functions/_lib/session.js`**

```js
function base64urlEncode(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSession(payload, secret) {
  const key = await importKey(secret);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = base64urlEncode(payloadBytes);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

export async function verifySession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  let sigBytes;
  try { sigBytes = base64urlDecode(sigB64); } catch { return null; }
  const key = await importKey(secret);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64)
  );
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64))); }
  catch { return null; }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setCookie(name, value, { maxAge, path = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (typeof maxAge === 'number') s += `; Max-Age=${maxAge}`;
  return s;
}

export function clearCookie(name, { path = '/' } = {}) {
  return `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function isAllowedLogin(login, env) {
  const allowed = (env.OWNER_GITHUB_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(login);
}
```

- [ ] **Step 2: Commit**

```bash
git add functions/_lib/session.js
git commit -m "Add session signing and cookie helpers for Pages Functions"
git push
```

This won't be reachable on its own — verification happens via the endpoints that use it.

### Task D2: Implement GitHub API helpers

**Files:**
- Create: `functions/_lib/github.js`

- [ ] **Step 1: Write `functions/_lib/github.js`**

```js
const UA = 'friend.fish';

export async function readGist(env) {
  const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw new Error(`gist read failed: ${res.status}`);
  const data = await res.json();
  const files = data.files || {};
  const parse = (name, fallback) => {
    try { return JSON.parse(files[name]?.content ?? JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  return {
    feeds: parse('tankdata.json', { feeds: [] }).feeds || [],
    photos: parse('photos.json', {}),
    covers: parse('covers.json', {}),
  };
}

export async function writeGist(env, { feeds, photos, covers }) {
  const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      files: {
        'tankdata.json': { content: JSON.stringify({ feeds }) },
        'photos.json': { content: JSON.stringify(photos) },
        'covers.json': { content: JSON.stringify(covers) },
      },
    }),
  });
  if (!res.ok) throw new Error(`gist write failed: ${res.status}`);
}

export async function exchangeOAuthCode(env, code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`token exchange returned no access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function fetchGitHubUser(accessToken) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw new Error(`user fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Commit**

```bash
git add functions/_lib/github.js
git commit -m "Add GitHub Gist and OAuth helper functions"
git push
```

---

## OAuth endpoints (Phase E)

### Task E1: `GET /auth/login`

**Files:**
- Create: `functions/auth/login.js`

- [ ] **Step 1: Write `functions/auth/login.js`**

```js
import { signSession, setCookie } from '../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const state = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  const signedState = await signSession({ state, exp }, env.SESSION_SECRET);

  const redirectUri = new URL('/auth/callback', request.url).toString();
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
    allow_signup: 'false',
  });

  const headers = new Headers();
  headers.append('Set-Cookie', setCookie('__Host-oauth_state', signedState, { maxAge: 600 }));
  headers.set('Location', `https://github.com/login/oauth/authorize?${params}`);
  return new Response(null, { status: 302, headers });
}
```

- [ ] **Step 2: Commit and push**

```bash
git add functions/auth/login.js
git commit -m "Add /auth/login: redirect to GitHub OAuth with signed state"
git push
```

- [ ] **Step 3: Wait for deploy, then verify**

Wait for Cloudflare to deploy (watch the dashboard or the GitHub commit checks).

In a fresh browser tab (or `curl -I`):

```bash
curl -sI "https://friend-fish.pages.dev/auth/login"
```

Expected:
- Status: `HTTP/2 302`
- `Location:` header starts with `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=https%3A%2F%2Ffriend-fish.pages.dev%2Fauth%2Fcallback&scope=read%3Auser&state=...`
- `Set-Cookie:` header contains `__Host-oauth_state=...; HttpOnly; Secure`

If the redirect URL has an empty `client_id=`, the env var didn't propagate — retry the deployment after Task C2.

### Task E2: `GET /auth/callback`

**Files:**
- Create: `functions/auth/callback.js`

- [ ] **Step 1: Write `functions/auth/callback.js`**

```js
import { verifySession, signSession, parseCookies, setCookie, clearCookie, isAllowedLogin } from '../_lib/session.js';
import { exchangeOAuthCode, fetchGitHubUser } from '../_lib/github.js';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function errorHtml(msg, status) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>sign-in failed</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1rem;color:#222">` +
    `<h1 style="font-weight:400">sign-in failed</h1>` +
    `<p>${msg}</p>` +
    `<p><a href="/">back to friend.fish</a></p>` +
    `</body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return errorHtml('Missing code or state parameter.', 400);

  const cookies = parseCookies(request.headers.get('Cookie'));
  const stateCookie = cookies['__Host-oauth_state'];
  if (!stateCookie) return errorHtml('OAuth state cookie missing — please try signing in again.', 400);

  const verifiedState = await verifySession(stateCookie, env.SESSION_SECRET);
  if (!verifiedState || verifiedState.state !== state) {
    return errorHtml('OAuth state mismatch — please try signing in again.', 400);
  }

  let accessToken;
  try { accessToken = await exchangeOAuthCode(env, code); }
  catch (e) {
    console.error('oauth code exchange failed', e);
    return errorHtml("Couldn't exchange OAuth code with GitHub.", 502);
  }

  let user;
  try { user = await fetchGitHubUser(accessToken); }
  catch (e) {
    console.error('github user fetch failed', e);
    return errorHtml("Couldn't fetch your GitHub profile.", 502);
  }

  if (!isAllowedLogin(user.login, env)) {
    const allowed = (env.OWNER_GITHUB_LOGINS || '').split(',').map(s => s.trim()).filter(Boolean).join(', ');
    return errorHtml(
      `Your GitHub account (<b>${user.login}</b>) isn't on the allowlist. Allowed: <b>${allowed}</b>.`,
      403
    );
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const session = await signSession({ login: user.login, exp }, env.SESSION_SECRET);

  const headers = new Headers();
  headers.append('Set-Cookie', setCookie('__Host-session', session, { maxAge: SESSION_TTL_SECONDS }));
  headers.append('Set-Cookie', clearCookie('__Host-oauth_state'));
  headers.set('Location', '/');
  return new Response(null, { status: 302, headers });
}
```

- [ ] **Step 2: Commit and push**

```bash
git add functions/auth/callback.js
git commit -m "Add /auth/callback: exchange code, check allowlist, set session"
git push
```

- [ ] **Step 3: Wait for deploy, then sanity-check error paths**

These verify error handling without needing a real OAuth flow:

```bash
# Missing code/state -> 400
curl -si "https://friend-fish.pages.dev/auth/callback" | head -20
# Expected: HTTP/2 400, body contains "Missing code or state"

# Bad state without cookie -> 400
curl -si "https://friend-fish.pages.dev/auth/callback?code=x&state=y" | head -20
# Expected: HTTP/2 400, body contains "OAuth state cookie missing"
```

End-to-end OAuth verification happens in Task G (or via the alternative test-OAuth-App path).

### Task E3: `POST /auth/logout`

**Files:**
- Create: `functions/auth/logout.js`

- [ ] **Step 1: Write `functions/auth/logout.js`**

```js
import { clearCookie } from '../_lib/session.js';

export async function onRequestPost() {
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie('__Host-session'));
  return new Response(null, { status: 204, headers });
}
```

- [ ] **Step 2: Commit, push, and verify**

```bash
git add functions/auth/logout.js
git commit -m "Add /auth/logout: clear session cookie"
git push
```

After deploy:

```bash
curl -si -X POST "https://friend-fish.pages.dev/auth/logout" | head -10
```

Expected: `HTTP/2 204`, `Set-Cookie: __Host-session=; ...; Max-Age=0`.

### Task E4: `GET /api/me`

**Files:**
- Create: `functions/api/me.js`

- [ ] **Step 1: Write `functions/api/me.js`**

```js
import { verifySession, parseCookies, isAllowedLogin } from '../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verifySession(cookies['__Host-session'], env.SESSION_SECRET);
  if (!session || !isAllowedLogin(session.login, env)) {
    return new Response(null, { status: 401 });
  }
  return new Response(JSON.stringify({ login: session.login }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: Commit, push, and verify**

```bash
git add functions/api/me.js
git commit -m "Add /api/me: return current login or 401"
git push
```

After deploy:

```bash
curl -si "https://friend-fish.pages.dev/api/me" | head -10
```

Expected: `HTTP/2 401`, empty body. (No cookie → not logged in.)

---

## Data endpoint (Phase F)

### Task F1: `GET /api/data` and `POST /api/data`

**Files:**
- Create: `functions/api/data.js`

- [ ] **Step 1: Write `functions/api/data.js`**

```js
import { verifySession, parseCookies, isAllowedLogin } from '../_lib/session.js';
import { readGist, writeGist } from '../_lib/github.js';

export async function onRequestGet({ env }) {
  try {
    const data = await readGist(env);
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error('gist read failed', e);
    return new Response(JSON.stringify({ error: 'gist unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestPost({ request, env }) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verifySession(cookies['__Host-session'], env.SESSION_SECRET);
  if (!session) {
    return new Response(JSON.stringify({ error: 'not authenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!isAllowedLogin(session.login, env)) {
    return new Response(JSON.stringify({ error: 'not authorized' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const feeds = Array.isArray(body.feeds) ? body.feeds : [];
  const photos = (body.photos && typeof body.photos === 'object') ? body.photos : {};
  const covers = (body.covers && typeof body.covers === 'object') ? body.covers : {};

  try {
    await writeGist(env, { feeds, photos, covers });
    return new Response(null, { status: 204 });
  } catch (e) {
    console.error('gist write failed', e);
    return new Response(JSON.stringify({ error: 'gist write failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}
```

- [ ] **Step 2: Commit, push, and verify**

```bash
git add functions/api/data.js
git commit -m "Add /api/data: public GET, owner-only POST proxying gist"
git push
```

After deploy:

```bash
# Read should return real gist content
curl -s "https://friend-fish.pages.dev/api/data" | head -c 500
# Expected: JSON with feeds/photos/covers keys

# Write without auth should 401
curl -si -X POST "https://friend-fish.pages.dev/api/data" \
  -H 'Content-Type: application/json' \
  -d '{"feeds":[],"photos":{},"covers":{}}' | head -10
# Expected: HTTP/2 401
```

If the GET returns the same JSON shape your old code was producing (compare to current `https://api.github.com/gists/1793476b9117a2b123ff35c0170c5705` content), the gist proxy is wired correctly.

---

## Frontend rewrite (Phase G)

### Task G1: Rewrite the data layer and remove the old auth UI

**Files:**
- Modify: `index.html` (the data-layer block around lines 786–840, the auth modal HTML around the existing auth-backdrop block, and the lock-button handlers around lines 1238–1310)

This is one logical change touching one file, but it has several edits. Make them all in one commit so the site is never half-migrated.

- [ ] **Step 1: Replace the gist data layer**

Find the `// ---- GITHUB GIST DATA LAYER ----` block in `index.html` (starts near line 786, ends after `gistSave()`). Replace its `gistGet`, `gistSave`, and the constants/lets with:

```js
  // ---- DATA LAYER (proxied through Cloudflare Pages Functions) ----

  let feedEntries = [];
  let photoStore = {};
  let coverStore = {};

  async function gistGet() {
    try {
      const res = await fetch('/api/data');
      if (!res.ok) { console.error('data load failed', res.status); return; }
      const data = await res.json();
      feedEntries = Array.isArray(data.feeds) ? data.feeds : [];
      photoStore  = data.photos && typeof data.photos === 'object' ? data.photos : {};
      coverStore  = data.covers && typeof data.covers === 'object' ? data.covers : {};
    } catch (e) { console.error('data load error', e); }
  }

  async function gistSave() {
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ feeds: feedEntries, photos: photoStore, covers: coverStore }),
      });
      if (res.status === 401 || res.status === 403) {
        isOwner = false;
        sessionStorage.removeItem('tankOwner');
        applyOwnerState();
        alert('session expired — please sign in again');
      } else if (!res.ok) {
        alert("couldn't save");
      }
    } catch (e) {
      console.error('data save error', e);
      alert("couldn't save");
    }
  }
```

Keep the `photosSize()`, `PHOTO_LIMIT`, `PHOTO_WARN`, and `compressImage()` helpers (they live in this block in the existing file) untouched.

- [ ] **Step 2: Replace the owner-state bootstrap**

Find the line `let isOwner = sessionStorage.getItem('tankOwner') === '1';` (around line 1247) and replace with:

```js
  let isOwner = false;

  async function checkSession() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      isOwner = res.ok;
    } catch { isOwner = false; }
  }
```

- [ ] **Step 3: Replace the lock-button handler**

Find `handleLockClick()` (around line 1278) and replace with:

```js
  async function handleLockClick() {
    if (isOwner) {
      try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
      isOwner = false;
      applyOwnerState();
    } else {
      window.location.href = '/auth/login';
    }
  }
```

- [ ] **Step 4: Delete the auth modal and its handlers**

Remove these entirely from `index.html`:
- The `<div id="auth-backdrop">…</div>` HTML block (and any associated `auth-*` markup).
- The CSS rules for `.auth-backdrop`, `.auth-modal`, `.auth-title`, `.auth-hint`, `.auth-input`, `.auth-error`, `.auth-actions`, `.auth-cancel`, `.auth-submit` (they're styling for the modal that no longer exists).
- The `OWNER_HASH` constant.
- The `checkPassword()` function.
- The `closeAuth()` function.
- The `submitAuth()` function.
- Any keyboard `keydown` listener that submits the auth modal.

Use search for `auth-` and `OWNER_HASH` and `checkPassword` to find every reference.

- [ ] **Step 5: Wire `checkSession()` into init**

Find where `initData()` is called on page load. Change init so `checkSession()` runs before `applyOwnerState()`. Pattern:

```js
  async function initData() {
    await checkSession();
    await gistGet();
    applyOwnerState();
    renderEntries();
    ['puffer1','puffer2','otos','amanos'].forEach(id => restoreCover(id));
    capFeedingLogHeight();
  }
```

(If `initData` already exists with a different structure, just add `await checkSession();` as its first line and add `applyOwnerState();` after it. The existing `applyOwnerState()` call at the bottom of the page load handler can stay.)

- [ ] **Step 6: Verify locally (read-only)**

```bash
git status
# Should show: modified: index.html (and nothing else)

grep -n "ghp_\|OWNER_HASH\|checkPassword\|GITHUB_TOKEN" index.html
# Expected: no matches (all old auth/token references removed)

grep -n "api/data\|api/me\|auth/login\|auth/logout" index.html
# Expected: matches present for each
```

- [ ] **Step 7: Commit and push**

```bash
git add index.html
git commit -m "Rewrite data layer to use Pages Functions; remove in-page token and password"
git push
```

- [ ] **Step 8: Smoke test on `*.pages.dev`**

After deploy, open `https://friend-fish.pages.dev/` in a fresh browser session.

Verify:
1. Page renders with existing feed entries and photos. (Reads work.)
2. View source: search for `ghp_` and `OWNER_HASH` — both absent.
3. No edit UI is visible (you're not signed in).
4. Lock button shows the locked state (🔒).

The OAuth-flow test (clicking the lock button → signing in → editing) won't work yet on the `*.pages.dev` hostname because the OAuth App callback is registered for `friend.fish`. That's fine — that test happens after DNS cutover.

---

## Cutover (Phase H)

### Task H1: Cut DNS from GitHub Pages to Cloudflare Pages

This is the irreversible-feeling step. It's actually reversible (just flip DNS back), but it's user-visible.

- [ ] **Step 1: Confirm pre-flight**

- The `*.pages.dev` URL renders the site correctly with reads working.
- The OAuth App callback URL is `https://friend.fish/auth/callback`.
- All six Cloudflare env vars from Task C2 are present in **Production**.
- Pages project custom domain `friend.fish` is added (Task C1).

- [ ] **Step 2: Update DNS**

Wherever `friend.fish` DNS is managed (registrar or Cloudflare DNS, depending on what you set up earlier), follow the records Cloudflare showed you when you added the custom domain in Task C1. Typically this means changing the apex/`@` and `www` CNAMEs from `<github-username>.github.io` to `friend-fish.pages.dev` (or following whatever exact instructions the Pages dashboard provided).

If `friend.fish` was previously using GitHub Pages with apex A records pointing at GitHub's IPs (`185.199.108.153` etc.), replace those with the Cloudflare-provided records.

- [ ] **Step 3: Wait for propagation, then verify**

```bash
dig friend.fish +short
# Expected: resolves to Cloudflare-controlled IPs, not GitHub Pages IPs
```

In a browser:
- Open `https://friend.fish/api/health` — expected: `ok`
- Open `https://friend.fish/` — site renders

If DNS hasn't fully propagated, give it 5–15 minutes.

### Task H2: Verify the full OAuth flow

- [ ] **Step 1: Sign in as an allowed user**

Open `https://friend.fish/` in a fresh browser window. Click the lock button (🔒). You should be redirected to GitHub's consent screen. Approve. Land back on `https://friend.fish/`. Edit UI should now be visible.

- [ ] **Step 2: Confirm the session cookie**

In devtools → Application → Cookies → `https://friend.fish`. Expected: a `__Host-session` cookie with HttpOnly, Secure, SameSite=Lax.

- [ ] **Step 3: Add a feed entry, then reload**

Add a feeding log entry through the UI. Reload the page (Cmd+R / Ctrl+R). The entry should persist.

- [ ] **Step 4: Sign out**

Click the lock button (now 🔓). Edit UI disappears. The `__Host-session` cookie is gone.

- [ ] **Step 5: Attempt a write without auth (should fail)**

In devtools console on `https://friend.fish/` while signed out:

```js
fetch('/api/data', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status)
```

Expected: `401`.

- [ ] **Step 6: Sign in as a non-allowlist user**

If you have access to a third GitHub account, sign in from a private browser window. Expected: the 403 error page naming the allowlist. No session cookie set.

### Task H3: Disable GitHub Pages and remove `CNAME`

- [ ] **Step 1: Turn off GitHub Pages**

Go to https://github.com/elwang1128/friend.fish → **Settings** → **Pages** → set **Source** to **None**.

- [ ] **Step 2: Delete the `CNAME` file**

```bash
git rm CNAME
git commit -m "Remove CNAME (GitHub Pages no longer serves this site)"
git push
```

- [ ] **Step 3: Final verification**

Open `https://friend.fish/` once more. Page renders. Sign in still works. View source: search for `ghp_` → absent.

---

## Self-review notes

**Spec coverage:**
- ✓ GitHub PAT no longer in browser (Tasks B–F + G1).
- ✓ Three Pages Function endpoints for data (`/api/data` GET/POST, `/api/me`).
- ✓ Three Pages Function endpoints for auth (`/auth/login`, `/auth/callback`, `/auth/logout`).
- ✓ OAuth allowlist enforced (callback.js + me.js + data.js POST all call `isAllowedLogin`).
- ✓ Signed cookie sessions (no KV).
- ✓ Frontend data layer rewritten.
- ✓ Frontend password modal removed.
- ✓ Migration sequence including revoke-leaked-PAT-first.
- ✓ Smoke test plan from spec executed in Task H2.
- ✓ Rollback path (DNS flip back + restore old `index.html`).

**Placeholder scan:** No TODO/TBD/"add error handling"-style fillers; every code step contains full code.

**Type/name consistency:** Cookie names (`__Host-session`, `__Host-oauth_state`), env var names, and exported helper names (`signSession`, `verifySession`, `parseCookies`, `setCookie`, `clearCookie`, `isAllowedLogin`, `readGist`, `writeGist`, `exchangeOAuthCode`, `fetchGitHubUser`) are consistent across all files that reference them.

**One nuance preserved across tasks:** the OAuth `redirect_uri` is computed from `request.url`, so on `*.pages.dev` it won't match the OAuth App's registered callback. This is why end-to-end OAuth testing is deferred to Task H2 (post-cutover). If the implementer wants pre-cutover OAuth testing, they should create a second OAuth App for the `*.pages.dev` URL and override `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` for the preview environment before Task E1.
