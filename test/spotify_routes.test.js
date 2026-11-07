'use strict';

process.env.DB_PATH = ':memory:';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createRouter } = require('../src/lib/spotify');
const db = require('../src/db/index');
after(() => db.close());

test('HTTP routes protect mutations, bind OAuth state to browser and never return credentials', async t => {
  const account = { user_id: 'user', tokens: 'must-never-leak' };
  const client = { config: () => ({ clientId: 'client', redirectUri: 'http://127.0.0.1/spotify/callback', origin: 'http://127.0.0.1', secure: false }),
    account: () => account, connect: async () => { client.connected = true; },
    pages: async () => [{ id: 'a'.repeat(22), name: 'Release Radar', owner: { id: 'spotify' } }] };
  const service = { exclusive: fn => Promise.resolve().then(fn), stop: async () => {} };
  const app = express(); app.use(express.json()); app.use('/spotify', createRouter(db, client, service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/spotify`;
  const status = await fetch(`${base}/api/status`);
  assert.ok(!(await status.text()).includes('must-never-leak'));
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const listed = await (await fetch(`${base}/api/playlists`)).json();
  assert.equal(listed.playlists[0].owned, false);
  assert.equal(listed.playlists[0].name, 'Release Radar');
  assert.equal(listed.playlists[0].reason, undefined);
  const bad = await fetch(`${base}/connect`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  const start = await fetch(`${base}/connect`, { method: 'POST', headers: { Origin: 'http://127.0.0.1' }, redirect: 'manual' });
  assert.equal(start.status, 303);
  const target = new URL(start.headers.get('location'));
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('scope'), 'playlist-read-private playlist-read-collaborative');
  const state = target.searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const wrong = await fetch(`${base}/callback?state=${state}&code=secret-code`, { redirect: 'manual' });
  assert.equal(wrong.headers.get('location'), '/playlists?spotify=1&connection_failed=1');
  assert.ok(!client.connected);
  const success = await fetch(`${base}/callback?state=${state}&code=secret-code`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(success.headers.get('location'), '/playlists?spotify=1&connected=1');
  assert.equal(client.connected, true);
  const replay = await fetch(`${base}/callback?state=${state}&code=secret-code`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(replay.headers.get('location'), '/playlists?spotify=1&connection_failed=1');
});

test('settings bootstrap works before OAuth is configured, rejects cross-origin updates and never leaks secrets', async t => {
  const { createClient } = require('../src/providers/spotify');
  const client = createClient(db, { env: { SPOTIFY_TOKEN_KEY: 'ab'.repeat(32) } });
  const service = { exclusive: fn => Promise.resolve().then(fn) };
  const app = express(); app.use(express.json()); app.use('/spotify', createRouter(db, client, service));
  app.use('/settings', require('../src/lib/settings'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const legacy = await fetch(`${origin}/spotify`, { redirect: 'manual' });
  assert.equal(legacy.headers.get('location'), '/playlists?spotify=1');
  const values = { clientId: 'ui-client', clientSecret: 'never-echo-this-secret', redirectUri: `${origin}/spotify/callback` };
  const post = (requestOrigin, body) => fetch(`${origin}/spotify/api/config`, { method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('https://evil.example', values)).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spotify_config').get().n, 0);
  const saved = await post(origin, values);
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(values.clientSecret));
  const displayed = await fetch(`${origin}/spotify/api/config`);
  const data = await displayed.json();
  assert.equal(data.settings.clientId, 'ui-client');
  assert.equal(data.settings.hasSecret, true);
  assert.ok(!JSON.stringify(data).includes(values.clientSecret));
  const generic = await fetch(`${origin}/settings/api`);
  assert.ok(!(await generic.text()).includes(values.clientSecret));
  const status = await (await fetch(`${origin}/spotify/api/status`)).json();
  assert.equal(status.configured, true);
  assert.equal((await post(origin, { ...values, clientSecret: '' })).status, 200);
  assert.equal(client.config().clientSecret, values.clientSecret);
});
