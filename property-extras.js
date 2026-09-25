const SCHOOL_CATCHMENTS=[
{name:'Beaumont',radiusMetres:1359.11,lat:51.75530556,lon:-0.29900000},
{name:'Sandringham',radiusMetres:1013.94,lat:51.77069444,lon:-0.30780556},
{name:'Samuel Ryder',radiusMetres:4227.18,lat:51.73883900,lon:-0.31101400},
{name:'Verulam',radiusMetres:2133.44,lat:51.75538889,lon:-0.31619444}
];
const PROPERTY_CHECKS=[
{key:'flood-risk-zone',label:'Flood Risk',kind:'flood'},
{key:'conservation-area',label:'Conservation Area'},
{key:'article-4-direction-area',label:'Article 4'},
{key:'listed-building',label:'Listed Building',kind:'listed'},
{key:'green-belt',label:'Green Belt'},
{key:'tree-preservation-zone',label:'Tree Protection'}
];

function distanceMetres(lat1,lon1,lat2,lon2){
  const R=6371000, rad=(d)=>d*Math.PI/180;
  const p1=rad(lat1),p2=rad(lat2),dp=rad(lat2-lat1),dl=rad(lon2-lon1);
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function renderSchools(point){
  const host=$('schoolCatchments');
  if(!host)return;
  if(!point){host.innerHTML='<p class="muted">Property location not available.</p>';return;}
  host.innerHTML=SCHOOL_CATCHMENTS.map((school)=>{
    const distance=distanceMetres(point.lat,point.lon,school.lat,school.lon);
    const inside=distance<=school.radiusMetres;
    return `<div class="local-row">
      <span class="local-dot ${inside?'good':'bad'}">${inside?'✓':'×'}</span>
      <div><strong>${escapeHtml(school.name)}</strong><small>${inside?'Within catchment distance':'Outside catchment distance'} · ${Math.round(distance).toLocaleString('en-GB')} m away · catchment ${school.radiusMetres.toLocaleString('en-GB',{maximumFractionDigits:0})} m</small></div>
      <b class="local-result ${inside?'good':'bad'}">${inside?'IN':'OUT'}</b>
    </div>`;
  }).join('');
}

function entityList(data){
  if(Array.isArray(data?.entities))return data.entities;
  if(Array.isArray(data?.results))return data.results;
  return Array.isArray(data)?data:[];
}

function pointFromWkt(value){
  const m=String(value||'').match(/POINT\s*\(\s*([-+\d.]+)\s+([-+\d.]+)\s*\)/i);
  if(!m)return null;
  const lon=Number(m[1]),lat=Number(m[2]);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}

function mainBuildingNumber(address){
  const noPc=String(address||'').replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/ig,'').replace(/\s+,/g,',').replace(/,\s*$/,'').trim();
  const parts=noPc.split(',').map((x)=>x.trim()).filter(Boolean);
  if(!parts.length)return '';
  if(/^(?:flat|apartment|unit)\b/i.test(parts[0])&&parts[1])return parts[1].match(/^(\d+[a-z]?)/i)?.[1]?.toUpperCase()||'';
  if(/^\d+[a-z]?$/i.test(parts[0])&&parts[1])return (parts[1].match(/^(\d+[a-z]?)/i)?.[1]||parts[0]).toUpperCase();
  return parts[0].match(/^(\d+[a-z]?)/i)?.[1]?.toUpperCase()||'';
}

function listingNameMatchesNumber(name,wantedNumber){
  const wanted=String(wantedNumber||'').toUpperCase();
  const wantedBase=Number(wanted.match(/^\d+/)?.[0]);
  if(!Number.isFinite(wantedBase))return false;
  const text=String(name||'').toUpperCase();
  const range=text.match(/\b(\d+)\s*[-–]\s*(\d+)\b/);
  if(range&&wantedBase>=Math.min(Number(range[1]),Number(range[2]))&&wantedBase<=Math.max(Number(range[1]),Number(range[2])))return true;
  return [...text.matchAll(/\b(\d+)[A-Z]?\b/g)].map((m)=>Number(m[1])).includes(wantedBase);
}

function listedFallbackMatches(item,point,address){
  const wanted=mainBuildingNumber(address);
  if(wanted&&listingNameMatchesNumber(item?.name,wanted))return true;
  const p=pointFromWkt(item?.point);
  return Boolean(p&&point&&distanceMetres(point.lat,point.lon,p.lat,p.lon)<=18);
}

function nearbyGeometry(point,metres=35){
  const latDelta=metres/111320;
  const lonScale=Math.max(.2,Math.cos(point.lat*Math.PI/180));
  const lonDelta=metres/(111320*lonScale);
  const minLat=point.lat-latDelta,maxLat=point.lat+latDelta,minLon=point.lon-lonDelta,maxLon=point.lon+lonDelta;
  return `POLYGON((${minLon} ${minLat},${maxLon} ${minLat},${maxLon} ${maxLat},${minLon} ${maxLat},${minLon} ${minLat}))`;
}

async function planningFetch(url){
  return entityList(await proxyJson(url.toString(),5*60_000));
}

