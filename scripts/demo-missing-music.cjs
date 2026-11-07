'use strict';

// Isolated local fixture: no real database, credentials or Lidarr transport.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { createRouter } = require('../src/lib/missing_music');
const { itemId } = require('../src/lib/missing_music_service');
const root = path.join(__dirname, '..');
const db = new Database(':memory:');
require('../src/db/schema')(db);

for (const [key, value] of Object.entries({
  lidarr_url: 'http://lidarr.invalid', lidarr_api_key: 'mock-not-a-real-key',
  lidarr_root_folder: '/media/library/music', lidarr_quality_profile_id: '4', lidarr_metadata_profile_id: '1',
})) db.prepare('INSERT INTO settings VALUES (?,?)').run(key, value);

const examples = [
  ['Boards of Canada', 'Music Has the Right to Children'], ['Björk', 'Vespertine'],
  ['Massive Attack', 'Mezzanine'], ['Portishead', 'Dummy'],
  ['Radiohead', 'In Rainbows'], ['Slowdive', 'Souvlaki'],
];
const artists = [...examples, ...Array.from({ length: 88 }, (_, i) =>
  ['Sample Artist ' + String(i + 1).padStart(2, '0'), 'A Different Light'])];
const demoPlaylists = [[], []];
for (const [index, [artist, album]] of artists.entries()) {
  const titles = ['The opening track', 'Somewhere in between', 'A familiar feeling', 'Night drive', 'The last light', 'A quieter place'];
  const tracks = Array.from({ length: 3 + index % 4 }, (_, n) => ({
    artist, primary_artist: artist, album, title: titles[n], supported: true, spotify_id: `demo-${index}-${n}`,
  }));
  if (index < 6) tracks.push({ artist, primary_artist: artist, album: 'Collected Singles', title: 'A different version', supported: true });
  demoPlaylists[index % 2].push(...tracks);
  if (index === 0) demoPlaylists[1].push(tracks[0]); // The queue deduplicates this shared song.
}
db.prepare('INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES (?,?,?)')
  .run('demo-favorites', 'Demo · Late night favorites', JSON.stringify(demoPlaylists[0]));
db.prepare('INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES (?,?,?)')
  .run('demo-radar', 'Demo · Release Radar', JSON.stringify(demoPlaylists[1]));
db.prepare('INSERT INTO missing_artists (artist_name,source,added_at) VALUES (?,?,?)')
  .run('Unknown Album Artist', 'lastfm_top_artists', Math.floor(Date.now() / 1000));
db.prepare("INSERT INTO lfm_playlists (lfm_id,title) VALUES ('demo-chart','Demo · Weekly chart')").run();
for (let position = 0; position < 3; position++)
  db.prepare('INSERT INTO lfm_playlist_tracks (lfm_id,position,artist,title) VALUES (?,?,?,?)')
    .run('demo-chart', position, 'Unknown Album Artist', 'A track without album metadata ' + (position + 1));
const decision = db.prepare('INSERT INTO missing_music_actions (item_id,kind,artist,album,status,message,updated_at) VALUES (?,?,?,?,?,?,?)');
decision.run(itemId('album', 'Sample Artist 05', 'A Different Light'), 'album', 'Sample Artist 05', 'A Different Light',
  'error', 'Demo error: metadata service temporarily unavailable. Nothing was sent.', Math.floor(Date.now() / 1000));
decision.run(itemId('artist', 'Sample Artist 10'), 'artist', 'Sample Artist 10', '', 'ignored',
  'Demo ignored artist. Restoring it does not send any requests.', Math.floor(Date.now() / 1000));

const uuid = name => {
  const hex = crypto.createHash('sha256').update(name).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const artistCandidate = name => ({
  foreignArtistId: uuid(name), artistName: name, artistType: 'Group', disambiguation: 'Mock metadata only',
});
const requests = [];
const mock = {
  lookupArtists: async (_, term) => [artistCandidate(term), artistCandidate(term + ' (different artist)')],
  lookupAlbums: async (_, term) => {
    const source = artists.find(([name]) => term.toLowerCase().startsWith(name.toLowerCase() + ' '));
    const artist = artistCandidate(source?.[0] || 'Demo artist');
    const title = source ? term.slice(source[0].length).trim() : term;
    const album = { foreignAlbumId: uuid(artist.artistName + title), title, artist, releaseDate: '1998-04-20', albumType: 'Album' };
    return [album, { ...album, foreignAlbumId: uuid(artist.artistName + title + 'reissue'), title: title + ' (reissue)', releaseDate: '2013-10-21' }];
  },
  requestArtistManually: async (_, candidate, { monitorMissing = false } = {}) => {
    requests.push({ kind: 'artist', id: candidate.foreignArtistId, monitorMissing });
    return { id: 100, status: 'added', message: monitorMissing
      ? 'MOCK: Missing album monitoring selected. No real monitoring or downloads are possible.'
      : 'MOCK: Artist added without searches.' };
  },
  requestAlbumManually: async (_, candidate, search) => {
    requests.push({ kind: 'album', id: candidate.foreignAlbumId, search });
    return { id: 200, status: search ? 'requested' : 'added', message: 'MOCK: Selected album request recorded; no real downloads are possible.' };
  },
};
const app = express();
app.use(express.json());
app.get('/missing-music', (req, res) => res.send(fs.readFileSync(path.join(root, 'public/missing_music.html'), 'utf8')
  .replace('<main class="mm-page">', '<main class="mm-page"><p class="mm-notice">LOCAL DEMO · Mock Lidarr only. No real download requests are possible.</p>')));
app.use('/missing-music', createRouter(db, mock));
app.get('/_demo/requests', (req, res) => res.json(requests));
app.use(express.static(path.join(root, 'public')));
app.get('/', (req, res) => res.redirect('/missing-music'));
app.listen(3141, '127.0.0.1', () => console.log('Local mock demo: http://127.0.0.1:3141/missing-music'));
