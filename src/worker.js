import { handleLogin } from './handlers/auth/login.js';

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/api/health' && method === 'GET') {
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (url.pathname === '/auth/login' && method === 'GET') {
      return handleLogin(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
