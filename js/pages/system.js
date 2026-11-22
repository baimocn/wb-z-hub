/* ─────────────────────────────────────────────────────────────
 * 页面：系统 —— 版本指纹 / 健康 / 状态 + 危险操作
 *
 * 组件层结构（原文件里 meta / status / health / realm / shutdown 混在一起，
 * 现拆成两块关注点 + 两个诊断入口）：
 *   1) 版本与健康   HUB.components.statCards —— 网关版本、两路上游指纹、健康读数
 *   2) 版本指纹明细 HUB.components.filterBar + dataTable —— WB versionfeed 逐组件探测值
 *   3) 原始响应     HUB.ui.openModal —— 完整 JSON，替代原来的 60 字截断
 *   4) 危险操作     HUB.ui.openModal 二次确认 —— 切换出口 / 解除连坐 / 关闭网关
 *
 * 覆盖端点（8 个，与重构前一致）：
 *   GET  /meta                            HUB.api.zc.meta
 *   GET  /admin/api/status                HUB.api.zc.status
 *   GET  /wb/health                       HUB.api.wb.health
 *   GET  /wb/realm                        HUB.api.wb.realmGet
 *   GET  /wb/settings                     HUB.api.wb.settings
 *   POST /wb/realm                        HUB.api.wb.realmSet
 *   POST /wb/settings/restriction/reset   HUB.api.wb.restrictionReset
 *   POST /wb/shutdown                     HUB.api.wb.shutdown
 *
 * 轮询不走 shell.poll：components.js:48 的 else 分支调用未定义的 stop()，
 * 页面失效后每拍抛异常且定时器不回收；router.js:14-24 也不调 shell.destroy()。
 * 改为自带定时器 + shell.onCleanup + 每拍自查 shell.alive（同 zc-upstream.js:21-23）。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

const U=HUB.ui;
const C=HUB.components;

/* ═══ 1. 常量：出口显示名 / 版本指纹键 / 筛选项 ═══ */
const REALM_LABEL={intl:'国际版', cn:'国内版', codearts:'CodeArts'};
/* 与后端 wb_settings.IDENTITY_VERSION_KEYS 一致；顺序即表格展示顺序 */
const PROBE_KEYS=['desktop_intl','desktop_cn','desktop_cli','vscode_product','vscode_ide','cli','sdk','node'];
const PROBE_LABEL={
  desktop_intl:'桌面国际版', desktop_cn:'桌面国内版', desktop_cli:'桌面 CLI',
  vscode_product:'VS Code 产品', vscode_ide:'VS Code 内核',
  cli:'CLI', sdk:'SDK', node:'Node'
};
const PROBE_FILTERS=[
  {value:'all', label:'全部指纹'},
  {value:'probed', label:'已探测'},
  {value:'missing', label:'缺失'}
];

/* ═══ 2. 纯函数：格式化 / 容错取值（无 DOM、无状态） ═══ */
const text=v=>(v===null||v===undefined||v==='')?'—':String(v);
const clip=s=>{ s=String(s==null?'':s); return s.length>160?s.slice(0,160)+'…':s; };
const realmName=v=>REALM_LABEL[v]||text(v);
const mono=v=>'<span class="mono">'+U.esc(text(v))+'</span>';
const nmono=v=>'<span class="mono">'+U.esc(U.num(v))+'</span>';
function timeAt(t){
  const n=Number(t);
  if(!t||!isFinite(n)||n<=0) return '—';
  /* checked_at 落盘为 Unix 秒；万一上游给毫秒则原样使用 */
  const d=new Date(n<1e12?n*1000:n);
  return isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{hour12:false});
}
function errText(e){
  /* api.js 对 502 / 500 的 message 可能是“[object Object]”，优先取 body 原文 */
  const body=e&&e.body;
  if(body&&typeof body==='object'){
    if(typeof body.error==='string'&&body.error) return body.error;
    if(body.error&&typeof body.error.message==='string') return body.error.message;
    if(typeof body.detail==='string'&&body.detail) return body.detail;
    if(typeof body.message==='string'&&body.message) return body.message;
  }
  return String((e&&e.message)||e||'未知错误');
}
function jsonText(v){
  try{ return JSON.stringify(v,null,2); }catch(e){ return String(v); }
}
/* /meta 的 workbuddy 段返回 versions（pages.py:93-103）；兼容旧字段 probed */
function probeVersions(meta){
  const w=(meta&&meta.upstreams&&meta.upstreams.workbuddy)||{};
  const src=(w.versions&&typeof w.versions==='object')?w.versions
    :((w.probed&&typeof w.probed==='object')?w.probed:{});
  const out={};
  Object.keys(src).forEach(k=>{ if(src[k]) out[k]=String(src[k]); });
  return out;
}
/* 已知键始终列出：缺失项也要能一眼看到，筛选才有意义 */
function probeRows(versions){
  const extra=Object.keys(versions).filter(k=>PROBE_KEYS.indexOf(k)<0);
  return PROBE_KEYS.concat(extra).map(k=>({
    key:k, label:PROBE_LABEL[k]||k, ver:versions[k]||'',
    state:versions[k]?'probed':'missing'
  }));
}
const settle=p=>p.then(v=>({ok:true,value:v}), e=>({ok:false,error:e}));
const failSub=(res,fallback)=>U.pill('失败','bad')+' '+U.esc(clip(errText(res&&res.error)||fallback));

