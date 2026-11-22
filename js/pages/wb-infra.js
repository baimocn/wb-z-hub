/* 页面：基础设施 —— 出口槽位 / CodeArts 第三出口 / /health 健康卡 / 关服
 *
 * 组件层重构结构：
 *   1) state     —— 3 个只读端点的结果 + 槽位 / CodeArts 账号筛选状态
 *   2) shell     —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听生命周期
 *   3) StatCards —— HUB.components.statCards 渲染 /health 健康指标与 CodeArts 概览
 *   4) FilterBar —— HUB.components.filterBar 筛选槽位状态 / CodeArts 账号状态
 *   5) DataTable —— HUB.components.dataTable 渲染槽位表、区域 / 模型就绪、媒体明细、
 *                   CodeArts 账号与模型目录
 *   6) Modal     —— HUB.ui.openModal 承载关服确认与完整模型清单
 *
 * 覆盖端点（HUB.api.wb）：
 *   GET  /wb/proxy/slots                 出口槽位（只读）
 *   GET  /wb/codearts/overview           CodeArts 概览
 *   POST /wb/codearts/models/refresh     刷新模型清单
 *   POST /wb/codearts/credits/refresh    刷新积分
 *   GET  /wb/health                      服务健康（匿名可通）
 *   POST /wb/shutdown                    关服（先回包再退出）
 * 说明：api.js 未封装出口槽的写操作（save / test / discover / subbridge），
 * 故本页只呈现只读槽位表，增删改仍走原生看板（docs/api-inventory.md §10、§三.5）。 */
