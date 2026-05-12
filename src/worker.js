import { handleLogin } from './handlers/auth/login.js';
import { handleCallback } from './handlers/auth/callback.js';
import { handleLogout } from './handlers/auth/logout.js';
import { handleMe } from './handlers/api/me.js';
import { handleDataGet, handleDataPost } from './handlers/api/data.js';

const routes = {
  'GET /api/health':    () => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }),
  'GET /api/me':        handleMe,
  'GET /api/data':      handleDataGet,
  'POST /api/data':     handleDataPost,
  'GET /auth/login':    handleLogin,
  'GET /auth/callback': handleCallback,
  'POST /auth/logout':  handleLogout,
};

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (handler) return handler(request, env);
    return env.ASSETS.fetch(request);
  }
};
