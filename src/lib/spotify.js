'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db/index');
const { createClient } = require('../providers/spotify');
const { createService, validId } = require('./spotify_service');

function createRouter(database, client, service) {
  const router = express.Router();
  const pending = new Map();
  const cookieName = 'navilist_spotify_state';
  const cookieOptions = c => ({ httpOnly: true, secure: c.secure, sameSite: 'lax', path: '/spotify', maxAge: 600000 });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST') return next();
    try {
      // Bootstrap configuration and disconnect/recovery must be possible before
      // config() is valid (including after losing the encryption key).
      // Require the browser's origin to match the current host; never trust a
      // callback URL supplied in the request body as the CSRF boundary.
      if (req.path === '/api/config' || req.path === '/disconnect') {
        const origin = new URL(req.get('origin') || '');
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.get('host') ||
            (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin'))
          return res.status(403).json({ ok: false, error: 'Same-origin request required' });
        return next();
      }
      if (req.get('origin') !== client.config().origin) return res.status(403).json({ ok: false, error: 'Same-origin request required' });
      next();
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  };
  router.get('/', (req, res) => res.redirect('/playlists?spotify=1'));
  router.get('/api/config', route(async (req, res) => res.json({ ok: true, settings: client.settings() })));
  router.post('/api/config', route(async (req, res) => {
    const settings = await service.exclusive(() => client.configure(req.body));
    pending.clear();
    res.json({ ok: true, settings });
  }));
  router.get('/api/status', (req, res) => {
    let configError = null;
    try { client.config(); } catch (e) { configError = e.message; }
    res.json({ ok: true, configured: !configError, configError, userId: client.account()?.user_id || null,
      playlists: database.prepare('SELECT spotify_id, title, enabled, navidrome_id, last_checked_at, last_synced_at, error FROM spotify_playlists').all() });
  });
  router.post('/connect', route(async (req, res) => {
    const c = client.config();
    for (const [state, entry] of pending) if (entry.expires < Date.now()) pending.delete(state);
    if (pending.size >= 100) throw new Error('Too many pending connections; retry in ten minutes');
    const state = crypto.randomBytes(32).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    pending.set(state, { verifier, expires: Date.now() + 600000 });
    res.cookie(cookieName, state, cookieOptions(c));
    const params = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.redirectUri,
      scope: 'playlist-read-private playlist-read-collaborative', state,
      code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
    res.redirect(303, `https://accounts.spotify.com/authorize?${params}`);
  }));
  router.get('/callback', async (req, res) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const entry = pending.get(state);
      if (!entry || cookie !== state || entry.expires < Date.now()) throw new Error('Invalid or expired authorization; try connecting again');
      pending.delete(state);
      res.clearCookie(cookieName, { ...cookieOptions(client.config()), maxAge: undefined });
      if (req.query.error) throw new Error('Spotify authorization was declined');
      if (typeof req.query.code !== 'string') throw new Error('Missing authorization code');
      await service.exclusive(() => client.connect(req.query.code, entry.verifier));
      res.redirect(303, '/playlists?spotify=1&connected=1');
    } catch (_) {
      // Do not echo authorization codes, states, provider responses or tokens.
      res.redirect(303, '/playlists?spotify=1&connection_failed=1');
    }
  });
  router.post('/disconnect', route(async (req, res) => {
    await service.exclusive(() => database.transaction(() => {
      database.prepare('DELETE FROM spotify_account').run();
      database.prepare('DELETE FROM spotify_matches').run();
      database.prepare('DELETE FROM spotify_playlists').run();
      pending.clear();
    })());
    res.json({ ok: true });
  }));
  router.get('/api/playlists', route(async (req, res) => {
    const playlists = await service.exclusive(async () => {
      const userId = client.account()?.user_id;
      if (!userId) throw new Error('Connect Spotify first');
      return (await client.pages('/me/playlists')).filter(Boolean).map(p => ({ id: p.id, name: p.name,
        owned: p.owner?.id === userId }));
    });
    res.json({ ok: true, playlists });
  }));
  router.param('id', (req, res, next, id) => {
    if (!validId(id)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });
    next();
  });
  router.post('/api/playlists/:id/preview', route(async (req, res) => res.json({ ok: true, playlist: await service.preview(req.params.id) })));
  router.post('/api/playlists/:id/subscribe', route(async (req, res) => res.json({ ok: true, playlist: await service.subscribe(req.params.id) })));
  router.post('/api/playlists/:id/sync', route(async (req, res) => res.json({ ok: true, playlist: await service.sync(req.params.id) })));
  router.post('/api/playlists/:id/stop', route(async (req, res) => {
    await service.stop(req.params.id);
    res.json({ ok: true });
  }));
  router.post('/api/playlists/:id/match', route(async (req, res) => res.json({ ok: true,
    update: await service.saveMatch(req.params.id, req.body.spotify_id, req.body.track_id) })));
  return router;
}

const client = createClient(db);
const service = createService(db, client);
module.exports = { router: createRouter(db, client, service), service, createRouter };
