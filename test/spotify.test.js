'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { configuration, encrypt, decrypt, createClient } = require('../src/providers/spotify');
const { createService, normalizeItems } = require('../src/lib/spotify_service');
const { snapshotPlaylist } = require('../src/lib/publish');

const env = { SPOTIFY_CLIENT_ID: 'client', SPOTIFY_CLIENT_SECRET: 'secret',
  SPOTIFY_REDIRECT_URI: 'https://navilist.example.com/spotify/callback', SPOTIFY_TOKEN_KEY: 'ab'.repeat(32) };
const id = 'a'.repeat(22);
const songId = 'b'.repeat(22);
function database(t) {
  const db = new Database(':memory:');
  require('../src/db/schema')(db);
  t.after(() => db.close());
  return db;
}
function addTrack(db, trackId, title = 'Song', artist = 'Artist') {
  db.prepare('INSERT INTO tracks (id, title, artist, album, duration, synced_at) VALUES (?, ?, ?, ?, ?, 1)').run(trackId, title, artist, 'Album', 200);
}
function item(title = 'Song', trackId = songId) {
  return { item: { id: trackId, type: 'track', name: title, artists: [{ name: 'Artist' }], album: { name: 'Album' }, duration_ms: 200000 } };
}
function fixture(t) {
  const db = database(t);
  const state = { snapshot: 'v1', items: [item()], calls: [], published: [], owner: 'user', fail: false };
  const client = {
    account: () => ({ user_id: 'user' }),
    get: async path => {
      state.calls.push(path);
      if (state.fail) throw new Error('Spotify unavailable');
      return { id, name: 'My playlist', snapshot_id: state.snapshot, owner: { id: state.owner } };
    },
    pages: async path => { state.calls.push(path); return state.items; },
  };
  const publish = async (database, options) => {
    state.published.push(options);
    const playlistId = options.id || 'destination';
    snapshotPlaylist(database, playlistId, options.name, null, options.trackIds, null, { type: options.type, config: options.config });
    return { ok: true, playlistId };
  };
  return { db, state, client, service: createService(db, client, { publish }) };
}
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('configuration requires HTTPS and a 256-bit hexadecimal encryption key', () => {
  assert.equal(configuration(env).origin, 'https://navilist.example.com');
  assert.throws(() => configuration({ ...env, SPOTIFY_TOKEN_KEY: 'bad' }), /64 hexadecimal/);
  assert.throws(() => configuration({ ...env, SPOTIFY_REDIRECT_URI: 'http://navilist.example.com/spotify/callback' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, SPOTIFY_REDIRECT_URI: 'https://navilist.example.com/other' }), /callback/);
  assert.equal(configuration({ ...env, SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:3000/spotify/callback' }).secure, false);
});

test('token encryption round-trips and rejects tampering or the wrong key', () => {
  const key = configuration(env).key;
  const encrypted = encrypt({ refresh_token: 'very-secret' }, key);
  assert.ok(!encrypted.includes('very-secret'));
  assert.deepEqual(decrypt(encrypted, key), { refresh_token: 'very-secret' });
  assert.throws(() => decrypt(encrypted, Buffer.alloc(32)));
  const data = Buffer.from(encrypted, 'base64'); data[data.length - 1] ^= 1;
  assert.throws(() => decrypt(data.toString('base64'), key));
});

test('UI configuration is encrypted, masks secrets, overrides env and preserves blank secrets across restarts', t => {
  const db = database(t);
  const client = createClient(db, { env });
  client.configure({ clientId: 'saved-client', clientSecret: 'private-saved-secret', redirectUri: env.SPOTIFY_REDIRECT_URI });
  const stored = db.prepare('SELECT * FROM spotify_config').get();
  assert.ok(!stored.client_secret.includes('private-saved-secret'));
  assert.ok(!JSON.stringify(client.settings()).includes('private-saved-secret'));
  assert.equal(client.settings().hasSecret, true);
  assert.equal(client.config().clientId, 'saved-client');
  assert.equal(client.config().clientSecret, 'private-saved-secret');
  client.configure({ clientId: 'edited-client', clientSecret: '', redirectUri: env.SPOTIFY_REDIRECT_URI });
  const restarted = createClient(db, { env: { SPOTIFY_TOKEN_KEY: env.SPOTIFY_TOKEN_KEY } });
  assert.equal(restarted.config().clientId, 'edited-client');
  assert.equal(restarted.config().clientSecret, 'private-saved-secret');
  db.prepare('INSERT INTO spotify_account VALUES (1, ?, ?)').run('user', 'tokens');
  assert.throws(() => client.configure({ clientId: 'other', clientSecret: 'other', redirectUri: env.SPOTIFY_REDIRECT_URI }), /Disconnect/);
});

test('saving configuration validates before writing and requires the deployment key', t => {
  const db = database(t);
  const client = createClient(db, { env: { SPOTIFY_TOKEN_KEY: env.SPOTIFY_TOKEN_KEY } });
  assert.throws(() => client.configure({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://unsafe.example/spotify/callback' }), /HTTPS/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spotify_config').get().n, 0);
  const missingKey = createClient(db, { env: {} });
  assert.ok(missingKey.settings().keyError);
  assert.throws(() => missingKey.configure({ clientId: 'client', clientSecret: 'secret', redirectUri: env.SPOTIFY_REDIRECT_URI }), /deployment Secret/);
});

test('connect stores only encrypted credentials and preserves identity', async t => {
  const db = database(t);
  const requests = [];
  const client = createClient(db, { env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/token')) return response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    return response({ id: 'user' });
  } });
  await client.connect('code', 'verifier');
  const stored = client.account();
  assert.equal(stored.user_id, 'user');
  assert.ok(!stored.tokens.includes('refresh'));
  assert.equal(decrypt(stored.tokens, configuration(env).key).refresh_token, 'refresh');
  assert.ok(requests[0].options.body.includes('code_verifier=verifier'));
});

test('concurrent API requests refresh a token only once and retain the refresh token', async t => {
  const db = database(t);
  db.prepare('INSERT INTO spotify_account VALUES (1, ?, ?)').run('user', encrypt({ access_token: 'old', refresh_token: 'refresh', expires_at: 0 }, configuration(env).key));
  let refreshes = 0;
  const client = createClient(db, { env, fetchImpl: async (url, options) => {
    if (url.endsWith('/api/token')) { refreshes++; return response({ access_token: 'new', expires_in: 3600 }); }
    assert.equal(options.headers.Authorization, 'Bearer new');
    return response({ id: 'user' });
  } });
  await Promise.all([client.get('/me'), client.get('/me')]);
  assert.equal(refreshes, 1);
  assert.equal(decrypt(client.account().tokens, configuration(env).key).refresh_token, 'refresh');
});

test('401 retries once after refresh and 429 prevents further calls during cooldown', async t => {
  const db = database(t);
  db.prepare('INSERT INTO spotify_account VALUES (1, ?, ?)').run('user', encrypt({ access_token: 'old', refresh_token: 'refresh', expires_at: Date.now() + 3600000 }, configuration(env).key));
  let requests = 0;
  const client = createClient(db, { env, fetchImpl: async url => {
    if (url.endsWith('/api/token')) return response({ access_token: 'new', expires_in: 3600 });
    requests++;
    return requests === 1 ? response({}, 401) : response({}, 429, { 'retry-after': '120' });
  } });
  await assert.rejects(client.get('/me'), /rate limit/);
  await assert.rejects(client.get('/me'), /rate limit/);
  assert.equal(requests, 2);
});

test('pagination follows offsets and rejects partial or malformed data', async t => {
  const db = database(t);
  db.prepare('INSERT INTO spotify_account VALUES (1, ?, ?)').run('user', encrypt({ access_token: 'token', expires_at: Date.now() + 3600000 }, configuration(env).key));
  const urls = [];
  const client = createClient(db, { env, fetchImpl: async url => {
    urls.push(url);
    return response(urls.length === 1 ? { items: ['a'], next: 'ignored-untrusted-url' } : { items: ['b'], next: null });
  } });
  assert.deepEqual(await client.pages('/me/playlists'), ['a', 'b']);
  assert.ok(urls[1].endsWith('offset=1'));
  const broken = createClient(db, { env, fetchImpl: async () => response({ name: 'No contents' }) });
  await assert.rejects(broken.pages(`/playlists/${id}/items`), /did not return/);
});

test('normalization preserves duplicates, positions and unsupported items', () => {
  const rows = normalizeItems([item(), item(), { item: null }, { item: { type: 'episode', name: 'Podcast' } }, { ...item(), is_local: true }]);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].spotify_id, rows[1].spotify_id);
  assert.equal(rows[4].position, 4);
  assert.deepEqual(rows.map(r => r.supported), [true, true, false, false, false]);
});

test('schema upgrades are idempotent and keep unrelated data', t => {
  const db = database(t);
  addTrack(db, 'local');
  db.prepare("INSERT INTO settings VALUES ('test', 'kept')").run();
  require('../src/db/schema')(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'test'").get().value, 'kept');
});

test('preview matches without publishing; subscribing preserves duplicate order', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'local');
  state.items = [item(), item('Missing', 'c'.repeat(22)), item()];
  const preview = await service.preview(id);
  assert.equal(preview.matched, 2);
  assert.equal(preview.missing, 1);
  assert.equal(state.published.length, 0);
  await service.subscribe(id);
  assert.deepEqual(state.published[0].trackIds, ['local', 'local']);
  assert.equal(state.published[0].refine, false);
});

test('unchanged snapshots skip item fetching and unchanged output skips publishing', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'local');
  await service.subscribe(id);
  await service.sync(id);
  assert.equal(state.calls.filter(c => c.endsWith('/items')).length, 1);
  assert.equal(state.published.length, 1);
});

