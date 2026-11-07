'use strict';

const crypto = require('crypto');
const { buildMatcher } = require('./match');
const { getSettings } = require('../db/settings');

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const itemId = (kind, artist, album = '') => crypto.createHash('sha256').update(JSON.stringify([kind, normalize(artist), normalize(album)])).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const legacyStatus = value => ({ sent: 'added', found: 'available', ignored: 'ignored' }[value] || 'pending');
const sourceLabels = {
  lfm_playlist:'Last.fm playlists', lb_playlist:'ListenBrainz playlists',
  lastfm_top_artists:'Last.fm top artists', lb_top_artists:'ListenBrainz top artists',
  maloja_top_artists:'Maloja top artists', exportify_csv:'File import · Exportify CSV',
  navilist_csv:'File import · naviList CSV', navilist_json:'File import · naviList JSON',
  m3u:'File import · M3U', jspf:'File import · JSPF',
};

function createService(db, lidarr, { now = Date.now } = {}) {
  let tail = Promise.resolve();
  const reviews = new Map();
  const exclusive = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const settingsFingerprint = s => crypto.createHash('sha256').update(JSON.stringify([
    s.lidarr_url, s.lidarr_api_key, s.lidarr_root_folder, s.lidarr_quality_profile_id, s.lidarr_metadata_profile_id,
  ])).digest('hex');

  function collect() {
    const groups = new Map(), items = new Map(), coverage = new Map(), warnings = [];
    const matcher = buildMatcher(db, { excludeLive: false });
    const exists = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
    const artistNames = new Set(db.prepare('SELECT DISTINCT artist FROM tracks').all().map(r => normalize(r.artist)));
    const overrides = new Map(db.prepare('SELECT * FROM spotify_matches').all().map(r => [r.spotify_id, r.track_id]));
    const actions = new Map(db.prepare('SELECT * FROM missing_music_actions').all().map(r => [r.item_id, r]));
    function ensureArtist(artist) {
      const id = itemId('artist', artist);
      if (!groups.has(id)) {
        const entry = { id, kind: 'artist', artist, album: '', sources: new Map(), tracks: new Map(), albums: new Map(),
          inLibrary: artistNames.has(normalize(artist)), legacyIds: [], legacyState: 'pending' };
        groups.set(id, entry); items.set(id, entry);
      }
      return groups.get(id);
    }
    function ensureAlbum(group, album) {
      const id = itemId('album', group.artist, album);
      if (!group.albums.has(id)) {
        const entry = { id, kind: 'album', artist: group.artist, album, sources: new Map(), tracks: new Map() };
        group.albums.set(id, entry); items.set(id, entry);
      }
      return group.albums.get(id);
    }
    function addTrack(track, source, cachedId = null) {
      const artist = String(track.primary_artist || track.artist || '').trim();
      const title = String(track.title || '').trim();
      if (!artist || !title || track.supported === false) return;
      const album = String(track.album || '').trim();
      const artistKey = itemId('artist', artist), albumKey = itemId('album', artist, album);
      for(const id of album?[artistKey,albumKey]:[artistKey]) {
        if(!coverage.has(id)) coverage.set(id,new Map());
        coverage.get(id).set(source.id,source);
      }
      const override = overrides.get(track.spotify_id);
      if ((override && exists.get(override)) || (cachedId && exists.get(cachedId)) || matcher.match({ artist, title })) return;
      const group = ensureArtist(artist);
      const key = JSON.stringify([normalize(title), normalize(album)]);
      const row = { title, album };
      group.tracks.set(key, row); group.sources.set(source.id, source);
      if (album) {
        const child = ensureAlbum(group, album);
        child.tracks.set(key, row); child.sources.set(source.id, source);
      }
    }
    for (const row of db.prepare('SELECT spotify_id, title, tracks_json FROM spotify_playlists').all()) {
      try {
        const tracks = JSON.parse(row.tracks_json);
        if (!Array.isArray(tracks) || tracks.some(t => !t || typeof t !== 'object' || Array.isArray(t)))
          throw new Error('Invalid track cache');
        for (const track of tracks) addTrack(track, { id: `spotify:${row.spotify_id}`, label: `Spotify · ${row.title}`, href: '/playlists?spotify=1' });
      } catch (_) { warnings.push(`Could not read the cached playlist “${row.title}”. Refresh its Spotify preview.`); }
    }
    for (const row of db.prepare(`SELECT t.*, p.title AS playlist_title FROM lfm_playlist_tracks t
      LEFT JOIN lfm_playlists p ON p.lfm_id = t.lfm_id`).all())
      addTrack(row, { id: `lastfm:${row.lfm_id}`, label: `Last.fm · ${row.playlist_title || row.lfm_id}`, href: '/playlists?lfm=1' }, row.track_id);
    for (const row of db.prepare(`SELECT t.*, p.title AS playlist_title FROM lb_playlist_tracks t
      LEFT JOIN lb_playlist_cache p ON p.lb_mbid = t.lb_mbid`).all())
      addTrack(row, { id: `listenbrainz:${row.lb_mbid}`, label: `ListenBrainz · ${row.playlist_title || row.lb_mbid}`, href: '/playlists?lb=1' }, row.track_id);
    for (const row of db.prepare('SELECT * FROM missing_artists ORDER BY id').all()) {
      const group = ensureArtist(row.artist_name);
      group.legacyIds.push(row.id); group.legacyState = legacyStatus(row.status);
      group.sources.set(`legacy:${row.source}`, { id: `legacy:${row.source}`, label: sourceLabels[row.source] || row.source || 'Existing missing-artist queue' });
    }
    for (const action of actions.values()) {
      const group = ensureArtist(action.artist);
      if (action.kind === 'album') ensureAlbum(group, action.album);
    }
    function serialize(entry, parentIgnored = false) {
      const action = actions.get(entry.id);
      let status = action?.status || entry.legacyState || 'pending';
      if (!entry.tracks.size && (coverage.has(entry.id) || (entry.kind === 'artist' && entry.inLibrary))) status = 'available';
      if (parentIgnored || action?.status === 'ignored') status = 'ignored';
      return { id: entry.id, kind: entry.kind, artist: entry.artist, album: entry.album,
        status, inheritedIgnored:parentIgnored, inLibrary: !!entry.inLibrary, missingTracks: entry.tracks.size,
        tracks: [...entry.tracks.values()].sort((a,b) => a.title.localeCompare(b.title)),
        sources: [...new Map([...(coverage.get(entry.id)||new Map()),...entry.sources]).values()].sort((a,b) => a.label.localeCompare(b.label)),
        message: action?.message || '', updatedAt: action?.updated_at || null,
        foreignId: action?.foreign_id || null, lidarrId: action?.lidarr_id || null,
        monitorMissing: action?.monitor_missing === 1 };
    }
    const artists = [...groups.values()].map(group => {
      const row = serialize(group);
      return { ...row, albums: [...group.albums.values()].map(a => serialize(a, row.status === 'ignored')).sort((a,b) => a.album.localeCompare(b.album)),
        unknownAlbumTracks: [...group.tracks.values()].filter(t => !t.album) };
    }).sort((a,b) => a.artist.localeCompare(b.artist));
    return { artists, items, warnings, coverage };
  }

  function list(query = {}) {
    const data = collect(), s = getSettings(db);
    const search = normalize(query.search).slice(0, 200), status = String(query.status || 'active'), source = String(query.source || '');
    const allSources = new Map();
    for (const artist of data.artists) for (const row of [artist, ...artist.albums]) for (const entry of row.sources) allSources.set(entry.id, entry);
    const filtered = data.artists.filter(group => {
      const rows = [group, ...group.albums];
      if (status === 'active' && !rows.some(r => r.status !== 'ignored' && r.status !== 'available')) return false;
      if (!['active','all'].includes(status) && !rows.some(r => r.status === status)) return false;
      if (source && !rows.some(r => r.sources.some(s => s.id === source))) return false;
      return !search || normalize([group.artist, ...group.albums.map(a => a.album), ...group.tracks.map(t => t.title)].join(' ')).includes(search);
    });
    const pages = Math.max(1, Math.ceil(filtered.length / 30));
    const page = Math.min(pages, Math.max(1, parseInt(query.page, 10) || 1));
    return { artists: filtered.slice((page-1)*30, page*30), page, pages, total: filtered.length,
      totals: { artists: data.artists.length, albums: data.artists.reduce((n,a) => n+a.albums.length,0),
        missingTracks: data.artists.reduce((n,a) => n+a.missingTracks,0) },
      sources: [...allSources.values()].sort((a,b) => a.label.localeCompare(b.label)), warnings: data.warnings,
      lidarrConfigured: !!(s.lidarr_url && s.lidarr_api_key), autoAddEnabled: s.lidarr_auto_add === 'true' };
  }
  function findItem(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid queue item');
    const data = collect(), item = data.items.get(id);
    if (!item) throw new Error('This item is no longer in the queue; refresh Missing Music');
    item.resolved = !item.tracks.size && (data.coverage.has(id) || (item.kind==='artist' && item.inLibrary));
    if(item.kind==='album') item.parentLegacyState=data.items.get(itemId('artist',item.artist))?.legacyState;
    return item;
  }
  function record(item, status, result = {}) {
    const monitoring = typeof result.monitorMissing === 'boolean' ? Number(result.monitorMissing) : null;
    db.prepare(`INSERT INTO missing_music_actions (item_id,kind,artist,album,status,foreign_id,lidarr_id,monitor_missing,message,updated_at)
      VALUES (?,?,?,?,?,?,?,COALESCE(?,0),?,?) ON CONFLICT(item_id) DO UPDATE SET status=excluded.status,
      foreign_id=COALESCE(excluded.foreign_id,missing_music_actions.foreign_id),
      lidarr_id=COALESCE(excluded.lidarr_id,missing_music_actions.lidarr_id),
      monitor_missing=COALESCE(?,missing_music_actions.monitor_missing),message=excluded.message,updated_at=excluded.updated_at`)
      .run(item.id,item.kind,item.artist,item.album,status,result.foreignId||null,result.id||null,monitoring,result.message||'',Math.floor(now()/1000),monitoring);
  }
  async function review(id, term) {
    const item = findItem(id), s = getSettings(db);
    const search = typeof term === 'string' ? term.trim() : [item.artist,item.album].filter(Boolean).join(' ');
    if (!search || search.length > 200) throw new Error('Search must contain 1–200 characters');
    const candidates = await (item.kind === 'artist' ? lidarr.lookupArtists(s,search) : lidarr.lookupAlbums(s,search));
    const usable = candidates.filter(c => item.kind === 'artist' ? uuid(c.foreignArtistId) : uuid(c.foreignAlbumId) && uuid(c.artist?.foreignArtistId)).slice(0,25);
    for (const [token,r] of reviews) if (r.expires < now()) reviews.delete(token);
    if (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
    const token = crypto.randomBytes(24).toString('hex');
    reviews.set(token,{ id,kind:item.kind,candidates:usable,expires:now()+10*60*1000,settings:settingsFingerprint(s) });
    return { token, kind:item.kind, search, candidates:usable.map(c => ({
      foreignId:item.kind==='artist'?c.foreignArtistId:c.foreignAlbumId,
      artist:item.kind==='artist'?c.artistName:c.artist.artistName,
      album:item.kind==='album'?c.title:'', disambiguation:c.disambiguation||'',
      year:c.releaseDate?String(c.releaseDate).slice(0,4):'', type:c.albumType||c.artistType||'' })),
      rootFolder:s.lidarr_root_folder||'',qualityProfile:s.lidarr_quality_profile_id||'',metadataProfile:s.lidarr_metadata_profile_id||'' };
  }
  async function send(id, body) {
    if (body.confirm !== true || typeof body.search !== 'boolean') throw new Error('Explicit confirmation and search choice are required');
    if (body.monitorMissing !== undefined && typeof body.monitorMissing !== 'boolean') throw new Error('Monitoring choice must be a boolean');
    const monitorMissing = body.monitorMissing === true;
    const saved = reviews.get(body.token), item = findItem(id), s = getSettings(db);
    if(item.resolved) throw new Error('This item no longer has library gaps; refresh Missing Music before requesting');
    if (!saved || saved.id !== id || saved.expires < now()) throw new Error('Review expired or does not belong to this item; review it again');
    if (saved.settings !== settingsFingerprint(s)) throw new Error('Lidarr configuration changed; review again before sending');
    const candidate = saved.candidates.find(c => (item.kind==='artist'?c.foreignArtistId:c.foreignAlbumId)===body.foreignId);
    if (!candidate) throw new Error('Select a candidate from this review');
    if (item.kind==='artist' && body.search) throw new Error('Artist-wide searches are not supported here; select an album instead');
    if (item.kind==='album' && monitorMissing) throw new Error('Missing-album catalog monitoring applies only to a full artist action');
    const ignored = db.prepare("SELECT 1 FROM missing_music_actions WHERE item_id IN (?,?) AND status='ignored'").get(id,itemId('artist',item.artist));
    if (ignored || item.legacyState === 'ignored' || item.parentLegacyState === 'ignored') throw new Error('Restore this ignored item or artist before sending');
    const previous = db.prepare("SELECT * FROM missing_music_actions WHERE kind = ? AND foreign_id = ? AND status IN ('added','requested') ORDER BY updated_at DESC LIMIT 1").get(item.kind,body.foreignId);
    const upgrade = (item.kind==='album' && body.search && previous?.status==='added') ||
      (item.kind==='artist' && monitorMissing && previous?.monitor_missing !== 1);
    if (previous && !upgrade) {
      record(item,previous.status,{id:previous.lidarr_id,foreignId:body.foreignId,monitorMissing:previous.monitor_missing===1,message:'Already sent from Missing Music. No duplicate request made.'});
      return { status:previous.status,message:'Already sent from Missing Music. No duplicate request made.' };
    }
    reviews.delete(body.token); // Confirmation is single-use, including partial failures.
    try {
      const result = await (item.kind==='artist'?lidarr.requestArtistManually(s,candidate,{monitorMissing}):lidarr.requestAlbumManually(s,candidate,body.search));
      record(item,result.status,{...result,foreignId:body.foreignId,monitorMissing});
      if(item.kind==='artist') for(const legacyId of item.legacyIds) db.prepare("UPDATE missing_artists SET status='sent',mbid=?,sent_at=? WHERE id=?").run(body.foreignId,Math.floor(now()/1000),legacyId);
      if(item.kind==='album') {
        const parent=collect().items.get(itemId('artist',item.artist));
        record(parent,'added',{foreignId:candidate.artist.foreignArtistId,message:'Artist confirmed in Lidarr through an individual album request. No artist-wide search requested.'});
        for(const legacyId of parent.legacyIds) db.prepare("UPDATE missing_artists SET status='sent',mbid=?,sent_at=? WHERE id=?").run(candidate.artist.foreignArtistId,Math.floor(now()/1000),legacyId);
      }
      return result;
    } catch(e) {
      record(item,'error',{foreignId:body.foreignId,message:`${e.message}. Check Lidarr before retrying: part of the request may have succeeded.`});
      throw e;
    }
  }
  return { list, review:(id,term)=>exclusive(()=>review(id,term)), send:(id,body)=>exclusive(()=>send(id,body)),
    decide:(id,ignore)=>exclusive(()=>{
      const item=findItem(id);
      record(item,ignore?'ignored':'pending',{monitorMissing:ignore?undefined:false,message:ignore?'Hidden from active queue; existing Lidarr monitoring or downloads are not cancelled.':''});
      if(item.kind==='artist') for(const legacyId of item.legacyIds) db.prepare("UPDATE missing_artists SET status=? WHERE id=? AND status IN ('pending','ignored')").run(ignore?'ignored':'pending',legacyId);
    }),
    manualMode:()=>exclusive(()=>{db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('lidarr_auto_add','false')").run();}),
  };
}

module.exports = { createService, itemId, normalize };
