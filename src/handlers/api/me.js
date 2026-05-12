import { verifySession, parseCookies, isAllowedLogin } from '../../lib/session.js';

export async function handleMe(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verifySession(cookies['__Host-session'], env.SESSION_SECRET);
  if (!session || !isAllowedLogin(session.login, env)) {
    return new Response(null, { status: 401 });
  }
  return new Response(JSON.stringify({ login: session.login }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
