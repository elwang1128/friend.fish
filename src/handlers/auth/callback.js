import { signSession, verifySession, parseCookies, setCookie, clearCookie, isAllowedLogin } from '../../lib/session.js';
import { exchangeOAuthCode, fetchGitHubUser } from '../../lib/github.js';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function errorHtml(message, status) {
  const body =
    '<!doctype html><meta charset="utf-8"><title>sign-in failed</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:4rem auto;padding:0 1rem;color:#222">' +
    '<h1 style="font-weight:400">sign-in failed</h1>' +
    `<p>${message}</p>` +
    '<p><a href="/">back to friend.fish</a></p>' +
    '</body>';
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return errorHtml('Missing code or state parameter.', 400);

  const cookies = parseCookies(request.headers.get('Cookie'));
  const stateCookie = cookies['__Host-oauth_state'];
  if (!stateCookie) {
    return errorHtml('OAuth state cookie missing — please try signing in again.', 400);
  }

  const verifiedState = await verifySession(stateCookie, env.SESSION_SECRET);
  if (!verifiedState || verifiedState.state !== state) {
    return errorHtml('OAuth state mismatch — please try signing in again.', 400);
  }

  let accessToken;
  try {
    accessToken = await exchangeOAuthCode(env, code);
  } catch (e) {
    return errorHtml(`Couldn't exchange OAuth code with GitHub: ${escapeHtml(e.message)}`, 502);
  }

  let user;
  try {
    user = await fetchGitHubUser(accessToken);
  } catch {
    return errorHtml("Couldn't fetch your GitHub profile.", 502);
  }

  if (!isAllowedLogin(user.login, env)) {
    const allowed = (env.OWNER_GITHUB_LOGINS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(escapeHtml)
      .join(', ');
    return errorHtml(
      `Your GitHub account (<b>${escapeHtml(user.login)}</b>) isn't on the allowlist. Allowed: <b>${allowed}</b>.`,
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
