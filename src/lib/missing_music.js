'use strict';
const express = require('express');
const path = require('path');
const { createService } = require('./missing_music_service');

function createRouter(db, lidarr) {
  const router=express.Router(), service=createService(db,lidarr);
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(req.method!=='POST')return next();
    try {
      const origin=new URL(req.get('origin')||'');
      if(!['http:','https:'].includes(origin.protocol)||origin.host!==req.get('host')||
        (req.get('sec-fetch-site')&&req.get('sec-fetch-site')!=='same-origin')) throw new Error('Same-origin request required');
      next();
    }catch(_){res.status(403).json({ok:false,error:'Same-origin request required'});}
  });
  const route=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(400).json({ok:false,error:e.message});}};
  router.get('/',(req,res)=>res.sendFile(path.join(__dirname,'../../public/missing_music.html')));
  router.get('/api',route(async(req,res)=>res.json({ok:true,...service.list(req.query)})));
  router.post('/api/manual-mode',route(async(req,res)=>{await service.manualMode();res.json({ok:true});}));
  router.post('/api/:id/review',route(async(req,res)=>res.json({ok:true,...await service.review(req.params.id,req.body.term)})));
  router.post('/api/:id/send',route(async(req,res)=>res.json({ok:true,...await service.send(req.params.id,req.body)})));
  router.post('/api/:id/decision',route(async(req,res)=>{
    if(typeof req.body.ignore!=='boolean')throw new Error('An explicit ignore or restore decision is required');
    await service.decide(req.params.id,req.body.ignore);res.json({ok:true});
  }));
  return router;
}
module.exports={createRouter};
