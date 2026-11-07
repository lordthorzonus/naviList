'use strict';

(() => {
  const el = id => document.getElementById(id);
  let busy = false;
  const show = text => { el('spotifySettingsStatus').textContent = text; };
  async function api(path, body) {
    const response = await fetch(`/spotify/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  async function load(populate = true) {
    const [config, status] = await Promise.all([api('api/config'), api('api/status')]);
    const settings = config.settings;
    if (populate) {
      el('spotifyClientId').value = settings.clientId;
      el('spotifyRedirectUri').value = settings.redirectUri || `${location.origin}/spotify/callback`;
    }
    el('spotifyClientSecret').placeholder = settings.hasSecret ? 'Saved — leave blank to keep' : 'Enter client secret';
    el('spotifySettingsHelp').textContent = settings.keyError || (status.userId
      ? `Connected as ${status.userId}. Disconnect before editing app details. Your Navidrome playlists will be kept.`
      : 'Save app details, then connect Spotify. The secret is encrypted and is never shown again.');
    for (const id of ['spotifyClientId', 'spotifyClientSecret', 'spotifyRedirectUri', 'spotifySave'])
      el(id).disabled = busy || !!status.userId || !!settings.keyError;
    el('spotifyConnect').disabled = busy || !status.configured;
    el('spotifyDisconnect').disabled = busy || !status.userId;
    return status;
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    for (const id of ['spotifySave', 'spotifyConnect', 'spotifyDisconnect']) el(id).disabled = true;
    show('Working…');
    try { await fn(); }
    catch (e) { show(e.message); }
    finally {
      busy = false;
      try { await load(false); } catch (e) { show(e.message); }
    }
  }
  el('spotifyConfigForm').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      await api('api/config', { clientId: el('spotifyClientId').value,
        clientSecret: el('spotifyClientSecret').value, redirectUri: el('spotifyRedirectUri').value });
      el('spotifyClientSecret').value = '';
      show('Spotify settings saved.');
    });
  });
  el('spotifyDisconnect').onclick = () => {
    if (!confirm('Disconnect Spotify and forget its subscriptions and match choices? App settings and Navidrome playlists will be kept.')) return;
    action(async () => { await api('disconnect', {}); show('Disconnected.'); });
  };
  load().catch(e => show(e.message));
})();