HUB.register({
  route:'wb-infra', group:'wb', title:'基础设施', order:80,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, A=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：端点结果与筛选（单一事实源） ═══ */
    const state={
      health:{ok:false, error:null, value:null},
      slots:{ok:false, error:null, value:null},
      ca:{ok:false, error:null, value:null},
      slotState:'all',
      caState:'all',
      lastAt:0,
      shuttingDown:false
    };
    let boxes={};
    let lastModels=[];
    let loadSeq=0;

    /* ═══ 2. 常量：筛选项与表格列 ═══ */
    const SLOT_STATE_OPTS=[
      {value:'all', label:'全部状态'},
      {value:'on', label:'启用'},
      {value:'off', label:'已停用'}
    ];
    const CA_STATE_OPTS=[
      {value:'all', label:'全部状态'},
      {value:'on', label:'正常'},
      {value:'cooling', label:'冷却中'},
      {value:'off', label:'已停用'}
    ];

    /* ═══ 3. 工具 ═══ */
    const settle=p=>p.then(v=>({ok:true,value:v}), e=>({ok:false,error:e}));
    const arr=v=>Array.isArray(v)?v:[];
    function text(v){ return (v===null||v===undefined||v==='')?'—':String(v); }
    function mono(v){ return '<span class="mono">'+U.esc(text(v))+'</span>'; }
    function nmono(v){ return '<span class="mono">'+U.esc(U.num(v))+'</span>'; }
    function cr(v){
      if(v===null||v===undefined||v===''||isNaN(Number(v))) return '—';
      return Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
    }
    /* 出口地址可能带 user:pass@，只读表里把口令打码，host:port 仍可见 */
    const maskUrl=u=>String(u||'').replace(
      /^([a-zA-Z][\w+.-]*:\/\/)([^@/]+)@/,
      (s,scheme,cred)=>scheme+String(cred).split(':')[0]+':***@'
    );
    function caption(t){
      return '<div class="sub" style="margin-top:var(--sp-4)">'+U.esc(t)+'</div>';
    }
    function failBox(title,res,hint){
      const e=res&&res.error;
      const msg=(e&&e.message)||String(e||'未知错误');
      const status=(e&&e.status)?('HTTP '+e.status+' · '):'';
      return '<div class="empty"><b>'+U.esc(title)+'</b> · '+U.esc(status+msg)+
        (hint?'<div class="dim">'+U.esc(hint)+'</div>':'')+'</div>';
    }
    function hintFor(res){
      const st=res&&res.error&&res.error.status;
      if(st===401) return '面板会话未就绪或已过期：先在原生看板完成面板登录。';
      if(st===502) return '上游不可达：检查 Base URL、API Key 与出口槽绑定。';
      if(st===503) return 'CodeArts 出口未启用：到设置页填写 Base URL 与 API Key。';
      return '';
    }
    function currentSlots(){
      return state.slots.ok ? arr(state.slots.value&&state.slots.value.slots) : [];
    }
    function slotLabel(slots,id,slotsOk){
      if(!id) return '<span class="dim">直连</span>';
      for(let i=0;i<slots.length;i++){
        if(slots[i]&&String(slots[i].id)===String(id)){
          return mono(slots[i].label||slots[i].name||slots[i].id);
        }
      }
      /* 槽位表读取失败时不能断定「已删除」，只回显绑定 id */
      return mono(id)+(slotsOk?' '+U.pill('已删除','warn'):'');
    }
    function caStateKey(a){
      if(!a) return 'on';
      if(a.disabled) return 'off';
      if(a.cooling) return 'cooling';
      return 'on';
    }
    function matchSlot(s){
      if(!s) return true;
      if(state.slotState==='on') return s.enabled!==false;
      if(state.slotState==='off') return s.enabled===false;
      return true;
    }
    function matchCa(a){
      return state.caState==='all' ? true : caStateKey(a)===state.caState;
    }

    /* ═══ 4. 表格列定义（render 内所有用户数据均经 U.esc / U.pill） ═══ */
    const SLOT_COLS=[
      {key:'label', label:'槽位', render:(v,r)=>
        '<b>'+U.esc(text(v||r.name||r.id))+'</b><div class="dim mono">'+U.esc(text(r.id))+'</div>'},
      {key:'url', label:'代理地址', render:v=>
        '<span class="mono">'+U.esc(maskUrl(v)||'—')+'</span>'},
      {key:'ip', label:'出口', render:(v,r)=>{
        if(!v) return '<span class="dim">未探测</span>';
        const kind=r.ip_type==='residential'?'住宅':(r.ip_type==='datacenter'?'机房':text(r.ip_type));
        const meta=[r.country, kind==='—'?'':kind].filter(Boolean).join(' · ')||'国家未知';
        return '<div class="mono">'+U.esc(v)+'</div><div class="dim">'+
          U.esc(meta+(r.isp?(' · '+r.isp):''))+'</div>';
      }},
      {key:'enabled', label:'状态', render:v=>
        v===false?U.pill('已停用','mute'):U.pill('启用','ok')},
      {key:'bound', label:'绑定', align:'right', render:v=>nmono(v)},
      {key:'probed_at', label:'探测时间', render:v=>
        '<span class="mono">'+U.esc(U.ts(v))+'</span>'}
    ];
    const CA_COLS=[
      {key:'uid', label:'账号', render:(v,r)=>
        '<b>'+U.esc(text(r.nickname||r.name||v))+'</b><div class="dim mono">'+U.esc(text(v))+'</div>'},
      {key:'disabled', label:'状态', render:(v,r)=>
        v?U.pill('已停用','mute'):(r.cooling?U.pill('冷却中','warn'):U.pill('正常','ok'))},
      {key:'credits', label:'剩余积分', render:v=>{
        const remain=v?cr(v.remain):'—';
        const note=v&&v.amount!=null?'<div class="dim">总额 '+U.esc(cr(v.amount))+'</div>':'';
        return '<span class="mono">'+U.esc(remain)+'</span>'+note;
      }},
      {key:'models', label:'模型', align:'right', render:v=>nmono(v)},
      {key:'proxy_slot', label:'出口槽', render:v=>slotLabel(currentSlots(),v,state.slots.ok)},
      {key:'checkin', label:'签到', render:v=>
        v&&v.ok
          ?U.pill('已签到','ok')+'<div class="dim mono">'+U.esc(text(v.checked_at))+'</div>'
          :U.pill('未签到','mute')},
      {key:'token_remaining', label:'令牌剩余', render:v=>
        '<span class="mono">'+U.esc(text(v))+'</span>'}
    ];
    const MODEL_COLS=[
      {key:'id', label:'模型 ID', render:v=>mono(v)},
      {key:'name', label:'名称', render:(v,r)=>U.esc(text(v||(r&&r.id)))},
      {key:'description', label:'说明', render:v=>U.esc(text(v))}
    ];

    /* ═══ 5. 布局（shell 结构只建一次；重检时重建） ═══ */
    function buildLayout(){
      shell.setTitle('基础设施','代理出口 · CodeArts 第三出口 · 服务健康 · 关服开关');
      const bar=shell.toolbar();
      if(bar){
        bar.innerHTML='<div class="toolbar">'+
          '<button class="btn mini" data-act="reload">立即刷新</button>'+
          '<span class="pill mute" id="wi-readat">尚未加载</span>'+
          '<span class="pill mute">每 30s 自动刷新</span>'+
          '</div>';
      }
      const c=shell.content();
      if(!c) return;
      c.innerHTML=
        '<h2>服务健康</h2>'+
        '<p class="sub">GET /wb/health · 匿名可通 · 指标卡汇总进程、出口、账号与加密状态</p>'+
        '<div id="wi-health-cards"></div>'+
        '<div class="toolbar" id="wi-health-pills"></div>'+
        '<div id="wi-health-regions"></div>'+
        '<div id="wi-health-models"></div>'+
        '<div id="wi-health-media"></div>'+
        '<h2>代理槽位</h2>'+
        '<p class="sub" id="wi-slots-sub">GET /wb/proxy/slots · 只读视图；增删改与探测在原生看板完成。</p>'+
        '<div class="toolbar" id="wi-slots-filter"></div>'+
        '<div id="wi-slots-table" style="overflow-x:auto"></div>'+
        '<h2>CodeArts 出口</h2>'+
        '<div class="toolbar" id="wi-ca-bar"></div>'+
        '<div id="wi-ca-cards"></div>'+
        '<p class="sub" id="wi-ca-sub">GET /wb/codearts/overview</p>'+
        '<div class="toolbar" id="wi-ca-filter"></div>'+
        '<div id="wi-ca-accounts" style="overflow-x:auto"></div>'+
        '<div id="wi-ca-models"></div>'+
        '<h2>危险操作</h2>'+
        '<div id="wi-danger"></div>';
      boxes={
        readAt:bar?bar.querySelector('#wi-readat'):null,
        healthCards:c.querySelector('#wi-health-cards'),
        healthPills:c.querySelector('#wi-health-pills'),
        healthRegions:c.querySelector('#wi-health-regions'),
        healthModels:c.querySelector('#wi-health-models'),
        healthMedia:c.querySelector('#wi-health-media'),
        slotsSub:c.querySelector('#wi-slots-sub'),
        slotFilter:c.querySelector('#wi-slots-filter'),
        slotsTable:c.querySelector('#wi-slots-table'),
        caBar:c.querySelector('#wi-ca-bar'),
        caCards:c.querySelector('#wi-ca-cards'),
        caSub:c.querySelector('#wi-ca-sub'),
        caFilter:c.querySelector('#wi-ca-filter'),
        caAccounts:c.querySelector('#wi-ca-accounts'),
        caModels:c.querySelector('#wi-ca-models'),
        danger:c.querySelector('#wi-danger')
      };
      /* FilterBar：挂载一次，选择值由 state 驱动；change 后只重画对应表格 */
      C.filterBar(boxes.slotFilter,[
        {key:'slotState', label:'槽位状态', options:SLOT_STATE_OPTS}
      ],state,()=>paintSlots());
      C.filterBar(boxes.caFilter,[
        {key:'caState', label:'账号状态', options:CA_STATE_OPTS}
      ],state,()=>paintCaAccounts());
      boxes.healthCards.innerHTML=U.loadHtml('拉取基础设施状态…');
      boxes.slotsTable.innerHTML=U.loadHtml('拉取出口槽…');
      boxes.caCards.innerHTML=U.loadHtml('拉取 CodeArts 概览…');
      paintDanger();
    }

    /* ═══ 6. 分区渲染 ═══ */
    function paintReadAt(){
      if(!boxes.readAt) return;
      boxes.readAt.textContent=state.lastAt
        ?('读数 '+new Date(state.lastAt).toLocaleTimeString('zh-CN',{hour12:false}))
        :'尚未加载';
    }

    function paintHealth(){
      if(!shell.alive) return;
      const r=state.health;
      if(!r.ok){
        boxes.healthCards.innerHTML=failBox('读取 /health 失败',r,'网关进程可能未启动。');
        boxes.healthPills.innerHTML='';
        boxes.healthRegions.innerHTML='';
        boxes.healthModels.innerHTML='';
        boxes.healthMedia.innerHTML='';
        return;
      }
      const h=r.value||{};
      const tls=h.outbound_tls||{};
      const realms=Object.keys(h.accounts_by_realm||{});
      const caH=h.codearts||{};
      const media=h.media||{};

      C.statCards(boxes.healthCards,[
        {label:'网关', value:h.ok===true?'在线':'离线',
          sub:U.pill(h.ok===true?'在线':'异常', h.ok===true?'ok':'bad')+
            ' · 进程存活即回 <span class="mono">ok:true</span>'},
        {label:'默认出口', value:text(h.realm), sub:'WB 文本派发区域'},
        {label:'账号就绪', value:U.num(h.accounts_ready)+' / '+U.num(h.accounts),
          sub:'全池可用 / 总数'},
        {label:'当前出口就绪', value:U.num(h.accounts_ready_current_realm),
          sub:'当前区域可用号'},
        {label:'加密', value:h.crypto_ok?'正常':'异常',
          sub:U.pill(h.crypto_ok?'PBKDF2 可用':'不可用', h.crypto_ok?'ok':'bad')+' '+
            U.esc(h.crypto_error||'面板口令散列正常')},
        {label:'出站 TLS', value:text(tls.bridge_state),
          sub:U.esc('模式 '+text(tls.requested_mode)+
            (tls.last_fallback_reason?(' · 回退：'+tls.last_fallback_reason):''))}
      ]);

      boxes.healthPills.innerHTML=
        U.pill(h.api_key_required?'API Key 必需':'匿名可调用', h.api_key_required?'warn':'info')+
        U.pill(!caH.configured?'CodeArts 未配置':(caH.ok?'CodeArts 在线':'CodeArts 异常'),
          !caH.configured?'mute':(caH.ok?'ok':'bad'))+
        (caH.configured?U.pill('CodeArts 账号 '+text(caH.healthy)+'/'+text(caH.accounts),'mute'):'')+
        U.pill('媒体入口 '+(media.enabled?'启用':'停用'), media.enabled?'ok':'bad')+
        (media.realm?U.pill('媒体出口 '+text(media.realm),'mute'):'');

      if(realms.length){
        const ready=h.accounts_ready_by_realm||{};
        boxes.healthRegions.innerHTML=caption('按区域就绪')+
          '<div id="wi-region-table" style="overflow-x:auto"></div>';
        C.dataTable(boxes.healthRegions.querySelector('#wi-region-table'),{
          columns:[
            {key:'realm', label:'区域', render:v=>mono(v)},
            {key:'total', label:'账号', align:'right', render:v=>nmono(v)},
            {key:'ready', label:'就绪', align:'right', render:v=>nmono(v)},
            {key:'rate', label:'就绪率', align:'right', render:v=>U.pct(v)}
          ],
          rows:realms.map(realm=>{
            const total=Number(h.accounts_by_realm[realm])||0;
            const ok=Number(ready[realm])||0;
            return {realm:realm, total:total, ready:ok, rate:total?ok/total*100:0};
          }),
          emptyText:'没有区域就绪数据'
        });
      } else {
        boxes.healthRegions.innerHTML='';
      }

      const mr=h.models_ready||{};
      const modelKeys=Object.keys(mr).sort();
      if(modelKeys.length&&realms.length){
        const shown=modelKeys.slice(0,12);
        boxes.healthModels.innerHTML=
          caption('按模型就绪'+(modelKeys.length>shown.length
            ?'（共 '+modelKeys.length+' 个，示前 '+shown.length+'）':''))+
          '<div id="wi-model-table" style="overflow-x:auto"></div>';
        C.dataTable(boxes.healthModels.querySelector('#wi-model-table'),{
          columns:[{key:'model', label:'模型', render:v=>mono(v)}].concat(
            realms.map((realm,i)=>({
              key:'r'+i, label:realm, align:'right', render:v=>nmono(v)
            }))
          ),
          rows:shown.map(model=>{
            const row={model:model};
            realms.forEach((realm,i)=>{ row['r'+i]=(mr[model]||{})[realm]; });
            return row;
          }),
          emptyText:'没有模型就绪数据'
        });
      } else {
        boxes.healthModels.innerHTML='';
      }

      if(media.enabled||media.tasks){
        const t=media.tasks||{};
        const rows=[
          {k:'启用', v:media.enabled?U.pill('是','ok'):U.pill('否','bad')},
          {k:'出口', v:mono(media.realm)},
          {k:'媒体槽', v:nmono(media.slots)},
          {k:'在飞', v:nmono(media.inflight)},
          {k:'视频并发上限', v:nmono(media.video_concurrency)}
        ];
        if(media.tasks){
          rows.push({k:'任务总数', v:nmono(t.total)});
          rows.push({k:'待处理', v:nmono(t.pending)});
          rows.push({k:'排队深度', v:nmono(t.queue_depth)});
          rows.push({k:'工作线程', v:nmono(t.workers)});
          rows.push({k:'并发 / 活跃 / 等待',
            v:nmono(t.concurrency)+' / '+nmono(t.active)+' / '+nmono(t.waiting)});
          rows.push({k:'忙碌账号', v:nmono(t.busy_accounts)});
          const bs=t.by_status||{};
          const statusKeys=Object.keys(bs).sort();
          if(statusKeys.length){
            rows.push({k:'按状态', v:statusKeys.map(k=>U.pill(k+' '+bs[k],'mute')).join(' ')});
          }
        }
        boxes.healthMedia.innerHTML=caption('媒体入口')+'<div id="wi-media-table"></div>';
        C.dataTable(boxes.healthMedia.querySelector('#wi-media-table'),{
          columns:[
            {key:'k', label:'项'},
            {key:'v', label:'值', render:v=>v}
          ],
          rows:rows,
          emptyText:'没有媒体运行数据'
        });
      } else {
        boxes.healthMedia.innerHTML='';
      }
    }

    function paintSlots(){
      if(!shell.alive) return;
      const r=state.slots;
      if(!r.ok){
        boxes.slotsSub.textContent='GET /wb/proxy/slots · 读取失败';
        boxes.slotsTable.innerHTML=state.lastAt
          ?failBox('读取出口槽失败',r,hintFor(r))
          :U.loadHtml('拉取出口槽…');
        return;
      }
      const slots=arr(r.value&&r.value.slots);
      const rows=slots.filter(matchSlot);
      boxes.slotsSub.textContent='共 '+slots.length+' 个出口槽'+
        (rows.length!==slots.length?' · 筛选后 '+rows.length+' 个':'')+
        ' · GET /wb/proxy/slots · 只读视图（增删改与探测在原生看板完成）';
      C.dataTable(boxes.slotsTable,{
        columns:SLOT_COLS,
        rows:rows,
        rowKey:'id',
        emptyText:slots.length
          ?'当前筛选没有匹配的槽位'
          :'还没有代理槽位。到原生看板的「设置 → 出口槽」添加或自动发现。'
      });
    }

    function paintCaAccounts(){
      if(!shell.alive) return;
      const r=state.ca;
      if(!r.ok){
        boxes.caSub.textContent='GET /wb/codearts/overview';
        boxes.caAccounts.innerHTML=state.lastAt?'':U.loadHtml('拉取 CodeArts 账号…');
        return;
      }
      const ca=r.value||{};
      const slots=currentSlots();
      const accounts=arr(ca.accounts);
      const rows=accounts.filter(matchCa);
      boxes.caSub.textContent='共 '+accounts.length+' 个账号'+
        (rows.length!==accounts.length?' · 筛选后 '+rows.length+' 个':'')+
        ' · GET /wb/codearts/overview';
      C.dataTable(boxes.caAccounts,{
        columns:CA_COLS,
        rows:rows,
        rowKey:'uid',
        emptyText:accounts.length
          ?'当前筛选没有匹配的账号'
          :'还没有 CodeArts 账号。OAuth 添加在原生看板完成。'
      });
    }

    function paintCodeArts(){
      if(!shell.alive) return;
      const r=state.ca;
      if(!r.ok){
        boxes.caBar.innerHTML='';
        boxes.caCards.innerHTML=failBox('读取 CodeArts 总览失败',r,hintFor(r));
        boxes.caSub.textContent='GET /wb/codearts/overview';
        boxes.caAccounts.innerHTML='';
        boxes.caModels.innerHTML='';
        return;
      }
      const ca=r.value||{};
      const st=ca.stats||{};
      const health=ca.health||{};
      const models=arr(ca.models);

      boxes.caBar.innerHTML=
        U.pill(ca.online?'在线':'离线', ca.online?'ok':'bad')+
        U.pill(health.ok?'健康检查通过':'健康检查未通过', health.ok?'ok':'bad')+
        U.pill('地址 '+text(ca.base_url),'mute')+
        '<button class="btn mini" data-act="ca-models">刷新模型清单</button>'+
        '<button class="btn mini" data-act="ca-credits">刷新积分</button>';

      C.statCards(boxes.caCards,[
        {label:'在线', value:ca.online?'在线':'离线',
          sub:U.pill(ca.online?'在线':'离线', ca.online?'ok':'bad')+
            ' 出口 '+U.esc(text(ca.base_url))},
        {label:'健康账号', value:U.num(st.healthy)+' / '+U.num(st.total),
          sub:'冷却 '+U.num(st.cooling)+' · 停用 '+U.num(st.disabled)},
        {label:'剩余积分', value:cr(st.credits), unit:'积分',
          sub:'总额 '+U.esc(cr(st.credits_total))+' · 已用 '+U.esc(cr(st.credits_used))},
        {label:'模型', value:U.num(models.length), sub:'CodeArts 目录并集'}
      ]);

      paintCaAccounts();

      if(models.length){
        const shown=models.slice(0,10);
        boxes.caModels.innerHTML=
          caption('模型目录（'+(models.length>shown.length?'示前 '+shown.length+' / ':'')+
            models.length+' 个）')+
          '<div id="wi-ca-model-table" style="overflow-x:auto"></div>'+
          (models.length>shown.length
            ?'<div class="toolbar"><button class="btn mini" data-act="ca-all-models">查看全部 '+
              models.length+' 个模型</button></div>'
            :'');
        C.dataTable(boxes.caModels.querySelector('#wi-ca-model-table'),{
          columns:MODEL_COLS,
          rows:shown,
          rowKey:'id',
          emptyText:'没有模型'
        });
      } else {
        boxes.caModels.innerHTML='';
      }
    }

    function paintDanger(){
      boxes.danger.innerHTML='<div class="card">'+
        '<div class="k">关闭网关服务'+U.pill('不可撤销','bad')+'</div>'+
        '<div class="n">向 <span class="mono">POST /wb/shutdown</span> 发送关闭指令：'+
          '<span class="mono">/wb</span> 进程先回包再退出，反代、面板、调度器与媒体任务线程一并停止；'+
          '需在服务器上重新启动进程才能恢复。</div>'+
        '<div style="margin-top:var(--sp-3)">'+
          '<button class="btn danger" data-act="shutdown">关闭网关服务</button>'+
        '</div>'+
      '</div>';
    }

    function paintAll(){
      if(!shell.alive) return;
      paintReadAt();
      paintHealth();
      paintSlots();
      paintCodeArts();
    }

    /* ═══ 7. 动作 ═══ */
    function showModels(){
      if(!lastModels.length){ U.toast('当前没有可展示的模型清单','warn'); return; }
      const m=U.openModal({
        title:'CodeArts 模型清单（'+lastModels.length+' 个）',
        wide:true,
        body:'<div id="wi-modal-models" style="max-height:60vh;overflow:auto"></div>',
        actions:[{label:'关闭'}]
      });
      const box=m&&m.querySelector?m.querySelector('#wi-modal-models'):null;
      if(box) C.dataTable(box,{columns:MODEL_COLS, rows:lastModels, rowKey:'id', emptyText:'没有模型'});
    }

    async function refresh(act,btn){
      const old=btn?btn.textContent:'';
      if(btn){ btn.disabled=true; btn.textContent='刷新中…'; }
      try{
        if(act==='ca-models'){
          const r=await A.codeartsModelsRefresh();
          U.toast('模型清单已刷新：'+(r&&r.models!=null?r.models+' 个':(r&&r.message)||'完成'),'ok');
        }else{
          const r=await A.codeartsCreditsRefresh();
          const failed=r&&r.ok===false;
          const msg=(r&&r.message)||('已刷新 '+(r&&r.refreshed!=null?r.refreshed:'')+' 个账号的积分');
          const tail=failed&&r.errors&&r.errors.length?(' · '+r.errors[0]):'';
          U.toast(msg+tail, failed?'warn':'ok');
        }
        if(ctx.stale()) return;
        await load(false);
      }catch(e){
        U.toast((act==='ca-models'?'模型清单':'积分')+'刷新失败：'+e.message,'bad');
      }finally{
        if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent=old; }
      }
    }

    function shutdownCard(r){
      const flag=(r&&r.shutting_down)?'shutting_down=true':'ok=true';
      return '<div class="card">'+
        '<div class="k">网关状态'+U.pill('已请求关闭','bad')+'</div>'+
        '<div class="v">已离线</div>'+
        '<div class="n"><span class="mono">'+U.esc(flag)+'</span> · 进程将在 0.4s 内退出；'+
          '确认进程已重启后可重新检测。</div>'+
        '<div style="margin-top:var(--sp-3)">'+
          '<button class="btn" data-act="recheck">重新检测</button>'+
        '</div>'+
      '</div>';
    }

    async function doShutdown(){
      try{
        const r=await A.shutdown();
        state.shuttingDown=true;
        U.toast('已发送关闭指令，网关正在退出','ok');
        if(ctx.stale()) return;
        shell.setTitle('基础设施','关服指令已发出 · 页面轮询已停止');
        const bar=shell.toolbar();
        if(bar){
          bar.innerHTML='<div class="toolbar">'+U.pill('已请求关闭','bad')+
            '<span class="pill mute">重新检测前不会自动刷新</span></div>';
        }
        shell.setContent(shutdownCard(r));
      }catch(e){
        U.toast('关闭失败：'+e.message,'bad');
      }
    }

    function openShutdown(){
      U.openModal({
        title:'确认关闭网关服务',
        body:'<p class="dim">将向 <span class="mono">POST /wb/shutdown</span> 发送关闭指令：</p>'+
          '<ul class="dim">'+
            '<li>反代与面板立即停止，本页随后失联；</li>'+
            '<li>账号池、调度器与媒体任务线程随进程结束；</li>'+
            '<li>需在服务器上手动重启进程才能恢复。</li>'+
          '</ul>',
        actions:[
          {label:'取消'},
          {label:'确认关闭', kind:'danger', onClick:doShutdown}
        ]
      });
    }

    function onAction(ev){
      const t=ev.target;
      const btn=t&&t.closest?t.closest('[data-act]'):null;
      if(!btn||!el.contains(btn)) return;
      const act=btn.getAttribute('data-act');
      if(act==='reload'){ load(true); return; }
      if(act==='shutdown'){ openShutdown(); return; }
      if(act==='recheck'){
        state.shuttingDown=false;
        buildLayout();
        load(true);
        return;
      }
      if(act==='ca-all-models'){ showModels(); return; }
      if(act==='ca-models'||act==='ca-credits'){ refresh(act,btn); return; }
    }

    /* ═══ 8. 加载：3 个端点并发，单端点失败不阻塞其余分区 ═══ */
    async function load(manual){
      if(state.shuttingDown) return;
      const my=++loadSeq;
      const rs=await Promise.all([
        settle(A.proxySlots()),
        settle(A.codeartsOverview()),
        settle(A.health())
      ]);
      if(state.shuttingDown||my!==loadSeq||ctx.stale()||!shell.alive) return;
      state.slots=rs[0];
      state.ca=rs[1];
      state.health=rs[2];
      lastModels=state.ca.ok?arr(state.ca.value&&state.ca.value.models):[];
      state.lastAt=Date.now();
      paintAll();
      if(manual){
        let bad=0;
        rs.forEach(x=>{ if(!x.ok) bad++; });
        U.toast(bad?('刷新完成，'+bad+' 个接口失败'):'基础设施状态已刷新', bad?'bad':'ok');
      }
    }

    /* ═══ 9. 启动 ═══ */
    if(ctx.stale()) return;
    buildLayout();
    shell.listen(el,'click',onAction);
    await load(false);
    if(ctx.stale()) return;
    shell.poll(function(){
      if(!document.hidden&&!state.shuttingDown) load(false);
    },30000);
    shell.onCleanup(function(){ loadSeq++; });
  }
});
