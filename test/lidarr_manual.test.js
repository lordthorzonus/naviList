'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const lidarr=require('../src/providers/lidarr');
const settings={lidarr_url:'http://lidarr.invalid',lidarr_api_key:'fake-key',lidarr_root_folder:'/music',lidarr_quality_profile_id:'4',lidarr_metadata_profile_id:'1'};
const artist={foreignArtistId:'11111111-1111-4111-8111-111111111111',artistName:'Artist'};
const album={foreignAlbumId:'22222222-2222-4222-8222-222222222222',title:'Album',artist};
function transport(t,handler){const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
 const call={path:new URL(url).pathname,query:new URL(url).searchParams,method:options.method,body:options.body?JSON.parse(options.body):null};calls.push(call);
 assert.equal(options.headers['X-Api-Key'],'fake-key');const value=handler(call);return new Response(JSON.stringify(value),{status:200});
});return calls;}

test('adding a manual artist never monitors or searches the catalog or future albums',async t=>{
 const calls=transport(t,c=>c.method==='GET'?[]:{id:10});await lidarr.requestArtistManually(settings,artist);
 const post=calls.find(c=>c.method==='POST');assert.equal(post.path,'/api/v1/artist');
 assert.equal(post.body.monitored,true);assert.equal(post.body.monitorNewItems,'none');
 assert.deepEqual(post.body.addOptions,{monitor:'none',searchForMissingAlbums:false});
 assert.equal(post.body.qualityProfileId,4);assert.equal(post.body.rootFolderPath,'/music');assert.equal(calls.length,2);
});

test('an existing artist is not modified or searched',async t=>{
 const calls=transport(t,()=>[{...artist,id:10,monitored:false}]);const result=await lidarr.requestArtistManually(settings,artist);
 assert.match(result.message,/already/);assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});

test('malformed Lidarr responses fail closed without attempting artist additions',async t=>{
 const calls=transport(t,()=>({error:'not a list'}));await assert.rejects(lidarr.requestArtistManually(settings,artist),/Invalid Lidarr artist/);
 assert.equal(calls.length,1);
});

test('adding an album searches only that album and adds any new artist with no catalog monitoring',async t=>{
 const calls=transport(t,c=>c.method==='GET'?[]:{id:20});await lidarr.requestAlbumManually(settings,album,true);
 const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/v1/album');
 assert.equal(posts[0].body.foreignAlbumId,album.foreignAlbumId);assert.equal(posts[0].body.monitored,true);
 assert.deepEqual(posts[0].body.addOptions,{searchForNewAlbum:true});
 assert.deepEqual(posts[0].body.artist.addOptions,{monitor:'none',searchForMissingAlbums:false});
 assert.equal(posts[0].body.artist.monitorNewItems,'none');
});

test('an existing album uses a single-album monitor update and AlbumSearch command only',async t=>{
 const calls=transport(t,c=>c.path==='/api/v1/album'?[{...album,id:20,monitored:false}]:c.path==='/api/v1/artist'?[{...artist,id:10,monitored:true}]:{});
 await lidarr.requestAlbumManually(settings,album,true);
 const writes=calls.filter(c=>c.method!=='GET');assert.equal(writes.length,2);
 assert.equal(writes[0].path,'/api/v1/album/monitor');assert.deepEqual(writes[0].body,{albumIds:[20],monitored:true});
 assert.equal(writes[1].path,'/api/v1/command');assert.deepEqual(writes[1].body,{name:'AlbumSearch',albumIds:[20]});
});

test('monitor-only album requests do not queue searches',async t=>{
 const calls=transport(t,c=>c.path==='/api/v1/album'?[{...album,id:20,monitored:false}]:c.path==='/api/v1/artist'?[{...artist,id:10,monitored:true}]:{});
 await lidarr.requestAlbumManually(settings,album,false);assert.ok(!calls.some(c=>c.path==='/api/v1/command'));
});

test('existing unmonitored artists are not silently enabled',async t=>{
 const calls=transport(t,c=>c.path==='/api/v1/album'?[]:[{...artist,id:10,monitored:false}]);
 await assert.rejects(lidarr.requestAlbumManually(settings,album,true),/unmonitored/);assert.ok(calls.every(c=>c.method==='GET'));
});

