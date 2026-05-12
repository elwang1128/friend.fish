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
  if (!data.access_token) throw new Error(`token exchange returned no access_token`);
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
