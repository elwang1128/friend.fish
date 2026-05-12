export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
