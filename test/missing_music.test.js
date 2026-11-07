'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {createService,itemId}=require('../src/lib/missing_music_service');
const artistId='11111111-1111-4111-8111-111111111111',albumId='22222222-2222-4222-8222-222222222222';
const artist={artistName:'New Band',foreignArtistId:artistId};
const album={title:'First Album',foreignAlbumId:albumId,artist,releaseDate:'2025-01-01',albumType:'Album'};

function fixture(t) {
  const db=new Database(':memory:');require('../src/db/schema')(db);t.after(()=>db.close());
  for(const [key,value]of Object.entries({lidarr_url:'http://lidarr.invalid',lidarr_api_key:'fake-test-key',lidarr_root_folder:'/music',lidarr_quality_profile_id:'4',lidarr_metadata_profile_id:'1'}))
    db.prepare('INSERT INTO settings VALUES (?,?)').run(key,value);
  let clock=1000000;const calls=[];
  const lidarr={
    lookupArtists:async(s,term)=>{calls.push(['lookupArtist',term]);return [artist];},
    lookupAlbums:async(s,term)=>{calls.push(['lookupAlbum',term]);return [album];},
    requestArtistManually:async(s,c,options)=>{calls.push(['sendArtist',c,options]);return {id:10,status:'added',message:'Artist added without searches'};},
    requestAlbumManually:async(s,c,search)=>{calls.push(['sendAlbum',c,search]);return {id:20,status:search?'requested':'added',message:'Selected album requested'};},
  };
  const service=createService(db,lidarr,{now:()=>clock});
  const cache=(id,title,tracks)=>db.prepare('INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES (?,?,?)').run(id,title,JSON.stringify(tracks));
  const missing=(name='New Band',albumName='First Album',title='Missing Song')=>({spotify_id:'track-'+title,artist:name,primary_artist:name,title,album:albumName,supported:true});
  cache('playlist1','My playlist',[missing()]);
  return {db,service,lidarr,calls,cache,missing,advance:()=>{clock+=11*60*1000;}};
}

test('listing is read-only, groups artists → albums → tracks and merges source playlists',t=>{
  const {service,calls,cache,missing,db}=fixture(t);
  cache('playlist2','Release Radar',[missing(),missing('New Band','Second Album','Another Song')]);
  const list=service.list();assert.equal(list.artists.length,1);assert.equal(list.artists[0].albums.length,2);
  assert.equal(list.artists[0].missingTracks,2);assert.equal(list.artists[0].albums[0].sources.length,2);
  assert.equal(list.totals.missingTracks,2);assert.equal(calls.length,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM missing_music_actions').get().n,0);
});

test('local matches, saved Spotify overrides and unsupported items are not treated as missing',t=>{
  const {db,service,cache,missing}=fixture(t);
  db.prepare('INSERT INTO tracks (id,title,artist,synced_at) VALUES (?,?,?,1)').run('local','Known Song','Known Band');
  db.prepare('INSERT INTO spotify_matches VALUES (?,?)').run('override','local');
  cache('playlist2','Other',[missing('Known Band','Known Album','Known Song'),{...missing('Other','Other','Alias'),spotify_id:'override'},{...missing('Podcast','Show','Episode'),supported:false}]);
  const list=service.list();assert.equal(list.artists.length,1);assert.equal(list.artists[0].artist,'New Band');
});

test('legacy artists, Last.fm and ListenBrainz gaps are included without inventing album names',t=>{
  const {db,service}=fixture(t);
  db.prepare('INSERT INTO missing_artists (artist_name,source,added_at) VALUES (?,?,1)').run('Legacy Artist','file import');
  db.prepare('INSERT INTO lfm_playlists (lfm_id,title) VALUES (?,?)').run('chart','Weekly chart');
  db.prepare('INSERT INTO lfm_playlist_tracks (lfm_id,position,artist,title) VALUES (?,0,?,?)').run('chart','Chart Artist','Chart Song');
  db.prepare('INSERT INTO lb_playlist_tracks (lb_mbid,position,artist,title) VALUES (?,0,?,?)').run('lb','LB Artist','LB Song');
  const list=service.list();assert.equal(list.artists.length,4);
  const chart=list.artists.find(a=>a.artist==='Chart Artist');assert.equal(chart.albums.length,0);assert.equal(chart.unknownAlbumTracks.length,1);
});

test('search, source and status filters paginate large queues at 30 artists',t=>{
  const {cache,missing,service}=fixture(t);
  cache('many','Big playlist',Array.from({length:80},(_,i)=>missing('Artist '+String(i).padStart(2,'0'),'Album','Song')));
  const list=service.list();assert.equal(list.total,81);assert.equal(list.artists.length,30);assert.equal(list.pages,3);
  assert.equal(service.list({page:999}).page,3);
  assert.equal(service.list({search:'artist 17'}).total,1);
  assert.equal(service.list({search:'first album'}).total,1);
  assert.equal(service.list({source:'spotify:many'}).total,80);
});

test('corrupt playlist JSON is surfaced as a warning without losing other queue sources',t=>{
  const {db,service}=fixture(t);db.prepare("INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES ('bad','Bad source','invalid json')").run();
  assert.equal(service.list().warnings.length,1);assert.equal(service.list().artists.length,1);
});

test('a malformed cached row does not produce a partially processed playlist queue',t=>{
  const {cache,missing,service}=fixture(t);
  cache('broken-rows','Malformed rows',[missing('Partial Artist','Album','First'),null]);
  const list=service.list();assert.equal(list.warnings.length,1);assert.equal(list.artists.length,1);
  assert.equal(list.artists[0].artist,'New Band');
});

test('review looks up candidates but never sends to Lidarr or exposes API credentials',async t=>{
  const {service,calls}=fixture(t);const review=await service.review(itemId('album','New Band','First Album'));
  assert.equal(review.candidates.length,1);assert.equal(review.candidates[0].foreignId,albumId);
  assert.equal(review.rootFolder,'/music');assert.ok(!JSON.stringify(review).includes('fake-test-key'));
  assert.deepEqual(calls.map(c=>c[0]),['lookupAlbum']);
});

test('artist additions require a reviewed candidate and confirmation and cannot search a catalog',async t=>{
  const {service,calls,db}=fixture(t);const id=itemId('artist','New Band');
  const review=await service.review(id);
  await assert.rejects(service.send(id,{token:review.token,foreignId:artistId,search:false}),/confirmation/);
  await assert.rejects(service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:true}),/Artist-wide/);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false}),/candidate/);
  assert.equal(calls.filter(c=>c[0]==='sendArtist').length,0);
  await service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:false});
  assert.equal(calls.filter(c=>c[0]==='sendArtist').length,1);
  assert.equal(db.prepare('SELECT status FROM missing_music_actions WHERE item_id=?').get(id).status,'added');
  assert.equal(calls.find(c=>c[0]==='sendArtist')[2].monitorMissing,false);
});