HUB.register({
  route:'system', group:'system', title:'系统', order:95,
  async render(el, ctx){
    const shell=HUB.shell(el, ctx);

    /* ═══ 3. state：5 个只读端点结果 + 指纹筛选（页面唯一可变状态） ═══ */
    const state={
      meta:{ok:false,error:null,value:null},
      status:{ok:false,error:null,value:null},
      health:{ok:false,error:null,value:null},
      realm:{ok:false,error:null,value:null},
      settings:{ok:false,error:null,value:null},
      filters:{probe:'all'},
      lastAt:0,
      shuttingDown:false
    };
    let boxes={};
    let loadSeq=0;
    let tick=null;

    const metaVal=()=>state.meta.ok?(state.meta.value||{}):null;
    const healthVal=()=>state.health.ok?(state.health.value||{}):null;
    const statusVal=()=>state.status.ok?(state.status.value||{}):null;
    const realmVal=()=>state.realm.ok?(state.realm.value||{}):null;
    const settingsVal=()=>state.settings.ok?(state.settings.value||{}):null;
    /* /wb/settings 的 restriction_holds 只列冻结中的域：realm -> 剩余秒数 */
    function holds(){
      const s=settingsVal();
      const src=(s&&s.restriction_holds)||{};
      const out={};
      Object.keys(src).forEach(k=>{ if(Number(src[k])>0) out[k]=Number(src[k]); });
      return out;
    }
    /* /wb/realm 的 options 是 intl / cn / codearts，codearts 未配置时不下发 */
    function realmOptions(){
      const r=realmVal();
      return (r&&Array.isArray(r.options)&&r.options.length)?r.options.slice():['intl','cn'];
    }

    /* ═══ 4. 布局：shell 只建一次，重绘只写分区容器 ═══ */
    function buildLayout(){
      shell.setTitle('系统',
        '网关版本 / 上游指纹 / 健康与状态一屏核对；危险操作集中在页尾，全部先弹确认框。');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'
          +'<button class="btn pri" type="button" data-act="refresh">刷新状态</button>'
          +'<span class="pill mute" data-role="readat">尚未加载</span>'
          +'<span class="pill mute">每 30 秒自动刷新</span>'
          +'</div>';
      }
      const c=shell.content();
      if(!c) return;
      c.innerHTML=
        '<h2>版本与健康</h2>'
        +'<p class="sub">网关版本与两路上游指纹；健康读数来自 <span class="mono">/wb/health</span>，管理接口读数来自 <span class="mono">/admin/api/status</span>。</p>'
        +'<div data-role="cards"></div>'
        +'<div class="toolbar">'
        +'<button class="btn" type="button" data-act="raw-health">查看 /wb/health 原始响应</button>'
        +'<button class="btn" type="button" data-act="raw-status">查看 /admin/api/status 原始响应</button>'
        +'<span class="pill mute">完整 JSON · 只读</span>'
        +'</div>'
        +'<h2>WB 版本指纹</h2>'
        +'<p class="sub">versionfeed 自动跟版写入 <span class="mono">identity_versions_auto</span>；缺失表示该组件本轮未探测到，不等于故障。</p>'
        +'<div class="toolbar" data-role="probe-filter"></div>'
        +'<div data-role="probe-table" style="overflow-x:auto"></div>'
        +'<h2>危险操作</h2>'
        +'<p class="sub">以下动作立即生效，并影响所有未绑定区域的 Key；点击后先弹确认框，确认才发请求。</p>'
        +'<div class="grid" data-role="danger"></div>';
      boxes={
        readat:bar?bar.querySelector('[data-role="readat"]'):null,
        cards:c.querySelector('[data-role="cards"]'),
        probeFilter:c.querySelector('[data-role="probe-filter"]'),
        probeTable:c.querySelector('[data-role="probe-table"]'),
        danger:c.querySelector('[data-role="danger"]')
      };
      /* FilterBar 挂载一次，选择值由 state 驱动；change 后只重画指纹表 */
      if(boxes.probeFilter){
        C.filterBar(boxes.probeFilter,[
          {key:'probe', label:'指纹状态', options:PROBE_FILTERS}
        ],state.filters,paintProbes);
      }
      if(boxes.cards) boxes.cards.innerHTML=U.loadHtml('拉取系统状态…');
      if(boxes.probeTable) boxes.probeTable.innerHTML=U.loadHtml('读取版本指纹…');
      paintDanger();
    }

    /* ═══ 5. 分区渲染 ═══ */
    function paintReadAt(){
      if(!boxes.readat) return;
      boxes.readat.textContent=state.lastAt
        ?('读数 '+new Date(state.lastAt).toLocaleTimeString('zh-CN',{hour12:false}))
        :'尚未加载';
    }

    function paintCards(){
      if(!shell.alive||!boxes.cards) return;
      if(!state.lastAt){ boxes.cards.innerHTML=U.loadHtml('拉取系统状态…'); return; }
      const meta=metaVal()||{};
      const z=(meta.upstreams&&meta.upstreams.zcode)||{};
      const w=(meta.upstreams&&meta.upstreams.workbuddy)||{};
      const rows=probeRows(probeVersions(meta));
      const probed=rows.filter(r=>r.state==='probed').length;
      const h=healthVal();
      const st=statusVal();
      const rv=realmVal();
      const hs=holds();
      const holdKeys=Object.keys(hs);

      C.statCards(boxes.cards,[
        {label:'zcode-hub 版本', value:state.meta.ok?text(meta.version):'读取失败',
         sub:state.meta.ok?('ZCODE 客户端 '+mono(z.client)+' · 正文锁 '+mono(z.prompt_aligned))
           :failSub(state.meta,'/meta 无响应')},
        {label:'WB 版本指纹', value:state.meta.ok?(probed+' / '+rows.length):'读取失败',
         sub:!state.meta.ok?failSub(state.meta,'/meta 无响应')
           :(w.checked_at?('versionfeed 探测于 '+U.esc(timeAt(w.checked_at))):'versionfeed 尚未探测')},
        {label:'WB 服务健康', value:h?(h.ok===true?'在线':'异常'):'读取失败',
         sub:h?(U.pill(h.ok===true?'在线':'异常',h.ok===true?'ok':'bad')
           +' 账号就绪 '+nmono(h.accounts_ready)+' / '+nmono(h.accounts))
           :failSub(state.health,'/wb/health 无响应')},
        {label:'ZC 管理接口', value:st?'可达':'读取失败',
         sub:st?('providers '+U.esc(text((st.providers||[]).join(' / ')))+' · 网关 Key '
           +(st.gateway_key_set?U.pill('已配置','ok'):U.pill('未配置','warn')))
           :failSub(state.status,'/admin/api/status 无响应')},
        {label:'WB 默认出口', value:rv?realmName(rv.current):'读取失败',
         sub:rv?('可选 '+U.esc(realmOptions().map(v=>realmName(v)+'（'+v+'）').join(' · ')))
           :failSub(state.realm,'/wb/realm 无响应')},
        {label:'风控连坐', value:settingsVal()?(holdKeys.length?holdKeys.length+' 个出口':'正常'):'读取失败',
         sub:settingsVal()?(holdKeys.length
           ?U.pill('冻结中','warn')+' '+U.esc(holdKeys.map(k=>realmName(k)+' '+hs[k]+'s').join(' · '))
           :U.pill('无冻结','ok'))
           :failSub(state.settings,'/wb/settings 无响应')}
      ]);
    }

    function paintProbes(){
      if(!shell.alive||!boxes.probeTable) return;
      if(!state.lastAt){ boxes.probeTable.innerHTML=U.loadHtml('读取版本指纹…'); return; }
      if(!state.meta.ok){
        boxes.probeTable.innerHTML='<div class="empty">'
          +U.esc('版本指纹读取失败：'+clip(errText(state.meta.error)))+'</div>';
        return;
      }
      const rows=probeRows(probeVersions(metaVal()||{}));
      const shown=state.filters.probe==='all'
        ?rows:rows.filter(r=>r.state===state.filters.probe);
      C.dataTable(boxes.probeTable,{
        columns:[
          {key:'label', label:'组件', render:(v,r)=>
            '<b>'+U.esc(text(v))+'</b><div class="dim mono">'+U.esc(r.key)+'</div>'},
          {key:'ver', label:'探测版本', render:v=>v?mono(v):'<span class="dim">未探测</span>'},
          {key:'state', label:'状态', render:v=>
            v==='probed'?U.pill('已探测','ok'):U.pill('缺失','mute')}
        ],
        rows:shown,
        rowKey:'key',
        emptyText:'当前筛选下没有指纹'
      });
    }

    /* 危险操作卡片：标题 / 说明里只拼已经转义过的片段 */
    function dangerCard(title, desc, act, label){
      return '<div class="card"><div class="k">'+title+'</div><div class="n">'+desc+'</div>'
        +'<div style="margin-top:var(--sp-3)">'
        +'<button class="btn danger" type="button" data-act="'+U.esc(act)+'">'+U.esc(label)+'</button>'
        +'</div></div>';
    }

    function paintDanger(){
      if(!shell.alive||!boxes.danger) return;
      const rv=realmVal();
      const hs=holds();
      const holdKeys=Object.keys(hs);
      const cur=rv?text(rv.current):'—';
      const optTxt=rv
        ?U.esc(realmOptions().map(v=>realmName(v)+'（'+v+'）').join(' · '))
        :'—';
      boxes.danger.innerHTML=
        dangerCard(
          'WB 默认出口'+U.pill('影响全局','warn'),
          '当前 '+mono(cur)+' · 可选 '+optTxt
            +'。切换后所有未绑定区域的 Key 立即按新出口派发，正在进行的请求不受影响。',
          'realm','切换出口')
        +dangerCard(
          '风控连坐暂停'+(holdKeys.length?U.pill('冻结中','warn'):U.pill('正常','ok')),
          holdKeys.length
            ?('冻结 '+U.esc(holdKeys.map(k=>realmName(k)+' '+hs[k]+'s').join(' · '))
              +'。解除后该域立即恢复派发，若上游仍在限流可能再次触发。')
            :'当前没有连坐冻结。解除为幂等操作，执行后仍返回空冻结表。',
          'unhold','解除连坐暂停')
        +dangerCard(
          '关闭网关服务'+U.pill('不可撤销','bad'),
          '向 <span class="mono">/wb</span> 进程发送关闭指令：先回包、0.4 秒后退出；'
            +'反代、面板、调度器与媒体任务线程一并停止，需重新运行启动脚本才能恢复。',
          'shutdown','关闭网关服务');
    }

    function paintAll(){
      if(!shell.alive) return;
      paintReadAt();
      paintCards();
      paintProbes();
      paintDanger();
    }

    /* ═══ 6. 原始响应：完整 JSON 放模态，页面不再截断 ═══ */
    function showRaw(title, endpoint, res){
      const body=(res&&res.ok)
        ?'<p class="sub">GET '+U.esc(endpoint)+' · 完整响应</p>'
          +'<pre class="raw" style="max-height:60vh;overflow:auto">'+U.esc(jsonText(res.value))+'</pre>'
        :'<p class="sub">GET '+U.esc(endpoint)+' · 读取失败</p>'
          +'<pre class="raw">'+U.esc(errText(res&&res.error))+'</pre>';
      U.openModal({title:title, wide:true, body:body, actions:[{label:'关闭'}]});
    }

    /* ═══ 7. 危险操作：一律 Modal 二次确认 ═══ */
    function openRealm(){
      if(!state.realm.ok){
        U.toast('出口选项读取失败：'+clip(errText(state.realm.error)),'bad');
        return;
      }
      const rv=realmVal()||{};
      const options=realmOptions();
      if(options.length<2){ U.toast('当前只有一个可用出口，无需切换','warn'); return; }
      const opts=options.map(v=>'<option value="'+U.esc(v)+'"'
        +(String(v)===String(rv.current)?' selected':'')+'>'
        +U.esc(realmName(v)+'（'+v+'）')+'</option>').join('');
      const m=U.openModal({
        title:'切换 WB 默认出口',
        body:'<p class="dim">当前出口 <b class="mono">'+U.esc(text(rv.current))+'</b>。'
          +'切换立即生效：未绑定区域的 Key 改走上游，正在进行的请求不受影响。</p>'
          +'<label>目标出口 <select data-role="realm-pick" style="margin-left:var(--sp-2)">'+opts+'</select></label>'
          +'<p class="dim" style="margin-top:var(--sp-3)">CodeArts 出口需先在设置页配置 Base URL 与 API Key，'
          +'未配置时不会出现在选项里。</p>',
        actions:[
          {label:'取消'},
          {label:'确认切换', kind:'danger', onClick:function(){ return doRealm(m); }}
        ]
      });
    }

    async function doRealm(m){
      const sel=m?m.querySelector('[data-role="realm-pick"]'):null;
      const target=sel?sel.value:'';
      const rv=realmVal()||{};
      if(!target){ U.toast('请选择目标出口','warn'); return; }
      if(String(target)===String(rv.current)){
        U.closeModal();
        U.toast('出口未变化：当前已是 '+realmName(target),'warn');
        return;
      }
      const btn=m?m.querySelector('.foot .btn.danger'):null;
      if(btn){ btn.disabled=true; btn.textContent='切换中…'; }
      try{
        const res=await HUB.api.wb.realmSet(target);
        const now=(res&&res.current)||target;
        if(!ctx.stale()) U.closeModal();
        U.toast('出口已切换到 '+realmName(now)+'（'+now+'）','ok');
        await load(false);
      }catch(e){
        U.toast('切换失败：'+clip(errText(e)),'bad');
        if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent='确认切换'; }
      }
    }

    function openUnhold(){
      const hs=holds();
      const keys=Object.keys(hs);
      const list=keys.length
        ?'<ul class="dim">'+keys.map(k=>'<li>'
          +U.esc(realmName(k)+'（'+k+'）剩余 '+hs[k]+' 秒')+'</li>').join('')+'</ul>'
        :'<p class="dim">当前没有处于连坐暂停的出口；该操作幂等，执行后仍返回空冻结表。</p>';
      const m=U.openModal({
        title:'解除风控连坐暂停',
        body:'<p class="dim">连坐暂停是同域多号被上游限流时的全池保护：解除后该域立即恢复派发，'
          +'若上游仍在限流可能再次触发。</p>'+list,
        actions:[
          {label:'取消'},
          {label:'确认解除', kind:'danger', onClick:function(){ return doUnhold(m); }}
        ]
      });
    }

    async function doUnhold(m){
      const btn=m?m.querySelector('.foot .btn.danger'):null;
      if(btn){ btn.disabled=true; btn.textContent='解除中…'; }
      try{
        await HUB.api.wb.restrictionReset();
        if(!ctx.stale()) U.closeModal();
        U.toast('风控连坐暂停已解除','ok');
        await load(false);
      }catch(e){
        U.toast('解除失败：'+clip(errText(e)),'bad');
        if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent='确认解除'; }
      }
    }

    function openShutdown(){
      const m=U.openModal({
        title:'确认关闭 WB 网关服务',
        body:'<p class="dim">将向 <span class="mono">POST /wb/shutdown</span> 发送关闭指令：</p>'
          +'<ul class="dim">'
          +'<li>反代与面板立即停止，本页随后失联；</li>'
          +'<li>账号池、调度器与媒体任务线程随进程结束；</li>'
          +'<li>需在服务器上重新运行启动脚本才能恢复（看门狗若在运行会自动拉起）。</li>'
          +'</ul>',
        actions:[
          {label:'取消'},
          {label:'确认关闭', kind:'danger', onClick:function(){ return doShutdown(m); }}
        ]
      });
    }

    async function doShutdown(m){
      const btn=m?m.querySelector('.foot .btn.danger'):null;
      if(btn){ btn.disabled=true; btn.textContent='发送中…'; }
      try{
        const r=await HUB.api.wb.shutdown();
        state.shuttingDown=true;
        stopTick();
        if(!ctx.stale()){ U.closeModal(); renderShutdown(r); }
        U.toast('关闭指令已发送，网关正在退出','warn');
      }catch(e){
        /* 有 HTTP 状态码 = 服务端明确拒绝，指令没有执行 */
        if(e&&e.status){
          U.toast('关闭失败：'+clip(errText(e)),'bad');
          if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent='确认关闭'; }
          return;
        }
        /* 无状态码 = 连接层中断，进程通常已在回包前退出 */
        state.shuttingDown=true;
        stopTick();
        if(!ctx.stale()){ U.closeModal(); renderShutdown(null); }
        U.toast('关闭指令已发送（连接随进程退出）','warn');
      }
    }

    function renderShutdown(r){
      const flag=(r&&r.shutting_down)?'shutting_down=true':(r&&r.ok?'ok=true':'响应未收到');
      shell.setTitle('系统','关闭指令已发出 · 自动刷新已停止');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'+U.pill('已请求关闭','bad')
          +'<span class="pill mute">进程退出后需重新运行启动脚本</span></div>';
      }
      shell.setContent('<div class="card">'
        +'<div class="k">网关状态'+U.pill('已请求关闭','bad')+'</div>'
        +'<div class="v">已离线</div>'
        +'<div class="n"><span class="mono">'+U.esc(flag)+'</span> · 进程将在 0.4 秒内退出；'
        +'确认已重启后可点「重新检测」。</div>'
        +'<div style="margin-top:var(--sp-3)">'
        +'<button class="btn" type="button" data-act="recheck">重新检测</button>'
        +'</div></div>');
    }

    /* ═══ 8. 事件：委托到 el，shell 负责解绑 ═══ */
    function onAction(ev){
      const t=ev.target;
      const btn=t&&t.closest?t.closest('[data-act]'):null;
      if(!btn||!el.contains(btn)) return;
      const act=btn.getAttribute('data-act');
      if(act==='refresh'){ load(true); return; }
      if(act==='raw-health'){ showRaw('WB 健康原始响应','/wb/health',state.health); return; }
      if(act==='raw-status'){ showRaw('ZC 状态原始响应','/admin/api/status',state.status); return; }
      if(act==='realm'){ openRealm(); return; }
      if(act==='unhold'){ openUnhold(); return; }
      if(act==='shutdown'){ openShutdown(); return; }
      if(act==='recheck'){
        state.shuttingDown=false;
        state.lastAt=0;
        buildLayout();
        load(true);
        startTick();
        return;
      }
    }

    /* ═══ 9. 加载：5 个只读端点并发，单端点失败不阻塞其余分区 ═══ */
    async function load(manual){
      if(state.shuttingDown) return;
      const my=++loadSeq;
      const rs=await Promise.all([
        settle(HUB.api.zc.meta()),
        settle(HUB.api.zc.status()),
        settle(HUB.api.wb.health()),
        settle(HUB.api.wb.realmGet()),
        settle(HUB.api.wb.settings())
      ]);
      if(my!==loadSeq||state.shuttingDown||ctx.stale()||!shell.alive) return;
      state.meta=rs[0];
      state.status=rs[1];
      state.health=rs[2];
      state.realm=rs[3];
      state.settings=rs[4];
      state.lastAt=Date.now();
      paintAll();
      if(manual){
        const bad=rs.filter(x=>!x.ok).length;
        U.toast(bad?('刷新完成，'+bad+' 个接口失败'):'系统状态已刷新',bad?'bad':'ok');
      }
    }

    /* 自带定时器：页面失效即自清，不依赖 shell.destroy（router 不会调用） */
    function startTick(){
      if(tick) return;
      tick=setInterval(function(){
        if(!shell.alive||state.shuttingDown){ clearInterval(tick); tick=null; return; }
        if(!document.hidden) load(false);
      },30000);
      shell.onCleanup(stopTick);
    }
    function stopTick(){
      if(tick){ clearInterval(tick); tick=null; }
    }

    /* ═══ 10. 启动 ═══ */
    if(ctx.stale()) return;
    buildLayout();
    shell.listen(el,'click',onAction);
    await load(false);
    if(ctx.stale()||state.shuttingDown) return;
    startTick();
    shell.onCleanup(function(){ loadSeq++; });
  }
});
})();
