import { signSession, setCookie } from '../../lib/session.js';

const STATE_TTL_SECONDS = 600; // 10 minutes

export async function handleLogin(request, env) {
  const state = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
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
  // __Host-oauth_state requires Secure: cookies are dropped on http://localhost.
  // Test on the deployed *.workers.dev URL or use `wrangler dev --local-protocol=https`.
  headers.append('Set-Cookie', setCookie('__Host-oauth_state', signedState, { maxAge: STATE_TTL_SECONDS }));
  headers.set('Location', `https://github.com/login/oauth/authorize?${params}`);
  return new Response(null, { status: 302, headers });
}