function checkView(check,items){
  if(check.kind==='flood'){
    if(!items.length)return{status:'Not flagged',tone:'good',detail:'No flood zone returned'};
    const levels=items.map((x)=>Number(x['flood-risk-level'])).filter(Number.isFinite);
    const level=levels.length?Math.max(...levels):null;
    if(level===3)return{status:'Zone 3',tone:'bad',detail:'Flood Risk Zone 3'};
    if(level===2)return{status:'Zone 2',tone:'warn',detail:'Flood Risk Zone 2'};
    if(level===1)return{status:'Zone 1',tone:'good',detail:'Flood Risk Zone 1'};
    return{status:'Flagged',tone:'warn',detail:'Flood risk zone found'};
  }
  if(check.kind==='listed'){
    if(!items.length)return{status:'No match found',tone:'good',detail:'No listed-building match returned'};
    const grade=items.map((x)=>x['listed-building-grade']||x.listed_building_grade).find(Boolean)||'Listed';
    const item=items[0]||{};
    return{status:grade,tone:'bad',detail:[item.name,item.reference?`Historic England ref ${item.reference}`:''].filter(Boolean).join(' · ')||'Listed building'};
  }
  if(!items.length)return{status:'Not flagged',tone:'good',detail:'No matching designation returned'};
  const names=items.map((x)=>x.name||x.description||x.reference).filter(Boolean);
  return{status:'YES',tone:'bad',detail:names.slice(0,3).join(' · ')||`${items.length} result${items.length===1?'':'s'}`};
}

function renderChecks(grouped){
  const host=$('propertyChecks');
  if(!host)return;
  host.innerHTML=PROPERTY_CHECKS.map((check)=>{
    const view=checkView(check,grouped[check.key]||[]);
    return `<div class="check-row">
      <span class="check-dot ${view.tone}"></span>
      <div><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(view.status)}</small><em>${escapeHtml(view.detail)}</em></div>
    </div>`;
  }).join('');
}

async function loadPropertyChecks(point,postcode,address){
  const status=$('propertyChecksStatus');
  if(status){status.textContent='Checking property…';status.classList.remove('hidden');}
  try{
    const exactUrl=new URL('https://www.planning.data.gov.uk/entity.json');
    exactUrl.searchParams.set('latitude',String(point.lat));
    exactUrl.searchParams.set('longitude',String(point.lon));
    PROPERTY_CHECKS.forEach((check)=>exactUrl.searchParams.append('dataset',check.key));
    exactUrl.searchParams.append('dataset','listed-building-outline');
    exactUrl.searchParams.set('limit','100');
    const exact=await planningFetch(exactUrl);
    const exactListed=exact.filter((x)=>['listed-building','listed-building-outline'].includes(x.dataset||x.prefix));
    let fallbackListed=[];

    if(postcode){
      try{
        const u=new URL('https://www.planning.data.gov.uk/entity.json');
        u.searchParams.set('q',postcode);
        u.searchParams.append('dataset','listed-building');
        u.searchParams.append('dataset','listed-building-outline');
        u.searchParams.set('limit','100');
        fallbackListed=(await planningFetch(u)).filter((x)=>listedFallbackMatches(x,point,address));
      }catch(_){}
    }
    if(!exactListed.length&&!fallbackListed.length){
      try{
        const u=new URL('https://www.planning.data.gov.uk/entity.json');
        u.searchParams.set('geometry',nearbyGeometry(point,35));
        u.searchParams.set('geometry_relation','intersects');
        u.searchParams.append('dataset','listed-building');
        u.searchParams.append('dataset','listed-building-outline');
        u.searchParams.set('limit','100');
        fallbackListed=(await planningFetch(u)).filter((x)=>listedFallbackMatches(x,point,address));
      }catch(_){}
    }

    const merged=[...exact,...fallbackListed];
    const grouped=Object.fromEntries(PROPERTY_CHECKS.map((c)=>[c.key,[]]));
    const seen=new Set();
    for(const entity of merged){
      const key=String(entity?.entity||`${entity?.dataset||entity?.prefix||''}|${entity?.reference||''}|${entity?.point||''}|${entity?.name||''}`);
      if(seen.has(key))continue;seen.add(key);
      let dataset=entity.dataset||entity.prefix;
      if(dataset==='listed-building-outline')dataset='listed-building';
      if(grouped[dataset])grouped[dataset].push(entity);
    }
    renderChecks(grouped);
    if(status)status.classList.add('hidden');
  }catch(_){
    if(status)status.textContent='Could not load property searches.';
    if($('propertyChecks'))$('propertyChecks').innerHTML='';
  }
}

function shadeMapUrl(point,address=''){
  if(!point)return '';
  const zoom=18.25;
  return `https://shademap.app/@${Number(point.lat).toFixed(5)},${Number(point.lon).toFixed(5)},${zoom}z`;
}

function renderShadeMap(point,address){
  const link=$('shadeMapLink'),copy=$('shadeMapAddress');
  if(!link)return;
  const url=shadeMapUrl(point,address);
  if(copy)copy.textContent=address||'Property location';
  if(url){link.href=url;link.classList.remove('disabled');link.removeAttribute('aria-disabled');}
  else{link.removeAttribute('href');link.classList.add('disabled');link.setAttribute('aria-disabled','true');}
}

async function runPropertyExtras(manual,listing,token){
  let resolved=manual;
  if(!(Number.isFinite(Number(listing?.lat))&&Number.isFinite(Number(listing?.lon)))){
    resolved=await ensurePreciseLocation(manual);
    if(token!==state.analysisToken)return;
    if(resolved&&resolved!==manual)Object.assign(manual,resolved);
  }
  const lat=Number(listing?.lat??manual?.lat),lon=Number(listing?.lon??manual?.lon);
  const point=Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)>.01&&Math.abs(lon)>.01?{lat,lon}:null;
  renderSchools(point);
  renderShadeMap(point,listing?.exactAddress||displayName(manual)||listing?.displayAddress||'');
  if(point){
    const postcode=manualPostcode(manual)||listing?.postcode||'';
    const address=listing?.exactAddress||displayName(manual)||listing?.displayAddress||'';
    loadPropertyChecks(point,postcode,address).catch(()=>{});
  }else{
    if($('propertyChecksStatus'))$('propertyChecksStatus').textContent='Property location not available.';
    if($('propertyChecks'))$('propertyChecks').innerHTML='';
  }
}