test('library rematching adds previously missing tracks without a Spotify request', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'local');
  state.items.push(item('New song', 'c'.repeat(22)));
  await service.subscribe(id);
  addTrack(db, 'new-local', 'New song');
  const before = state.calls.length;
  await service.syncAll({ cachedOnly: true });
  assert.equal(state.calls.length, before);
  assert.deepEqual(state.published[1].trackIds, ['local', 'new-local']);
});

test('source removals and reordering are mirrored', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'one'); addTrack(db, 'two', 'Second');
  state.items = [item(), item('Second', 'c'.repeat(22))];
  await service.subscribe(id);
  state.snapshot = 'v2'; state.items.reverse();
  await service.sync(id);
  assert.deepEqual(state.published[1].trackIds, ['two', 'one']);
  state.snapshot = 'v3'; state.items = [item('Second', 'c'.repeat(22))];
  await service.sync(id);
  assert.deepEqual(state.published[2].trackIds, ['two']);
});

test('saved overrides are reused, resettable and validated', async t => {
  const { db, service } = fixture(t);
  addTrack(db, 'local'); addTrack(db, 'alternative', 'Alternative');
  await service.preview(id);
  assert.equal((await service.saveMatch(id, songId, 'alternative')).tracks[0].track_id, 'alternative');
  assert.equal((await service.preview(id)).tracks[0].track_id, 'alternative');
  await assert.rejects(service.saveMatch(id, songId, 'nonexistent'), /not found/);
  await assert.rejects(service.saveMatch(id, 'not-in-playlist', 'local'), /not present/);
  assert.equal((await service.saveMatch(id, songId, null)).tracks[0].track_id, 'local');
});

