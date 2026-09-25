// Search, EPC and fast Rightmove upgrades.
function resetResults() {
  $('results')?.classList.add('hidden');
  $('marketCard')?.classList.add('hidden');
  if ($('comparables')) $('comparables').innerHTML = '';
  if ($('marketListings')) $('marketListings').innerHTML = '';
  if ($('schoolCatchments')) $('schoolCatchments').innerHTML = '<p class="muted">Choose a property to check catchments.</p>';
  if ($('propertyChecks')) $('propertyChecks').innerHTML = '';
  if ($('propertyChecksStatus')) { $('propertyChecksStatus').textContent = 'Choose a property to run searches.'; $('propertyChecksStatus').classList.remove('hidden'); }
  if ($('shadeMapLink')) { $('shadeMapLink').removeAttribute('href'); $('shadeMapLink').classList.add('disabled'); $('shadeMapLink').setAttribute('aria-disabled','true'); }
  if ($('shadeMapAddress')) $('shadeMapAddress').textContent = 'Choose a property first';
}

function parseAddressQuery(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  const postcodeMatch = clean.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  const postcode = postcodeMatch ? normalisePostcode(postcodeMatch[0]) : '';
  const withoutPostcode = postcodeMatch ? clean.replace(postcodeMatch[0], '').replace(/\s*,\s*$/, '').trim() : clean;
  const parts = withoutPostcode.split(',').map((x) => x.trim()).filter(Boolean);
  const first = parts[0] || withoutPostcode;

  const flatMatch = first.match(/^(flat|apartment|unit)\s+([a-z0-9-]+)\s*,?\s*/i);
  let addressPart = flatMatch ? first.slice(flatMatch[0].length).trim() : first;
  let localityStart = 1;

  // Common UK flat format: "Flat 5, 10 Example Road, St Albans". The old
  // parser stopped after "Flat 5" and lost the road, which made exact address
  // matching much weaker. Pull the next comma-part in as the building/road.
  if (flatMatch && !addressPart && parts[1]) {
    addressPart = parts[1];
    localityStart = 2;
  }

  const numberMatch = addressPart.match(/^(\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?)\b\s*(.*)$/i);
  const houseNumber = numberMatch ? numberMatch[1].replace(/\s+/g, '') : '';
  const road = numberMatch ? String(numberMatch[2] || '').trim() : String(addressPart || '').trim();
  const flatLabel = flatMatch ? `${flatMatch[1][0].toUpperCase()}${flatMatch[1].slice(1).toLowerCase()} ${flatMatch[2]}` : '';
  const flatNumber = flatMatch ? String(flatMatch[2] || '').replace(/\s+/g, '') : '';
  return {
    clean, postcode, houseNumber, flatNumber,
    lookupNumber:flatNumber || houseNumber,
    road,
    locality:parts.slice(localityStart).join(', '),
    premiseLabel:[flatLabel, houseNumber].filter(Boolean).join(', ')
  };
}

function enhanceAddressRow(row, parsed) {
  const next = {...row, address:{...(row.address || {})}};
  const actualHouse = String(next.address.house_number || '').toUpperCase().replace(/\s+/g,'');
  const wanted = String(parsed?.houseNumber || '').toUpperCase().replace(/\s+/g,'');
  const matchesRoad = roadMatchesRow(next, parsed);
  const group = String(next.address.house_number || '').split(/[,;]/).map((x) => x.trim().toUpperCase()).includes(wanted);
  if (wanted && matchesRoad && (!actualHouse || group)) {
    next.address.house_number = parsed.houseNumber;
    next._premiseLabel = parsed.premiseLabel || parsed.houseNumber;
  }
  let score = 0;
  if (wanted && String(next.address.house_number || '').toUpperCase().replace(/\s+/g,'') === wanted) score += 100;
  if (matchesRoad && parsed?.road) score += 35;
  if (parsed?.postcode && manualPostcode(next).replace(/\s+/g,'') === parsed.postcode.replace(/\s+/g,'')) score += 45;
  score += Math.min(10, Math.max(0, Number(next.importance || 0) * 10));
  next._score = Math.max(Number(next._score || 0), score);
  return next;
}