test('artist missing-album monitoring is opt-in, can upgrade an earlier plain add and is deduplicated',async t=>{
  const {service,calls,db}=fixture(t);const id=itemId('artist','New Band');let review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:false});
  review=await service.review(id);await service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:false,monitorMissing:true});
  assert.deepEqual(calls.filter(c=>c[0]==='sendArtist').map(c=>c[2].monitorMissing),[false,true]);
  assert.equal(db.prepare('SELECT monitor_missing FROM missing_music_actions WHERE item_id=?').get(id).monitor_missing,1);
  review=await service.review(id);await service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:false,monitorMissing:true});
  assert.equal(calls.filter(c=>c[0]==='sendArtist').length,2);
});

test('an album action cannot opt into whole-artist monitoring and invalid monitoring values are rejected',async t=>{
  const {service,calls}=fixture(t);const id=itemId('album','New Band','First Album');const review=await service.review(id);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false,monitorMissing:true}),/full artist action/);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false,monitorMissing:'true'}),/boolean/);
  assert.ok(!calls.some(c=>c[0].startsWith('send')));
});

test('monitoring upgrade preserves plain existing queue decisions during an additive schema migration',t=>{
  const {db}=fixture(t);
  db.prepare("INSERT INTO missing_music_actions (item_id,kind,artist,status,updated_at) VALUES ('old','artist','Kept artist','added',1)").run();
  db.exec('ALTER TABLE missing_music_actions DROP COLUMN monitor_missing');
  require('../src/db/schema')(db);
  const row=db.prepare("SELECT status,artist,monitor_missing FROM missing_music_actions WHERE item_id='old'").get();
  assert.deepEqual(row,{status:'added',artist:'Kept artist',monitor_missing:0});
});

test('album send targets the reviewed album, records status and prevents repeat searches',async t=>{
  const {service,calls}=fixture(t);const id=itemId('album','New Band','First Album');
  const review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true});
  assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,1);assert.equal(calls.find(c=>c[0]==='sendAlbum')[2],true);
  const next=await service.review(id);
  const duplicate=await service.send(id,{token:next.token,foreignId:albumId,confirm:true,search:true});
  assert.match(duplicate.message,/duplicate/);assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,1);
  const list=service.list();assert.equal(list.artists[0].status,'added');assert.equal(list.artists[0].albums[0].status,'requested');
});

test('monitor-only album confirmation can later be explicitly upgraded to a search',async t=>{
  const {service,calls}=fixture(t);const id=itemId('album','New Band','First Album');
  let review=await service.review(id);await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false});
  review=await service.review(id);await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true});
  assert.deepEqual(calls.filter(c=>c[0]==='sendAlbum').map(c=>c[2]),[false,true]);
});

