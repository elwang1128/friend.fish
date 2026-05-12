import { handleLogin } from './handlers/auth/login.js';
import { handleCallback } from './handlers/auth/callback.js';
import { handleLogout } from './handlers/auth/logout.js';
import { handleMe } from './handlers/api/me.js';

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === '/api/health' && method === 'GET') {
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (url.pathname === '/api/me' && method === 'GET') {
      return handleMe(request, env);
    }

    if (url.pathname === '/auth/login' && method === 'GET') {
      return handleLogin(request, env);
    }

    if (url.pathname === '/auth/callback' && method === 'GET') {
      return handleCallback(request, env);
    }

    if (url.pathname === '/auth/logout' && method === 'POST') {
      return handleLogout();
    }

    return env.ASSETS.fetch(request);
  },
};
