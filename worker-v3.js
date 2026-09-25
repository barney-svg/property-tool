// Deployment trigger: access-control routing must run before static assets.
import workerV2 from './worker-v2.js';
import {AccessRegistry,accessState,handleAdmin,accessLoginPage,accessBlockedPage,json} from './access-v3.js';
import {addressQuick,subjectEpc,marketComps} from './data-v3.js';
export {AccessRegistry};

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/api/auth/login'&&request.method==='POST')return accessState(request,env);
    const access=await accessState(request,env);
    const admin=await handleAdmin(request,env,access);if(admin)return admin;
    const pageView=url.pathname==='/'||url.pathname==='/index.html';if(pageView)ctx.waitUntil(access.reg.record(access.ip,access.userAgent));
    if(access.blocked)return url.pathname.startsWith('/api/')?json({ok:false,error:'Blocked'},403):accessBlockedPage();
    if(!access.authorized){if(url.pathname.startsWith('/api/'))return json({ok:false,error:'Password required'},401);return accessLoginPage();}
    if(url.pathname==='/api/address-quick'){try{return json(await addressQuick(url.searchParams.get('q')||'',Math.max(1,Math.min(12,Number(url.searchParams.get('limit'))||8)),url.searchParams.get('mode')==='autocomplete'));}catch(e){return json({ok:false,error:String(e?.message||'Address lookup failed')},502)}}
    if(url.pathname==='/api/subject-epc'){try{return json(await subjectEpc(url.searchParams.get('address')||'',url.searchParams.get('postcode')||''));}catch(e){return json({ok:false,error:String(e?.message||'EPC lookup failed')},502)}}
    if(url.pathname==='/api/market-comps'){try{return json(await marketComps(url.searchParams));}catch(e){return json({ok:false,error:String(e?.message||'Market lookup failed')},502)}}
    return workerV2.fetch(request,env,ctx);
  }
};
