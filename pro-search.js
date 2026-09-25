// v3 search speed layer: quick address resolution, EPC lookup and Rightmove prefetch.
(() => {
  const quickCache=new Map(), epcCache=new Map(), rightmovePrefetch=new Map();
  const withTimeout=(p,ms,fallback=null)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(fallback),ms))]);

  async function quickAddressSearch(query,limit=8,autocomplete=false){
    const key=`${autocomplete?'a':'s'}|${limit}|${String(query).trim().toLowerCase()}`;
    const hit=quickCache.get(key);if(hit&&Date.now()-hit.time<300000)return hit.rows;
    const url=new URL('/api/address-quick',location.origin);url.searchParams.set('q',query);url.searchParams.set('limit',String(limit));if(autocomplete)url.searchParams.set('mode','autocomplete');
    const r=await fetch(url,{cache:'no-store'}),d=await r.json().catch(()=>({}));if(!r.ok||!d?.ok)throw new Error(d?.error||'Address lookup failed.');
    const parsed=parseAddressQuery(query);
    const rows=(d.rows||[]).map(row=>enhanceAddressRow({...row,lat:Number(row.lat),lon:Number(row.lon),address:row.address||{},_exactDisplay:row._exactDisplay||'',_exactEpcHref:row._exactEpcHref||'',_needsPreciseGeocode:Boolean(row._needsPreciseGeocode)},parsed)).sort((a,b)=>(b._score||0)-(a._score||0));
    quickCache.set(key,{time:Date.now(),rows});return rows;
  }

  findAddresses=async function(query,limit=7,thorough=false){
    try{return await quickAddressSearch(query,limit,!thorough);}catch(_){
      const parsed=parseAddressQuery(query),raw=await nominatim({q:String(query||'').trim()},limit).catch(()=>[]);
      return raw.map(r=>enhanceAddressRow({lat:Number(r.lat),lon:Number(r.lon),display_name:String(r.display_name||''),address:r.address||{},importance:Number(r.importance||0)},parsed)).slice(0,limit);
    }
  };

  const oldLoadEpc=loadEpc;
  loadEpc=async function(manual,listing=null){
    if(listing?.epcUrl){try{return await withTimeout(epcDetails(listing.epcUrl),1800,{currentEnergyRating:listing.epcRating||'',certificateUrl:listing.epcUrl});}catch(_){}}
    if(listing?.epcRating&&!listing?.exactAddress)return{currentEnergyRating:String(listing.epcRating).toUpperCase()};
    const address=listing?.exactAddress||displayName(manual)||listing?.displayAddress||'',postcode=manualPostcode(manual)||listing?.postcode||'';
    if(!postcode)return listing?.epcRating?{currentEnergyRating:listing.epcRating}:null;
    const key=`${address}|${postcode}`.toLowerCase(),hit=epcCache.get(key);if(hit&&Date.now()-hit.time<1800000)return hit.value;
    try{const u=new URL('/api/subject-epc',location.origin);u.searchParams.set('address',address);u.searchParams.set('postcode',postcode);const r=await fetch(u,{cache:'no-store'}),d=await r.json().catch(()=>({}));if(r.ok&&d?.ok&&d?.found){const value={currentEnergyRating:d.currentEnergyRating||listing?.epcRating||'',sqm:d.sqm||null,sqft:d.sqft||null,propertyType:d.propertyType||'',builtForm:d.builtForm||'',tenure:d.tenure||'',habitableRooms:d.habitableRooms||null,certificateUrl:d.certificateUrl||''};epcCache.set(key,{time:Date.now(),value});return value;}}catch(_){}
    if(listing?.epcRating)return{currentEnergyRating:String(listing.epcRating).toUpperCase()};
    try{return await withTimeout(oldLoadEpc(manual,listing),1800,null);}catch(_){return null;}
  };

  selectAddress=async function(row){
    state.listing=null;renderSuggestions([]);setStatus('Working','loading');state.selected=row;$('searchInput').value=displayName(row);showImmediateProperty(row,null);analyse(row,null,{progressive:true});
    ensurePreciseLocation(row).then(precise=>{if(!precise||state.selected!==row)return;Object.assign(row,precise);runPropertyExtras(row,null,state.analysisToken).catch(()=>{});}).catch(()=>{});
  };

  const originalReadRightmove=readRightmoveLink;
  readRightmoveLink=async function(value){const id=String(value||'').match(/rightmove\.co\.uk\/properties\/(\d+)/i)?.[1];if(!id)return originalReadRightmove(value);if(!rightmovePrefetch.has(id))rightmovePrefetch.set(id,originalReadRightmove(value).finally(()=>setTimeout(()=>rightmovePrefetch.delete(id),30000)));return rightmovePrefetch.get(id);};
  function prefetchRightmove(value){const id=String(value||'').match(/rightmove\.co\.uk\/properties\/(\d+)/i)?.[1];if(!id||rightmovePrefetch.has(id))return;rightmovePrefetch.set(id,originalReadRightmove(value).finally(()=>setTimeout(()=>rightmovePrefetch.delete(id),30000)));}

  runSearch=async function(){
    clearError();const value=String($('searchInput')?.value||'').trim();if(!value){showError(state.mode==='rightmove'?'Paste a Rightmove property link.':'Enter a property address.');return;}
    const rm=/rightmove\.co\.uk\/properties\/\d+/i.test(value);if(rm&&state.mode!=='rightmove'){setMode('rightmove');$('searchInput').value=value;}
    if(rm||state.mode==='rightmove'){
      resetResults();setLoading(true,'Rightmove link recognised','Loading the listing now — deeper matching will continue after it appears.');setStatus('Working','loading');renderSuggestions([]);prefetchRightmove(value);
      try{const listing=await readRightmoveLink(value);state.listing=listing;const manual=manualFromListing(listing);state.selected=manual;showImmediateProperty(manual,listing);setLoading(false);analyse(manual,listing,{progressive:true});queueMicrotask(()=>enrichRightmove(listing,manual,value,state.analysisToken));}
      catch(error){setLoading(false);showError(error?.message||'Could not read that Rightmove link.');setStatus('Error','bad');}return;
    }
    setLoading(true,'Finding property…','Matching the address and postcode.');setStatus('Working','loading');
    try{const rows=await findAddresses(value,8,true);setLoading(false);if(!rows.length){showError('No exact address found. Try the house/flat number and full postcode.');setStatus('Ready');return;}const parsed=parseAddressQuery(value),top=rows[0];if(parsed.lookupNumber&&parsed.postcode&&(top?._exactDisplay||(top?._score||0)>=170)){selectAddress(top);return;}if(rows.length===1){selectAddress(rows[0]);return;}renderSuggestions(rows);setStatus('Choose address');}
    catch(error){setLoading(false);showError(error?.message||'Could not search addresses.');setStatus('Error','bad');}
  };

  const oldSetMode=setMode;
  setMode=function(mode){oldSetMode(mode);if($('searchInput'))$('searchInput').placeholder='';if(mode==='address')$('helperText').textContent='Type an address or use house/flat number + full postcode for the fastest exact match.';else $('helperText').textContent='Paste a Rightmove link — it starts loading as soon as the link is recognised.';};
  if($('searchInput'))$('searchInput').placeholder='';
  $('searchInput')?.addEventListener('paste',e=>{const text=(e.clipboardData||window.clipboardData)?.getData('text')||'';if(!/rightmove\.co\.uk\/properties\/\d+/i.test(text))return;setTimeout(()=>{setMode('rightmove');$('searchInput').value=text.trim();prefetchRightmove(text);setTimeout(()=>runSearch(),60);},0);});
  $('searchInput')?.addEventListener('input',()=>{const v=$('searchInput').value;if(/rightmove\.co\.uk\/properties\/\d+/i.test(v))prefetchRightmove(v);});
})();
