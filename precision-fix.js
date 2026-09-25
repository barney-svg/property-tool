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
