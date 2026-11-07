'use strict';

const logger = require('../utils/logger');

/**
 * lidarr.js — Lidarr API provider
 *
 * Docs: https://lidarr.audio/
 * Auth: X-Api-Key header
 * Rate limit: none documented — no throttling needed for our use case
 */

const TIMEOUT_DEFAULT = 10000;
const TIMEOUT_WRITE   = 60000;

// ── Core request ──────────────────────────────────────────────────────────────

async function request(settings, method, path, body = null, timeout = TIMEOUT_DEFAULT) {
  const base = (settings.lidarr_url || '').replace(/\/$/, '');
  const key  = settings.lidarr_api_key || '';
  if (!base || !key) throw new Error('Lidarr URL and API key required');
  logger.debug('lidarr', `request: ${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const opts = {
      method,
      signal:  controller.signal,
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${base}/api/v1${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * Test connection. Returns { ok, version? }.
 */
async function ping(settings) {
  try {
    const data = await request(settings, 'GET', '/system/status');
    return { ok: true, version: data.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Profile / folder discovery ────────────────────────────────────────────────

/**
 * Get all root folders. Returns [{ id, path, freeSpace }].
 */
async function getRootFolders(settings) {
  const data = await request(settings, 'GET', '/rootfolder');
  return (Array.isArray(data) ? data : []).map(f => ({
    id:        f.id,
    path:      f.path,
    freeSpace: f.freeSpace
  }));
}

/**
 * Get all quality profiles. Returns [{ id, name }].
 */
async function getQualityProfiles(settings) {
  const data = await request(settings, 'GET', '/qualityprofile');
  return (Array.isArray(data) ? data : []).map(p => ({ id: p.id, name: p.name }));
}

/**
 * Get all metadata profiles. Returns [{ id, name }].
 */
async function getMetadataProfiles(settings) {
  const data = await request(settings, 'GET', '/metadataprofile');
  return (Array.isArray(data) ? data : []).map(p => ({ id: p.id, name: p.name }));
}

/**
 * Get all three in one call. Returns { rootFolders, qualityProfiles, metadataProfiles }.
 */
async function getAllProfiles(settings) {
  const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
    getRootFolders(settings),
    getQualityProfiles(settings),
    getMetadataProfiles(settings)
  ]);
  return { rootFolders, qualityProfiles, metadataProfiles };
}

// ── Artist ────────────────────────────────────────────────────────────────────

/**
 * Get all artists currently in Lidarr. Returns raw array.
 */
async function getArtists(settings) {
  const data = await request(settings, 'GET', '/artist');
  if (!Array.isArray(data)) throw new Error('Invalid Lidarr artist response');
  return data;
}

/**
 * Check if an artist is already monitored in Lidarr by MusicBrainz ID.
 * Returns { exists: bool, artist? }.
 */
async function artistExists(settings, foreignArtistId) {
  try {
    const data = await request(settings, 'GET', '/artist');
    const arr  = Array.isArray(data) ? data : [];
    const found = arr.find(a => a.foreignArtistId === foreignArtistId);
    return { exists: !!found, artist: found || null };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

/**
 * Add an artist to Lidarr by MusicBrainz ID.
 * Returns { ok, error? }.
 */
async function addArtist(settings, artistName, foreignArtistId) {
  const rootFolderPath      = settings.lidarr_root_folder;
  const qualityProfileId    = parseInt(settings.lidarr_quality_profile_id);
  const metadataProfileId   = parseInt(settings.lidarr_metadata_profile_id);

  if (!rootFolderPath || !qualityProfileId || !metadataProfileId) {
    return { ok: false, error: 'Lidarr root folder, quality profile, and metadata profile must be configured' };
  }

  // Check if already exists first
  const check = await artistExists(settings, foreignArtistId);
  if (check.exists) return { ok: true, skipped: true, reason: 'already in Lidarr' };

  try {
    await request(settings, 'POST', '/artist', {
      artistName,
      foreignArtistId,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      monitored:  true,
      addOptions: { searchForMissingAlbums: true }
    }, TIMEOUT_WRITE);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Manual queue operations deliberately do not use addArtist(), whose legacy
// defaults search an entire artist catalog. Lookups are read-only; callers must
// present the returned candidate for explicit user confirmation before writing.
async function lookupArtists(settings, term) {
  const data = await request(settings, 'GET', `/artist/lookup?term=${encodeURIComponent(term)}`);
  if (!Array.isArray(data)) throw new Error('Invalid Lidarr artist lookup response');
  return data;
}

async function lookupAlbums(settings, term) {
  const data = await request(settings, 'GET', `/album/lookup?term=${encodeURIComponent(term)}`);
  if (!Array.isArray(data)) throw new Error('Invalid Lidarr album lookup response');
  return data;
}

function manualArtistSettings(settings, candidate, monitorMissing = false) {
  const qualityProfileId = Number(settings.lidarr_quality_profile_id);
  const metadataProfileId = Number(settings.lidarr_metadata_profile_id);
  if (!settings.lidarr_root_folder || !Number.isInteger(qualityProfileId) || qualityProfileId < 1 ||
      !Number.isInteger(metadataProfileId) || metadataProfileId < 1)
    throw new Error('Configure the Lidarr root folder, quality profile and metadata profile in Settings first');
  return { ...candidate, id: undefined, path: undefined,
    rootFolderPath: settings.lidarr_root_folder, qualityProfileId, metadataProfileId,
    monitored: true, monitorNewItems: 'none',
    addOptions: { monitor: monitorMissing ? 'missing' : 'none', searchForMissingAlbums: false } };
}

async function requestArtistManually(settings, candidate, { monitorMissing = false } = {}) {
  if (typeof monitorMissing !== 'boolean') throw new Error('An explicit monitoring choice is required');
  const artists = await getArtists(settings); // Errors stop the request, never imply "not present".
  const existing = artists.find(a => a.foreignArtistId === candidate.foreignArtistId);
  if (existing) {
    if (!monitorMissing) return { id: existing.id, status: 'added', message: 'Artist already in Lidarr; monitoring and searches were not changed.' };
    if (!Number.isInteger(existing.id) || existing.id < 1) throw new Error('Invalid existing Lidarr artist ID');
    if (existing.monitored === false) throw new Error('This artist is paused in Lidarr. Enable artist monitoring there first; no settings were changed.');
    const albums = await request(settings, 'GET', `/album?artistId=${existing.id}`);
    if (!Array.isArray(albums)) throw new Error('Invalid Lidarr album response');
    if (albums.some(a => a.artistId !== undefined && a.artistId !== existing.id)) throw new Error('Lidarr returned albums for another artist; no monitoring changed');
    const eligible = albums.filter(a => a.statistics?.trackFileCount === 0 &&
      typeof a.releaseDate === 'string' && Number.isFinite(Date.parse(a.releaseDate)) && Date.parse(a.releaseDate) <= Date.now());
    const ids = eligible.filter(a => !a.monitored).map(a => a.id);
    if (ids.some(id => !Number.isInteger(id) || id < 1)) throw new Error('Invalid album IDs; no monitoring changed');
    if (ids.length) await request(settings, 'PUT', '/album/monitor', { albumIds: ids, monitored: true });
    return { id: existing.id, status: 'added', message: ids.length
      ? `${ids.length} released albums with no files are now monitored. Other monitoring choices were retained. No immediate search requested; normal Lidarr automation may acquire monitored releases.`
      : 'No additional verified missing released albums needed monitoring. No monitoring changes or searches requested.' };
  }
  const added = await request(settings, 'POST', '/artist', manualArtistSettings(settings, candidate, monitorMissing), TIMEOUT_WRITE);
  if (!Number.isInteger(added?.id) || added.id < 1) throw new Error('Lidarr did not return the new artist ID; check Lidarr before retrying');
  return { id: added.id, status: 'added', message: monitorMissing
    ? 'Artist added using Lidarr’s Missing album monitoring mode. New/future albums are not auto-monitored. No immediate search requested; normal Lidarr automation may acquire monitored releases.'
    : 'Artist added. No albums monitored, no future albums auto-monitored, and no search started.' };
}

async function requestAlbumManually(settings, candidate, search) {
  const albums = await request(settings, 'GET', `/album?foreignAlbumId=${encodeURIComponent(candidate.foreignAlbumId)}`);
  if (!Array.isArray(albums)) throw new Error('Invalid Lidarr album response');
  const existing = albums.find(a => a.foreignAlbumId === candidate.foreignAlbumId);
  const artists = await getArtists(settings);
  const artist = artists.find(a => a.foreignArtistId === candidate.artist?.foreignArtistId);
  if (artist && artist.monitored === false)
    throw new Error('This artist is unmonitored in Lidarr. Enable artist monitoring in Lidarr before requesting an album; no settings were changed.');
  if (existing) {
    if (!Number.isInteger(existing.id) || existing.id < 1) throw new Error('Invalid existing Lidarr album ID');
    const stats = existing.statistics;
    if (stats?.totalTrackCount > 0 && stats.trackFileCount >= stats.totalTrackCount)
      return { id: existing.id, status: 'added', message: 'Lidarr already has files for this album. No search started; sync Navidrome and review matching.' };
    if (!existing.monitored) await request(settings, 'PUT', '/album/monitor', { albumIds: [existing.id], monitored: true });
    if (search) await request(settings, 'POST', '/command', { name: 'AlbumSearch', albumIds: [existing.id] }, TIMEOUT_WRITE);
    return { id: existing.id, status: search ? 'requested' : 'added', message: search
      ? 'Selected album monitored and search queued. No other albums were changed.'
      : 'Selected album monitored. No search started and no other albums were changed.' };
  }
  const artistResource = artist
    ? { ...artist, addOptions: { monitor: 'none', searchForMissingAlbums: false } }
    : manualArtistSettings(settings, candidate.artist);
  const added = await request(settings, 'POST', '/album', { ...candidate, id: undefined,
    artist: artistResource, artistId: artist?.id || 0, monitored: true,
    addOptions: { searchForNewAlbum: search } }, TIMEOUT_WRITE);
  if (!Number.isInteger(added?.id) || added.id < 1) throw new Error('Lidarr did not return the new album ID; check Lidarr before retrying');
  return { id: added.id, status: search ? 'requested' : 'added', message: search
    ? 'Selected album added and search requested. No artist-wide search requested.'
    : 'Selected album added for monitoring only. No search requested.' };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  ping,
  getRootFolders,
  getQualityProfiles,
  getMetadataProfiles,
  getAllProfiles,
  getArtists,
  artistExists,
  addArtist,
  lookupArtists,
  lookupAlbums,
  requestArtistManually,
  requestAlbumManually
};
