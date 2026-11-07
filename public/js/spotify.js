'use strict';

(() => {
const root = document.getElementById('viewSpotify');
const $ = id => document.getElementById(`sp-${id}`);
let selected = null;
let busy = false;
let connection = null;
let browsed = null;
const time = value => value ? new Date(value * 1000).toLocaleString() : 'Never';
function message(text) { $('message').textContent = text; }
async function request(path, body) {
  const response = await fetch(`/spotify/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function action(fn, { revealPreview = false } = {}) {
  if (busy) return;
  busy = true;
  message('Working…');
  root.querySelectorAll('button:not(#sp-back)').forEach(button => { button.disabled = true; });
  let succeeded = false;
  try {
    const result = await fn();
    message(typeof result === 'string' ? result : 'Done.');
    succeeded = true;
  }
  catch (e) { message(e.message); }
  finally {
    busy = false;
    try { await status(); } catch (e) { message(e.message); }
    renderPreview();
    if (succeeded && revealPreview && selected) {
      $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('previewTitle').focus({ preventScroll: true });
    }
  }
}
async function status() {
  const next = await request('api/status');
  if (connection?.userId && connection.userId !== next.userId) { browsed = null; selected = null; }
  connection = next;
  $('connection').textContent = connection.configError || (connection.userId ? `Connected as ${connection.userId}` : 'Connect Spotify in Settings to import playlists.');
  $('browse').disabled = !connection.userId || busy;
  const cached = connection.playlists.map(p => ({ id: p.spotify_id, name: p.title, ...p }));
  renderList(browsed ? browsed.map(p => ({ ...p, ...connection.playlists.find(c => c.spotify_id === p.id) })) : cached);
}
function renderList(playlists) {
  $('playlists').replaceChildren();
  if (!playlists.length) $('playlists').textContent = connection?.userId ? 'No playlists found. Click Refresh playlists to try again.' : 'Connect Spotify in Settings to get started.';
  for (const playlist of playlists) {
    const row = document.createElement('div'); row.className = `lb-card${playlist.enabled ? ' is-enabled' : ''}`;
    const body = document.createElement('div'); body.className = 'lb-card-body';
    const name = document.createElement('div'); name.className = 'lb-card-title';
    name.textContent = playlist.name + (playlist.enabled ? ' · Sync enabled' : '') + (playlist.error ? ` · ${playlist.error}` : '');
    const button = document.createElement('button'); button.className = 'btn btn-secondary btn-sm';
    button.textContent = 'Preview';
    button.disabled = busy || !connection?.userId;
    button.title = 'Try reading this playlist’s tracks from Spotify';
    button.onclick = () => action(async () => {
      selected = null;
      renderPreview();
      selected = (await request(`api/playlists/${playlist.id}/preview`, {})).playlist;
      return selected.total
        ? `Read ${selected.total} items from “${selected.title}”: ${selected.matched} matched, ${selected.missing} missing, ${selected.review} need review, ${selected.unsupported} unsupported. Preview only — nothing imported.`
        : `Spotify returned no items for “${selected.title}”. Nothing imported.`;
    }, { revealPreview: true });
    const actions = document.createElement('div'); actions.className = 'lb-card-actions'; actions.append(button);
    body.append(name, actions); row.append(body); $('playlists').append(row);
  }
}
function renderPreview() {
  $('preview').hidden = !selected;
  if (!selected) return;
  // Status may have changed even if publishing returned an error.
  const latest = connection?.playlists.find(p => p.spotify_id === selected.spotify_id);
  if (latest) Object.assign(selected, latest);
  $('previewTitle').textContent = selected.title;
  $('summary').textContent = `${selected.total} items · ${selected.matched} matched · ${selected.missing} missing · ${selected.review} need review · ${selected.unsupported} unsupported`;
  $('syncStatus').textContent = `Last checked: ${time(selected.last_checked_at)} · Last successful sync: ${time(selected.last_synced_at)}${selected.error ? ` · ${selected.error}` : ''}`;
  $('subscribe').disabled = busy || !!selected.enabled || !selected.matched || !connection?.userId;
  $('sync').disabled = busy || !selected.enabled || !connection?.userId;
  $('stop').disabled = busy || !selected.enabled;
  $('tracks').replaceChildren();
  for (const track of selected.tracks) {
    if ($('missingOnly').checked && track.status === 'matched') continue;
    const tr = document.createElement('tr');
    for (const value of [track.position + 1, track.artist, track.title]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    const td = document.createElement('td'); td.textContent = track.status;
    if (track.candidates.length) {
      const select = document.createElement('select'); select.setAttribute('aria-label', `Match for ${track.title}`);
      select.add(new Option('Choose a local track…', ''));
      for (const candidate of track.candidates) select.add(new Option(`${candidate.artist} — ${candidate.title} (${candidate.album || 'unknown album'}, ${candidate.score}%)`, candidate.id));
      select.disabled = busy;
      select.onchange = () => { if (select.value) action(async () => {
        selected = (await request(`api/playlists/${selected.spotify_id}/match`, { spotify_id: track.spotify_id, track_id: select.value })).playlist;
      }); };
      td.append(select);
    }
    if (track.track_id && track.spotify_id) {
      const reset = document.createElement('button'); reset.className = 'btn btn-secondary btn-sm';
      reset.textContent = 'Reset choice'; reset.disabled = busy;
      reset.onclick = () => action(async () => { selected = (await request(`api/playlists/${selected.spotify_id}/match`, { spotify_id: track.spotify_id, track_id: null })).playlist; });
      td.append(reset);
    }
    tr.append(td); $('tracks').append(tr);
  }
}
for (const name of ['subscribe', 'sync', 'stop']) $(name).onclick = () => action(async () => {
  const result = await request(`api/playlists/${selected.spotify_id}/${name}`, {});
  if (result.playlist) selected = result.playlist;
});
$('missingOnly').onchange = renderPreview;
$('browse').onclick = () => action(async () => {
  browsed = (await request('api/playlists')).playlists;
});
window.navilistSpotify = {
  open: async () => {
    await action(async () => {
      await status();
      if (connection.userId) browsed = (await request('api/playlists')).playlists;
    });
    const params = new URLSearchParams(location.search);
    if (params.has('connection_failed')) message('Spotify connection failed. Check your app details in Settings, then reconnect.');
    if (params.has('connected')) message('Spotify connected. Preview a playlist to get started.');
    if (params.has('connected') || params.has('connection_failed')) history.replaceState(null, '', '/playlists?spotify=1');
  },
};
})();