test('albums which already have all files do not trigger another search',async t=>{
 const calls=transport(t,c=>c.path==='/api/v1/album'?[{...album,id:20,monitored:true,statistics:{totalTrackCount:10,trackFileCount:10}}]:[{...artist,id:10,monitored:true}]);
 const result=await lidarr.requestAlbumManually(settings,album,true);assert.match(result.message,/already has files/);assert.ok(calls.every(c=>c.method==='GET'));
});

test('lookup metadata cannot override a monitor-only choice or enable artist-wide searches',async t=>{
 const existing={...artist,id:10,monitored:true,path:'/existing/Artist',qualityProfileId:2,metadataProfileId:3,addOptions:{monitor:'all',searchForMissingAlbums:true}};
 const calls=transport(t,c=>c.method==='GET'?(c.path==='/api/v1/album'?[]:[existing]):{id:20});
 await lidarr.requestAlbumManually(settings,{...album,addOptions:{searchForNewAlbum:true}},false);
 const post=calls.find(c=>c.method==='POST');assert.equal(post.path,'/api/v1/album');
 assert.deepEqual(post.body.addOptions,{searchForNewAlbum:false});assert.deepEqual(post.body.artist.addOptions,{monitor:'none',searchForMissingAlbums:false});
 assert.equal(post.body.artist.qualityProfileId,2);assert.equal(post.body.artist.path,'/existing/Artist');
 assert.ok(!calls.some(c=>c.path==='/api/v1/command'||(c.path==='/api/v1/artist'&&c.method!=='GET')));
});

test('new artist additions require valid configured folders and profile IDs before writing',async t=>{
 const calls=transport(t,()=>[]);
 await assert.rejects(lidarr.requestArtistManually({...settings,lidarr_quality_profile_id:'invalid'},artist),/Configure/);
 assert.ok(calls.every(c=>c.method==='GET'));
});

test('malformed album inventory responses stop requests before any writes',async t=>{
 const calls=transport(t,()=>null);await assert.rejects(lidarr.requestAlbumManually(settings,album,true),/Invalid Lidarr album response/);
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});

test('new artist monitoring opt-in uses Lidarr Missing mode without an immediate search or future monitoring',async t=>{
 const calls=transport(t,c=>c.method==='GET'?[]:{id:10});await lidarr.requestArtistManually(settings,artist,{monitorMissing:true});
 const post=calls.find(c=>c.method==='POST');assert.deepEqual(post.body.addOptions,{monitor:'missing',searchForMissingAlbums:false});
 assert.equal(post.body.monitorNewItems,'none');assert.ok(!calls.some(c=>c.path==='/api/v1/command'));
});

test('existing artist opt-in enables only released zero-file albums and preserves other monitoring choices',async t=>{
 const existing={...artist,id:10,monitored:true,monitorNewItems:'all'};
 const albums=[
  {id:20,artistId:10,releaseDate:'2000-01-01',monitored:false,statistics:{trackFileCount:0}},
  {id:21,artistId:10,releaseDate:'2000-01-01',monitored:false,statistics:{trackFileCount:1}},
  {id:22,artistId:10,releaseDate:'2999-01-01',monitored:false,statistics:{trackFileCount:0}},
  {id:23,artistId:10,releaseDate:'2000-01-01',monitored:false},
  {id:24,artistId:10,releaseDate:'2000-01-01',monitored:true,statistics:{trackFileCount:0}},
 ];
 const calls=transport(t,c=>c.path==='/api/v1/artist'?[existing]:c.method==='GET'?albums:{});
 const result=await lidarr.requestArtistManually(settings,artist,{monitorMissing:true});
 const writes=calls.filter(c=>c.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/v1/album/monitor');
 assert.deepEqual(writes[0].body,{albumIds:[20],monitored:true});assert.match(result.message,/1 released albums/);
 assert.ok(!calls.some(c=>c.path==='/api/v1/command'));
});

test('existing paused artists are not silently resumed by monitoring opt-in',async t=>{
 const calls=transport(t,()=>[{...artist,id:10,monitored:false}]);
 await assert.rejects(lidarr.requestArtistManually(settings,artist,{monitorMissing:true}),/paused/);
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
});

test('monitoring does not write when no albums have verified missing-file and release-date metadata',async t=>{
 const calls=transport(t,c=>c.path==='/api/v1/artist'?[{...artist,id:10,monitored:true}]:[{id:20,artistId:10,releaseDate:'invalid',statistics:{trackFileCount:0}}]);
 await lidarr.requestArtistManually(settings,artist,{monitorMissing:true});assert.ok(calls.every(c=>c.method==='GET'));
});