test('large-playlist match saves return only supported duplicate occurrences without scanning the library', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'local');
  const tracks = normalizeItems(Array.from({ length: 5000 }, (_, i) => item('Song', String(i).padStart(22, '0'))));
  tracks[10].spotify_id = songId; tracks[4000].spotify_id = songId;
  tracks[4999].spotify_id = songId; tracks[4999].supported = false;
  db.prepare('INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES (?,?,?)').run(id, 'Huge playlist', JSON.stringify(tracks));
  const queries = [], prepare = db.prepare;
  t.mock.method(db, 'prepare', function(sql) { queries.push(sql); return prepare.call(this, sql); });
  const update = await service.saveMatch(id, songId, 'local');
  assert.equal(update.spotify_id, id);
  assert.deepEqual(update.tracks.map(track => track.position), [10, 4000]);
  assert.ok(update.tracks.every(track => track.status === 'matched' && track.track_id === 'local'));
  assert.ok(!queries.some(sql => /FROM tracks/i.test(sql) && !/WHERE id = \?/i.test(sql)), 'must not rebuild the library index');
  assert.ok(JSON.stringify(update).length < 1500, 'response must not contain the full playlist');
  assert.equal(state.calls.length, 0);
  assert.equal(state.published.length, 0);
  const reset = await service.saveMatch(id, songId, null);
  assert.deepEqual(reset.tracks.map(track => track.position), [10, 4000]);
  assert.ok(reset.tracks.every(track => track.track_id === 'local'));
});

