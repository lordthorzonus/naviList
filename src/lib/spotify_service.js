'use strict';

const { buildMatcher } = require('./match');
const { publishPlaylist } = require('./publish');
const { TYPES } = require('./playlist_types');

const validId = id => typeof id === 'string' && /^[A-Za-z0-9]{22}$/.test(id);

function normalizeItems(items) {
  return items.map((row, position) => {
    const track = row?.item ?? row?.track;
    const supported = track?.type === 'track' && !row.is_local && !track.is_local;
    return { position, spotify_id: track?.id || null,
      title: track?.name || 'Unavailable item',
      artist: (track?.artists || []).map(a => a.name).join(', '),
      primary_artist: track?.artists?.[0]?.name || '',
      album: track?.album?.name || '', duration: (track?.duration_ms || 0) / 1000,
      supported: !!supported };
  });
}

function createService(db, client, { publish = publishPlaylist } = {}) {
  // Serialize preview, matching and publishing, including automatic runs.
  let tail = Promise.resolve();
  const exclusive = fn => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const row = id => db.prepare('SELECT * FROM spotify_playlists WHERE spotify_id = ?').get(id);
  function report(cached) {
    const matcher = buildMatcher(db, { excludeLive: false });
    const overrides = new Map(db.prepare('SELECT * FROM spotify_matches').all().map(r => [r.spotify_id, r.track_id]));
    const exists = db.prepare('SELECT id FROM tracks WHERE id = ?');
    const threshold = Number(db.prepare("SELECT value FROM settings WHERE key = 'fuzzy_match_threshold'").get()?.value) || 80;
    const tracks = JSON.parse(cached.tracks_json).map(track => {
      const chosen = overrides.get(track.spotify_id);
      const source = { artist: track.primary_artist, title: track.title };
      const match = !track.supported ? null : chosen && exists.get(chosen) ? chosen : matcher.match(source);
      const review = !match && track.supported ? matcher.review(source, threshold) : null;
      const candidates = (review?.candidates || []).map(c => ({ ...c,
        ...db.prepare('SELECT artist, title, album, duration FROM tracks WHERE id = ?').get(c.id) }));
      return { ...track, track_id: match, status: !track.supported ? 'unsupported' : match ? 'matched' : candidates.length ? 'review' : 'missing', candidates };
    });
    return { ...cached, tracks_json: undefined, tracks, total: tracks.length,
      matched: tracks.filter(t => t.track_id).length,
      missing: tracks.filter(t => t.status === 'missing').length,
      review: tracks.filter(t => t.status === 'review').length,
      unsupported: tracks.filter(t => t.status === 'unsupported').length };
  }
  async function fetchPlaylist(id) {
    if (!validId(id)) throw new Error('Invalid Spotify playlist ID');
    if (!client.account()) throw new Error('Connect Spotify first');
    const metadata = await client.get(`/playlists/${id}`);
    // Ownership is not an access test. Attempt the items endpoint and let
    // Spotify determine this application's access, including generated lists.
    const existing = row(id);
    let tracks = existing?.tracks_json;
    if (!existing || !metadata.snapshot_id || existing.snapshot_id !== metadata.snapshot_id) {
      let items;
      try { items = await client.pages(`/playlists/${id}/items`); }
      catch (e) { throw new Error(`Cannot read playlist tracks: ${e.message}`); }
      const after = await client.get(`/playlists/${id}`);
      if (metadata.snapshot_id && after.snapshot_id !== metadata.snapshot_id) throw new Error('Playlist changed during retrieval; retry');
      tracks = JSON.stringify(normalizeItems(items));
    }
    db.prepare(`INSERT INTO spotify_playlists (spotify_id, title, snapshot_id, tracks_json, last_checked_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(spotify_id) DO UPDATE SET title=excluded.title,
      snapshot_id=excluded.snapshot_id, tracks_json=excluded.tracks_json, last_checked_at=excluded.last_checked_at`)
      .run(id, metadata.name, metadata.snapshot_id || null, tracks, Math.floor(Date.now() / 1000));
    return report(row(id));
  }
  async function syncOne(id, cachedOnly = false) {
    try {
      const result = cachedOnly ? report(row(id)) : await fetchPlaylist(id);
      if (!result.enabled) return result;
      const ids = result.tracks.map(t => t.track_id).filter(Boolean);
      // Conservative MVP: even an intentionally emptied source does not erase
      // the last successful destination. Display this condition for the user.
      if (!ids.length) throw new Error('No matched tracks; destination preserved (empty playlists are not published)');
      const previous = result.navidrome_id && db.prepare('SELECT config FROM navilist_playlists WHERE navidrome_id = ?').get(result.navidrome_id);
      const fingerprint = require('crypto').createHash('sha256').update(JSON.stringify([result.title, ids])).digest('hex');
      let oldFingerprint;
      try { oldFingerprint = JSON.parse(previous?.config || '{}').fingerprint; } catch (_) {}
      if (!result.navidrome_id || fingerprint !== oldFingerprint) {
        const published = await publish(db, { id: result.navidrome_id, name: result.title,
          type: TYPES.SPOTIFY, config: { spotify_id: id, fingerprint }, trackIds: ids, refine: false });
        // Preserve a newly-created ID even when a subsequent metadata update failed.
        if (published.playlistId) db.prepare('UPDATE spotify_playlists SET navidrome_id = ? WHERE spotify_id = ?').run(published.playlistId, id);
        if (!published.ok) throw new Error(published.error || 'Navidrome publishing failed');
      }
      db.prepare('UPDATE spotify_playlists SET last_synced_at = ?, error = NULL WHERE spotify_id = ?')
        .run(Math.floor(Date.now() / 1000), id);
      return report(row(id));
    } catch (e) {
      db.prepare('UPDATE spotify_playlists SET error = ? WHERE spotify_id = ?').run(e.message, id);
      throw e;
    }
  }
  return {
    exclusive, report,
    preview: id => exclusive(() => fetchPlaylist(id)),
    sync: id => exclusive(() => syncOne(id)),
    subscribe: id => exclusive(async () => {
      await fetchPlaylist(id);
      db.prepare('UPDATE spotify_playlists SET enabled = 1 WHERE spotify_id = ?').run(id);
      return syncOne(id);
    }),
    stop: id => exclusive(() => { db.prepare('UPDATE spotify_playlists SET enabled = 0 WHERE spotify_id = ?').run(id); }),
    syncAll: ({ cachedOnly = false } = {}) => exclusive(async () => {
      if (!client.account()) return;
      for (const entry of db.prepare('SELECT spotify_id FROM spotify_playlists WHERE enabled = 1').all()) {
        try { await syncOne(entry.spotify_id, cachedOnly); } catch (_) { /* persisted per playlist, never discard the previous destination */ }
      }
    }),
    saveMatch: (id, sourceId, trackId) => exclusive(() => {
      const cached = row(id);
      if (!cached || !JSON.parse(cached.tracks_json).some(t => t.spotify_id === sourceId && t.supported)) throw new Error('Track not present in this playlist');
      if (trackId === null) db.prepare('DELETE FROM spotify_matches WHERE spotify_id = ?').run(sourceId);
      else {
        if (typeof trackId !== 'string' || !db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId)) throw new Error('Local track not found');
        db.prepare('INSERT OR REPLACE INTO spotify_matches (spotify_id, track_id) VALUES (?, ?)').run(sourceId, trackId);
      }
      return report(cached);
    }),
  };
}

module.exports = { createService, normalizeItems, validId };
