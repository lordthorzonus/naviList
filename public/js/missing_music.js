'use strict';

(() => {
  const $=id=>document.getElementById(`mm-${id}`);
  const statuses={pending:'Needs a decision',requested:'Search requested',added:'Added / monitored',ignored:'Ignored',available:'Now available',error:'Needs attention'};
  const expanded=new Set();
  let page=1,data=null,busy=false,loadController=null,reviewItem=null,reviewData=null,chosen=null,lookupSequence=0;
  const node=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
  const message=text=>{$('message').textContent=text;};
  async function api(path,body,signal) {
    const response=await fetch(`/missing-music/${path}`,body===undefined?{signal}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Request failed');return result;
  }
  async function load() {
    loadController?.abort();const controller=new AbortController();loadController=controller;
    $('list').setAttribute('aria-busy','true');
    const query=new URLSearchParams({page:String(page),search:$('search').value,status:$('status').value,source:$('source').value});
    try {
      data=await api(`api?${query}`,undefined,controller.signal);page=data.page;
      $('artist-count').textContent=data.totals.artists.toLocaleString();$('album-count').textContent=data.totals.albums.toLocaleString();$('track-count').textContent=data.totals.missingTracks.toLocaleString();
      $('auto-notice').hidden=!data.autoAddEnabled;$('config-notice').hidden=data.lidarrConfigured;
      const selected=$('source').value;$('source').replaceChildren(new Option('All sources',''));
      for(const source of data.sources)$('source').add(new Option(source.label,source.id));$('source').value=selected;
      $('range').textContent=data.total?`${(page-1)*30+1}–${Math.min(page*30,data.total)} of ${data.total} artists`:'No matching artists';
      $('pages').textContent=`Page ${page} of ${data.pages}`;$('prev').disabled=page<=1;$('next').disabled=page>=data.pages;
      $('warnings').replaceChildren(...data.warnings.map(w=>node('p','mm-item-note',w)));
      render();
    }catch(e){if(e.name!=='AbortError')message(e.message);}
    finally{if(loadController===controller)$('list').setAttribute('aria-busy','false');}
  }
  function badge(status){return node('span',`mm-badge mm-badge-${status}`,statuses[status]||status);}
  function sources(entries) {
    const wrap=node('div','mm-source-chips');
    for(const source of entries){const chip=node(source.href?'a':'span','mm-source',source.label);if(source.href)chip.href=source.href;wrap.append(chip);}return wrap;
  }
  function tracks(rows) {
    const list=node('ol','mm-track-list');for(const [index,track]of rows.entries()){const li=node('li');li.append(node('span','',String(index+1)),document.createTextNode(track.title));list.append(li);}return list;
  }
  async function decide(item) {
    if(busy)return;
    const ignore=item.status!=='ignored';
    if(ignore&&item.kind==='artist'&&!confirm('Ignore this artist and its album gaps in Missing Music? This does not cancel existing Lidarr monitoring or downloads.'))return;
    busy=true;
    try{await api(`api/${item.id}/decision`,{ignore});message(ignore?'Item ignored. No Lidarr settings were changed.':'Item restored to the queue.');await load();}
    catch(e){message(e.message);}finally{busy=false;}
  }
  function actions(item) {
    const wrap=node('div','mm-item-actions');
    const review=node('button','btn btn-secondary btn-sm',item.kind==='artist'?'Review artist in Lidarr':'Review album in Lidarr');
    review.disabled=!data.lidarrConfigured||item.status==='ignored'||item.status==='available';review.onclick=()=>openReview(item);
    const ignore=node('button','mm-text-button',item.inheritedIgnored?'Restore artist first':item.status==='ignored'?'Restore':'Ignore');ignore.disabled=!!item.inheritedIgnored;ignore.onclick=()=>decide(item);
    wrap.append(review,ignore);
    if(['added','requested'].includes(item.status)) {
      const reset=node('button','mm-text-button','Reset to pending');
      reset.onclick=async()=>{
        if(busy||!confirm('Return this item to pending so you can review and send it again? This does not cancel existing Lidarr activity; sending again may start another search.'))return;
        busy=true;
        try{await api(`api/${item.id}/decision`,{ignore:false});message('Decision reset. Review again before sending another request.');await load();}
        catch(e){message(e.message);}finally{busy=false;}
      };
      wrap.append(reset);
    }
    return wrap;
  }
  function albumCard(album) {
    const details=node('details','mm-album'),summary=node('summary');
    const title=node('div','mm-title-wrap');title.append(node('strong','',album.album),node('p','mm-subtitle',`${album.missingTracks} unmatched song${album.missingTracks===1?'':'s'}`));
    summary.append(node('span','mm-chevron','›'),title,badge(album.status));details.append(summary);
    details.addEventListener('toggle',()=>{
      if(!details.open||details.dataset.rendered)return;details.dataset.rendered='true';
      const body=node('div','mm-album-body');body.append(actions(album),sources(album.sources));
      if(album.message)body.append(node('p','mm-item-note',album.message));
      body.append(tracks(album.tracks));details.append(body);
    });return details;
  }
  function artistCard(artist) {
    const details=node('details','mm-artist'),summary=node('summary');
    const title=node('div','mm-title-wrap');title.append(node('div','mm-artist-name',artist.artist),node('p','mm-subtitle',`${artist.albums.length} album${artist.albums.length===1?'':'s'} · ${artist.missingTracks} unmatched song${artist.missingTracks===1?'':'s'}${artist.inLibrary?' · Artist in library':''}`));
    summary.append(node('span','mm-avatar',[...artist.artist][0]?.toUpperCase()||'♪'),title,badge(artist.status),node('span','mm-chevron','›'));details.append(summary);
    details.addEventListener('toggle',()=>{
      if(details.open)expanded.add(artist.id);else expanded.delete(artist.id);
      if(!details.open||details.dataset.rendered)return;details.dataset.rendered='true';
      const body=node('div','mm-artist-body');body.append(actions(artist),sources(artist.sources));
      if(artist.message)body.append(node('p','mm-item-note',artist.message));
      if(!artist.missingTracks)body.append(node('p','mm-item-note','This artist comes from the existing queue or request history. No current cached track gaps are listed.'));
      for(const album of artist.albums)body.append(albumCard(album));
      if(artist.unknownAlbumTracks.length){const unknown=node('div','mm-unknown');unknown.append(node('p','mm-item-note','Album information not provided by the source. Review these tracks before choosing albums in Lidarr.'),tracks(artist.unknownAlbumTracks));body.append(unknown);}
      details.append(body);
    });
    if(expanded.has(artist.id))details.open=true;return details;
  }
  function render() {
    $('list').replaceChildren();
    if(!data.artists.length){const empty=node('div','mm-empty');empty.append(node('h2','',data.totals.artists?'Nothing matches these filters':'No missing music to review'),node('p','',data.totals.artists?'Try another artist, source, or status. Ignored items remain available under the Ignored filter.':'Preview a Spotify playlist or sync your external playlists to discover library gaps. Nothing is sent to Lidarr automatically from this page.'));$('list').append(empty);return;}
    for(const artist of data.artists)$('list').append(artistCard(artist));
  }
  function updateEffect() {
    const album=reviewItem?.kind==='album',search=album&&$('search-album').checked,monitorMissing=!album&&$('monitor-missing').checked;
    $('effect-text').textContent=album
      ? 'Only the selected album will be monitored'+(search?' and a search requested.':'. No search will be started.')+' If its artist is new, the artist will be added without monitoring other or future albums.'
      : monitorMissing
        ? 'New artists use Lidarr’s Missing album monitoring mode; future releases are not auto-monitored. For existing active artists, only already-released albums with no files are enabled; other monitoring choices stay unchanged. No immediate catalog search is requested, but normal Lidarr automation may grab monitored releases.'
        : 'Adds this artist without monitoring albums or future releases. Existing artists are left unchanged; unchecking does not undo existing monitoring. No search is requested.';
    $('search-choice').hidden=!album;
    $('monitor-choice').hidden=album;
    $('send').textContent=album?(search?'Monitor & search this album':'Monitor this album'):monitorMissing?'Add & monitor missing':'Add artist — no search';
    $('send').disabled=busy||!chosen||!$('confirm').checked;
  }
  async function lookup() {
    const sequence=++lookupSequence;reviewData=null;chosen=null;$('confirm').checked=false;$('candidates').replaceChildren();updateEffect();$('review-message').textContent='Looking up metadata in Lidarr…';
    try{
      const result=await api(`api/${reviewItem.id}/review`,{term:$('lookup-term').value});
      if(sequence!==lookupSequence)return;reviewData=result;
      $('profile-info').textContent=`New-artist defaults: ${result.rootFolder||'root not set'} · Quality profile ${result.qualityProfile||'not set'} · Metadata profile ${result.metadataProfile||'not set'}. Existing artist profiles and paths are retained.`;
      $('review-message').textContent=result.candidates.length?`Matches for “${result.search}”. Select the correct one; nothing has been sent.`:'No matches found. Try changing the search; do not send an uncertain match.';
      for(const candidate of result.candidates){
        const label=node('label','mm-candidate'),radio=node('input');radio.type='radio';radio.name='mm-candidate';radio.value=candidate.foreignId;
        const text=node('span');text.append(node('strong','',candidate.album?`${candidate.artist} — ${candidate.album}`:candidate.artist),node('small','',[candidate.year,candidate.type,candidate.disambiguation].filter(Boolean).join(' · ')));
        radio.onchange=()=>{chosen=candidate;$('confirm').checked=false;updateEffect();};label.append(radio,text);$('candidates').append(label);
      }
    }catch(e){if(sequence===lookupSequence)$('review-message').textContent=e.message;}
  }
  async function openReview(item) {
    if(busy)return;reviewItem=item;reviewData=null;chosen=null;$('confirm').checked=false;$('search-album').checked=true;$('monitor-missing').checked=false;
    $('review-title').textContent=item.kind==='artist'?'Review artist':'Review album';$('review-context').textContent=[item.artist,item.album].filter(Boolean).join(' — ');
    $('lookup-term').value=[item.artist,item.album].filter(Boolean).join(' ');$('profile-info').textContent='';updateEffect();$('review').showModal();await lookup();
  }
  $('lookup-form').onsubmit=event=>{event.preventDefault();if(!busy)lookup();};
  $('confirm').onchange=updateEffect;$('search-album').onchange=()=>{$('confirm').checked=false;updateEffect();};
  $('monitor-missing').onchange=()=>{$('confirm').checked=false;updateEffect();};
  $('send').onclick=async()=>{
    if(busy||!chosen||!reviewData||!$('confirm').checked)return;
    busy=true;updateEffect();$('lookup-button').disabled=true;$('close').disabled=true;$('cancel').disabled=true;$('review-message').textContent='Sending this item to Lidarr…';
    try{
      const result=await api(`api/${reviewItem.id}/send`,{token:reviewData.token,foreignId:chosen.foreignId,confirm:true,
        search:reviewItem.kind==='album'&&$('search-album').checked,monitorMissing:reviewItem.kind==='artist'&&$('monitor-missing').checked});
      $('review').close();message(result.message);await load();
    }catch(e){$('review-message').textContent=e.message+' Check Lidarr before retrying; use Find matches to create a fresh review.';reviewData=null;}
    finally{busy=false;$('lookup-button').disabled=false;$('close').disabled=false;$('cancel').disabled=false;chosen=null;$('confirm').checked=false;updateEffect();}
  };
  const close=()=>{if(!busy){lookupSequence++;$('review').close();}};$('close').onclick=close;$('cancel').onclick=close;
  $('review').addEventListener('cancel',event=>{if(busy)event.preventDefault();else lookupSequence++;});
  let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=1;load();},250);};
  for(const id of ['status','source'])$(id).onchange=()=>{page=1;load();};
  $('prev').onclick=async()=>{if(page<=1)return;page--;await load();$('list').scrollIntoView({behavior:'smooth',block:'start'});};
  $('next').onclick=async()=>{if(!data||page>=data.pages)return;page++;await load();$('list').scrollIntoView({behavior:'smooth',block:'start'});};
  $('refresh').onclick=()=>load();
  $('collapse').onclick=()=>{expanded.clear();document.querySelectorAll('.mm-artist[open]').forEach(d=>{d.open=false;});};
  $('manual').onclick=async()=>{if(busy||!confirm('Disable automatic artist sending? Existing Lidarr monitoring and downloads will not be cancelled.'))return;try{await api('api/manual-mode',{});await load();message('Manual mode enabled. Automatic artist sending is off.');}catch(e){message(e.message);}};
  load();
})();
