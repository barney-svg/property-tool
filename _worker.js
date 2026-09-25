const HOSTS = new Set([
  'www.rightmove.co.uk',
  'find-energy-certificate.service.gov.uk',
  'landregistry.data.gov.uk',
  'nominatim.openstreetmap.org'
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
  });
}

function cleanText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&pound;|&#163;/gi, '£')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = String(value || '').replace(/,/g,'').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function normalisePostcode(value) {
  const compact = String(value || '').toUpperCase().replace(/-/g,' ').replace(/\s+/g,'').trim();
  const m = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  return m ? `${m[1]} ${m[2]}` : '';
}

function extractAssignedObject(scriptText, marker) {
  const markerIndex = scriptText.indexOf(marker);
  if (markerIndex < 0) return null;
  const equals = scriptText.indexOf('=', markerIndex + marker.length);
  const start = scriptText.indexOf('{', equals);
  if (equals < 0 || start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < scriptText.length; i++) {
    const ch = scriptText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(scriptText.slice(start, i + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function decodeFlattened(data) {
  let values = data;
  if (typeof values === 'string') {
    try { values = JSON.parse(values); } catch (_) { return null; }
  }
  if (!Array.isArray(values) || !values.length) return null;
  const cache = new Map();
  function decode(index) {
    if (!Number.isInteger(index)) return index;
    if (index === -1 || index === -2) return undefined;
    if (index === -3) return NaN;
    if (index === -4) return Infinity;
    if (index === -5) return -Infinity;
    if (index === -6) return -0;
    if (index < 0 || index >= values.length) return undefined;
    if (cache.has(index)) return cache.get(index);
    const raw = values[index];
    if (raw === null || typeof raw !== 'object') { cache.set(index, raw); return raw; }
    if (Array.isArray(raw)) {
      const arr = []; cache.set(index, arr);
      for (const item of raw) arr.push(Number.isInteger(item) ? decode(item) : item);
      return arr;
    }
    const obj = {}; cache.set(index, obj);
    for (const [key, value] of Object.entries(raw)) obj[key] = Number.isInteger(value) ? decode(value) : value;
    return obj;
  }
  try { return decode(0); } catch (_) { return null; }
}

function pageModel(html) {
  let model = null;
  if (html.includes('window.__PAGE_MODEL')) {
    const packed = extractAssignedObject(html, 'window.__PAGE_MODEL');
    if (packed) model = decodeFlattened(packed.data);
  }
  if (!model?.propertyData && html.includes('window.PAGE_MODEL')) model = extractAssignedObject(html, 'window.PAGE_MODEL');
  return model?.propertyData ? model : null;
}

function floorArea(pd) {
  const sizings = Array.isArray(pd?.sizings) ? pd.sizings : [];
  const ft = sizings.find(s => String(s?.unit || '').toLowerCase() === 'sqft');
  const mt = sizings.find(s => ['sqm','sq m','m2','m²'].includes(String(s?.unit || '').toLowerCase()));
  const sqft = Number(ft?.minimumSize ?? ft?.min ?? ft?.maximumSize ?? ft?.max);
  const sqm = Number(mt?.minimumSize ?? mt?.min ?? mt?.maximumSize ?? mt?.max);
  if (Number.isFinite(sqft) && sqft >= 150 && sqft <= 30000) return {sqft:Math.round(sqft),sqm:Number.isFinite(sqm)?Math.round(sqm*10)/10:Math.round((sqft/10.7639)*10)/10,source:'Rightmove size'};
  if (Number.isFinite(sqm) && sqm >= 14 && sqm <= 3000) return {sqft:Math.round(sqm*10.7639),sqm:Math.round(sqm*10)/10,source:'Rightmove size'};
  const price = parseMoney(pd?.prices?.primaryPrice), ppsf = parseMoney(pd?.prices?.pricePerSqFt);
  if (price && ppsf) {
    const inferred = price / ppsf;
    if (inferred >= 150 && inferred <= 30000) return {sqft:Math.round(inferred),sqm:Math.round((inferred/10.7639)*10)/10,source:'Rightmove price per sq ft'};
  }
  return null;
}

const ADDRESS_SHAPE = /\{\\?"displayAddress\\?":\d+,\\?"countryCode\\?":\d+,\\?"deliveryPointId\\?":\d+,\\?"ukCountry\\?":\d+,\\?"outcode\\?":\d+,\\?"incode\\?":\d+\}/.source;
const FLAT_TOKEN = /(?:\\?"[^"\\]*\\?"|\d+)/.source;

function identifiers(html, pd) {
  let deliveryPointId = Number(pd?.address?.deliveryPointId ?? pd?.deliveryPointId) || null;
  let postcode = normalisePostcode(pd?.address?.outcode && pd?.address?.incode ? `${pd.address.outcode} ${pd.address.incode}` : '');
  if (!deliveryPointId) {
    const m = html.match(new RegExp(`${ADDRESS_SHAPE},${FLAT_TOKEN},${FLAT_TOKEN},(\\d+)`));
    if (m) deliveryPointId = Number(m[1]);
  }
  if (!postcode) {
    const m = html.match(new RegExp(`${ADDRESS_SHAPE},(?:${FLAT_TOKEN},)*?\\\\?"([^"\\\\]+)\\\\?",\\\\?"([^"\\\\]+)\\\\?",\\[`));
    if (m) postcode = normalisePostcode(`${m[1]} ${m[2]}`);
  }
  return {deliveryPointId:Number.isFinite(deliveryPointId)?deliveryPointId:null,postcode};
}

function soldCards(html) {
  const raw = String(html || ''), starts = [];
  const startRe = /<a\b[^>]*data-testid\s*=\s*["']propertyCard["'][^>]*>/gi;
  let m; while ((m = startRe.exec(raw))) starts.push(m.index);
  const chunks = [];
  if (starts.length) for (let i=0;i<starts.length;i++) chunks.push(raw.slice(starts[i],starts[i+1] ?? raw.length));
  else { const split = raw.split(/data-testid\s*=\s*["']propertyCard["']/i); for (let i=1;i<split.length;i++) chunks.push(split[i]); }
  const cards = [];
  for (const chunk of chunks) {
    const address = cleanText(chunk.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]);
    if (!address) continue;
    const transactions = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let row;
    while ((row = rowRe.exec(chunk))) {
      const cells = []; const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi; let td;
      while ((td = tdRe.exec(row[1]))) cells.push(cleanText(td[1]));
      const year = cells[0]?.match(/\b(19|20)\d{2}\b/)?.[0] || '';
      if (year && parseMoney(cells[1])) transactions.push({year,price:cells[1]});
    }
    if (!transactions.length) {
      const text = cleanText(chunk), re = /\b((?:19|20)\d{2})\b[\s\S]{0,80}?£\s*([\d,]+)/g; let tx;
      while ((tx = re.exec(text))) transactions.push({year:tx[1],price:`£${tx[2]}`});
    }
    cards.push({address,transactions});
  }
  return cards;
}

function matchSoldAddress(cards, history) {
  for (const sold of Array.isArray(history) ? history : []) {
    const year = String(sold?.year ?? sold?.soldYear ?? sold?.date ?? '').match(/\b(19|20)\d{2}\b/)?.[0] || '';
    const price = parseMoney(sold?.soldPrice ?? sold?.price ?? sold?.amount);
    if (!year || !price) continue;
    for (const card of cards) if (card.transactions.some(tx => tx.year === year && parseMoney(tx.price) === price)) return card.address;
  }
  return '';
}

function visibleEpc(html) {
  const text = cleanText(String(html || '').slice(0,250000));
  return (text.match(/this property[’']?s (?:current )?energy(?: efficiency)? rating is ([A-G])\b/i)?.[1] || text.match(/current energy(?: efficiency)? rating.{0,50}?\b([A-G])\b/i)?.[1] || text.match(/\bEPC\s*(?:rating)?\s*[:\-]?\s*([A-G])\b/i)?.[1] || '').toUpperCase();
}

function titleCaseAddress(value) {
  const raw = cleanText(value);
  const pc = raw.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] || '';
  const postcode = normalisePostcode(pc);
  const body = pc ? raw.replace(pc,'').replace(/[\s,]+$/,'') : raw;
  const out = body.split(',').map(part => part.trim().split(/\s+/).map(word => /^\d+[a-z]?$/i.test(word) ? word.toUpperCase() : word.split(/([-'’])/).map(p => /[-'’]/.test(p) ? p : p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()).join('')).join(' ')).filter(Boolean).join(', ');
  return [out,postcode].filter(Boolean).join(', ');
}

function epcRows(html, postcode) {
  const rows = [], seen = new Set();
  const re = /<a\b([^>]*href=["']([^"']*\/energy-certificate\/[^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html))) {
    const href = m[2], address = titleCaseAddress(m[3]);
    if (!href || !address || seen.has(href)) continue;
    seen.add(href);
    const near = cleanText(html.slice(Math.max(0,m.index-900),Math.min(html.length,re.lastIndex+1200)));
    const rating = (near.match(/(?:current\s+)?energy(?:\s+efficiency)?\s+rating\s*[:\-]?\s*([A-G])\b/i)?.[1] || near.match(/\bEPC\s*(?:rating)?\s*[:\-]?\s*([A-G])\b/i)?.[1] || '').toUpperCase();
    rows.push({href,address,postcode,rating});
  }
  const next = html.match(/<a\b[^>]*(?:rel=["']next["']|aria-label=["'][^"']*next[^"']*["'])[^>]*href=["']([^"']+)["']/i)?.[1] || '';
  return {rows,next};
}

function streetTokens(title) {
  const stop = new Set(['road','street','avenue','close','drive','lane','way','gardens','court','place','crescent','terrace','st','albans','herts','hertfordshire','property','for','sale']);
  return String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(t => t.length >= 4 && !stop.has(t)).slice(0,8);
}

async function upstream(url, accept='*/*', ttl=180) {
  const key = new Request(url,{headers:{'x-pbea-cache':'1'}}), cache = caches.default;
  if (ttl) { const hit = await cache.match(key); if (hit) return hit.clone(); }
  const response = await fetch(url,{headers:{Accept:accept,'Accept-Language':'en-GB,en;q=0.9'},redirect:'follow'});
  if (ttl && response.ok) {
    const stored = new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers});
    stored.headers.set('Cache-Control',`public, max-age=${ttl}`); await cache.put(key,stored.clone()); return stored;
  }
  return response;
}
async function text(url,ttl=180){const r=await upstream(url,'text/html,application/xhtml+xml,*/*;q=0.8',ttl);if(!r.ok)throw new Error(`Upstream returned ${r.status}`);return r.text();}
async function data(url,ttl=120){const r=await upstream(url,'application/json,*/*;q=0.8',ttl);if(!r.ok)throw new Error(`Upstream returned ${r.status}`);return r.json();}

async function epcFallback(postcode,title,rating,listingSqft) {
  if (!postcode || !rating) return null;
  let url = `https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?postcode=${encodeURIComponent(postcode)}`;
  const tokens = streetTokens(title), relevant = [], seen = new Set(); let complete = true;
  for (let page=0;page<3&&url;page++) {
    let html; try { html = await text(url,600); } catch (_) { complete=false; break; }
    const parsed = epcRows(html,postcode);
    for (const row of parsed.rows) {
      if (seen.has(row.href)) continue; seen.add(row.href);
      const a = row.address.toLowerCase(); if (!tokens.length || tokens.some(t => a.includes(t))) relevant.push(row);
    }
    if (!parsed.next) { url=''; break; }
    url = new URL(parsed.next,'https://find-energy-certificate.service.gov.uk').toString();
    if (page===2 && url) complete=false;
  }
  if (!complete || !relevant.length || relevant.length>12) return null;
  const matches = relevant.filter(r => r.rating === rating);
  if (matches.length === 1) return {address:matches[0].address,epcUrl:new URL(matches[0].href,'https://find-energy-certificate.service.gov.uk').toString()};
  if (matches.length > 1 && matches.length <= 4 && Number.isFinite(Number(listingSqft))) {
    const candidates = [];
    for (const row of matches) try {
      const certUrl = new URL(row.href,'https://find-energy-certificate.service.gov.uk').toString();
      const html = await text(certUrl,1800), plain = cleanText(html);
      const sqm = Number(plain.match(/total floor area.{0,80}?([\d,.]+)\s*(?:square metres?|sq\.?\s*m|sqm|m²|m2)/i)?.[1]?.replace(/,/g,''));
      const sqft = Number.isFinite(sqm) ? sqm*10.7639 : null;
      if (Number.isFinite(sqft)) candidates.push({row,certUrl,diff:Math.abs(sqft-listingSqft)});
    } catch (_) {}
    candidates.sort((a,b)=>a.diff-b.diff);
    if (candidates[0] && (!candidates[1] || candidates[0].diff+45<candidates[1].diff) && candidates[0].diff<=Math.max(90,listingSqft*.12)) return {address:candidates[0].row.address,epcUrl:candidates[0].certUrl};
  }
  return null;
}

async function rightmove(propertyUrl) {
  const id = String(propertyUrl || '').match(/rightmove\.co\.uk\/properties\/(\d+)/i)?.[1] || '';
  if (!id) throw new Error('Paste a Rightmove property link.');
  const canonical = `https://www.rightmove.co.uk/properties/${id}`;
  const html = await text(canonical,120), model = pageModel(html), pd = model?.propertyData || {};
  const ids = identifiers(html,pd), loc = pd?.location || {}, size = floorArea(pd);
  const displayAddress = String(pd?.address?.displayAddress || cleanText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) || `Rightmove property ${id}`).trim();
  const askingPrice = parseMoney(pd?.prices?.primaryPrice) || parseMoney(cleanText(html).match(/£\s*[\d,]{5,}/)?.[0]);
  const epcRating = visibleEpc(html); let exactAddress='', exactSource='', epcUrl='';
  if (ids.deliveryPointId && ids.postcode && ids.postcode.toLowerCase().replace(/\s+/g,'-') !== 'rh13-9jl') try {
    const history = await data(`https://www.rightmove.co.uk/properties/api/soldProperty/transactionHistory?deliveryPointId=${encodeURIComponent(String(ids.deliveryPointId))}`,600);
    const tx = history?.soldPropertyTransactions || history?.transactions || [];
    if (Array.isArray(tx) && tx.length) {
      const sold = await text(`https://www.rightmove.co.uk/house-prices/${ids.postcode.toLowerCase().replace(/\s+/g,'-')}.html`,900);
      const match = matchSoldAddress(soldCards(sold),tx);
      if (match) { exactAddress=titleCaseAddress(`${match}, ${ids.postcode}`); exactSource='Rightmove sold history'; }
    }
  } catch (_) {}
  if (!exactAddress && epcRating && ids.postcode) try {
    const fallback = await epcFallback(ids.postcode,displayAddress,epcRating,size?.sqft);
    if (fallback?.address) { exactAddress=fallback.address; epcUrl=fallback.epcUrl || ''; exactSource='EPC match'; }
  } catch (_) {}
  return {ok:true,propertyId:id,url:canonical,displayAddress,exactAddress,exactSource,postcode:ids.postcode,deliveryPointId:ids.deliveryPointId,lat:Number.isFinite(Number(loc.latitude))?Number(loc.latitude):null,lon:Number.isFinite(Number(loc.longitude))?Number(loc.longitude):null,askingPrice:Number.isFinite(Number(askingPrice))?Number(askingPrice):null,squareFootage:size,bedrooms:Number(pd?.bedrooms)||null,bathrooms:Number(pd?.bathrooms)||null,propertyType:String(pd?.propertySubType||pd?.propertyTypeFullDescription||pd?.propertyType||''),epcRating,epcUrl};
}

async function proxy(url) {
  let target; try { target = new URL(url.searchParams.get('url') || ''); } catch (_) { return json({error:'Invalid URL.'},400); }
  if (target.protocol !== 'https:' || !HOSTS.has(target.hostname)) return json({error:'This host is not allowed.'},403);
  try {
    const response = await upstream(target.toString(),url.searchParams.get('accept')||'*/*',target.hostname.includes('landregistry')?300:180);
    return new Response(response.body,{status:response.status,headers:{'content-type':response.headers.get('content-type')||'text/plain; charset=utf-8','cache-control':'no-store'}});
  } catch (error) { return json({error:String(error?.message||'Upstream request failed.')},502); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed',{status:405});
    if (url.pathname === '/api/health') return json({ok:true,service:'property-tool'});
    if (url.pathname === '/api/proxy') return proxy(url);
    if (url.pathname === '/api/rightmove') {
      try { return json(await rightmove(url.searchParams.get('url') || '')); }
      catch (error) { return json({ok:false,error:String(error?.message||'Could not read Rightmove listing.')},502); }
    }
    return env.ASSETS.fetch(request);
  }
};