test('an explicit reset to pending allows a consciously reviewed repeat album search',async t=>{
  const {service,calls}=fixture(t);const id=itemId('album','New Band','First Album');let review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true});
  await service.decide(id,false);review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true});
  assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,2);
});

test('expired reviews, mismatched items and changed settings cannot send',async t=>{
  const {service,db,calls,advance}=fixture(t);const id=itemId('album','New Band','First Album');
  let review=await service.review(id);
  await assert.rejects(service.send(itemId('artist','New Band'),{token:review.token,foreignId:albumId,confirm:true,search:false}),/does not belong/);
  advance();await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false}),/expired/);
  review=await service.review(id);db.prepare("UPDATE settings SET value='/changed' WHERE key='lidarr_root_folder'").run();
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false}),/configuration changed/);
  assert.equal(calls.filter(c=>c[0].startsWith('send')).length,0);
});

test('ignoring artists suppresses their album requests including previously open reviews',async t=>{
  const {service,calls}=fixture(t);const id=itemId('album','New Band','First Album');const review=await service.review(id);
  await service.decide(itemId('artist','New Band'),true);
  assert.equal(service.list().total,0);assert.equal(service.list({status:'ignored'}).artists[0].albums[0].inheritedIgnored,true);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true}),/Restore/);
  assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,0);
  await service.decide(itemId('artist','New Band'),false);assert.equal(service.list().total,1);
});

test('ignoring or sending a legacy artist updates only the selected legacy row',async t=>{
  const {service,db}=fixture(t);
  const insert=db.prepare('INSERT INTO missing_artists (artist_name,source,added_at) VALUES (?, ?,1)');insert.run('New Band','import');insert.run('Other Band','import');
  const id=itemId('artist','New Band');await service.decide(id,true);
  assert.equal(db.prepare("SELECT status FROM missing_artists WHERE artist_name='New Band'").get().status,'ignored');
  assert.equal(db.prepare("SELECT status FROM missing_artists WHERE artist_name='Other Band'").get().status,'pending');
  await service.decide(id,false);const review=await service.review(id);await service.send(id,{token:review.token,foreignId:artistId,confirm:true,search:false});
  assert.equal(db.prepare("SELECT status FROM missing_artists WHERE artist_name='New Band'").get().status,'sent');
});

test('library rematching resolves a previously requested album without network calls',async t=>{
  const {service,db,calls}=fixture(t);const id=itemId('album','New Band','First Album');const review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true});
  db.prepare("INSERT INTO tracks (id,title,artist,synced_at) VALUES ('now-present','Missing Song','New Band',1)").run();
  const count=calls.length;const list=service.list({status:'available'});
  assert.equal(list.artists[0].albums[0].status,'available');assert.equal(calls.length,count);
  assert.equal(service.list({status:'available',source:'spotify:playlist1'}).total,1);
});

test('an open review cannot send an album after library matching has resolved its gaps',async t=>{
  const {service,db,calls}=fixture(t);const id=itemId('album','New Band','First Album');let review=await service.review(id);
  await service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:false});
  review=await service.review(id);
  db.prepare("INSERT INTO tracks (id,title,artist,synced_at) VALUES ('arrived','Missing Song','New Band',1)").run();
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true}),/no longer has library gaps/);
  assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,1);
});

test('legacy ignored artist state also blocks individual album requests',async t=>{
  const {service,db,calls}=fixture(t);const id=itemId('album','New Band','First Album');const review=await service.review(id);
  db.prepare("INSERT INTO missing_artists (artist_name,source,added_at,status) VALUES ('New Band','legacy',1,'ignored')").run();
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true}),/Restore/);
  assert.equal(calls.filter(c=>c[0]==='sendAlbum').length,0);
});

test('Lidarr failures are recorded, consume confirmation and do not resend automatically',async t=>{
  const {service,lidarr,db}=fixture(t);const id=itemId('album','New Band','First Album');
  lidarr.requestAlbumManually=async()=>{throw new Error('HTTP 503');};const review=await service.review(id);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true}),/503/);
  const action=db.prepare('SELECT * FROM missing_music_actions WHERE item_id=?').get(id);
  assert.equal(action.status,'error');assert.match(action.message,/part of the request may have succeeded/);
  await assert.rejects(service.send(id,{token:review.token,foreignId:albumId,confirm:true,search:true}),/expired/);
});

test('manual mode is explicit and disables global auto-add without sending music',async t=>{
  const {service,db,calls}=fixture(t);db.prepare("INSERT INTO settings VALUES ('lidarr_auto_add','true')").run();
  assert.equal(service.list().autoAddEnabled,true);await service.manualMode();assert.equal(service.list().autoAddEnabled,false);assert.equal(calls.length,0);
});
