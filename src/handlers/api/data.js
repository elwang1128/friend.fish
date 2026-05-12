import { verifySession, parseCookies, isAllowedLogin } from '../../lib/session.js';
import { readGist, writeGist } from '../../lib/github.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function handleDataGet(_request, env) {
  try {
    const data = await readGist(env);
    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', ...NO_STORE },
    });
  } catch (e) {
    console.error('gist read failed', e);
    return new Response(JSON.stringify({ error: 'gist unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...NO_STORE },
    });
  }
}

export async function handleDataPost(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const session = await verifySession(cookies['__Host-session'], env.SESSION_SECRET);
  if (!session) {
    return jsonError(401, 'not authenticated');
  }
  if (!isAllowedLogin(session.login, env)) {
    return jsonError(403, 'not authorized');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid JSON');
  }
  if (!body || typeof body !== 'object') {
    return jsonError(400, 'invalid body shape');
  }

  const feeds = Array.isArray(body.feeds) ? body.feeds : [];
  const photos = (body.photos && typeof body.photos === 'object' && !Array.isArray(body.photos)) ? body.photos : {};
  const covers = (body.covers && typeof body.covers === 'object' && !Array.isArray(body.covers)) ? body.covers : {};

  try {
    await writeGist(env, { feeds, photos, covers });
    return new Response(null, { status: 204, headers: NO_STORE });
  } catch (e) {
    console.error('gist write failed', e);
    return jsonError(502, 'gist write failed');
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