test('errors and empty source preserve the last successful destination and timestamp', async t => {
  const { db, service, state } = fixture(t);
  addTrack(db, 'local');
  const previous = await service.subscribe(id);
  state.fail = true;
  await assert.rejects(service.sync(id), /unavailable/);
  assert.equal(state.published.length, 1);
  state.fail = false; state.snapshot = 'v2'; state.items = [];
  await assert.rejects(service.sync(id), /destination preserved/);
  const cached = db.prepare('SELECT * FROM spotify_playlists').get();
  assert.equal(cached.navidrome_id, previous.navidrome_id);
  assert.equal(cached.last_synced_at, previous.last_synced_at);
  assert.equal(state.published.length, 1);
});

test('non-owned playlists can be previewed and subscribed when Spotify returns tracks; stopping keeps the destination', async t => {
  const { db, service, state } = fixture(t);
  state.owner = 'spotify';
  addTrack(db, 'local');
  const preview = await service.preview(id);
  assert.equal(preview.matched, 1);
  assert.ok(state.calls.includes(`/playlists/${id}/items`));
  assert.equal(state.published.length, 0);
  await service.subscribe(id);
  await service.stop(id);
  await service.syncAll();
  assert.equal(state.published.length, 1);
  assert.equal(db.prepare('SELECT navidrome_id FROM spotify_playlists').get().navidrome_id, 'destination');
});

