/* 页面：智能体 —— 智能体（客户端）列表 + 模型分配编辑
 *
 * 组件层结构：
 *   1) state      —— 三个端点的结果与筛选状态（单一事实源）
 *   2) shell      —— 标题 / 工具栏 / 内容区 / 轮询 / 监听生命周期
 *   3) StatCards  —— 一键配置能力 / 客户端 / 模型目录 / 网关 Key / 写入记录
 *   4) FilterBar  —— 智能体列表按「已安装 / 已接通 / 外部改动」过滤
 *   5) DataTable  —— 智能体列表 · 网关 Key · 客户端写入记录（Modal 内）
 *   6) Modal      —— 模型分配编辑（勾选 / 筛选 / 全选 / 撤销 / 覆盖保存）
 *
 * 端点：GET /wb/agents · GET /wb/agents/available · GET /wb/agents/model-selection
 *       POST /wb/agents/model-selection（保存端点未在 api.js 封装，走 HUB.api.POST）
 */
(function(){
const REALM_NAME={cn:'国内版',intl:'国际版'};
const CLIENT_VIEWS=[
  {value:'all',label:'全部客户端'},
  {value:'installed',label:'本机已安装'},
  {value:'configured',label:'已接通'},
  {value:'external',label:'有外部改动'}
];
const MODEL_SCOPES=[
  {value:'all',label:'全部分配状态'},
  {value:'selected',label:'仅已选'},
  {value:'unselected',label:'仅未选'},
  {value:'outside',label:'仅目录外'}
];
const MODEL_CAPS=[
  {value:'all',label:'全部能力'},
  {value:'vision',label:'视觉'},
  {value:'reasoning',label:'思考档位'}
];

function errMsg(e){ return String((e&&e.message)||e||'未知错误'); }
function mono(v){ return '<span class="mono">'+HUB.ui.esc(v==null?'—':v)+'</span>'; }
function bigN(v){
  const n=Number(v);
  if(v===null||v===undefined||v===''||!isFinite(n)) return '—';
  return '<span class="mono">'+n.toLocaleString('zh-CN')+'</span>';
}
function fmtWhen(v){
  if(v===null||v===undefined||v==='') return '—';
  return mono(typeof v==='number'?HUB.ui.ts(v):String(v));
}
function sameSet(a,b){
  if(a.size!==b.size) return false;
  for(const x of a){ if(!b.has(x)) return false; }
  return true;
}
function errPill(label,e){ return e?HUB.ui.pill(label+'失败：'+errMsg(e).slice(0,70),'bad'):''; }

HUB.register({
  route:'wb-agents', group:'wb', title:'智能体', order:50,

  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, W=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：端点结果与筛选（单一事实源） ═══ */
    const state={
      available:false,
      availErr:null,
      data:null,               /* GET /wb/agents：clients / models / keys / gateway */
      dataErr:null,
      selection:new Set(),     /* GET /wb/agents/model-selection：已保存的模型清单 */
      selectionKnown:false,
      selectionErr:null,
      configured:false,        /* 区分「从未保存」与「保存了 0 个」 */
      view:'all',              /* 智能体列表筛选 */
      loading:false
    };
    let pillsBox=null, bannerBox=null, cardsBox=null, clientBar=null, clientNote=null;
    let clientsBox=null, modelPills=null, selectionBox=null, embedNote=null;
    let keysBox=null, refreshBtn=null, editBtn=null;

    /* ═══ 2. 数据派生（一律从 state.data 读；请求失败时保留上一次结果） ═══ */
    const clients=()=> (state.data&&Array.isArray(state.data.clients))?state.data.clients:[];
    const models=()=> (state.data&&Array.isArray(state.data.models))?state.data.models:[];
    const keys=()=> (state.data&&Array.isArray(state.data.keys))?state.data.keys:[];
    const realm=()=> (state.data&&state.data.realm)||'';
    const gateway=()=> (state.data&&state.data.gateway&&state.data.gateway.base_url)||'';
    const embIds=()=> (state.data&&Array.isArray(state.data.model_embedding_clients))?state.data.model_embedding_clients:[];
    function catalogIds(){
      const set=new Set();
      models().forEach(m=>{ if(m&&m.id) set.add(String(m.id)); });
      return set;
    }
    function clientLabel(id){
      const hit=clients().filter(c=>c&&c.id===id)[0];
      return hit?(hit.label||hit.id):String(id);
    }

    /* ═══ 3. 拉取：三个端点互不拖累，失败只挂错误徽章 ═══ */
    async function fetchAll(){
      if(state.loading) return;
      state.loading=true;
      const [aR,bR,cR]=await Promise.allSettled([W.agentsAvailable(),W.agents(),W.agentsModelSelection()]);
      state.loading=false;
      if(!shell.alive) return;

      state.availErr=aR.status==='rejected'?aR.reason:null;
      state.dataErr=bR.status==='rejected'?bR.reason:null;
      state.selectionErr=cR.status==='rejected'?cR.reason:null;
      if(aR.status==='fulfilled') state.available=!!(aR.value&&aR.value.enabled);
      else if(bR.status==='fulfilled') state.available=!!(bR.value&&bR.value.enabled);
      if(bR.status==='fulfilled') state.data=bR.value||null;

      let sel=null;
      if(cR.status==='fulfilled'&&cR.value&&Array.isArray(cR.value.selected_models)) sel=cR.value.selected_models;
      else if(bR.status==='fulfilled'&&bR.value&&Array.isArray(bR.value.selected_models)) sel=bR.value.selected_models;
      if(sel){ state.selection=new Set(sel.map(String)); state.selectionKnown=true; }

      if(cR.status==='fulfilled'&&cR.value&&typeof cR.value.configured==='boolean') state.configured=cR.value.configured;
      else if(bR.status==='fulfilled'&&bR.value&&typeof bR.value.models_configured==='boolean') state.configured=!!bR.value.models_configured;
    }

    /* ═══ 4. 布局：shell 结构只建一次，后续只更新各分区盒子 ═══ */
    function buildLayout(){
      shell.setTitle('智能体','客户端一键配置与模型分配 · 勾选的模型才会被写入客户端配置');
      const bar=shell.toolbar();
      bar.innerHTML=`<div class="toolbar">
        <span id="ag-pills"></span><span class="spacer"></span>
        <button class="btn" id="ag-refresh">重新拉取</button>
      </div>`;

      const c=shell.content();
      c.innerHTML=`
        <div id="ag-banner"></div>
        <div id="ag-cards"></div>
        <h2>智能体列表</h2>
        <p class="sub">「已接通」表示本网关写过配置并可回滚；外部改动会单独标出。</p>
        <div class="toolbar"><span id="ag-cview"></span><span id="ag-cnote" class="dim"></span></div>
        <div id="ag-clients"></div>
        <h2>模型分配</h2>
        <p class="sub">只有勾选的模型会被一键配置写进客户端；清单为空时，读取清单的客户端会拒绝写入。</p>
        <div class="toolbar">
          <span id="ag-mpills"></span><span class="spacer"></span>
          <button class="btn pri" id="ag-edit" disabled>编辑模型分配</button>
        </div>
        <div id="ag-selection"></div>
        <p class="sub" id="ag-embed"></p>
        <h2>可用网关 Key</h2>
        <p class="sub">仅列出启用中的 Key；一键配置优先用全局 Key，否则用第一个启用的 Key。</p>
        <div id="ag-keys"></div>
        <p class="sub" style="margin-top:var(--sp-5)">数据来源：/wb/agents · /wb/agents/available · /wb/agents/model-selection</p>`;

      pillsBox=bar.querySelector('#ag-pills');
      refreshBtn=bar.querySelector('#ag-refresh');
      bannerBox=c.querySelector('#ag-banner');
      cardsBox=c.querySelector('#ag-cards');
      clientBar=c.querySelector('#ag-cview');
      clientNote=c.querySelector('#ag-cnote');
      clientsBox=c.querySelector('#ag-clients');
      modelPills=c.querySelector('#ag-mpills');
      selectionBox=c.querySelector('#ag-selection');
      embedNote=c.querySelector('#ag-embed');
      keysBox=c.querySelector('#ag-keys');
      editBtn=c.querySelector('#ag-edit');

      cardsBox.innerHTML=U.loadHtml('拉取智能体目录…');
      clientsBox.innerHTML=U.loadHtml('检测客户端…');
      selectionBox.innerHTML=U.loadHtml('读取模型清单…');
      keysBox.innerHTML=U.loadHtml('读取网关 Key…');
    }

    /* ═══ 5. 状态徽章 / 不可用横幅 / 指标卡 ═══ */
    function paintPills(){
      if(!pillsBox) return;
      const out=[state.available?U.pill('本机可写客户端配置','ok'):U.pill('本机不可用','bad')];
      const r=realm(); if(r) out.push(U.pill('出口 '+(REALM_NAME[r]||r),'info'));
      const g=gateway(); if(g) out.push(U.pill('网关 '+g,'mute'));
      if(state.data) out.push(U.pill(state.configured?'清单已保存':'清单从未保存','mute'));
      const errs=[
        errPill('可用性探测',state.availErr),
        errPill('智能体目录',state.dataErr),
        errPill('模型清单',state.selectionErr)
      ].filter(Boolean);
      pillsBox.innerHTML=out.join(' ')+(errs.length?' '+errs.join(' '):'');
    }

    function paintBanner(){
      if(!bannerBox) return;
      if(state.available||(!state.data&&!state.availErr)){ bannerBox.innerHTML=''; return; }
      const reason=(state.data&&state.data.reason)||'';
      bannerBox.innerHTML=`<div class="empty">一键配置只对「网关所在机器」上打开的看板开放${
        reason?'：'+U.esc(reason):''}。远程看板仍可查看模型清单并保存分配。</div>`;
    }

    /* statCards 只自动转义 value；sub 是原样 HTML，动态文本在这里转义 */
    function paintCards(){
      if(!cardsBox) return;
      const d=state.data;
      if(!d){
        C.statCards(cardsBox,[
          {label:'一键配置能力',value:state.available?'可用':'不可用',
           sub:state.available
             ?U.pill('仅网关本机可写入客户端配置','ok')
             :U.pill(state.availErr?'可用性探测失败':'本机不可用','bad')},
          {label:'智能体目录',value:'—',
           sub:state.dataErr?('接口未返回：'+U.esc(errMsg(state.dataErr).slice(0,80))):'接口未返回'}
        ]);
        return;
      }
      const cs=clients(), ms=models(), ks=keys(), r=realm();
      const installed=cs.filter(c=>c.installed).length;
      const configured=cs.filter(c=>c.configured).length;
      const applied=cs.filter(c=>c.applied).length;
      const ext=cs.filter(c=>c.applied&&c.applied.external_change).length;
      C.statCards(cardsBox,[
        {label:'一键配置能力',value:state.available?'可用':'不可用',
         sub:state.available
           ?U.pill('仅网关本机可写入客户端配置','ok')
           :U.pill(d.reason||'来源地址不是网关本机','bad')},
        {label:'客户端',value:cs.length,unit:'个',
         sub:'本机检测到 '+installed+' · 已有写入记录 '+configured},
        {label:'模型目录',value:ms.length,unit:'个',
         sub:'出口 '+U.esc(REALM_NAME[r]||r||'未知')
           +' · 已选 <span class="mono">'+U.esc(String(state.selection.size))+'</span>'},
        {label:'网关 Key',value:ks.length,unit:'个启用',
         sub:(d.global_key_set?'全局 Key 已设':'全局 Key 未设')+' · 鉴权'+(d.auth_required?'开启':'关闭')},
        {label:'写入记录',value:applied,unit:'个客户端',
         sub:ext?('外部改动 '+ext+' 个'):'全部与本页写入一致'}
      ]);
    }

    /* ═══ 6. 智能体列表：FilterBar + DataTable ═══ */
    const CLIENT_COLS=[
      {key:'label',label:'客户端',render:(v,row)=>U.esc(v||row.id||'—')
        +'<div class="dim mono" style="font-size:var(--fs-xs)">'+U.esc(row.id||'')+'</div>'},
      {key:'protocol',label:'协议',render:v=>U.pill(v||'—',v==='anthropic'?'info':'mute')},
      {key:'installed',label:'本机检测',render:v=>v?U.pill('已安装','ok'):U.pill('未检测到','mute')},
      {key:'configured',label:'一键配置',render:(v,row)=>{
        if(!v) return U.pill('未接通','mute');
        const app=row.applied||null;
        return app&&app.external_change?U.pill('已接通 · 外部改动','warn'):U.pill('已接通','ok');
      }},
      {key:'config_paths',label:'配置文件',
       render:v=>'<span class="mono">'+U.esc(String(Array.isArray(v)?v.length:0))+'</span> 个'},
      {key:'applied',label:'最近写入',render:v=>fmtWhen(v&&v.at)}
    ];

    function paintClients(){
      if(!clientsBox) return;
      const all=clients().filter(c=>c&&c.id);
      let shown=all;
      if(state.view==='installed') shown=all.filter(c=>c.installed);
      else if(state.view==='configured') shown=all.filter(c=>c.configured);
      else if(state.view==='external') shown=all.filter(c=>c.applied&&c.applied.external_change);
      if(clientNote) clientNote.textContent=state.data?('显示 '+shown.length+' / '+all.length+' 个客户端'):'';
      C.dataTable(clientsBox,{
        columns:CLIENT_COLS,
        rows:shown,
        rowKey:'id',
        actions:row=>[{label:'详情',onClick:()=>openClient(row)}],
        emptyText:!state.data
          ? ('智能体目录读取失败'+(state.dataErr?'：'+errMsg(state.dataErr).slice(0,120):'')+'（可点「重新拉取」重试）')
          : (all.length?'当前筛选下没有客户端':'后端未返回任何客户端定义')
      });
    }

    /* ═══ 7. 模型分配摘要（清单在 Modal 里编辑） ═══ */
    function paintModels(){
      const ids=[...state.selection], cat=catalogIds();
      const outside=ids.filter(id=>!cat.has(id)).length;

      if(modelPills){
        const out=[U.pill('已选 '+ids.length,'mute')];
        if(state.data) out.push(U.pill('目录 '+models().length,'mute'));
        if(state.configured) out.push(U.pill('清单已保存','ok'));
        else if(state.data) out.push(U.pill('清单从未保存','warn'));
        if(outside) out.push(U.pill('目录外 '+outside,'warn'));
        if(state.selectionErr) out.push(U.pill('清单读取失败','bad'));
        modelPills.innerHTML=out.join(' ');
      }

      if(selectionBox){
        const list=ids.slice().sort();
        if(!state.selectionKnown){
          selectionBox.innerHTML='<div class="empty">模型清单状态未知'
            +(state.selectionErr?('：'+U.esc(errMsg(state.selectionErr).slice(0,120))):'')+'</div>';
        }else if(!list.length){
          selectionBox.innerHTML='<div class="empty">'
            +(state.configured
              ? '清单已保存，但勾选了 0 个模型：读取清单的客户端会拒绝一键配置。'
              : '清单从未保存：一键配置会退回完整目录。')
            +'</div>';
        }else{
          const head=list.slice(0,40);
          selectionBox.innerHTML='<div class="toolbar">'+head.map(id=>U.pill(id,'mute')).join(' ')
            +(list.length>head.length?U.pill('… 其余 '+(list.length-head.length)+' 个','mute'):'')+'</div>';
        }
      }

      if(embedNote){
        const emb=embIds().map(clientLabel);
        const non=clients().filter(c=>c&&c.id&&embIds().indexOf(c.id)<0).map(c=>c.label||c.id);
        embedNote.textContent='读取此清单的客户端：'+(emb.length?emb.join(' / '):'无')
          +(non.length?('；'+non.join(' / ')+' 不读取模型清单'):'');
      }
    }

    /* ═══ 8. 网关 Key 表 ═══ */
    function paintKeys(){
      if(!keysBox) return;
      const rows=keys().filter(k=>k&&k.id)
        .map(k=>({id:String(k.id),name:k.name||'',realm:k.realm||'',global:false}));
      if(state.data&&state.data.global_key_set) rows.push({id:'__global',name:'全局 Key',realm:'',global:true});
      C.dataTable(keysBox,{
        columns:[
          {key:'id',label:'Key',render:(v,row)=>row.global?U.pill('__global','ok'):mono(v)},
          {key:'name',label:'名称',render:(v,row)=>row.global
            ?U.pill('全局 Key','ok')+' <span class="dim">环境变量配置</span>'
            :U.esc(v||'未命名')},
          {key:'realm',label:'出口绑定',render:(v,row)=>row.global
            ?U.pill('默认出口','mute')
            :(v?U.pill(v,'info'):U.pill('未绑定','mute'))}
        ],
        rows,
        rowKey:'id',
        emptyText:'没有启用中的网关 Key'
      });
    }

    function paintAll(){
      if(!shell.alive) return;
      paintPills(); paintBanner(); paintCards(); paintClients(); paintModels(); paintKeys();
      if(editBtn) editBtn.disabled=!state.data;
    }

    /* ═══ 9. 客户端详情 Modal（写入记录用 DataTable） ═══ */
    function openClient(c){
      if(!c) return;
      const app=c.applied||null;
      const paths=(Array.isArray(c.config_paths)?c.config_paths:[]).map(p=>U.esc(p)).join('\n')||'—';
      const m=U.openModal({
        title:(c.label||c.id||'客户端')+' · 配置详情',
        wide:true,
        body:`<p class="sub" style="margin:0 0 var(--sp-3)">${U.esc(c.desc||c.label||c.id||'')}</p>
          <div class="toolbar">
            ${c.installed?U.pill('本机已安装','ok'):U.pill('未检测到安装','mute')}
            ${U.pill('协议 '+(c.protocol||'—'),'info')}
            ${c.configured?U.pill('本网关已接通','ok'):U.pill('本网关未接通','mute')}
          </div>
          <h2 style="margin-top:var(--sp-2)">配置文件</h2>
          <pre class="raw">${paths}</pre>
          <h2>最近一次一键写入</h2>
          <div id="ag-applied"></div>
          <p class="sub" style="margin-top:var(--sp-4)">本页为状态视图：写入与回滚由网关本机的配置器执行，控制台只负责核对与模型清单分配。</p>`,
        actions:[{label:'关闭'}]
      });
      const box=m&&m.querySelector('#ag-applied');
      if(!box) return;
      C.dataTable(box,{
        columns:[{key:'k',label:'字段'},{key:'v',label:'值',render:v=>v}],
        rows:app?[
          {k:'写入时间',v:fmtWhen(app.at)},
          {k:'Base URL',v:app.base_url?mono(app.base_url):'—'},
          {k:'默认模型',v:app.model?mono(app.model):'—'},
          {k:'写入文件',v:'<span class="mono">'+U.esc(String(app.files||0))+'</span> 个'},
          {k:'一致性',v:app.external_change?U.pill('文件已被外部修改','warn'):U.pill('无外部改动','ok')}
        ]:[],
        rowKey:'k',
        emptyText:'没有本网关的写入记录'
      });
    }

    /* ═══ 10. 模型分配编辑 Modal ═══ */
    function openEditor(){
      if(!state.data){ U.toast('智能体目录尚未加载，无法编辑模型分配','warn'); return; }
      const draft=new Set(state.selection);      /* 弹窗内草稿 */
      const baseline=new Set(state.selection);   /* 打开时快照：脏检查与撤销 */
      const view={q:'',scope:'all',cap:'all'};
      let busy=false;

      const modal=U.openModal({
        title:'模型分配编辑',
        wide:true,
        body:`<p class="sub" style="margin:0 0 var(--sp-3)">勾选的模型会写入「网关模型清单」，一键配置只把这些模型交给客户端。清空全部勾选并保存等于清空清单，读取清单的客户端会拒绝一键配置。</p>
          <div class="toolbar">
            <input id="ag-q" type="search" aria-label="筛选模型" placeholder="筛选模型 ID / 名称" autocomplete="off" style="min-width:220px;max-width:320px;flex:1">
            <span id="ag-filters"></span>
            <span class="spacer"></span>
            <span id="ag-mcount"></span><span id="ag-mdirty"></span>
          </div>
          <div class="toolbar">
            <button class="btn mini" id="ag-all">全选当前结果</button>
            <button class="btn mini" id="ag-none">清空勾选</button>
            <button class="btn mini" id="ag-undo" disabled>撤销改动</button>
            <span id="ag-shown" class="dim"></span>
            <span class="spacer"></span>
            <button class="btn pri" id="ag-save" disabled>保存模型清单</button>
          </div>
          <div id="ag-confirm"></div>
          <div id="ag-mtable"></div>`,
        actions:[{label:'关闭'}]
      });

      const $=s=>modal.querySelector(s);
      const qInput=$('#ag-q'), filterBox=$('#ag-filters'), countEl=$('#ag-mcount');
      const dirtyEl=$('#ag-mdirty'), allBtn=$('#ag-all'), noneBtn=$('#ag-none');
      const undoBtn=$('#ag-undo'), shownEl=$('#ag-shown'), saveBtn=$('#ag-save');
      const confirmBox=$('#ag-confirm'), tableBox=$('#ag-mtable');

      /* 目录 + 历史已选但目录外的模型：目录外的勾选必须保留，否则保存会丢 */
      function allRows(){
        const seen=new Set(), cat=[];
        models().forEach(x=>{
          const id=x&&x.id?String(x.id):'';
          if(!id||seen.has(id)) return;
          seen.add(id);
          cat.push({id,name:x.name||'',ctx:x.context_window,out:x.max_output,vision:!!x.supports_vision,
            efforts:Array.isArray(x.reasoning_efforts)?x.reasoning_efforts:[],outside:false});
        });
        const outside=[...draft].filter(id=>!seen.has(id)).sort()
          .map(id=>({id,name:'',ctx:null,out:null,vision:false,efforts:[],outside:true}));
        return outside.concat(cat);
      }

      function matches(r){
        if(view.scope==='selected'&&!draft.has(r.id)) return false;
        if(view.scope==='unselected'&&draft.has(r.id)) return false;
        if(view.scope==='outside'&&!r.outside) return false;
        if(view.cap==='vision'&&!(r.vision&&!r.outside)) return false;
        if(view.cap==='reasoning'&&!(r.efforts.length&&!r.outside)) return false;
        const q=view.q.trim().toLowerCase();
        return !q||(r.id+' '+r.name).toLowerCase().indexOf(q)>=0;
      }

      function syncMeta(){
        countEl.innerHTML=U.pill('已选 '+draft.size,'mute');
        const dirty=!sameSet(draft,baseline);
        dirtyEl.innerHTML=dirty?U.pill('有未保存改动','warn'):U.pill('与网关一致','ok');
        saveBtn.disabled=!dirty||busy;
        undoBtn.disabled=!dirty||busy;
      }

      function syncBoxes(){
        tableBox.querySelectorAll('input[data-mid]').forEach(i=>{
          i.checked=draft.has(i.getAttribute('data-mid'));
        });
      }

      function paintTable(){
        const all=allRows(), shown=all.filter(matches);
        C.dataTable(tableBox,{
          columns:[
            {key:'_pick',label:'选',render:(v,r)=>'<input type="checkbox" aria-label="选择 '
              +U.esc(r.id)+'" data-mid="'+U.esc(r.id)+'"'+(draft.has(r.id)?' checked':'')+'>'},
            {key:'id',label:'模型 ID',render:v=>mono(v)},
            {key:'name',label:'名称',render:v=>v?U.esc(v):'<span class="dim">—</span>'},
            {key:'ctx',label:'上下文',render:v=>bigN(v)},
            {key:'out',label:'输出上限',render:v=>bigN(v)},
            {key:'efforts',label:'能力',render:(v,r)=>{
              const parts=[];
              if(r.outside) parts.push(U.pill('目录外','warn'));
              if(r.vision) parts.push(U.pill('视觉','info'));
              if(r.efforts.length) parts.push(U.pill('思考 '+r.efforts.join('/'),'mute'));
              return parts.join(' ')||'<span class="dim">—</span>';
            }}
          ],
          rows:shown,
          rowKey:'id',
          emptyText:all.length?'没有符合筛选条件的模型':'模型目录为空：请检查出口目录或稍后重试'
        });
        shownEl.textContent='显示 '+shown.length+' / '+all.length+' 个模型';
        syncMeta();
      }

      /* 覆盖保存前先弹窗内确认，避免误触清空清单 */
      function askSave(){
        if(busy) return;
        if(sameSet(draft,baseline)){ U.toast('没有需要保存的改动','warn'); return; }
        const list=[...draft];
        const preview=list.slice(0,8).join('、')+(list.length>8?' 等':'');
        confirmBox.innerHTML=`<div class="toolbar">
          <span class="pill warn">覆盖网关模型清单</span>
          <span class="dim">${list.length
            ?'将写入 '+list.length+' 个模型：'+U.esc(preview)
            :'将清空清单（读取清单的客户端会拒绝一键配置）'}</span>
          <span class="spacer"></span>
          <button class="btn pri" data-confirm="save">确认保存</button>
          <button class="btn" data-confirm="cancel">取消</button>
        </div>`;
        if(confirmBox.scrollIntoView) confirmBox.scrollIntoView({block:'nearest'});
      }

      async function doSave(){
        if(busy) return;
        const list=[...draft];
        busy=true;
        confirmBox.innerHTML='';
        saveBtn.textContent='保存中…';
        syncMeta();
        try{
          /* 保存端点未在 api.js 封装，仍走统一 API 客户端（非裸 fetch） */
          const res=await HUB.api.POST('/wb/agents/model-selection',{models:list});
          if(!shell.alive) return;
          const saved=(res&&Array.isArray(res.selected_models))?res.selected_models.map(String):list;
          state.selection=new Set(saved);
          state.selectionKnown=true;
          state.configured=true;
          baseline.clear(); saved.forEach(x=>baseline.add(x));
          draft.clear(); saved.forEach(x=>draft.add(x));
          paintAll();
          U.toast('已保存 '+state.selection.size+' 个模型到网关清单','ok');
          U.closeModal();
        }catch(e){
          if(!shell.alive) return;
          busy=false;
          if(saveBtn.isConnected) saveBtn.textContent='保存模型清单';
          syncMeta();
          U.toast('保存模型清单失败：'+errMsg(e).slice(0,120),'bad');
        }
      }

      /* 事件：节点随 Modal 销毁，shell.listen 负责切页时清理 */
      C.filterBar(filterBox,[
        {key:'scope',label:'分配状态',options:MODEL_SCOPES},
        {key:'cap',label:'能力',options:MODEL_CAPS}
      ],view,()=>paintTable());

      shell.listen(qInput,'input',()=>{ view.q=qInput.value||''; paintTable(); });
      shell.listen(tableBox,'change',ev=>{
        const t=ev.target;
        if(!t||t.tagName!=='INPUT'||t.type!=='checkbox') return;
        const id=t.getAttribute('data-mid');
        if(!id) return;
        if(t.checked) draft.add(id); else draft.delete(id);
        syncMeta();   /* 不整表重绘：保住滚动位置 */
      });
      shell.listen(allBtn,'click',()=>{
        const shown=allRows().filter(matches);
        shown.forEach(r=>draft.add(r.id));
        syncBoxes(); syncMeta();
        U.toast(shown.length?('已勾选 '+shown.length+' 个当前结果'):'当前筛选下没有模型','ok');
      });
      shell.listen(noneBtn,'click',()=>{ draft.clear(); syncBoxes(); syncMeta(); });
      shell.listen(undoBtn,'click',()=>{
        draft.clear(); baseline.forEach(x=>draft.add(x));
        syncBoxes(); syncMeta();
        U.toast('已撤销未保存的改动','info');
      });
      shell.listen(saveBtn,'click',askSave);
      shell.listen(confirmBox,'click',ev=>{
        const b=ev.target&&ev.target.closest?ev.target.closest('[data-confirm]'):null;
        if(!b) return;
        const act=b.getAttribute('data-confirm');
        if(act==='cancel'){ confirmBox.innerHTML=''; return; }
        if(act==='save') doSave();
      });

      paintTable();
    }

    /* ═══ 11. 动作与生命周期 ═══ */
    async function refresh(){
      if(state.loading) return;
      refreshBtn.disabled=true;
      refreshBtn.textContent='拉取中…';
      try{
        await fetchAll();
        if(!shell.alive) return;
        paintAll();
        U.toast('已重新拉取智能体目录','ok');
      }finally{
        if(refreshBtn.isConnected){ refreshBtn.disabled=false; refreshBtn.textContent='重新拉取'; }
      }
    }

    function bindEvents(){
      shell.listen(refreshBtn,'click',refresh);
      shell.listen(editBtn,'click',openEditor);
      shell.onCleanup(()=>U.closeModal());
      /* 60s 轻轮询：本机配置器改动客户端文件后，外部改动徽章自动跟上 */
      shell.poll(async()=>{
        if(state.loading) return;
        await fetchAll();
        if(!shell.alive) return;
        paintAll();
      },60000);
    }

    /* ═══ 12. 首屏：布局 → 组件 → 事件 → 首次拉取 ═══ */
    if(!shell.alive) return;
    buildLayout();
    bindEvents();
    C.filterBar(clientBar,[{key:'view',label:'客户端视图',options:CLIENT_VIEWS}],state,()=>paintClients());
    await fetchAll();
    if(!shell.alive) return;
    paintAll();
  }
});
})();
