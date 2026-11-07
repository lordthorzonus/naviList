'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');const Database=require('better-sqlite3');
const {createRouter}=require('../src/lib/missing_music');const {itemId}=require('../src/lib/missing_music_service');

test('HTTP browsing and reviews cannot send requests; a selected item needs same-origin explicit confirmation',async t=>{
 const db=new Database(':memory:');require('../src/db/schema')(db);
 db.prepare("INSERT INTO settings VALUES ('lidarr_url','http://lidarr.invalid')").run();db.prepare("INSERT INTO settings VALUES ('lidarr_api_key','never-leak-this-test-key')").run();
 db.prepare('INSERT INTO spotify_playlists (spotify_id,title,tracks_json) VALUES (?,?,?)').run('p','Demo',JSON.stringify([{artist:'Artist',title:'Track',album:'Album',supported:true}]));
 let sends=0,lookups=0;const foreignId='11111111-1111-4111-8111-111111111111';
 const lidarr={lookupArtists:async()=>{lookups++;return [{foreignArtistId:foreignId,artistName:'Artist'}];},requestArtistManually:async()=>{sends++;return {id:1,status:'added',message:'Added without searches'};}};
 const app=express();app.use(express.json());app.use('/missing-music',createRouter(db,lidarr));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();db.close();});
 const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/missing-music';
 const post=(path,body,from=origin)=>fetch(base+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/Missing Music/);
 const response=await fetch(base+'/api');const data=await response.json();assert.equal(data.artists.length,1);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(data).includes('never-leak-this-test-key'));
 assert.equal(sends,0);assert.equal(lookups,0);
 const id=itemId('artist','Artist');
 assert.equal((await post(`/api/${id}/review`,{},'https://evil.invalid')).status,403);
 const review=await(await post(`/api/${id}/review`,{})).json();assert.equal(lookups,1);assert.equal(sends,0);
 assert.ok(!JSON.stringify(review).includes('never-leak-this-test-key'));
 assert.equal((await post(`/api/${id}/send`,{token:review.token,foreignId,search:false})).status,400);assert.equal(sends,0);
 assert.equal((await post(`/api/${id}/send`,{token:review.token,foreignId,search:false,confirm:true},'https://evil.invalid')).status,403);assert.equal(sends,0);
 const sent=await post(`/api/${id}/send`,{token:review.token,foreignId,search:false,confirm:true});assert.equal(sent.status,200);assert.equal(sends,1);
 assert.equal((await post(`/api/${id}/decision`,{ignore:true})).status,200);assert.equal(sends,1);
});
