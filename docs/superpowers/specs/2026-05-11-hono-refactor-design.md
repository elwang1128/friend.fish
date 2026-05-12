# Hono refactor — design

**Date:** 2026-05-11
**Status:** Approved (pending user review of this written spec)
**Topic:** Replace the hand-rolled session crypto, cookie helpers, and GitHub OAuth flow with the `hono` framework and `@hono/oauth-providers/github`. Add a Nix flake + direnv for the dev environment. Goal: reduce code we maintain and shrink the security-critical surface to two narrow checks.

---

## Background

The Cloudflare migration (spec `2026-05-11-cloudflare-migration-and-oauth-design.md`) shipped a working but hand-rolled Worker:

- `src/lib/session.js` (~97 lines) — base64url encode/decode, HMAC-SHA256 sign/verify (a custom JWT-like format), cookie parser/serializer, allowlist matcher, secret-length guard.
- `src/lib/github.js` (~75 lines) — `readGist`, `writeGist`, plus OAuth-specific helpers `exchangeOAuthCode` and `fetchGitHubUser`.
- `src/handlers/auth/{login,callback,logout}.js` and `src/handlers/api/{me,data,health-inline}` — six handler files, each a thin wrapper around the helpers, plus a small dispatch table in `src/worker.js`.

The hand-rolled crypto-shaped code (~50 lines of base64url + HMAC + token format + `exp` check) is exactly where standard libraries pay off: subtle bugs in constant-time compare, base64url normalization, or expiry checks would be hard to spot in review. The OAuth flow code is small but mechanically identical to what a library would generate.

## Goals

1. Replace the custom JWT-like token format with `hono/jwt` (which uses Web Crypto under the hood, but the format and constant-time verify are library-provided).
2. Replace `parseCookies` / `setCookie` / `clearCookie` with `hono/cookie`.
3. Replace `exchangeOAuthCode` + `fetchGitHubUser` + the manual state-cookie handling with `@hono/oauth-providers/github`.
4. Replace the dispatch-table router in `src/worker.js` with Hono's routing.
5. Add a Nix flake + direnv so the dev shell is reproducible.
6. Preserve all current behavior end-to-end (same endpoints, same response shapes, same frontend, same wrangler config).

## Non-goals

- **No new endpoints, no new features.**
- **No frontend rewrite.** `public/index.html` changes one URL only (`/auth/login` → `/auth/github`).
- **No additional auth libraries beyond Hono.** No `jose`, no `arctic`, no `better-auth`.
- **No build tooling beyond what `wrangler` already does** (its built-in esbuild).
- **No TypeScript migration.** Plain `.js` with ESM.
- **No package manager other than npm.** The flake provides only Node.

## Architecture (after)

Single Hono app handles all routes inline.

```
Browser ──► friend.fish (Cloudflare Worker)
  │
  ├─ GET  /api/health   ──► c.text('ok')
  ├─ GET  /api/me       ──► getSession → c.json({login}) | 401
  ├─ GET  /api/data     ──► readGist → c.json(data)
  ├─ POST /api/data     ──► getSession + isAllowed → validate body → writeGist → 204
  ├─ ALL  /auth/github  ──► githubAuth middleware → handler mints session + redirects
  ├─ POST /auth/logout  ──► deleteCookie → 204
  └─ *                  ──► env.ASSETS.fetch(c.req.raw)
```

Static assets are still served by the Cloudflare ASSETS binding; the Hono catch-all simply delegates.

### Final file structure

```
/
├── flake.nix                 (new)
├── flake.lock                (new, committed)
├── .envrc                    (new: `use flake`)
├── package.json              (new)
├── package-lock.json         (new, committed)
├── wrangler.jsonc            (unchanged)
├── .gitignore                (add: node_modules/, .direnv/)
├── public/
│   └── index.html            (one-line change: /auth/login → /auth/github)
└── src/
    ├── worker.js             (rewritten as Hono app, ~80–90 lines)
    └── lib/
        └── github.js         (~45 lines: readGist + writeGist only)
```

**Deleted:**
- `src/lib/session.js`
- `src/handlers/auth/login.js`
- `src/handlers/auth/callback.js`
- `src/handlers/auth/logout.js`
- `src/handlers/api/me.js`
- `src/handlers/api/data.js`

Net: ~290 lines deleted, ~130 added, plus the flake/package.json scaffolding.

## Libraries

| Library | Approx. minified+gzipped | What it provides |
|---|---|---|
| `hono` | ~12 KB | Routing, request context, `getCookie`/`setCookie`/`deleteCookie`, `sign`/`verify` from `hono/jwt` |
| `@hono/oauth-providers` | ~5 KB (GitHub provider only) | `githubAuth` middleware: redirect to GitHub, code exchange, `/user` fetch — all under one route |

