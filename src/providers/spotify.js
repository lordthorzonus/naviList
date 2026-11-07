'use strict';

const crypto = require('crypto');

function configuration(env = process.env) {
  const { SPOTIFY_CLIENT_ID: clientId, SPOTIFY_CLIENT_SECRET: clientSecret,
    SPOTIFY_REDIRECT_URI: redirectUri, SPOTIFY_TOKEN_KEY: tokenKey } = env;
  if (!clientId || !clientSecret || !redirectUri || !tokenKey)
    throw new Error('Configure Spotify app details in Settings and set SPOTIFY_TOKEN_KEY in the deployment Secret');
  const url = new URL(redirectUri);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Spotify redirect URI must use HTTPS (or HTTP on a loopback IP)');
  if (url.pathname !== '/spotify/callback' || url.search || url.hash || url.username || url.password)
    throw new Error('Spotify redirect URI must end with /spotify/callback without query parameters');
  if (!/^[a-fA-F0-9]{64}$/.test(tokenKey)) throw new Error('SPOTIFY_TOKEN_KEY must be 64 hexadecimal characters');
  return { clientId, clientSecret, redirectUri, key: Buffer.from(tokenKey, 'hex'), origin: url.origin, secure: url.protocol === 'https:' };
}

function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function decrypt(value, key) {
  const data = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
}

function createClient(db, { env = process.env, fetchImpl = fetch } = {}) {
  let refreshing = null;
  let blockedUntil = 0;
  const savedConfig = () => db.prepare('SELECT * FROM spotify_config WHERE id = 1').get();
  const encryptionKey = () => {
    if (!/^[a-fA-F0-9]{64}$/.test(env.SPOTIFY_TOKEN_KEY || ''))
      throw new Error('Set SPOTIFY_TOKEN_KEY to a stable 64-character hexadecimal key in the deployment Secret');
    return Buffer.from(env.SPOTIFY_TOKEN_KEY, 'hex');
  };
  const config = () => {
    const saved = savedConfig();
    if (!saved) return configuration(env);
    let secret;
    try { secret = decrypt(saved.client_secret, encryptionKey()); }
    catch (_) { throw new Error('Cannot decrypt Spotify settings; check the deployment encryption key'); }
    return configuration({ ...env, SPOTIFY_CLIENT_ID: saved.client_id,
      SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REDIRECT_URI: saved.redirect_uri });
  };
  function settings() {
    const saved = savedConfig();
    let keyError = null;
    try { encryptionKey(); } catch (e) { keyError = e.message; }
    return { clientId: saved?.client_id || env.SPOTIFY_CLIENT_ID || '',
      redirectUri: saved?.redirect_uri || env.SPOTIFY_REDIRECT_URI || '',
      hasSecret: !!(saved?.client_secret || env.SPOTIFY_CLIENT_SECRET), keyError };
  }
  function configure(values) {
    if (account()) throw new Error('Disconnect Spotify before changing its app settings');
    if (typeof values.clientId !== 'string' || typeof values.redirectUri !== 'string' ||
        (values.clientSecret !== undefined && typeof values.clientSecret !== 'string'))
      throw new Error('Client ID, secret and callback URL must be text');
    const key = encryptionKey();
    const saved = savedConfig();
    let secret = values.clientSecret?.trim();
    if (!secret) {
      if (saved) {
        try { secret = decrypt(saved.client_secret, key); }
        catch (_) { throw new Error('Cannot decrypt the saved secret; enter it again'); }
      } else secret = env.SPOTIFY_CLIENT_SECRET;
    }
    const next = configuration({ ...env, SPOTIFY_CLIENT_ID: values.clientId.trim(),
      SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REDIRECT_URI: values.redirectUri.trim() });
    db.prepare('INSERT OR REPLACE INTO spotify_config (id, client_id, client_secret, redirect_uri) VALUES (1, ?, ?, ?)')
      .run(next.clientId, encrypt(next.clientSecret, key), next.redirectUri);
    return settings();
  }
  const account = () => db.prepare('SELECT * FROM spotify_account WHERE id = 1').get();
  function store(userId, tokens) {
    db.prepare('INSERT OR REPLACE INTO spotify_account (id, user_id, tokens) VALUES (1, ?, ?)')
      .run(userId, encrypt(tokens, config().key));
  }
  async function tokenRequest(fields) {
    const c = config();
    const response = await fetchImpl('https://accounts.spotify.com/api/token', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    if (!response.ok) throw new Error(`Spotify authorization failed (${response.status}); reconnect your account`);
    const tokens = await response.json();
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in)) throw new Error('Invalid Spotify token response');
    return { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
  }
  async function accessToken(force = false) {
    const row = account();
    if (!row) throw new Error('Connect Spotify first');
    const tokens = decrypt(row.tokens, config().key);
    if (!force && tokens.expires_at > Date.now() + 60000) return tokens.access_token;
    if (!refreshing) refreshing = (async () => {
      const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      // A disconnect/reconnect during an in-flight request must not restore old credentials.
      if (account()?.tokens !== row.tokens) throw new Error('Spotify connection changed; retry');
      store(row.user_id, { ...next, refresh_token: next.refresh_token || tokens.refresh_token });
      return next.access_token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function get(path, retry = true) {
    if (Date.now() < blockedUntil) throw new Error('Spotify rate limit active; retry after the cooldown');
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Spotify API path');
    const token = await accessToken();
    const response = await fetchImpl(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401 && retry) { await accessToken(true); return get(path, false); }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      blockedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 1800) * 1000;
      throw new Error('Spotify rate limit reached; automatic requests paused until Retry-After');
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        if (typeof body.error?.message === 'string') detail = `: ${body.error.message.slice(0, 300)}`;
      } catch (_) { /* An HTTP error need not have a JSON body. */ }
      throw new Error(`Spotify API error (${response.status})${detail}${response.status === 403 ? ' — Spotify denied access; check app permissions, playlist access, Premium and the user allowlist' : ''}`);
    }
    return response.json();
  }
  async function pages(path) {
    const items = [];
    let offset = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await get(`${path}${path.includes('?') ? '&' : '?'}limit=50&offset=${offset}`);
      if (!Array.isArray(data.items)) throw new Error('Spotify did not return playlist items; the playlist may not be accessible');
      items.push(...data.items);
      if (!data.next) return items;
      if (!data.items.length) throw new Error('Incomplete Spotify pagination');
      offset += data.items.length;
    }
    throw new Error('Spotify pagination limit exceeded');
  }
  async function connect(code, verifier) {
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code,
      redirect_uri: config().redirectUri, code_verifier: verifier });
    if (!tokens.refresh_token) throw new Error('Spotify did not return a refresh token');
    const response = await fetchImpl('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Could not read Spotify profile; check the app allowlist');
    const user = await response.json();
    if (!user.id) throw new Error('Spotify profile has no user ID');
    const previous = account();
    if (previous && previous.user_id !== user.id) throw new Error('Disconnect the previous Spotify account before connecting another');
    store(user.id, tokens);
  }
  return { config, settings, configure, account, connect, get, pages };
}

module.exports = { configuration, encrypt, decrypt, createClient };
