/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 版本 —— 上游版本对齐 / WB versionfeed 指纹 / 官方包提示词比对
 *
 * 组件层重构结构（原 373 行单体重绘拆为三段关注点）：
 *   1) state      —— 三个只读端点的结果 + 包段落判定筛选（单一事实源）
 *   2) shell      —— HUB.shell 管理标题 / 工具栏 / 内容区 / 事件监听 / 存活判定
 *   3) StatCards  —— 版本对齐指标（官方最新 / 网关伪装 / 正文锁 / WB 指纹）
 *                    与包分析指标（分析版本 / 包内版本 / 正文锁 / 段落命中 / 下载）
 *   4) DataTable  —— 动作建议、WB 版本探测、包内提示词段落指纹、核验结果、缺失行
 *   5) FilterBar  —— 按段落判定筛选包分析表
 *   6) Modal      —— 检查更新核验结果、段落缺失行明细
 *
 * 覆盖端点（HUB.api.zc，与重构前一致，无增减）：
 *   GET  /admin/api/upstream-analysis         版本对齐事实 + 动作建议
 *   GET  /admin/api/upstream-package-analysis 官方包提示词指纹比对（首次需下载数 MB）
 *   POST /admin/api/version/zcode/check       强制核验官方 manifest，随后回读分析
 *
 * 只读分析页：不提供手工改写版本号入口，版本对齐由 version_tracker 受正文锁
 * （PROMPT_ALIGNED_VERSION）约束自动执行；「检查更新」只是触发核验。
 *
 * 本页不注册 shell.poll：HUB.shell.poll 在页面失效后会调用未定义的 stop()，且
 * router 不调用 shell.destroy()（components.js:48、router.js:14-24），定时器无法
 * 清理；版本事实由「检查更新 / 刷新分析」按需拉取，轮询没有收益。
 * ───────────────────────────────────────────────────────────── */