No other runtime deps. `wrangler` stays as the dev/deploy tool.

## Endpoint behavior

Endpoints retain identical response semantics from the prior migration; only the implementation moves.

### `GET /api/health`
```js
app.get('/api/health', c => c.text('ok'));
```
200, body `ok`, `text/plain; charset=utf-8`.

### `GET /api/me`
```js
app.get('/api/me', async c => {
  const s = await getSession(c);
  if (!s || !isAllowed(s.login, c.env)) {
    return c.body(null, 401, NO_CACHE);
  }
  return c.json({ login: s.login }, 200, NO_CACHE);
});
```
- 200 `{login}` with `Cache-Control: no-store` and `Vary: Cookie` when signed in and allowlisted.
- 401 with the same cache headers otherwise.

### `GET /api/data`
```js
app.get('/api/data', async c =>
  c.json(await readGist(c.env), 200, NO_CACHE)
);
```
- 200 `{feeds, photos, covers}` with `no-store`.
- Failure: throw bubbles to Hono's default 500. The frontend already treats any non-401/403 5xx as "couldn't save."

### `POST /api/data`
```js
app.post('/api/data', async c => {
  const s = await getSession(c);
  if (!s) return c.json({ error: 'not authenticated' }, 401, NO_CACHE);
  if (!isAllowed(s.login, c.env)) return c.json({ error: 'not authorized' }, 403, NO_CACHE);
  const body = await c.req.json();
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body shape' }, 400, NO_CACHE);
  const feeds = Array.isArray(body.feeds) ? body.feeds : [];
  const photos = (body.photos && typeof body.photos === 'object' && !Array.isArray(body.photos)) ? body.photos : {};
  const covers = (body.covers && typeof body.covers === 'object' && !Array.isArray(body.covers)) ? body.covers : {};
  await writeGist(c.env, { feeds, photos, covers });
  return c.body(null, 204, NO_CACHE);
});
```
- 401/403: JSON, no cookie touched.
- 400 only on the narrow "body isn't even an object" case. Malformed JSON bubbles to a 500 (frontend shows "couldn't save", same as today).
- `writeGist` throw → 500 (same UX as 502 from the frontend's perspective).

### `ALL /auth/github`

Middleware-driven. `githubAuth` does both legs of the OAuth flow:

```js
app.use('/auth/github', (c, next) =>
  githubAuth({
    client_id: c.env.GITHUB_OAUTH_CLIENT_ID,
    client_secret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
    scope: ['read:user'],
    oauthApp: true,
  })(c, next)
);

app.get('/auth/github', async c => {
  const user = c.get('user-github');
  if (!user || !isAllowed(user.login, c.env)) {
    return c.html(notAuthorizedHtml(user?.login, c.env), 403);
  }
  const secret = c.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('SESSION_SECRET missing or too short');
  }
  const token = await sign(
    { login: user.login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL },
    secret
  );
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
  return c.redirect('/');
});
```

- The middleware manages its own state cookie internally (the previous custom `__Host-oauth_state` is gone).
- Allowlist failure: 403 friendly HTML, login name HTML-escaped, no session cookie issued.
- The `SESSION_SECRET` guard runs before `sign` so an unset secret produces a loud 500 on the first login attempt instead of a silent forgeable cookie (`hono/jwt` will encode `undefined` as the literal string `"undefined"` otherwise — same vulnerability we hardened against in the prior migration).

### `POST /auth/logout`
```js
app.post('/auth/logout', c => {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure: true });
  return c.body(null, 204);
});
```
204, no body, cookie cleared.

### Catch-all (static assets)
```js
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
```
Anything not matched falls through to the static asset binding, exactly as today.

## `getSession` and the security-critical narrow surface

The only two security-critical checks in the new code are concentrated in `getSession` (verify path) and the mint path. Both validate `SESSION_SECRET` before invoking `hono/jwt`.

```js
const COOKIE_NAME = '__Host-session';
const SESSION_TTL = 30 * 24 * 60 * 60;
const NO_CACHE = { 'Cache-Control': 'no-store', 'Vary': 'Cookie' };

async function getSession(c) {
  const secret = c.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) return null;
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  try { return await verify(token, secret); }
  catch { return null; }
}

function isAllowed(login, env) {
  if (typeof login !== 'string' || !login) return false;
  const needle = login.toLowerCase();
  return (env.OWNER_GITHUB_LOGINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .includes(needle);
}
```

Every other error path lets Hono throw → default 500. The frontend treats 500 as "couldn't save" (same as it treats today's 502), so the UX is unchanged.

## Auth flow change

| | Before | After |
|---|---|---|
| Sign-in entry route | `GET /auth/login` | `GET /auth/github` |
| OAuth callback route | `GET /auth/callback` | (same single route) `GET /auth/github` |
| Frontend `handleLockClick` redirect | `window.location.href = '/auth/login'` | `window.location.href = '/auth/github'` |
| GitHub OAuth App callback URL | `https://friend.fish/auth/callback` | `https://friend.fish/auth/github` |
| State/CSRF cookie | custom `__Host-oauth_state` | managed by `@hono/oauth-providers` |
| Session cookie | `__Host-session` (custom HMAC) | `__Host-session` (standard JWT) |

The session cookie name doesn't change, but the cookie's value format becomes a real JWT. Any cookies issued by the old Worker will fail verification under the new one — users will need to sign in again once. That's a one-time inconvenience for two users.

## Dev environment (Nix flake + direnv)

**`flake.nix`** — provides only Node 22 LTS:

```nix
{
  description = "friend.fish dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShells.default = nixpkgs.legacyPackages.${system}.mkShell {
        packages = [ nixpkgs.legacyPackages.${system}.nodejs_22 ];
      };
    });
}
```

Rationale for keeping it minimal: project tooling (`wrangler`) belongs in `package.json` so the version is pinned next to its consumers. Adding it to the flake too would create two pin points to keep in sync.

**`.envrc`:** single line `use flake`. After cloning, `direnv allow` once.

**`package.json`** (shape — actual deps versions resolved at install):

```json
{
  "name": "friend-fish",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4",
    "@hono/oauth-providers": "^0"
  },
  "devDependencies": {
    "wrangler": "^3"
  }
}
```

`package-lock.json` committed so reproducible installs work without further flake plumbing.

**`.gitignore`** additions:
```
node_modules/
.direnv/
```

(The existing `.gitignore` already excludes `.wrangler/`, `.dev.vars*`, `.env*`.)

## Migration approach

Single PR, big-bang on a feature branch. The current backend is small (~290 lines being replaced); a piecewise refactor would require both implementations running in parallel, which adds complexity and risk without benefit.

Ordered steps:
1. Add `flake.nix`, `flake.lock`, `.envrc`, `package.json`, `package-lock.json`, `.gitignore` entries. Verify shell + `npm install` work in CI / local.
2. Rewrite `src/worker.js` as the Hono app.
3. Reduce `src/lib/github.js` to `readGist` + `writeGist`.
4. Delete the six obsolete files (`src/lib/session.js`, `src/handlers/auth/{login,callback,logout}.js`, `src/handlers/api/{me,data}.js`).
5. Update `public/index.html` (one URL change).
6. Update the GitHub OAuth App's callback URL in the GitHub dashboard from `/auth/callback` to `/auth/github`.

Steps 1–5 are one PR. Step 6 is operator work, done immediately before merge (so the callback URL is correct when the new code goes live).

## Testing

Same approach as the prior migration: no unit tests, manual smoke test after deploy.

**Smoke plan:**
1. Logged out: `/` renders, no edit UI, `view-source` has no `ghp_`, no JWT.
2. Click sign-in → GitHub consent → land at `/`, edit UI present, `__Host-session` cookie present in devtools, value is a JWT (three base64url segments separated by dots).
3. `GET /api/me` while signed in → `{login: "..."}`.
4. Add a feed entry → reload → entry persists.
5. Sign out → owner UI gone, `__Host-session` cookie cleared, `GET /api/me` returns 401.
6. Sign in as a third (non-allowlisted) GitHub user → 403 page naming the allowlist, no cookie.
7. `curl -s friend.fish/api/data` (no cookie) → returns the gist JSON publicly (read path).
8. `curl -s -X POST friend.fish/api/data -H 'content-type: application/json' -d '{}'` (no cookie) → 401 JSON.

If any step fails, restore from `git revert` of the PR's merge commit.

## Risks and rollback

- **Hono OAuth provider state-cookie quirks**: the middleware sets its own state cookie. If the GitHub OAuth App's callback URL is set to a path the middleware doesn't recognize, the dance breaks. Mitigation: confirm the OAuth App URL update (step 6) immediately before merge; smoke-test the full flow before declaring success.
- **JWT secret length validation in `hono/jwt`**: unverified at the time of writing whether the library rejects short secrets. The inline guards in `getSession` and the mint path defend regardless.
- **One-time forced re-login** for the two allowlisted users (old cookies don't verify under JWT). Acceptable for two users; no announcement needed.
- **Rollback**: `git revert <merge-commit>` restores the prior Worker; the GitHub OAuth App's callback URL would need to be reverted to `/auth/callback` simultaneously. The gist contents are untouched throughout — same data store, same shape.

## Open questions

None — design is ready to implement.