test('visible playlist metadata with denied track access cannot be imported', async t => {
  const { db, service, state, client } = fixture(t);
  state.owner = 'spotify';
  let attempted = false;
  client.pages = async () => { attempted = true; throw new Error('Spotify API error (403): Forbidden'); };
  await assert.rejects(service.preview(id), /Cannot read playlist tracks:.*403/);
  await assert.rejects(service.subscribe(id), /403/);
  assert.equal(attempted, true);
  assert.equal(state.published.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spotify_playlists').get().n, 0);
});

test('denied track access during a refresh preserves cached source tracks and the destination', async t => {
  const { db, service, state, client } = fixture(t);
  addTrack(db, 'local');
  state.owner = 'spotify';
  await service.subscribe(id);
  const before = db.prepare('SELECT * FROM spotify_playlists').get();
  state.snapshot = 'v2';
  client.pages = async () => { throw new Error('Spotify API error (403): Forbidden'); };
  await assert.rejects(service.sync(id), /403/);
  const after = db.prepare('SELECT * FROM spotify_playlists').get();
  assert.equal(after.tracks_json, before.tracks_json);
  assert.equal(after.snapshot_id, before.snapshot_id);
  assert.equal(after.navidrome_id, before.navidrome_id);
  assert.equal(after.last_synced_at, before.last_synced_at);
  assert.equal(state.published.length, 1);
});

test('missing playlist snapshot does not prevent testing track access and disables snapshot caching', async t => {
  const { service, state } = fixture(t);
  state.owner = 'spotify'; state.snapshot = undefined;
  assert.equal((await service.preview(id)).total, 1);
  assert.equal((await service.preview(id)).total, 1);
  assert.equal(state.calls.filter(c => c.endsWith('/items')).length, 2);
});

test('Spotify access errors expose the HTTP status and provider reason, not a guessed ownership restriction', async t => {
  const db = database(t);
  db.prepare('INSERT INTO spotify_account VALUES (1, ?, ?)').run('user', encrypt({ access_token: 'token', expires_at: Date.now() + 3600000 }, configuration(env).key));
  const client = createClient(db, { env, fetchImpl: async () => response({ error: { message: 'Insufficient client scope' } }, 403) });
  await assert.rejects(client.get(`/playlists/${id}/items`), /Spotify API error \(403\): Insufficient client scope/);
});

test('a source change during pagination is rejected without caching partial data', async t => {
  const { db, service, state, client } = fixture(t);
  client.pages = async () => { state.snapshot = 'v2'; return [item()]; };
  await assert.rejects(service.preview(id), /changed during retrieval/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spotify_playlists').get().n, 0);
});

test('real publishing adapter sends ordered duplicates and replaces only its own destination', async t => {
  const { db, state, client } = fixture(t);
  addTrack(db, 'one'); addTrack(db, 'two', 'Second');
  for (const [key, value] of Object.entries({ navidrome_url: 'https://nd.example', navidrome_user: 'test', navidrome_password: 'test' }))
    db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, value);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url); calls.push(parsed);
    return response({ 'subsonic-response': { status: 'ok', playlist: { id: 'only-this-destination' } } });
  });
  const service = createService(db, client);
  state.items = [item(), item('Second', 'c'.repeat(22)), item()];
  await service.subscribe(id);
  assert.deepEqual(calls[0].searchParams.getAll('songId'), ['one', 'two', 'one']);
  assert.equal(calls[1].pathname, '/rest/updatePlaylist');
  state.snapshot = 'v2'; state.items = [item('Second', 'c'.repeat(22)), item()];
  await service.sync(id);
  assert.equal(calls[2].searchParams.get('playlistId'), 'only-this-destination');
  assert.deepEqual(calls[2].searchParams.getAll('songId'), ['two', 'one']);
  assert.equal(calls.length, 4); // no detached studio-refinement write
});

test('failed metadata write retains the new destination ID so retries cannot create duplicates', async t => {
  const { db, client } = fixture(t);
  addTrack(db, 'local');
  for (const [key, value] of Object.entries({ navidrome_url: 'https://nd.example', navidrome_user: 'test', navidrome_password: 'test' }))
    db.prepare('INSERT INTO settings VALUES (?, ?)').run(key, value);
  let creates = 0; let failMetadata = true;
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/createPlaylist') && !parsed.searchParams.has('playlistId')) creates++;
    if (parsed.pathname.endsWith('/updatePlaylist') && failMetadata)
      return response({ 'subsonic-response': { status: 'failed', error: { message: 'Temporary failure' } } });
    return response({ 'subsonic-response': { status: 'ok', playlist: { id: 'saved-destination' } } });
  });
  const service = createService(db, client);
  await assert.rejects(service.subscribe(id), /Temporary failure/);
  assert.equal(db.prepare('SELECT navidrome_id FROM spotify_playlists').get().navidrome_id, 'saved-destination');
  failMetadata = false;
  await service.sync(id);
  assert.equal(creates, 1);
});
