import { verifySession, parseCookies, isAllowedLogin } from '../../lib/session.js';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store',
  'Vary': 'Cookie',
};

export async function handleMe(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verifySession(cookies['__Host-session'], env.SESSION_SECRET);
  if (!session || !isAllowedLogin(session.login, env)) {
    return new Response(null, { status: 401, headers: NO_CACHE_HEADERS });
  }
  return new Response(JSON.stringify({ login: session.login }), {
    headers: {
      'Content-Type': 'application/json',
      ...NO_CACHE_HEADERS,
    },
  });
}
