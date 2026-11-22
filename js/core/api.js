/* ─────────────────────────────────────────────────────────────
 * API 客户端 —— 后端全部端点的单一事实源。
 * 每个前端页面只准通过 HUB.api 调接口，禁止裸 fetch。
 * 端点清单与后端实现见 docs/api-inventory.md。
 *
 * GET 请求带 30s TTL 内存缓存：wb 代理每请求 ~650ms（wb_proxy 单线程从
 * 磁盘读 accounts/settings），切页时命中缓存即瞬时渲染。
 * POST / DELETE 不缓存。
 * ───────────────────────────────────────────────────────────── */
(function(){
const WB='/wb';
const _cache=new Map();
const CACHE_TTL=30000;
async function req(url, opts){
  const r=await fetch(url, Object.assign({headers:{'Accept':'application/json'}}, opts||{}));
  const ct=r.headers.get('content-type')||'';
  const body=ct.includes('json')? await r.json().catch(()=>({})) : await r.text().catch(()=>'');
  if(!r.ok){
    const msg=(body&&body.error&&body.error.message)||(body&&body.message)||body||('HTTP '+r.status);
    const e=new Error(String(msg).slice(0,300)); e.status=r.status; e.body=body; throw e;
  }
  return body;
}
async function cachedGet(p){
  const now=Date.now();
  const hit=_cache.get(p);
  if(hit && now-hit.ts<CACHE_TTL) return hit.data;
  const data=await GET(p);
  _cache.set(p,{data,ts:now});
  return data;
}
function invalidate(prefix){ for(const k of _cache.keys()){ if(!prefix||k.startsWith(prefix)) _cache.delete(k); } }
const GET=p=>req(p);
const POST=async(p,b)=>{ const r=await req(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); invalidate(WB+'/'); invalidate('/admin/'); return r; };
const DEL=async(p,b)=>{ const r=await req(p,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); invalidate(WB+'/'); invalidate('/admin/'); return r; };

const wb={
  /* 账号 */
  accounts:(realm='all')=>cachedGet(`${WB}/accounts?realm=${encodeURIComponent(realm)}`),
  accountsRefresh:uids=>POST(`${WB}/accounts/refresh`,uids?{uids}:{}),
  accountsSetAll:(enabled,uids)=>POST(`${WB}/accounts/set-all`,{enabled,uids}),
  accountsSet:payload=>POST(`${WB}/accounts/set`,payload),
  accountsProduct:payload=>POST(`${WB}/accounts/product`,payload),
  accountsTest:payload=>POST(`${WB}/accounts/test`,payload),
  accountsDelete:payload=>POST(`${WB}/accounts/delete`,payload),
  accountsImport:payload=>POST(`${WB}/accounts/import`,payload),
  accountsImportDesktop:payload=>POST(`${WB}/accounts/import/desktop`,payload),
  accountsAddApiKey:payload=>POST(`${WB}/accounts/add-api-key`,payload),
  creditsGrants:()=>cachedGet(`${WB}/accounts/credits/grants`),
  accountsCredits:payload=>POST(`${WB}/accounts/credits`,payload),
  activityHistory:(range='today',limit=200)=>cachedGet(`${WB}/activity/history?range=${range}&limit=${limit}`),
  /* 自动化 / 任务 */
  scheduler:()=>cachedGet(`${WB}/scheduler`),
  tasks:()=>cachedGet(`${WB}/tasks`),
  tasksProgress:uids=>cachedGet(`${WB}/tasks/progress?uids=${encodeURIComponent(uids.join(','))}`),
  /* 智能体 */
  agents:(realm)=>cachedGet(`${WB}/agents${realm?`?realm=${realm}`:''}`),
  agentsAvailable:()=>cachedGet(`${WB}/agents/available`),
  agentsModelSelection:()=>cachedGet(`${WB}/agents/model-selection`),
  /* 用量全家桶 */
  usage:()=>cachedGet(`${WB}/usage`),
  usageAnalytics:()=>cachedGet(`${WB}/usage/analytics`),
  usageByAccount:()=>cachedGet(`${WB}/usage/by-account`),
  usagePerf:(realm)=>cachedGet(`${WB}/usage/perf${realm?`?realm=${realm}`:''}`),
  usageRemaining:()=>cachedGet(`${WB}/usage/remaining`),
  usageTimeseries:()=>cachedGet(`${WB}/usage/timeseries`),
  /* 日志 */
  logs:(limit=300,sinceId)=>GET(`${WB}/logs?limit=${limit}${sinceId?`&since_id=${sinceId}`:''}`),
  /* 定价 / 目录 */
  pricing:()=>cachedGet(`${WB}/pricing`),
  pricingRefresh:()=>POST(`${WB}/pricing/refresh`,{}),
  pricingMapping:payload=>POST(`${WB}/pricing/mapping`,payload),
  catalogRefresh:realm=>POST(`${WB}/catalog/refresh`,{realm}),
  models:(realm)=>cachedGet(`${WB}/v1/models${realm?`?realm=${realm}`:''}`),
  /* 媒体 */
  mediaModels:()=>cachedGet(`${WB}/v1/media/models`),
  mediaTasks:(limit=20)=>cachedGet(`${WB}/v1/media/tasks?limit=${limit}`),
  imageGenerate:payload=>POST(`${WB}/v1/images/generations`,payload),
  imageEdit:payload=>POST(`${WB}/v1/images/edits`,payload),
  videoSubmit:payload=>POST(`${WB}/v1/videos`,payload),
  video:(id)=>cachedGet(`${WB}/v1/videos/${id}`),
  videoCancel:(id)=>POST(`${WB}/v1/videos/${id}/cancel`,{}),
  /* 基础设施 */
  proxySlots:()=>cachedGet(`${WB}/proxy/slots`),
  codeartsOverview:()=>cachedGet(`${WB}/codearts/overview`),
  codeartsModelsRefresh:()=>POST(`${WB}/codearts/models/refresh`,{}),
  codeartsCreditsRefresh:()=>POST(`${WB}/codearts/credits/refresh`,{}),
  health:()=>cachedGet(`${WB}/health`),
  realmGet:()=>cachedGet(`${WB}/realm`),
  realmSet:(realm)=>POST(`${WB}/realm`,{realm}),
  /* 设置 / 运维 */
  settings:()=>cachedGet(`${WB}/settings`),
  settingsSave:payload=>POST(`${WB}/settings/save`,payload),
  settingsReveal:id=>cachedGet(`${WB}/settings/reveal?id=${encodeURIComponent(id)}`),
  restrictionReset:()=>POST(`${WB}/settings/restriction/reset`,{}),
  deviceTokenReload:()=>POST(`${WB}/settings/device-token/reload`,{}),
  updates:()=>cachedGet(`${WB}/updates`),
  updatesBackups:()=>cachedGet(`${WB}/updates/backups`),
  updatesCheck:()=>POST(`${WB}/updates/check`,{}),
  updatesInstall:tag=>POST(`${WB}/updates/install`,{tag}),
  panelStatus:()=>cachedGet(`${WB}/panel/status`),
  shutdown:()=>POST(`${WB}/shutdown`,{}),
};

const zc={
  accounts:()=>cachedGet('/admin/api/accounts'),
  accountAdd:payload=>POST('/admin/api/accounts',payload),
  accountDelete:ids=>DEL('/admin/api/accounts',ids),
  accountEnabled:(id,enabled)=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/enabled`,{enabled}),
  accountRotateFingerprint:id=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/fingerprint/rotate`,{}),
  accountsRefresh:()=>POST('/admin/api/accounts/refresh',{}),
  accountRefresh:id=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/refresh`,{}),
  accountCodingLimits:id=>cachedGet(`/admin/api/accounts/${encodeURIComponent(id)}/coding_limits`),
  loginStart:payload=>POST('/admin/api/login/start',payload),
  loginPoll:flowId=>cachedGet(`/admin/api/login/poll/${encodeURIComponent(flowId)}`),
  claimPreview:()=>cachedGet('/admin/api/claim/preview'),
  claim:()=>POST('/admin/api/claim',{}),
  claimCaptchaConfig:()=>cachedGet('/admin/api/claim/captcha-config'),
  claimManual:payload=>POST('/admin/api/claim/manual',payload),
  settings:()=>cachedGet('/admin/api/settings'),
  upstreamAnalysis:()=>cachedGet('/admin/api/upstream-analysis'),
  upstreamPackageAnalysis:()=>cachedGet('/admin/api/upstream-package-analysis'),
  versionCheck:()=>POST('/admin/api/version/zcode/check',{}),
  monitoring:(limit=200)=>GET(`/admin/api/monitoring?limit=${limit}`),
  monitoringClear:()=>POST('/admin/api/monitoring/clear',{}),
  exportData:payload=>POST('/admin/api/export',payload),
  importData:payload=>POST('/admin/api/import',payload),
  verify:()=>cachedGet('/admin/api/verify'),
  status:()=>cachedGet('/admin/api/status'),
  meta:()=>cachedGet('/meta'),
};

window.HUB=window.HUB||{};
HUB.api={wb,zc,req,GET,POST,DEL};
})();
