const UA = 'friend.fish';

function githubError(label, status) {
  const e = new Error(`${label}: ${status}`);
  e.status = status;
  return e;
}

export async function readGist(env) {
  const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': UA,
    },
  });
  if (!res.ok) throw githubError('gist read failed', res.status);
  const data = await res.json();
  const files = data.files || {};

  // When the gist's total content is large, GitHub flags individual files as
  // truncated and leaves their `content` empty — even tiny files. Fall back to
  // the raw URL in that case so we never silently load empty data.
  const readFile = async (name) => {
    const file = files[name];
    if (!file) return null;
    if (!file.truncated && typeof file.content === 'string') return file.content;
    if (!file.raw_url) return null;
    const rawRes = await fetch(file.raw_url, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_GIST_TOKEN}`,
        'User-Agent': UA,
      },
    });
    if (!rawRes.ok) throw githubError(`raw read failed for ${name}`, rawRes.status);
    return await rawRes.text();
  };

  const parse = (content, fallback) => {
    if (content == null) return fallback;
    try { return JSON.parse(content); }
    catch { return fallback; }
  };

  const [tankdata, photos, covers, guestbook] = await Promise.all([
    readFile('tankdata.json'),
    readFile('photos.json'),
    readFile('covers.json'),
    readFile('guestbook.json'),
  ]);

  return {
    feeds: parse(tankdata, { feeds: [] }).feeds || [],
    photos: parse(photos, {}),
    covers: parse(covers, {}),
    guestbook: parse(guestbook, []),
  };
}

// Writes only the fields that are provided, so e.g. a guestbook write can
// never clobber photos and vice versa.
export async function writeGist(env, { feeds, photos, covers, guestbook }) {
  const files = {};
  if (feeds !== undefined) files['tankdata.json'] = { content: JSON.stringify({ feeds }) };
  if (photos !== undefined) files['photos.json'] = { content: JSON.stringify(photos) };
  if (covers !== undefined) files['covers.json'] = { content: JSON.stringify(covers) };
  if (guestbook !== undefined) files['guestbook.json'] = { content: JSON.stringify(guestbook) };
  if (!Object.keys(files).length) return;

  const res = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_GIST_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw githubError('gist write failed', res.status);
}
