/* ─────────────────────────────────────────────────────────────
 * API 客户端 —— 后端全部端点的单一事实源。
 * 每个前端页面只准通过 HUB.api 调接口，禁止裸 fetch。
 * 端点清单与后端实现见 docs/api-inventory.md。
 * ───────────────────────────────────────────────────────────── */
(function(){
const WB='/wb';
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
const GET=p=>req(p);
const POST=(p,b)=>req(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
const DEL=(p,b)=>req(p,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});

const wb={
  /* 账号 */
  accounts:(realm='all')=>GET(`${WB}/accounts?realm=${encodeURIComponent(realm)}`),
  accountsRefresh:uids=>POST(`${WB}/accounts/refresh`,uids?{uids}:{}),
  accountsSetAll:(enabled,uids)=>POST(`${WB}/accounts/set-all`,{enabled,uids}),
  accountsSet:payload=>POST(`${WB}/accounts/set`,payload),
  accountsProduct:payload=>POST(`${WB}/accounts/product`,payload),
  accountsTest:payload=>POST(`${WB}/accounts/test`,payload),
  accountsDelete:payload=>POST(`${WB}/accounts/delete`,payload),
  accountsImport:payload=>POST(`${WB}/accounts/import`,payload),
  accountsImportDesktop:payload=>POST(`${WB}/accounts/import/desktop`,payload),
  accountsAddApiKey:payload=>POST(`${WB}/accounts/add-api-key`,payload),
  creditsGrants:()=>GET(`${WB}/accounts/credits/grants`),
  accountsCredits:payload=>POST(`${WB}/accounts/credits`,payload),
  activityHistory:(range='today',limit=200)=>GET(`${WB}/activity/history?range=${range}&limit=${limit}`),
  /* 自动化 / 任务 */
  scheduler:()=>GET(`${WB}/scheduler`),
  tasks:()=>GET(`${WB}/tasks`),
  tasksProgress:uids=>GET(`${WB}/tasks/progress?uids=${encodeURIComponent(uids.join(','))}`),
  /* 智能体 */
  agents:(realm)=>GET(`${WB}/agents${realm?`?realm=${realm}`:''}`),
  agentsAvailable:()=>GET(`${WB}/agents/available`),
  agentsModelSelection:()=>GET(`${WB}/agents/model-selection`),
  /* 用量全家桶 */
  usage:()=>GET(`${WB}/usage`),
  usageAnalytics:()=>GET(`${WB}/usage/analytics`),
  usageByAccount:()=>GET(`${WB}/usage/by-account`),
  usagePerf:(realm)=>GET(`${WB}/usage/perf${realm?`?realm=${realm}`:''}`),
  usageRemaining:()=>GET(`${WB}/usage/remaining`),
  usageTimeseries:()=>GET(`${WB}/usage/timeseries`),
  /* 日志 */
  logs:(limit=300,sinceId)=>GET(`${WB}/logs?limit=${limit}${sinceId?`&since_id=${sinceId}`:''}`),
  /* 定价 / 目录 */
  pricing:()=>GET(`${WB}/pricing`),
  pricingRefresh:()=>POST(`${WB}/pricing/refresh`,{}),
  pricingMapping:payload=>POST(`${WB}/pricing/mapping`,payload),
  catalogRefresh:realm=>POST(`${WB}/catalog/refresh`,{realm}),
  models:(realm)=>GET(`${WB}/v1/models${realm?`?realm=${realm}`:''}`),
  /* 媒体 */
  mediaModels:()=>GET(`${WB}/v1/media/models`),
  mediaTasks:(limit=20)=>GET(`${WB}/v1/media/tasks?limit=${limit}`),
  imageGenerate:payload=>POST(`${WB}/v1/images/generations`,payload),
  imageEdit:payload=>POST(`${WB}/v1/images/edits`,payload),
  videoSubmit:payload=>POST(`${WB}/v1/videos`,payload),
  video:(id)=>GET(`${WB}/v1/videos/${id}`),
  videoCancel:(id)=>POST(`${WB}/v1/videos/${id}/cancel`,{}),
  /* 基础设施 */
  proxySlots:()=>GET(`${WB}/proxy/slots`),
  codeartsOverview:()=>GET(`${WB}/codearts/overview`),
  codeartsModelsRefresh:()=>POST(`${WB}/codearts/models/refresh`,{}),
  codeartsCreditsRefresh:()=>POST(`${WB}/codearts/credits/refresh`,{}),
  health:()=>GET(`${WB}/health`),
  realmGet:()=>GET(`${WB}/realm`),
  realmSet:(realm)=>POST(`${WB}/realm`,{realm}),
  /* 设置 / 运维 */
  settings:()=>GET(`${WB}/settings`),
  settingsSave:payload=>POST(`${WB}/settings/save`,payload),
  settingsReveal:id=>GET(`${WB}/settings/reveal?id=${encodeURIComponent(id)}`),
  restrictionReset:()=>POST(`${WB}/settings/restriction/reset`,{}),
  deviceTokenReload:()=>POST(`${WB}/settings/device-token/reload`,{}),
  updates:()=>GET(`${WB}/updates`),
  updatesBackups:()=>GET(`${WB}/updates/backups`),
  updatesCheck:()=>POST(`${WB}/updates/check`,{}),
  updatesInstall:tag=>POST(`${WB}/updates/install`,{tag}),
  panelStatus:()=>GET(`${WB}/panel/status`),
  shutdown:()=>POST(`${WB}/shutdown`,{}),
};

const zc={
  accounts:()=>GET('/admin/api/accounts'),
  accountAdd:payload=>POST('/admin/api/accounts',payload),
  accountDelete:ids=>DEL('/admin/api/accounts',ids),
  accountEnabled:(id,enabled)=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/enabled`,{enabled}),
  accountRotateFingerprint:id=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/fingerprint/rotate`,{}),
  accountsRefresh:()=>POST('/admin/api/accounts/refresh',{}),
  accountRefresh:id=>POST(`/admin/api/accounts/${encodeURIComponent(id)}/refresh`,{}),
  accountCodingLimits:id=>GET(`/admin/api/accounts/${encodeURIComponent(id)}/coding_limits`),
  loginStart:payload=>POST('/admin/api/login/start',payload),
  loginPoll:flowId=>GET(`/admin/api/login/poll/${encodeURIComponent(flowId)}`),
  claimPreview:()=>GET('/admin/api/claim/preview'),
  claim:()=>POST('/admin/api/claim',{}),
  claimCaptchaConfig:()=>GET('/admin/api/claim/captcha-config'),
  claimManual:payload=>POST('/admin/api/claim/manual',payload),
  settings:()=>GET('/admin/api/settings'),
  upstreamAnalysis:()=>GET('/admin/api/upstream-analysis'),
  upstreamPackageAnalysis:()=>GET('/admin/api/upstream-package-analysis'),
  versionCheck:()=>POST('/admin/api/version/zcode/check',{}),
  monitoring:(limit=200)=>GET(`/admin/api/monitoring?limit=${limit}`),
  monitoringClear:()=>POST('/admin/api/monitoring/clear',{}),
  exportData:payload=>POST('/admin/api/export',payload),
  importData:payload=>POST('/admin/api/import',payload),
  verify:()=>GET('/admin/api/verify'),
  status:()=>GET('/admin/api/status'),
  meta:()=>GET('/meta'),
};

window.HUB=window.HUB||{};
HUB.api={wb,zc,req,GET,POST,DEL};
})();