async function ensurePreciseLocation(row) {
  if (!row) return row;
  const lat=Number(row.lat), lon=Number(row.lon);
  if (!row._needsPreciseGeocode && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.01 && Math.abs(lon) > 0.01) return row;
  const address = displayName(row) || row._exactDisplay || row.display_name || '';
  if (!address) return row;
  try {
    const results = await nominatim({q:`${address}, UK`},5);
    const pc = manualPostcode(row).replace(/\s+/g,'');
    const best = results.find((candidate) => manualPostcode(candidate).replace(/\s+/g,'') === pc) || results[0];
    if (!best) return row;
    return {
      ...row,
      lat:Number(best.lat),
      lon:Number(best.lon),
      address:{...(row.address||{}),...(best.address||{}),postcode:manualPostcode(row)||best?.address?.postcode||''},
      _needsPreciseGeocode:false
    };
  } catch (_) { return row; }
}

function parseEpcDetails(html) {
  const doc = new DOMParser().parseFromString(html,'text/html');
  const details = {};
  const textFor = (patterns) => {
    for (const dt of doc.querySelectorAll('dt')) {
      const label = String(dt.textContent || '').replace(/\s+/g,' ').trim();
      if (!patterns.some((p) => p.test(label))) continue;
      return String(dt.nextElementSibling?.textContent || '').replace(/\s+/g,' ').trim();
    }
    return '';
  };

  const body = String(doc.body?.innerText || doc.body?.textContent || '').replace(/\s+/g,' ');
  const areaText = textFor([/total\s+floor\s+area/i]) || body.match(/total\s+floor\s+area.{0,80}?([\d,.]+)\s*(?:square\s+metres?|sq\.?\s*m|sqm|m²|m2)/i)?.[0] || '';
  const sqm = Number(String(areaText).match(/([\d,.]+)\s*(?:square\s+metres?|sq\.?\s*m|sqm|m²|m2)/i)?.[1]?.replace(/,/g,''));
  if (Number.isFinite(sqm) && sqm >= 14 && sqm <= 3000) {
    details.sqm=Math.round(sqm*10)/10;
    details.sqft=Math.round(sqm*10.7639);
  }

  details.propertyType = textFor([/^property\s+type$/i]);
  details.builtForm = textFor([/^built\s+form$/i]);
  details.tenure = textFor([/^tenure$/i]);

  const ratingText = textFor([
    /^current\s+energy\s+(?:efficiency\s+)?rating$/i,
    /^current\s+rating$/i,
    /^energy\s+rating$/i
  ]);
  const lead = body.slice(0,2600);
  const ratingMatch =
    String(ratingText).toUpperCase().match(/\b([A-G])\b/) ||
    lead.match(/this\s+property[’']?s\s+(?:current\s+)?energy(?:\s+efficiency)?\s+rating\s+is\s+([A-G])\b/i) ||
    lead.match(/current\s+energy(?:\s+efficiency)?\s+rating\s*(?:is|:)?\s*([A-G])\b/i) ||
    lead.match(/current\s+rating\s*(?:is|:)?\s*([A-G])\b/i) ||
    lead.match(/energy\s+rating\s+([A-G])\s+valid\s+until\b/i);
  details.currentEnergyRating = ratingMatch ? String(ratingMatch[1]).toUpperCase() : '';

  const bedrooms = Number.parseInt(textFor([/^number\s+of\s+bedrooms$/i,/^bedrooms$/i]),10);
  const bathrooms = Number.parseInt(textFor([/^number\s+of\s+bathrooms$/i,/^bathrooms$/i]),10);
  const hab = Number.parseInt(textFor([/^number\s+of\s+habitable\s+rooms$/i,/^habitable\s+rooms$/i]),10);
  details.bedrooms = Number.isFinite(bedrooms) && bedrooms > 0 ? bedrooms : null;
  details.bathrooms = Number.isFinite(bathrooms) && bathrooms > 0 ? bathrooms : null;
  details.habitableRooms = Number.isFinite(hab) && hab > 0 ? hab : null;
  return details;
}

async function loadEpc(manual, listing = null) {
  if (listing?.epcUrl) {
    try { return await epcDetails(listing.epcUrl); } catch (_) {}
  }
  // A Rightmove page already exposes the EPC band in many listings. Show/use
  // that immediately instead of blocking the whole page on a postcode-wide EPC
  // scan. Exact certificate matching continues separately in the background.
  if (listing?.epcRating && !manual?._exactEpcHref) {
    return {currentEnergyRating:String(listing.epcRating).toUpperCase()};
  }
  const postcode = manualPostcode(manual) || listing?.postcode || '';
  if (!postcode) return listing?.epcRating ? {currentEnergyRating:listing.epcRating} : null;
  let match = manual?._exactEpcHref ? {href:manual._exactEpcHref,score:999} : null;
  if (!match) {
    const rows = await epcPostcodeRows(postcode);
    const ranked = rows.map((r) => ({...r,score:scoreEpcAddress(r.address,manual)})).filter((r) => r.score > 0).sort((a,b) => b.score-a.score);
    if (ranked[0]?.score >= 70 && (!ranked[1] || ranked[1].score < ranked[0].score - 8 || ranked[1].address === ranked[0].address)) match = ranked[0];
  }
  if (!match) return listing?.epcRating ? {currentEnergyRating:listing.epcRating} : null;
  try {
    const d = await epcDetails(match.href);
    if (!d.currentEnergyRating && listing?.epcRating) d.currentEnergyRating = listing.epcRating;
    return d;
  } catch (_) { return listing?.epcRating ? {currentEnergyRating:listing.epcRating} : null; }
}

function manualFromListing(listing) {
  const address=listing.exactAddress || [listing.displayAddress,listing.postcode].filter(Boolean).join(', ');
  const parsed=parseAddressQuery(address);
  return {
    lat:Number(listing.lat)||0,
    lon:Number(listing.lon)||0,
    display_name:address,
    _exactDisplay:address,
    address:{
      house_number:parsed.lookupNumber||parsed.houseNumber||'',
      road:parsed.road||'',
      postcode:listing.postcode||parsed.postcode||''
    },
    _epcPremise:epcPremise(address)
  };
}

async function resolveListingManual(listing) {
  const seed=manualFromListing(listing);
  if (Number.isFinite(Number(listing.lat)) && Number.isFinite(Number(listing.lon))) return seed;
  return ensurePreciseLocation(seed);
}

async function readRightmoveLink(value) {
  const url=new URL('/api/rightmove',location.origin);
  url.searchParams.set('url',value);
  const r=await fetch(url.toString(),{cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.ok)throw new Error(data?.error||'Could not read that Rightmove listing.');
  return data;
}

async function readRightmoveEnrichment(value) {
  const url=new URL('/api/rightmove-address',location.origin);
  url.searchParams.set('url',value);
  const r=await fetch(url.toString(),{cache:'no-store'});
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data?.ok)throw new Error(data?.error||'Could not resolve that Rightmove address.');
  return data;
}

function renderFacts(manual, epc, subject, listing, estimate) {
  const facts=[];
  const add=(label,value,extra='')=>{
    if(value!==null&&value!==undefined&&String(value)!=='')facts.push(`<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${extra}</div>`);
  };
  const address=listing?.exactAddress||displayName(manual)||listing?.displayAddress;
  $('propertyAddress').textContent=address||'Property';
  const link=$('sourceLink');
  if(listing?.url){link.href=listing.url;link.classList.remove('hidden');}else link.classList.add('hidden');

  add('Postcode',manualPostcode(manual)||listing?.postcode||'');
  add('Property type',estimate?.propertyType||typeLabel(subject?.best?.propertyType||listing?.propertyType||epc?.builtForm||epc?.propertyType)||'Unknown');

  const sqft=Number(listing?.squareFootage?.sqft||epc?.sqft);
  add('Floor area',sqft>0?`${Math.round(sqft).toLocaleString('en-GB')} sq ft`:(epc?._loading?'Checking…':'Not found'));

  const beds=estimate?.subjectBedrooms||listing?.bedrooms||epc?.bedrooms||'';
  add('Bedrooms',beds ? `${beds}${estimate?.bedroomsEstimated?' (estimated)':''}` : '');

  const rating=String(epc?.currentEnergyRating||listing?.epcRating||'').toUpperCase().match(/\b([A-G])\b/)?.[1]||'';
  const epcText=rating?`EPC rating ${rating}`:(epc?._loading?'Checking…':'Not found');
  const epcUrl=String(epc?.certificateUrl||listing?.epcUrl||'');
  add('EPC',epcText,epcUrl?`<a class="fact-link" target="_blank" rel="noopener" href="${escapeHtml(epcUrl)}">Open EPC</a>`:'');

  add('Tenure',epc?.tenure||uriTail(subject?.best?.estateType)||'');
  if(listing?.askingPrice)add('Current asking price',money(listing.askingPrice));
  if(subject?.history?.[0])add('Last registered sale',`${money(subject.history[0].amount)} · ${dateShort(subject.history[0].date)}`);
  $('facts').innerHTML=facts.join('');
}

function showImmediateProperty(manual, listing=null) {
  $('results').classList.remove('hidden');
  $('estimateMid').textContent='Checking…';
  $('estimateRange').textContent='Loading sold and current market evidence.';
  $('confidence').textContent='Working';
  $('confidence').className='confidence';
  $('explanation').innerHTML='<p>Property details and local checks are shown first while valuation evidence loads in the background.</p>';
  $('compCount').textContent='';
  $('comparables').innerHTML='<p class="muted">Checking sold comparables…</p>';
  $('marketCard').classList.add('hidden');
  renderFacts(manual,{_loading:!listing?.epcRating,currentEnergyRating:listing?.epcRating||''},null,listing,null);
}

async function enrichRightmove(listing,manual,searchValue,token){
  try{
    const extra=await readRightmoveEnrichment(searchValue);
    if(token!==state.analysisToken||state.listing!==listing)return;
    if(extra.exactAddress){
      listing.exactAddress=extra.exactAddress;
      listing.exactSource=extra.exactSource||'';
      const parsed=parseAddressQuery(extra.exactAddress);
      manual._exactDisplay=extra.exactAddress;
      manual.display_name=extra.exactAddress;
      manual._epcPremise=epcPremise(extra.exactAddress);
      manual.address={...(manual.address||{}),house_number:parsed.lookupNumber||parsed.houseNumber||manual.address?.house_number||'',road:parsed.road||manual.address?.road||'',postcode:extra.postcode||listing.postcode||parsed.postcode||''};
      $('propertyAddress').textContent=extra.exactAddress;
      renderShadeMap({lat:Number(listing.lat||manual.lat),lon:Number(listing.lon||manual.lon)},extra.exactAddress);
    }
    if(extra.epcUrl)listing.epcUrl=extra.epcUrl;
    if(extra.epcRating)listing.epcRating=extra.epcRating;
    if(extra.epcSqft&&!listing.squareFootage?.sqft)listing.squareFootage={sqft:Number(extra.epcSqft),sqm:Math.round(Number(extra.epcSqft)/10.7639*10)/10,source:'GOV.UK EPC'};

    let epc=state.lastEpc||{currentEnergyRating:listing.epcRating||''};
    if(listing.epcUrl){
      try{epc=await epcDetails(listing.epcUrl);}catch(_){}
      if(!epc?.currentEnergyRating&&listing.epcRating)epc={...(epc||{}),currentEnergyRating:listing.epcRating};
    }
    if(token!==state.analysisToken||state.listing!==listing)return;
    state.lastEpc=epc;
    renderFacts(manual,epc,state.lastSubject||null,listing,state.lastEstimate||null);
  }catch(_){}
}

async function analyse(manual, listing = null, {progressive=false} = {}) {
  const token=++state.analysisToken;
  clearError();
  if(!progressive)resetResults();
  setLoading(true,'Loading property evidence…','Matching EPC, sold prices and current market evidence.');
  setStatus('Working','loading');
  state.lastEpc=null;state.lastSubject=null;state.lastEstimate=null;

  if(progressive)$('results')?.classList.remove('hidden');

  try{
    const postcode=manualPostcode(manual)||listing?.postcode||'';
    if(!postcode)throw new Error('A full postcode is needed for the property search.');

    if(!progressive)showImmediateProperty(manual,listing);
    runPropertyExtras(manual,listing,token).catch(()=>{});

    const epcPromise=loadEpc(manual,listing).catch(()=>null);
    const postcodePromise=postcodeSales(postcode).catch(()=>[]);
    const [epc,postcodeRows]=await Promise.all([epcPromise,postcodePromise]);
    if(token!==state.analysisToken)return;

    const subject=matchSubject(postcodeRows,manual);
    state.lastEpc=epc;state.lastSubject=subject;
    renderFacts(manual,epc,subject,listing,null);

    setLoading(true,'Building estimate…','Checking recent comparable sales and current Rightmove asking prices.');
    const estimate=await buildEstimate(manual,subject,epc,listing,postcodeRows);
    if(token!==state.analysisToken)return;

    state.lastEstimate=estimate;
    renderEstimate(estimate);
    renderFacts(manual,epc,subject,listing,estimate);
    renderComparables(estimate);
    $('results').classList.remove('hidden');
    setStatus('Ready','good');
  }catch(error){
    if(token!==state.analysisToken)return;
    showError(error?.message||'Could not analyse this property.');
    setStatus('Error','bad');
  } finally {
    if(token===state.analysisToken)setLoading(false);
  }
}

async function selectAddress(row) {
  state.listing=null;
  renderSuggestions([]);
  setStatus('Working','loading');
  const precise=await ensurePreciseLocation(row);
  state.selected=precise||row;
  $('searchInput').value=displayName(state.selected);
  showImmediateProperty(state.selected,null);
  await analyse(state.selected,null,{progressive:true});
}

async function runSearch() {
  clearError();
  const value=String($('searchInput')?.value||'').trim();
  if(!value){showError(state.mode==='rightmove'?'Paste a Rightmove property link.':'Enter a property address.');return;}

  if(state.mode==='rightmove'){
    resetResults();
    setLoading(true,'Reading Rightmove listing…','Opening the listing first; address and EPC matching will continue in the background.');
    setStatus('Working','loading');
    renderSuggestions([]);
    try{
      // This endpoint now only reads the main listing page, so the useful
      // Rightmove facts appear without waiting for sold-history/EPC fallbacks.
      const listing=await readRightmoveLink(value);
      state.listing=listing;
      const manual=await resolveListingManual(listing);
      state.selected=manual;

      // Paint immediately: asking price, size, bedrooms and visible EPC letter.
      showImmediateProperty(manual,listing);
      setLoading(false);
      analyse(manual,listing,{progressive:true});
      // Wait one tick so analyse owns the current token, then enrich quietly.
      queueMicrotask(()=>enrichRightmove(listing,manual,value,state.analysisToken));
    }catch(error){
      setLoading(false);
      showError(error?.message||'Could not read that Rightmove link.');
      setStatus('Error','bad');
    }
    return;
  }

  setLoading(true,'Finding address…','Searching the exact property and postcode directory.');
  setStatus('Working','loading');
  try{
    const rows=await findAddresses(value,7,true);
    setLoading(false);
    if(!rows.length){showError('No address found. Try the house/flat number and full postcode.');setStatus('Ready');return;}
    if(rows.length===1){await selectAddress(rows[0]);return;}
    renderSuggestions(rows);
    setStatus('Choose address');
  }catch(error){
    setLoading(false);
    showError(error?.message||'Could not search addresses.');
    setStatus('Error','bad');
  }
}

// Exact postcode/house lookup: consult the GOV.UK EPC address directory in
// parallel with OpenStreetMap. This is especially useful for flats and house
// numbers that Nominatim does not return as individual addresses.
findAddresses = async function(query, limit = 7, thorough = false) {
  const q=String(query||'').trim();
  if(q.length<3)return [];
  const parsed=parseAddressQuery(q);

  const exactPromise=(parsed.lookupNumber&&parsed.postcode)
    ? exactNumberPostcodeAddresses(parsed,Math.max(limit,12)).catch(()=>[])
    : Promise.resolve([]);
  const osmPromise=(async()=>{
    let raw=[];
    if(parsed.houseNumber&&parsed.road) raw=await nominatim({street:`${parsed.houseNumber} ${parsed.road}`,city:parsed.locality,postalcode:parsed.postcode},Math.max(limit,7));
    else raw=await nominatim({q},Math.max(limit,7));
    if(thorough&&!raw.length&&parsed.houseNumber&&parsed.road)raw=await nominatim({q},Math.max(limit,7));
    return raw;
  })().catch(()=>[]);

  let [exact,raw]=await Promise.all([exactPromise,osmPromise]);
  if(exact.length&&parsed.road){
    const wanted=normaliseRoad(parsed.road);
    const tokens=wanted.split(' ').filter(t=>t.length>2);
    const filtered=exact.filter(r=>{
      const got=epcNormalise(displayName(r));
      return !tokens.length||tokens.every(t=>got.includes(t));
    });
    if(filtered.length)exact=filtered;
  }
  if(exact.length)return exact.slice(0,limit);

  const seen=new Set();
  return raw.map(row=>({lat:Number(row.lat),lon:Number(row.lon),display_name:String(row.display_name||''),address:row.address||{},importance:Number(row.importance||0)}))
    .filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lon))
    .map(r=>enhanceAddressRow(r,parsed))
    .filter(r=>{const k=`${Number(r.lat||0).toFixed(6)},${Number(r.lon||0).toFixed(6)}|${displayName(r).toLowerCase()}`;if(seen.has(k))return false;seen.add(k);return true;})
    .sort((a,b)=>(b._score||0)-(a._score||0)).slice(0,limit);
};
