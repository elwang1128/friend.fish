// Session token format: base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(base64url(JSON(payload))))

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
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
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
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
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
  if (typeof login !== 'string' || !login) return false;
  const needle = login.toLowerCase();
  const allowed = (env.OWNER_GITHUB_LOGINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(needle);
}
