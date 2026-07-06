import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { githubAuth } from '@hono/oauth-providers/github';
import { readGist, writeGist } from './lib/github.js';

const COOKIE_NAME = '__Host-session';
const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days
const NO_CACHE = { 'Cache-Control': 'no-store', 'Vary': 'Cookie' };

function isAllowed(login, env) {
  if (typeof login !== 'string' || !login) return false;
  const needle = login.toLowerCase();
  return (env.OWNER_GITHUB_LOGINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .includes(needle);
}

async function getSession(c) {
  const secret = c.env.SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) return null;
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;
  try { return await verify(token, secret, 'HS256'); }
  catch { return null; }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notAuthorizedHtml(login, env) {
  const allowed = (env.OWNER_GITHUB_LOGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(escapeHtml).join(', ');
  return '<!doctype html><meta charset="utf-8"><title>not authorized</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1rem;color:#222">' +
    '<h1 style="font-weight:400">not authorized</h1>' +
    `<p>Your GitHub account (<b>${escapeHtml(login || '?')}</b>) isn't on the allowlist. Allowed: <b>${allowed}</b>.</p>` +
    '<p><a href="/">back to friend.fish</a></p>' +
    '</body>';
}

const app = new Hono();

app.get('/api/health', c => c.text('ok'));

app.get('/api/me', async c => {
  const s = await getSession(c);
  if (!s || !isAllowed(s.login, c.env)) {
    return c.body(null, 401, NO_CACHE);
  }
  return c.json({ login: s.login }, 200, NO_CACHE);
});

app.get('/api/data', async c =>
  c.json(await readGist(c.env), 200, NO_CACHE)
);

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

const GUESTBOOK_MAX_NAME = 40;
const GUESTBOOK_MAX_MESSAGE = 280;
const GUESTBOOK_MAX_ENTRIES = 500;

app.post('/api/guestbook', async c => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid body' }, 400, NO_CACHE); }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!name || !message) return c.json({ error: 'name and message required' }, 400, NO_CACHE);
  if (name.length > GUESTBOOK_MAX_NAME || message.length > GUESTBOOK_MAX_MESSAGE) {
    return c.json({ error: 'too long' }, 400, NO_CACHE);
  }
  const data = await readGist(c.env);
  const entry = { id: crypto.randomUUID(), name, message, ts: Date.now() };
  const guestbook = [...(Array.isArray(data.guestbook) ? data.guestbook : []), entry]
    .slice(-GUESTBOOK_MAX_ENTRIES);
  await writeGist(c.env, { guestbook });
  return c.json(entry, 201, NO_CACHE);
});

app.delete('/api/guestbook/:id', async c => {
  const s = await getSession(c);
  if (!s) return c.json({ error: 'not authenticated' }, 401, NO_CACHE);
  if (!isAllowed(s.login, c.env)) return c.json({ error: 'not authorized' }, 403, NO_CACHE);
  const id = c.req.param('id');
  const data = await readGist(c.env);
  const before = Array.isArray(data.guestbook) ? data.guestbook : [];
  const guestbook = before.filter(e => e.id !== id);
  if (guestbook.length !== before.length) await writeGist(c.env, { guestbook });
  return c.body(null, 204, NO_CACHE);
});

app.use('/auth/callback', (c, next) =>
  githubAuth({
    client_id: c.env.GITHUB_OAUTH_CLIENT_ID,
    client_secret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
    scope: ['read:user', 'user:email'],
    oauthApp: true,
  })(c, next)
);

app.get('/auth/callback', async c => {
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

app.post('/auth/logout', c => {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure: true });
  return c.body(null, 204);
});

app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default app;
