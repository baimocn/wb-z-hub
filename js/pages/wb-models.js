/* 页面：模型 —— 模型目录 / 定价估算 / 手填映射（wb-models）
 *
 * 组件层结构：
 *   1) state     —— 端点结果与筛选状态（单一事实源）
 *   2) shell     —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 监听生命周期
 *   3) FilterBar —— 目录版本（intl / cn）切换，只改本页目录视图，不动全局出口
 *   4) DataTable —— 模型目录 / 生效定价 / 未定价模型三张表
 *   5) StatCards —— 定价运行状态指标
 *   6) Modal     —— 定价映射编辑（保存 / 删除；写入后立即重新取价）
 *
 * 覆盖端点：wb.models · wb.pricing · wb.pricingRefresh · wb.pricingMapping · wb.catalogRefresh
 * 目录不带 realm 时由后端按当前出口回答，再据返回的 realm 固定本页视图。 */
HUB.register({
  route:'wb-models', group:'wb', title:'模型', order:40,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, W=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：端点结果与筛选（单一事实源） ═══ */
    const state={
      realm:null,                 /* null = 自动：首次由后端回答当前出口 */
      query:'',
      models:null, modelsErr:null,
      pricing:null, pricingErr:null,
      busy:false,
      pricePoll:false, pollTicks:0 /* 取价进行中的 4s 轮询开关 */
    };
    let modelSeq=0, realmSig='';
    let barRealm=null, catPills=null, catNote=null, catTable=null;
    let priceHead=null, priceCards=null, priceTable=null, gapTable=null, logBox=null;
    let btnCatalog=null, btnPrice=null, btnMap=null, searchInput=null;

    /* ═══ 2. 常量与格式化（动态值一律 U.esc） ═══ */
    const SOURCE_LABELS={remote:'上游实时',endpoint:'上游端点',cache:'本机缓存',legacy:'旧版缓存',bundled:'内置快照'};
    const GAP_LABELS={
      or_missing:{text:'OpenRouter 无对应',kind:'warn'},
      variant_unmatched:{text:'变体名未命中基准',kind:'warn'},
      alias:{text:'虚拟别名（非实体）',kind:'mute'}
    };

    function errMsg(e){ return String((e&&e.message)||e||'未知错误'); }
    function errBox(label,e){ return '<div class="empty">'+U.esc(label)+'：'+U.esc(errMsg(e).slice(0,240))+'</div>'; }
    function mono(v,title){
      return '<span class="mono"'+(title?' title="'+U.esc(title)+'"':'')+'>'+U.esc(v==null?'—':v)+'</span>';
    }
    function searchText(m){
      const caps=m.capabilities||{};
      const bits=[m.id,m.name,m.description];
      if(caps.vision) bits.push('视觉');
      if(caps.tool_calls) bits.push('工具');
      if(caps.reasoning) bits.push('推理');
      if(m.entitlement&&m.entitlement.required==='standard') bits.push('pro');
      return bits.filter(Boolean).join(' ').toLowerCase();
    }
    function capsCell(m){
      const caps=m.capabilities||{};
      const out=[];
      if(caps.vision) out.push(U.pill('视觉','info'));
      if(caps.tool_calls) out.push(U.pill('工具','mute'));
      if(caps.reasoning) out.push(U.pill('推理','mute'));
      if(m.entitlement&&m.entitlement.required==='standard') out.push(U.pill('PRO','warn'));
      if(m.always_reasoning) out.push(U.pill('强制推理','mute'));
      return out.length?out.join(' '):'<span class="dim">纯文本</span>';
    }
    function ctxCell(m){
      if(!m.context_length) return '—';
      let html='<span class="mono">'+U.esc(U.num(m.context_length))+'</span>';
      if(m.max_output_tokens){
        html+='<div class="dim" style="font-size:var(--fs-xs)">出 <span class="mono">'+U.esc(U.num(m.max_output_tokens))+'</span></div>';
      }
      return html;
    }
    function viaCell(c){
      if(c.via==='variant') return U.pill('变体继承','info')+' '+mono(c.inherited_from||'?');
      if(c.via==='override') return U.pill('人工映射','warn');
      return U.pill('直接匹配','mute');
    }
    function gapPill(g){
      const lab=GAP_LABELS[g.reason]||{text:g.reason||'未定价',kind:'mute'};
      return U.pill(lab.text,lab.kind);
    }
    function candCell(g){
      if(g.reason==='alias') return '<span class="dim">虚拟别名，无需登记</span>';
      const cands=Array.isArray(g.candidates)?g.candidates:[];
      if(!cands.length) return '<span class="dim">无候选，可手填 OpenRouter id</span>';
      return cands.map(c=>'<button class="btn mini" data-cand="'+U.esc(c)+'" data-cand-model="'+U.esc(g.model)+'" title="填入映射表单">'+U.esc(c)+'</button>').join(' ');
    }

    /* DataTable 列定义：render 返回 HTML，内部动态值已自行转义 */
    const MODEL_COLS=[
      {key:'id',label:'模型 ID',render:(v,row)=>mono(v,row.description)},
      {key:'name',label:'名称',render:v=>v?U.esc(v):'—'},
      {key:'capabilities',label:'能力',render:(v,row)=>capsCell(row)},
      {key:'context_length',label:'上下文',render:(v,row)=>ctxCell(row)}
    ];
    const PRICE_COLS=[
      {key:'model',label:'模型',render:v=>mono(v)},
      {key:'id',label:'当前策略 ID',render:v=>mono(v,'策略内容哈希')},
      {key:'via',label:'匹配方式',render:(v,row)=>viaCell(row)},
      {key:'label',label:'首次取价',render:v=>mono(v)}
    ];
    const GAP_COLS=[
      {key:'model',label:'模型',render:v=>mono(v)},
      {key:'reason',label:'原因',render:(v,row)=>gapPill(row)},
      {key:'candidates',label:'候选 / 填单',render:(v,row)=>candCell(row)}
    ];

    /* ═══ 3. 数据：模型目录 / 定价状态 ═══ */
    function catalogData(){ return (state.models&&Array.isArray(state.models.data))?state.models.data:[]; }

    async function fetchModels(){
      const seq=++modelSeq;              /* 竞态守卫：只认最后一次目录请求 */
      const realm=state.realm;
      try{
        let res;
        if(!realm){
          res=await W.models();
          if(seq!==modelSeq) return;
          const r=res&&res.realm;
          if(r==='intl'||r==='cn'){ state.realm=r; }
          else{
            state.realm='intl';
            res=await W.models('intl');
            if(seq!==modelSeq) return;
          }
        }else{
          res=await W.models(realm);
          if(seq!==modelSeq) return;
          if(res&&(res.realm==='intl'||res.realm==='cn')) state.realm=res.realm;
        }
        state.models=res||null; state.modelsErr=null;
      }catch(e){
        if(seq!==modelSeq) return;
        if(!state.realm) state.realm='intl';
        state.models=null; state.modelsErr=e;
      }
    }
    async function fetchPricing(){
      try{ state.pricing=await W.pricing(); state.pricingErr=null; }
      catch(e){ if(!state.pricing) state.pricingErr=e; }
    }

    /* ═══ 4. 布局（shell 结构只建一次；后续只更新各分区盒子） ═══ */
    function realmChoices(){
      const opts=[{value:'intl',label:'intl · 国际版'},{value:'cn',label:'cn · 国内版'}];
      return state.realm?opts:[{value:'',label:'自动（当前出口）'}].concat(opts);
    }
    function mountRealmFilter(force){
      if(!barRealm) return;
      const opts=realmChoices();
      const sig=opts.map(o=>o.value).join(',');
      if(!force&&sig===realmSig) return;   /* 选项集合不变就不重建，保住用户选择 */
      realmSig=sig;
      C.filterBar(barRealm,[{key:'realm',label:'目录版本',options:opts}],state,onRealmChange);
    }
    function syncCatalogButton(){
      if(btnCatalog) btnCatalog.disabled=!state.realm||state.busy;
    }

    function buildLayout(){
      shell.setTitle('模型','模型目录 / 定价估算 / 手填映射 · 目录版本只切换本页视图，不改全局出口');

      const bar=shell.toolbar();
      bar.innerHTML='<div class="toolbar">'
        +'<span id="mdl-realm"></span>'
        +'<button class="btn" id="mdl-btn-catalog" disabled>刷新目录</button>'
        +'<button class="btn pri" id="mdl-btn-price">立即取价</button>'
        +'<button class="btn" id="mdl-btn-map">映射编辑</button>'
        +'<span class="spacer"></span>'
        +'<span class="pill mute">目录 · 定价 · 映射</span>'
        +'</div>';

      const c=shell.content();
      c.innerHTML=
        '<h2>模型目录</h2>'
        +'<p class="sub">上游 /v1/models 的完整清单；搜索覆盖模型 id、名称、描述与能力标签。</p>'
        +'<div class="toolbar">'
        +'<input id="mdl-q" placeholder="搜索模型 id / 名称 / 能力…" autocomplete="off" style="min-width:300px">'
        +'<span id="mdl-catpills"></span>'
        +'<span id="mdl-note" class="dim"></span>'
        +'</div>'
        +'<div id="mdl-table"></div>'
        +'<h2>定价估算</h2>'
        +'<div class="toolbar" id="mdl-price-head"></div>'
        +'<div id="mdl-cards"></div>'
        +'<div id="mdl-price-table"></div>'
        +'<h2>未定价模型</h2>'
        +'<p class="sub">没有有效价格的模型；点候选或「填入映射」把手填映射写进定价覆盖表，保存后立即重新取价。</p>'
        +'<div id="mdl-gap-table"></div>'
        +'<h2>取价日志</h2>'
        +'<div id="mdl-logs"></div>'
        +'<p class="sub" style="margin-top:var(--sp-5)">数据来源：/wb/v1/models · /wb/pricing · /wb/pricing/refresh · /wb/pricing/mapping · /wb/catalog/refresh</p>';

      barRealm=bar.querySelector('#mdl-realm');
      btnCatalog=bar.querySelector('#mdl-btn-catalog');
      btnPrice=bar.querySelector('#mdl-btn-price');
      btnMap=bar.querySelector('#mdl-btn-map');
      searchInput=c.querySelector('#mdl-q');
      catPills=c.querySelector('#mdl-catpills');
      catNote=c.querySelector('#mdl-note');
      catTable=c.querySelector('#mdl-table');
      priceHead=c.querySelector('#mdl-price-head');
      priceCards=c.querySelector('#mdl-cards');
      priceTable=c.querySelector('#mdl-price-table');
      gapTable=c.querySelector('#mdl-gap-table');
      logBox=c.querySelector('#mdl-logs');

      catTable.innerHTML=U.loadHtml('模型目录加载中…');
      priceCards.innerHTML=U.loadHtml('拉取定价状态…');
    }

    /* ═══ 5. 模型目录：来源徽章 + DataTable ═══ */
    function paintCatalog(){
      if(!shell.alive) return;
      const all=catalogData();
      const cat=(state.models&&state.models.catalog)?state.models.catalog:null;
      if(catPills){
        catPills.innerHTML=
          U.pill('目录版本 '+(state.realm||'自动'),'info')+' '
          +U.pill('目录来源 '+(cat?(SOURCE_LABELS[cat.source]||cat.source||'未知'):'未拉取'),
            cat&&cat.source==='remote'?'ok':'mute')
          +((cat&&cat.fetched_at)?(' <span class="dim">拉取于 '+U.esc(U.ts(cat.fetched_at))+'</span>'):'');
      }
      if(!catTable) return;
      if(state.modelsErr){
        catTable.innerHTML=errBox('模型目录读取失败',state.modelsErr);
        if(catNote) catNote.textContent='';
        return;
      }
      if(!state.models){
        catTable.innerHTML=U.loadHtml('模型目录加载中…');
        if(catNote) catNote.textContent='';
        return;
      }
      const q=state.query.trim().toLowerCase();
      const shown=q?all.filter(m=>searchText(m).indexOf(q)>=0):all;
      C.dataTable(catTable,{
        columns:MODEL_COLS,
        rows:shown,
        rowKey:'id',
        emptyText:q?('没有匹配「'+state.query+'」的模型'):'该目录暂无模型'
      });
      if(catNote) catNote.textContent='显示 '+shown.length+' / '+all.length+' 个模型';
    }

    /* ═══ 6. 定价：StatCards + 生效定价表 + 未定价表 + 日志 ═══ */
    function paintPricing(){
      if(!shell.alive||!priceHead||!priceCards||!priceTable||!gapTable) return;

      if(state.pricingErr){
        priceHead.innerHTML=U.pill('定价状态不可用','bad');
        priceCards.innerHTML=errBox('定价状态读取失败',state.pricingErr);
        priceTable.innerHTML='';
        gapTable.innerHTML='';
        if(logBox) logBox.innerHTML='';
        return;
      }
      if(!state.pricing){
        priceHead.innerHTML='';
        priceCards.innerHTML=U.loadHtml('定价状态加载中…');
        priceTable.innerHTML=U.loadHtml('取价结果加载中…');
        gapTable.innerHTML='';
        if(logBox) logBox.innerHTML='';
        return;
      }

      const p=state.pricing;
      const cur=p.current||{};
      const sum=p.gap_summary||{};
      const gaps=Array.isArray(p.gaps)?p.gaps:[];
      const logs=Array.isArray(p.logs)?p.logs:[];

      /* 状态：总开关 / 运行 / 变体继承 / 上次错误 */
      const statusPill=p.enabled
        ? U.pill('自动取价已启用','ok')
        : (p.master_enabled?U.pill('总开关开启 · 间隔为 0','warn'):U.pill('价估算已关闭','bad'));
      const runPill=p.running?U.pill('取价进行中','info'):U.pill('空闲','mute');
      const varPill=typeof p.variant_inherit==='boolean'
        ? U.pill('变体继承 '+(p.variant_inherit?'开':'关'),p.variant_inherit?'info':'mute') : '';
      const errPill=p.last_error?U.pill('上次失败：'+String(p.last_error).slice(0,80),'bad'):'';
      priceHead.innerHTML=statusPill+' '+runPill+' '+varPill+' '+errPill
        +'<span class="dim">上次 '+U.esc(p.last_run_label||'—')
        +' · 下次 '+U.esc(p.next_run_label||'—')
        +' · 生效于 '+U.esc(p.current_at_label||'—')+'</span>';

      /* 指标卡 */
      C.statCards(priceCards,[
        {label:'生效定价模型',value:U.num(p.models||0),unit:'个',
          sub:'策略表共 '+mono(U.num(p.policies||0))+' 条'},
        {label:'未定价模型',value:U.num(sum.total||0),
          sub:'无对应 '+mono(U.num(sum.or_missing||0))
            +' · 变体未命中 '+mono(U.num(sum.variant_unmatched||0))
            +(sum.aliases?(' · 别名 '+mono(U.num(sum.aliases))+'（不计）'):'')},
        {label:'取价间隔',value:String(p.interval_minutes==null?0:p.interval_minutes),unit:'分钟',
          sub:p.enabled?'自动取价运行中':'自动取价已暂停'},
        {label:'上次取价',value:p.last_run_label||'—',
          sub:p.last_models?('本次写入 '+mono(U.num(p.last_models))+' 个模型'):'尚未取过价'},
        {label:'当前生效批次',value:p.current_at_label||'—',
          sub:p.next_run_label?('下次计划 '+U.esc(p.next_run_label)):'下次未排期'}
      ]);

      /* 生效定价表 */
      const rows=Object.keys(cur).sort().map(m=>{
        const c=cur[m]||{};
        return {model:m,id:c.id||'',via:c.via||'direct',inherited_from:c.inherited_from,label:c.label||''};
      });
      C.dataTable(priceTable,{
        columns:PRICE_COLS,
        rows:rows,
        rowKey:'model',
        actions:r=>[{label:'改映射',onClick:()=>openMappingEditor(r.model,'')}],
        emptyText:'还没有生效定价：点「立即取价」抓一份'
      });

      /* 未定价表 */
      C.dataTable(gapTable,{
        columns:GAP_COLS,
        rows:gaps,
        rowKey:'model',
        actions:r=>[{label:'填入映射',onClick:()=>openMappingEditor(r.model,'')}],
        emptyText:(sum.total||0)===0
          ? '全部模型都有价。'
          : ('未定价 '+U.num(sum.total)+' 个（明细超出返回上限或暂不可枚举）')
      });

      /* 取价日志 */
      if(logBox){
        logBox.innerHTML=logs.length
          ? '<pre class="raw">'+U.esc(logs.slice(-12).join('\n'))+'</pre>'
          : '<div class="empty">暂无取价日志</div>';
      }
    }

    /* ═══ 7. 映射编辑 Modal（保存 / 删除） ═══ */
    function openMappingEditor(model, orId){
      const ids=catalogData().map(m=>m.id).filter(Boolean);
      const datalist=ids.length
        ? '<datalist id="mdl-model-options">'+ids.map(id=>'<option value="'+U.esc(id)+'"></option>').join('')+'</datalist>'
        : '';
      const fileHint=(state.pricing&&state.pricing.overrides_file)
        ? ('，写入 <span class="mono">'+U.esc(state.pricing.overrides_file)+'</span>') : '';
      const m=U.openModal({
        title:'定价映射编辑',
        wide:true,
        body:
          '<p class="sub" style="margin:0 0 var(--sp-3)">手填「hub 模型 id → OpenRouter id」，保存后立即重新取价；删除手填映射后回到自动匹配。OpenRouter id 形如 <span class="mono">vendor/model</span>'+fileHint+'。</p>'
          +'<div class="toolbar">'
          +'<label for="mdl-map-model">hub 模型 id</label>'
          +'<input id="mdl-map-model" list="mdl-model-options" placeholder="hub 模型 id" autocomplete="off" style="min-width:280px;flex:1" value="'+U.esc(model||'')+'">'
          +'<span class="dim mono">→</span>'
          +'<label for="mdl-map-or">OpenRouter id</label>'
          +'<input id="mdl-map-or" placeholder="vendor/model" autocomplete="off" style="min-width:220px;flex:1" value="'+U.esc(orId||'')+'">'
          +'</div>'+datalist,
        actions:[
          {label:'取消'},
          {label:'删除映射',kind:'danger',onClick:()=>askDeleteMapping(m)},
          {label:'保存并取价',kind:'pri',onClick:()=>saveMapping(m)}
        ]
      });
      const mi=m.querySelector('#mdl-map-model'), oi=m.querySelector('#mdl-map-or');
      shell.listen(m,'keydown',ev=>{
        if(ev.key==='Enter'&&(ev.target===mi||ev.target===oi)){ ev.preventDefault(); saveMapping(m); }
      });
      if(!model&&mi) mi.focus();
    }

    async function saveMapping(m){
      const mi=m.querySelector('#mdl-map-model'), oi=m.querySelector('#mdl-map-or');
      if(!mi||!oi) return;
      const model=(mi.value||'').trim();
      const orId=(oi.value||'').trim();
      if(!model){ U.toast('请先填写 hub 模型 id','warn'); mi.focus(); return true; }
      if(!orId){ U.toast('请填写 OpenRouter id；要删除映射请用「删除映射」','warn'); oi.focus(); return true; }

      const btn=m.querySelector('.foot .btn.pri');
      if(btn&&btn.disabled) return true;   /* 防 Enter 连按重复提交 */
      if(btn) btn.disabled=true;
      try{
        const res=await W.pricingMapping({model:model,or_id:orId});
        if(!shell.alive) return;
        U.toast((res&&res.msg)||'已提交', res&&res.ok?(res.known?'ok':'warn'):'bad');
        if(res&&res.ok){
          U.closeModal();
          await applyAfterWrite();
        }else{
          return true;                 /* 失败保持弹窗，便于改值重试 */
        }
      }catch(e){
        U.toast('保存映射失败：'+errMsg(e),'bad');
        return true;
      }finally{
        if(btn&&btn.isConnected) btn.disabled=false;
      }
    }

    function askDeleteMapping(m){
      const mi=m.querySelector('#mdl-map-model');
      const model=((mi&&mi.value)||'').trim();
      if(!model){ U.toast('请先填写要删除映射的模型 id','warn'); if(mi) mi.focus(); return true; }

      const cm=U.openModal({
        title:'删除定价映射',
        body:'<p class="sub" style="margin:0">确认删除「<span class="mono">'+U.esc(model)+'</span>」的手填映射？删除后将按自动匹配取价。</p>',
        actions:[
          {label:'取消'},
          {label:'确认删除',kind:'danger',onClick:async()=>{
            const btn=cm.querySelector('.foot .btn.danger');
            if(btn&&btn.disabled) return true;   /* 防连按重复提交 */
            if(btn) btn.disabled=true;
            try{
              const res=await W.pricingMapping({model:model,or_id:''});
              if(!shell.alive) return;
              U.toast((res&&res.msg)||'已删除映射', res&&res.ok?'ok':'bad');
              if(res&&res.ok){ U.closeModal(); await applyAfterWrite(); }
            }catch(e){
              U.toast('删除映射失败：'+errMsg(e),'bad');
            }finally{
              if(btn&&btn.isConnected) btn.disabled=false;
            }
          }}
        ]
      });
      return true;   /* openModal 已把编辑器换成确认弹窗，保留新弹窗 */
    }

    /* ═══ 8. 动作：刷新目录 / 立即取价 ═══ */
    async function onRealmChange(){
      await fetchModels();
      if(!shell.alive) return;
      mountRealmFilter();      /* 自动检测后把选择器钉到实际版本 */
      syncCatalogButton();
      paintCatalog();
    }
    async function refreshCatalog(btn){
      if(state.busy||!state.realm) return;
      state.busy=true; btn.disabled=true; btn.textContent='刷新中…';
      try{
        const res=await W.catalogRefresh(state.realm);
        if(!shell.alive) return;
        U.toast((res&&res.msg)||'目录刷新完成', res&&res.ok?'ok':'warn');
        await onRealmChange();
      }catch(e){
        U.toast('刷新目录失败：'+errMsg(e),'bad');
      }finally{
        state.busy=false;
        if(btn.isConnected){ btn.textContent='刷新目录'; syncCatalogButton(); }
      }
    }
    async function applyAfterWrite(){
      state.pricePoll=true; state.pollTicks=0;
      await fetchPricing();
      if(!shell.alive) return;
      paintPricing();
    }
    async function triggerPricing(btn){
      if(state.busy) return;
      state.busy=true; btn.disabled=true;
      try{
        const res=await W.pricingRefresh();
        if(!shell.alive) return;
        U.toast((res&&res.msg)||'取价请求已提交', res&&res.ok?'ok':'warn');
        if(res&&res.ok) await applyAfterWrite();
      }catch(e){
        U.toast('取价失败：'+errMsg(e),'bad');
      }finally{
        state.busy=false;
        if(btn.isConnected) btn.disabled=false;
      }
    }

    /* ═══ 9. 事件（shell.listen 统一清理）+ 轮询 ═══ */
    function bindEvents(){
      shell.listen(btnCatalog,'click',()=>refreshCatalog(btnCatalog));
      shell.listen(btnPrice,'click',()=>triggerPricing(btnPrice));
      shell.listen(btnMap,'click',()=>openMappingEditor('',''));
      shell.listen(searchInput,'input',()=>{
        state.query=searchInput.value||'';
        paintCatalog();
      });
      /* 未定价表的候选按钮：表体反复重绘，用容器委托 */
      shell.listen(gapTable,'click',ev=>{
        const b=ev.target.closest?ev.target.closest('[data-cand]'):null;
        if(!b||!gapTable.contains(b)) return;
        openMappingEditor(b.getAttribute('data-cand-model')||'', b.getAttribute('data-cand')||'');
      });
      shell.onCleanup(()=>U.closeModal());

      /* 取价进行中：4s 轮询；结束（连续两轮非 running）后自动停 */
      shell.poll(async()=>{
        if(!state.pricePoll) return;
        await fetchPricing();
        if(!shell.alive) return;
        paintPricing();
        state.pollTicks++;
        const p=state.pricing;
        if(p&&!p.running&&state.pollTicks>=2){ state.pricePoll=false; state.pollTicks=0; }
      },4000);
    }

    /* ═══ 10. 首屏：布局 → 组件 → 事件 → 首次拉取 ═══ */
    if(!shell.alive) return;
    buildLayout();
    bindEvents();
    mountRealmFilter(true);
    syncCatalogButton();
    await Promise.all([fetchModels(),fetchPricing()]);
    if(!shell.alive) return;
    mountRealmFilter();
    syncCatalogButton();
    paintCatalog();
    paintPricing();
  }
});
