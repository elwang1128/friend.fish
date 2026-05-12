import { clearCookie } from '../../lib/session.js';

export async function handleLogout() {
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie('__Host-session'));
  return new Response(null, { status: 204, headers });
}