(function(){
'use strict';

const U=HUB.ui;
const C=HUB.components;
const Z=HUB.api.zc;

/* ═══ 常量：版本键排序 / 中文标签 / 段落筛选项 ═══ */
const KEY_ORDER=['desktop_intl','desktop_cn','desktop_cli','vscode_product','vscode_ide','cli','sdk','node'];
const KEY_LABEL={
  desktop_intl:'桌面国际版', desktop_cn:'桌面国内版', desktop_cli:'桌面 CLI',
  vscode_product:'VS Code 产品', vscode_ide:'VS Code 内核',
  cli:'CLI', sdk:'SDK', node:'Node'
};
const SEC_STATE_OPTS=[
  {value:'all', label:'全部段落'},
  {value:'missing', label:'正文已变'},
  {value:'partial', label:'片段命中'},
  {value:'full', label:'整行命中'}
];

/* ═══ 纯函数：格式化 / 版本比较（无 DOM、无状态） ═══ */
const arr=v=>Array.isArray(v)?v:[];
const text=v=>(v===null||v===undefined||v==='')?'—':String(v);
const mono=v=>'<span class="mono">'+U.esc(text(v))+'</span>';
const cell=v=>'<span class="mono">'+U.esc(text(v))+'</span>';
const dimMono=v=>'<span class="mono dim">'+U.esc(text(v))+'</span>';

function errText(e){
  /* api.js 对 502 / 500 的 message 可能是“[object Object]”，优先取 body 原文 */
  const body=e&&e.body;
  if(body&&typeof body==='object'){
    if(typeof body.error==='string'&&body.error) return body.error;
    if(typeof body.detail==='string'&&body.detail) return body.detail;
    if(typeof body.message==='string'&&body.message) return body.message;
  }
  return String((e&&e.message)||e||'未知错误');
}
function resErrText(res, fallback){
  return (res&&typeof res.error==='string'&&res.error)?res.error:fallback;
}
function parseVer(v){
  const s=String(v==null?'':v).trim().replace(/^v/i,'');
  const m=s.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m?[parseInt(m[1],10),parseInt(m[2],10),parseInt(m[3],10)]:null;
}
function cmpVer(a,b){
  const x=parseVer(a), y=parseVer(b);
  if(!x||!y) return null;
  for(let i=0;i<3;i++){ if(x[i]!==y[i]) return x[i]>y[i]?1:-1; }
  return 0;
}
function levelPill(level){
  if(level==='ok') return U.pill('正常','ok');
  if(level==='manual') return U.pill('人工处置','warn');
  if(level==='warn') return U.pill('注意','warn');
  return U.pill(level?text(level):'未知','mute');
}
function upstreamName(u){
  if(u==='zcode') return 'ZCODE';
  if(u==='workbuddy') return 'WORKBUDDY';
  return String(u||'—').toUpperCase();
}
/* 探测值 vs 静态默认：只做展示级比较，不参与任何写操作 */
function diffPill(probed,dflt,manual){
  let out='—';
  if(probed&&dflt){
    const c=cmpVer(probed,dflt);
    if(c===null) out=String(probed)===String(dflt)?U.pill('一致','ok'):U.pill('不同','warn');
    else if(c===0) out=U.pill('一致','ok');
    else out=c>0?U.pill('↑ 领先默认','warn'):U.pill('↓ 低于默认','warn');
  }else if(probed){
    out=U.pill('仅探测','info');
  }
  if(manual) out+=' '+U.pill('人工','info');
  return out;
}
function safeUrl(u){
  const s=String(u||'');
  return /^https?:\/\//i.test(s)?s:'';
}

HUB.register({
  route:'zc-upstream', group:'zc', title:'ZC 版本', order:85,
  async render(el, ctx){
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：端点结果 + 筛选（页面唯一可变状态） ═══ */
    const state={
      analysis:null,     /* GET upstream-analysis 的 data */
      analysisErr:null,  /* 最近一次读取失败；保留旧 analysis 供对照 */
      analysisAt:0,      /* data.generated_at（Unix 秒） */
      pkg:null,          /* GET upstream-package-analysis 的 data */
      pkgErr:null,       /* 包分析失败原因（字符串） */
      pkgBusy:false,
      checkBusy:false,
      refreshBusy:false,
      secState:'all'
    };
    let boxes={};

    /* ═══ 2. 布局：shell 结构只建一次，重绘只写分区容器 ═══ */
    function buildLayout(){
      shell.setTitle('ZC 版本',
        'ZCode 上游对齐：官方 manifest 最新版 / 网关伪装版 / 正文锁（PROMPT_ALIGNED_VERSION）；WORKBUDDY versionfeed 指纹联动；官方包内提示词逐行比对。版本对齐由 version_tracker 受正文锁约束自动执行；本页只做核对与触发核验，不提供手工改写版本号入口。');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'
          +'<button class="btn pri" type="button" data-act="check">检查更新</button>'
          +'<button class="btn" type="button" data-act="refresh">刷新分析</button>'
          +'<span class="pill mute">manifest · 正文锁 · versionfeed</span>'
          +'<span style="display:inline-flex;gap:var(--sp-2);flex-wrap:wrap;align-items:center" data-role="tb-pills"></span>'
          +'</div>';
      }
      const c=shell.content();
      if(!c) return;
      c.innerHTML=
        '<h2>版本对齐</h2><p class="sub">官方 manifest 最新版 / 网关伪装版 / 正文锁三方对照。正文锁是人工闸门：官方新于锁时先移植 prompt 正文，再抬 PROMPT_ALIGNED_VERSION，顺序不能反（头新正文旧 = 405/3012）。</p>'
        +'<div data-role="align-cards"></div>'
        +'<h2>动作建议</h2><p class="sub">按「先移植正文、后抬版本锁」的顺序执行；wb 指纹只读，缺失时先查探测循环与网络出口。</p>'
        +'<div data-role="actions-table"></div>'
        +'<h2>WB 版本探测</h2><p class="sub">差异为展示级比较：上游探测 对比 wb_identity 静态默认；人工覆盖来自 settings.json 的 identity_versions。</p>'
        +'<div class="toolbar" data-role="wb-pills"></div><div data-role="wb-table"></div>'
        +'<h2>包内提示词指纹</h2><p class="sub">只解官方包内的 <span class="mono">glm/zcode.cjs</span>，与 <span class="mono">app/zcode_system.json</span> 的 stableSections 逐行比对；分析对象为 manifest 最新版，同版本命中服务端缓存（首次需分段下载数 MB，最长约 90 秒）。</p>'
        +'<div class="toolbar"><button class="btn" type="button" data-act="pkg-run">重新分析</button>'
        +'<span class="pill mute" data-role="pkg-hint">准备分析…</span>'
        +'<span style="display:inline-flex;gap:var(--sp-2);flex-wrap:wrap;align-items:center" data-role="pkg-meta"></span></div>'
        +'<div data-role="pkg-cards"></div><div class="toolbar" data-role="pkg-filter"></div>'
        +'<div data-role="pkg-table"></div><p class="sub" data-role="pkg-reco"></p><div data-role="pkg-url"></div>';
      boxes={
        tbPills:bar?bar.querySelector('[data-role="tb-pills"]'):null,
        alignCards:c.querySelector('[data-role="align-cards"]'),
        actionsTable:c.querySelector('[data-role="actions-table"]'),
        wbPills:c.querySelector('[data-role="wb-pills"]'),
        wbTable:c.querySelector('[data-role="wb-table"]'),
        pkgHint:c.querySelector('[data-role="pkg-hint"]'),
        pkgMeta:c.querySelector('[data-role="pkg-meta"]'),
        pkgCards:c.querySelector('[data-role="pkg-cards"]'),
        pkgFilter:c.querySelector('[data-role="pkg-filter"]'),
        pkgTable:c.querySelector('[data-role="pkg-table"]'),
        pkgReco:c.querySelector('[data-role="pkg-reco"]'),
        pkgUrl:c.querySelector('[data-role="pkg-url"]')
      };
      if(boxes.alignCards) boxes.alignCards.innerHTML=U.loadHtml('正在读取上游版本分析…');
      if(boxes.pkgCards) boxes.pkgCards.innerHTML=U.loadHtml('准备分析官方包…');
    }

    /* 事件只在装配时绑定一次：按钮节点常驻，重绘只改分区内容 */
    function wire(){
      const bar=shell.toolbar();
      const c=shell.content();
      const checkBtn=bar?bar.querySelector('[data-act="check"]'):null;
      const refreshBtn=bar?bar.querySelector('[data-act="refresh"]'):null;
      const pkgBtn=c?c.querySelector('[data-act="pkg-run"]'):null;
      if(checkBtn) shell.listen(checkBtn,'click',()=>runCheck(checkBtn));
      if(refreshBtn) shell.listen(refreshBtn,'click',()=>refreshAnalysis(refreshBtn));
      if(pkgBtn) shell.listen(pkgBtn,'click',()=>loadPkg(pkgBtn));
    }

    /* ═══ 3. 版本对齐：StatCards + 动作建议表 + WB 指纹表 ═══ */
    /* wb 版本三元组只解一次，供工具栏徽章 / 指标卡 / 指纹表共用 */
    function wbInfo(){
      const wb=(state.analysis&&state.analysis.upstreams&&state.analysis.upstreams.workbuddy)||{};
      const minutes=(wb.probed_minutes_ago===null||wb.probed_minutes_ago===undefined)?null:wb.probed_minutes_ago;
      return {
        probed:wb.probed||{},
        defaults:wb.identity_defaults||{},
        manual:wb.manual_overrides||{},
        keys:Object.keys(wb.probed||{}),
        minutes:minutes
      };
    }

    function paintHeaderPills(){
      if(!boxes.tbPills) return;
      const pills=[];
      if(!state.analysis){
        pills.push(state.analysisErr?U.pill('分析不可用','bad'):U.pill('加载分析中','mute'));
      }else{
        const zc=state.analysis.upstreams&&state.analysis.upstreams.zcode||{};
        const info=wbInfo();
        pills.push(zc.prompt_port_required?U.pill('正文需移植','warn'):U.pill('正文已对齐','ok'));
        pills.push(info.keys.length?U.pill('wb 指纹 '+info.keys.length+' 项','info'):U.pill('wb 未探测','warn'));
        pills.push(U.pill('分析于 '+U.ts(state.analysisAt),'mute'));
        if(info.minutes!==null) pills.push(U.pill('探测于 '+info.minutes+' 分钟前','mute'));
        if(state.analysisErr) pills.push(U.pill('最近刷新失败','bad'));
      }
      boxes.tbPills.innerHTML=pills.join('');
    }

    function paintAlign(){
      if(!boxes.alignCards) return;
      if(!state.analysis){
        boxes.alignCards.innerHTML=state.analysisErr
          ? '<div class="empty">上游分析读取失败：'+U.esc(errText(state.analysisErr))+'</div>'
          : U.loadHtml('正在读取上游版本分析…');
        return;
      }
      const ups=state.analysis.upstreams||{};
      const zc=ups.zcode||{};
      const info=wbInfo();
      const latest=zc.latest||'';
      const client=zc.client||'';
      const port=!!zc.prompt_port_required;
      const delta=(latest&&client)?cmpVer(latest,client):null;
      let clientNote='尚无官方版本记录';
      if(latest){
        if(delta===1) clientNote='落后官方 '+U.esc(latest);
        else if(delta===0) clientNote='与官方一致';
        else if(delta===-1) clientNote='领先官方 '+U.esc(latest);
        else clientNote='版本号无法比较';
      }
      C.statCards(boxes.alignCards,[
        {label:'官方最新 · latest', value:text(latest),
         sub:port?'新于正文锁：禁止直接抬版本头':'与正文锁对齐，无需动作'},
        {label:'网关伪装 · client', value:text(client), sub:clientNote},
        {label:'正文锁 · prompt_aligned', value:text(zc.prompt_aligned),
         sub:port?'先移植 prompt 正文，再抬 PROMPT_ALIGNED_VERSION':'闸门与官方一致'},
        {label:'WB 版本指纹', value:String(info.keys.length), unit:'项',
         sub:info.minutes===null?'尚无 versionfeed 探测记录':'探测于 '+U.esc(String(info.minutes))+' 分钟前'}
      ]);
    }

    function paintActions(){
      if(!boxes.actionsTable) return;
      if(!state.analysis){ boxes.actionsTable.innerHTML=''; return; }
      C.dataTable(boxes.actionsTable,{
        columns:[
          {key:'level', label:'级别', render:v=>levelPill(v)},
          {key:'upstream', label:'上游', render:v=>'<b>'+U.esc(upstreamName(v))+'</b>'},
          {key:'action', label:'建议动作', render:v=>U.esc(text(v))}
        ],
        rows:arr(state.analysis.actions),
        emptyText:'暂无建议'
      });
    }

    function wbRows(){
      const info=wbInfo();
      const keys=[], seen={};
      Object.keys(info.probed).concat(Object.keys(info.defaults),Object.keys(info.manual)).forEach(k=>{
        if(!seen[k]){ seen[k]=1; keys.push(k); }
      });
      keys.sort((a,b)=>{
        const ia=KEY_ORDER.indexOf(a), ib=KEY_ORDER.indexOf(b);
        if(ia<0&&ib<0) return a<b?-1:a>b?1:0;
        if(ia<0) return 1;
        if(ib<0) return -1;
        return ia-ib;
      });
      return keys.map(k=>({
        key:k, label:KEY_LABEL[k]||k,
        probed:info.probed[k], dflt:info.defaults[k], manual:info.manual[k]
      }));
    }

    function paintWb(){
      if(!boxes.wbPills||!boxes.wbTable) return;
      if(!state.analysis){ boxes.wbPills.innerHTML=''; boxes.wbTable.innerHTML=''; return; }
      const info=wbInfo();
      const manualCount=Object.keys(info.manual).length;
      boxes.wbPills.innerHTML=[
        info.minutes===null?U.pill('探测时间未知','warn'):U.pill('探测于 '+info.minutes+' 分钟前','mute'),
        manualCount?U.pill('人工覆盖 '+manualCount+' 项','info'):U.pill('无人工覆盖','mute')
      ].join('');
      C.dataTable(boxes.wbTable,{
        columns:[
          {key:'label', label:'版本键', render:(v,r)=>U.esc(v)+' '+dimMono(r.key)},
          {key:'probed', label:'上游探测', render:v=>v?mono(v):'—'},
          {key:'dflt', label:'静态默认', render:v=>v?mono(v):'—'},
          {key:'manual', label:'人工覆盖', render:v=>v?mono(v):'—'},
          {key:'diff', label:'差异', render:(v,r)=>diffPill(r.probed,r.dflt,r.manual)}
        ],
        rows:wbRows(),
        emptyText:'versionfeed 尚未产生任何版本指纹'
      });
    }

    function paintAnalysis(){
      if(!shell.alive) return;
      paintHeaderPills();
      paintAlign();
      paintActions();
      paintWb();
    }

    /* ═══ 4. 包内提示词指纹：StatCards + FilterBar + DataTable ═══ */
    function setHint(msg,kind){
      if(!boxes.pkgHint) return;
      boxes.pkgHint.textContent=msg;
      boxes.pkgHint.className='pill '+(kind||'mute');
    }
    function secKind(s){
      if(!s||!s.found) return 'missing';
      return s.partial>0?'partial':'full';
    }
    function clearPkgParts(){
      ['pkgMeta','pkgFilter','pkgTable','pkgReco','pkgUrl'].forEach(k=>{
        if(boxes[k]) boxes[k].innerHTML='';
      });
    }

    function paintPkgTable(){
      if(!shell.alive||!boxes.pkgTable) return;
      const all=arr(state.pkg&&state.pkg.sections);
      const rows=all.filter(s=>state.secState==='all'||secKind(s)===state.secState);
      C.dataTable(boxes.pkgTable,{
        columns:[
          {key:'index', label:'段', render:cell},
          {key:'lines', label:'可指纹行', render:cell},
          {key:'full', label:'整行命中', render:cell},
          {key:'partial', label:'片段命中', render:cell},
          {key:'missing_count', label:'缺失行', render:cell},
          {key:'found', label:'判定', render:(v,r)=>{
            if(!v) return U.pill('正文已变','bad');
            return r.partial>0?U.pill('片段命中','info'):U.pill('整行命中','ok');
          }}
        ],
        rows:rows,
        rowKey:'index',
        actions:row=>arr(row.missing_lines).length
          ?[{label:'查看缺失行', onClick:s=>openSection(s)}]
          :[],
        emptyText:all.length?('当前筛选下没有段落（共 '+all.length+' 段）'):'包内未提取到可比对段落'
      });
    }

    function mountSecFilter(){
      if(!boxes.pkgFilter) return;
      C.filterBar(boxes.pkgFilter,[
        {key:'secState', label:'段落判定', options:SEC_STATE_OPTS}
      ],state,()=>paintPkgTable());
    }

    function paintPkg(){
      if(!shell.alive) return;
      if(state.pkgBusy){
        setHint('分析中…','warn');
        clearPkgParts();
        if(boxes.pkgCards) boxes.pkgCards.innerHTML=U.loadHtml('正在提取官方包并比对提示词指纹…（首次需分段下载数 MB，最长约 90 秒）');
        return;
      }
      if(state.pkgErr){
        setHint('分析失败','bad');
        clearPkgParts();
        if(boxes.pkgCards) boxes.pkgCards.innerHTML='<div class="empty">包分析失败：'+U.esc(state.pkgErr)+'</div>';
        return;
      }
      if(!state.pkg){
        setHint('待分析','mute');
        clearPkgParts();
        if(boxes.pkgCards) boxes.pkgCards.innerHTML='<div class="empty">尚未分析。</div>';
        return;
      }

      const pkg=state.pkg;
      const secs=arr(pkg.sections);
      const hit=secs.filter(s=>!!s.found).length;
      const miss=arr(pkg.missing_sections);
      const hasMiss=miss.length>0;
      setHint(hasMiss?('正文已变 · '+miss.length+' 段'):'正文全文命中', hasMiss?'bad':'ok');
      if(boxes.pkgMeta){
        boxes.pkgMeta.innerHTML=[
          U.pill('包内版本 '+text(pkg.version),'mute'),
          U.pill(pkg.downloaded_now?'本次已下载':'命中缓存', pkg.downloaded_now?'info':'mute'),
          U.pill('耗时 '+(pkg.elapsed_s==null?'—':pkg.elapsed_s)+' 秒','mute')
        ].join('');
      }
      if(boxes.pkgCards){
        C.statCards(boxes.pkgCards,[
          {label:'分析版本', value:text(pkg.version),
           sub:'成员 '+U.esc(text(pkg.member||'glm/zcode.cjs'))},
          {label:'包内 APP_VERSION', value:text(pkg.app_version_in_package),
           sub:'从 zcode.cjs 提取'},
          {label:'本地正文锁', value:text(pkg.local_prompt_aligned),
           sub:'PROMPT_ALIGNED_VERSION'},
          {label:'段落命中', value:String(hit), unit:'/ '+secs.length,
           sub:hasMiss?('缺失段 '+U.esc(miss.join(', '))):'全部段落逐行命中'},
          {label:'本次下载', value:pkg.downloaded_now?'是':'否',
           sub:pkg.downloaded_now?'本次重新分段解包':'同版本命中服务端缓存'}
        ]);
      }
      mountSecFilter();
      paintPkgTable();
      if(boxes.pkgReco) boxes.pkgReco.innerHTML=U.esc(pkg.recommendation||'');
      const url=safeUrl(pkg.package_url);
      if(boxes.pkgUrl){
        boxes.pkgUrl.innerHTML=url
          ?'<p class="sub" style="word-break:break-all">包地址 <a class="mono ext" href="'+U.esc(url)+'" target="_blank" rel="noopener noreferrer">'+U.esc(url)+'</a></p>'
          :'';
      }
    }

    /* 弹窗内的只读表格：先开弹窗，再让 DataTable 接管容器 */
    function openTableModal(title,body,columns,rows,emptyText,actions){
      const m=U.openModal({title:title, wide:true,
        body:body+'<div data-role="modal-table"></div>',
        actions:actions||[{label:'关闭'}]});
      if(m) C.dataTable(m.querySelector('[data-role="modal-table"]'),{
        columns:columns, rows:rows, emptyText:emptyText
      });
      return m;
    }

    function openSection(sec){
      const lines=arr(sec&&sec.missing_lines);
      const rows=lines.map((m,i)=>({
        n:i+1,
        line:m&&m.line,
        frag:arr(m&&m.fragments).join(' / ')
      }));
      openTableModal(
        '段 '+text(sec&&sec.index)+' · 缺失 '+text(sec&&sec.missing_count)+' 行（展示前 '+lines.length+' 行）',
        '',
        [
          {key:'n', label:'序号', render:cell},
          {key:'line', label:'本地行（截断 200 字）', render:cell},
          {key:'frag', label:'官方包内未命中片段', render:dimMono}
        ],
        rows,
        '无缺失行明细'
      );
    }

    async function loadPkg(btn){
      if(state.pkgBusy||!shell.alive) return;
      state.pkgBusy=true;
      state.pkgErr=null;
      const label=btn?btn.textContent:'';
      if(btn){ btn.disabled=true; btn.textContent='分析中…'; }
      paintPkg();
      try{
        const res=await Z.upstreamPackageAnalysis();
        if(!shell.alive) return;
        if(!res||res.ok===false) throw new Error(resErrText(res,'探针接口返回 ok=false'));
        if(!res.data) throw new Error('探针接口返回缺少 data');
        state.pkg=res.data;
      }catch(e){
        if(!shell.alive) return;
        state.pkg=null;
        state.pkgErr=errText(e);
      }finally{
        state.pkgBusy=false;
        if(shell.alive){
          paintPkg();
          if(btn){ btn.disabled=false; btn.textContent=label||'重新分析'; }
        }
      }
    }

    /* ═══ 5. 检查更新 / 刷新分析 ═══ */
    async function loadAnalysis(){
      try{
        const res=await Z.upstreamAnalysis();
        if(!shell.alive) return false;
        if(!res||res.ok===false) throw new Error(resErrText(res,'上游分析接口返回 ok=false'));
        const data=res.data||{};
        state.analysis=data;
        state.analysisErr=null;
        state.analysisAt=Number(data.generated_at)||0;
        paintAnalysis();
        return true;
      }catch(e){
        if(!shell.alive) return false;
        /* 保留上一次成功结果；仅标记最近一次刷新失败 */
        state.analysisErr=e;
        paintAnalysis();
        return false;
      }
    }

    function showCheckResult(res){
      res=res||{};
      const ok=res.ok!==false;
      const has=!!res.has_update;
      const port=!!res.prompt_port_required;
      const pills=[
        ok?U.pill('核验完成','ok'):U.pill('拉取失败','bad'),
        has?U.pill('发现新版本','warn'):U.pill('已是最新','ok'),
        port?U.pill('正文需移植','bad'):U.pill('正文已对齐','ok'),
        res.updated?U.pill('已自动对齐指纹','info'):U.pill('未改动伪装版本','mute')
      ].join('');
      const rows=[
        {k:'当前伪装版本', v:mono(res.current_version)},
        {k:'官方最新版本', v:mono(res.latest_version)},
        {k:'正文锁版本', v:mono(res.prompt_aligned_version)},
        {k:'发布名称', v:U.esc(text(res.release_name))},
        {k:'发布日期', v:U.esc(text(res.release_date))},
        {k:'核验时间', v:U.esc(res.checked_at?U.ts(res.checked_at):'—')}
      ];
      const notes=res.release_notes
        ?'<h2>官方更新日志</h2><pre class="raw">'+U.esc(res.release_notes)+'</pre>'
        :'';
      openTableModal(
        ok?'版本核验结果':'版本核验失败（沿用缓存值）',
        '<div class="toolbar">'+pills+'</div>'+notes,
        [{key:'k', label:'项'},{key:'v', label:'值', render:v=>v}],
        rows,
        '无核验结果',
        [{label:'关闭', kind:'pri'}]
      );
    }

    async function runCheck(btn){
      if(state.checkBusy||!shell.alive) return;
      state.checkBusy=true;
      const label=btn?btn.textContent:'';
      if(btn){ btn.disabled=true; btn.textContent='核验中…'; }
      try{
        const res=await Z.versionCheck();
        if(!shell.alive) return;
        showCheckResult(res);
        if(res&&res.ok===false) U.toast('官方 manifest 拉取失败，沿用上次缓存值','warn');
        /* 核验是 POST，api.js 会清空 /admin/ 下的 GET 缓存，回读必得新值 */
        const ok=await loadAnalysis();
        if(shell.alive&&!ok) U.toast('核验完成，但刷新分析失败：'+errText(state.analysisErr),'warn');
      }catch(e){
        if(shell.alive) U.toast('核验失败：'+errText(e),'bad');
      }finally{
        state.checkBusy=false;
        if(shell.alive&&btn){ btn.disabled=false; btn.textContent=label||'检查更新'; }
      }
    }

    async function refreshAnalysis(btn){
      if(state.refreshBusy||!shell.alive) return;
      state.refreshBusy=true;
      const label=btn?btn.textContent:'';
      if(btn){ btn.disabled=true; btn.textContent='刷新中…'; }
      let ok=false;
      try{
        ok=await loadAnalysis();
      }finally{
        state.refreshBusy=false;
        if(shell.alive&&btn){ btn.disabled=false; btn.textContent=label||'刷新分析'; }
      }
      if(!shell.alive) return;
      if(ok) U.toast('分析已刷新','ok');
      else U.toast('刷新失败：'+errText(state.analysisErr),'bad');
    }

    /* ═══ 6. 装配 ═══ */
    buildLayout();
    wire();
    await loadAnalysis();
    /* 包探针最长约 90 秒：不阻塞首屏，结果到达后再补画包分析分区 */
    if(shell.alive) loadPkg();

    /* 弹窗挂在 body 上，而 router 目前不调用 shell.destroy()：
       用自停哨兵兜底，切走页面后关掉弹窗，避免核验结果盖住新页面。 */
    const staleWatch=setInterval(()=>{
      if(ctx.stale()){ clearInterval(staleWatch); U.closeModal(); }
    },300);
    shell.onCleanup(()=>{ clearInterval(staleWatch); U.closeModal(); });
  }
});
})();
