// EPC postcode rows use a postcode centroid at first. Resolve the selected
// address to its own coordinates before school/dataset checks.
ensurePreciseLocation = async function(row) {
  if(!row)return row;
  const lat=Number(row.lat),lon=Number(row.lon);
  const needs=Boolean(row._exactEpcHref||row._needsPreciseGeocode)||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)<=.01||Math.abs(lon)<=.01;
  if(!needs)return row;
  const address=displayName(row)||row._exactDisplay||row.display_name||'';
  if(!address)return row;
  try{
    const results=await nominatim({q:`${address}, UK`},5);
    const pc=manualPostcode(row).replace(/\s+/g,'');
    const best=results.find(x=>manualPostcode(x).replace(/\s+/g,'')===pc)||results[0];
    if(!best)return row;
    return {...row,lat:Number(best.lat),lon:Number(best.lon),address:{...(row.address||{}),...(best.address||{}),postcode:manualPostcode(row)||best?.address?.postcode||''},_needsPreciseGeocode:false};
  }catch(_){return row;}
};

// Never hold up the first Rightmove paint just because the listing coordinates
// are missing. Precise geocoding is already handled by the local-check task.
resolveListingManual = async function(listing){
  return manualFromListing(listing);
};

// If the normal Rightmove sold-history route resolves the exact address, match
// its EPC afterwards so the already-visible EPC letter can become a certificate
// link without delaying the main result.
const enrichRightmoveBase = enrichRightmove;
enrichRightmove = async function(listing,manual,searchValue,token){
  await enrichRightmoveBase(listing,manual,searchValue,token);
  if(token!==state.analysisToken||state.listing!==listing||listing.epcUrl||!listing.exactAddress)return;
  const pc=manualPostcode(manual)||listing.postcode||'';
  if(!pc)return;
  try{
    const rows=await epcPostcodeRows(pc);
    const ranked=rows.map(r=>({...r,score:scoreEpcAddress(r.address,manual)})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score);
    const best=ranked[0];
    const unique=best&&best.score>=70&&(!ranked[1]||ranked[1].score<best.score-8||ranked[1].address===best.address);
    if(!unique)return;
    listing.epcUrl=new URL(best.href,'https://find-energy-certificate.service.gov.uk').toString();
    const details=await epcDetails(best.href).catch(()=>null);
    if(token!==state.analysisToken||state.listing!==listing)return;
    if(details){
      state.lastEpc=details;
      if(!details.currentEnergyRating&&listing.epcRating)details.currentEnergyRating=listing.epcRating;
      renderFacts(manual,details,state.lastSubject||null,listing,state.lastEstimate||null);
    }else{
      renderFacts(manual,{currentEnergyRating:listing.epcRating||''},state.lastSubject||null,listing,state.lastEstimate||null);
    }
  }catch(_){}
};
