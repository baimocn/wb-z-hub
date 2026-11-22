/* 页面：模型 —— 模型目录 / 定价估算 / 定价映射（wb-models）
 * 覆盖端点：wb.models · wb.pricing · wb.pricingRefresh · wb.pricingMapping · wb.catalogRefresh
 * 目录版本 intl/cn 只切换本页的目录视图（?realm=），全局出口切换仍由设置页负责。 */
HUB.register({
  route:'wb-models', group:'wb', title:'模型', order:40,
  async render(el, ctx){
    const U=HUB.ui, W=HUB.api.wb;
    const view={realm:null, query:'', models:null, pricing:null, modelsErr:null, pricingErr:null};
    let busy=false, pricePolling=false, pollTicks=0;

    const SOURCE_LABELS={remote:'上游实时',endpoint:'上游端点',cache:'本机缓存',legacy:'旧版缓存',bundled:'内置快照'};
    const GAP_LABELS={
      or_missing:{text:'OpenRouter 无对应',kind:'warn'},
      variant_unmatched:{text:'变体名未命中基准',kind:'warn'},
      alias:{text:'虚拟别名（非实体）',kind:'mute'}
    };

    function errMsg(e){ return String((e&&e.message)||e||'未知错误'); }
    function errBox(title,e){ return '<div class="empty">'+U.esc(title)+'：'+U.esc(errMsg(e))+'</div>'; }
    function monoNum(n){ return '<span class="mono">'+U.esc(U.num(n))+'</span>'; }

    /* ───────── 数据 ───────── */
    async function fetchModels(){
      try{
        let res;
        if(!view.realm){
          // 不带 realm：让后端按当前出口回答，再据返回的 realm 固定本页视图。
          res=await W.models();
          const r=res&&res.realm;
          if(r==='intl'||r==='cn'){ view.realm=r; }
          else { view.realm='intl'; res=await W.models('intl'); }
        }else{
          res=await W.models(view.realm);
          if(res&&(res.realm==='intl'||res.realm==='cn')) view.realm=res.realm;
        }
        view.models=res||null; view.modelsErr=null;
      }catch(e){
        if(!view.realm) view.realm='intl';
        view.models=null; view.modelsErr=e;
      }
    }
    async function fetchPricing(){
      try{ view.pricing=await W.pricing(); view.pricingErr=null; }
      catch(e){ if(!view.pricing) view.pricingErr=e; }
    }

    /* ───────── 模型目录 ───────── */
    function modelSearchText(m){
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
      let html='<span class="mono" title="'+U.esc(String(m.context_length))+'">'+U.esc(U.num(m.context_length))+'</span>';
      if(m.max_output_tokens){
        html+='<div class="dim" style="font-size:11px">出 <span class="mono">'+U.esc(U.num(m.max_output_tokens))+'</span></div>';
      }
      return html;
    }
    function modelIdCell(m){
      const title=m.description?(' title="'+U.esc(m.description)+'"'):'';
      return '<span class="mono"'+title+'>'+U.esc(m.id)+'</span>';
    }
    function paintModels(){
      if(ctx.stale()) return;
      const box=el.querySelector('#modelsBox');
      if(!box) return;
      const note=el.querySelector('#modelFilterNote');
      if(view.modelsErr){
        box.innerHTML=errBox('模型目录读取失败', view.modelsErr);
        if(note) note.textContent='';
        return;
      }
      if(!view.models){
        box.innerHTML=U.loadHtml('模型目录加载中…');
        if(note) note.textContent='';
        return;
      }
      const all=Array.isArray(view.models.data)?view.models.data:[];
      const q=view.query.trim().toLowerCase();
      const shown=q?all.filter(function(m){ return modelSearchText(m).indexOf(q)>=0; }):all;
      box.innerHTML=U.table(['模型 ID','名称','能力','上下文'], shown.map(function(m){
        return [modelIdCell(m), U.esc(m.name||'—'), capsCell(m), ctxCell(m)];
      }), {empty: all.length?('没有匹配「'+view.query+'」的模型'):'该目录暂无模型'});
      if(note) note.textContent='显示 '+shown.length+' / '+all.length+' 个模型';
    }

    /* ───────── 定价估算 ───────── */
    function viaCell(c){
      if(c.via==='variant'){
        return U.pill('变体继承','info')+' <span class="mono dim">'+U.esc(c.inherited_from||'?')+'</span>';
      }
      if(c.via==='override') return U.pill('人工映射','warn');
      return U.pill('直接匹配','mute');
    }
    function gapCandidatesCell(g){
      if(g.reason==='alias') return '<span class="dim">虚拟别名，无需登记</span>';
      const cands=Array.isArray(g.candidates)?g.candidates:[];
      const btns=cands.map(function(c){
        return '<button class="btn mini" data-map-model="'+U.esc(g.model)+'" data-map-or="'+U.esc(c)+'" title="填入映射表单">'+U.esc(c)+'</button>';
      }).join(' ');
      const fill='<button class="btn mini" data-map-model="'+U.esc(g.model)+'" data-map-or="" title="只填入模型名">填入表单</button>';
      return '<div style="display:flex;gap:4px;flex-wrap:wrap;max-width:520px">'+(btns?btns+' ':'')+fill+'</div>';
    }
    function pricingHtml(){
      if(view.pricingErr) return errBox('定价状态读取失败', view.pricingErr);
      if(!view.pricing) return U.loadHtml('定价状态加载中…');
      const p=view.pricing;
      const cur=p.current||{};
      const ids=Object.keys(cur).sort();
      const sum=p.gap_summary||{};
      const gaps=Array.isArray(p.gaps)?p.gaps:[];
      const statusPill=p.enabled
        ? U.pill('自动取价已启用','ok')
        : (p.master_enabled?U.pill('总开关开启 · 间隔为 0','warn'):U.pill('价估算已关闭','bad'));
      const runPill=p.running?U.pill('取价进行中','info'):U.pill('空闲','mute');
      const errPill=p.last_error?U.pill('上次失败：'+String(p.last_error).slice(0,80),'bad'):'';
      const cards=U.cards([
        {k:'生效定价模型', v:U.esc(U.num(p.models||0)), vsmall:'个', n:'策略表共 '+monoNum(p.policies||0)+' 条'},
        {k:'未定价模型', v:U.esc(U.num(sum.total||0)),
          n:'无对应 '+monoNum(sum.or_missing||0)+' · 变体未命中 '+monoNum(sum.variant_unmatched||0)+(sum.aliases?(' · 别名 '+monoNum(sum.aliases)+'（不计）'):'')},
        {k:'取价间隔', v:U.esc(String(p.interval_minutes==null?0:p.interval_minutes)), vsmall:'分钟',
          n:p.enabled?'自动取价运行中':'自动取价已暂停'},
        {k:'上次取价', v:U.esc(p.last_run_label||'—'),
          n:p.last_models?('本次写入 '+monoNum(p.last_models)+' 个模型'):'尚未取过价'},
        {k:'当前生效批次', v:U.esc(p.current_at_label||'—'),
          n:p.next_run_label?('下次计划 '+U.esc(p.next_run_label)):'下次未排期'}
      ]);
      const rows=ids.map(function(m){
        const c=cur[m]||{};
        return [
          '<span class="mono">'+U.esc(m)+'</span>',
          '<span class="mono" title="策略内容哈希">'+U.esc(c.id||'—')+'</span>',
          viaCell(c),
          '<span class="mono">'+U.esc(c.label||'—')+'</span>'
        ];
      });
      const gapRows=gaps.map(function(g){
        const lab=GAP_LABELS[g.reason]||{text:g.reason||'未定价',kind:'mute'};
        return ['<span class="mono">'+U.esc(g.model)+'</span>', U.pill(lab.text,lab.kind), gapCandidatesCell(g)];
      });
      const logs=Array.isArray(p.logs)?p.logs:[];
      return cards+
        '<div class="toolbar">'+statusPill+' '+runPill+' '+errPill+
          '<span class="dim">上次 '+U.esc(p.last_run_label||'—')+' · 下次 '+U.esc(p.next_run_label||'—')+' · 生效于 '+U.esc(p.current_at_label||'—')+'</span>'+
        '</div>'+
        U.table(['模型','当前策略 ID','匹配方式','首次取价'], rows, {empty:'还没有生效定价：点「立即取价」抓一份'})+
        '<h2>未定价模型</h2>'+
        (gaps.length
          ? U.table(['模型','原因','候选 / 填单'], gapRows, {empty:'全部模型都有价'})
          : '<div class="empty">'+((sum.total||0)===0?'全部模型都有价。':'未定价 '+U.esc(String(sum.total||0))+' 个（明细超出返回上限或暂不可枚举）')+'</div>')+
        '<h2>取价日志</h2>'+
        (logs.length ? '<pre class="raw">'+U.esc(logs.slice(-12).join('\n'))+'</pre>' : '<div class="empty">暂无取价日志</div>');
    }
    function paintPricing(){
      if(ctx.stale()) return;
      const box=el.querySelector('#pricingBox');
      if(!box) return;
      box.innerHTML=pricingHtml();
      box.querySelectorAll('button[data-map-model]').forEach(function(b){
        b.addEventListener('click',function(){
          const modelInput=el.querySelector('#mapModel');
          const orInput=el.querySelector('#mapOr');
          if(!modelInput||!orInput) return;
          modelInput.value=b.getAttribute('data-map-model')||'';
          orInput.value=b.getAttribute('data-map-or')||'';
          modelInput.scrollIntoView({block:'center'});
          orInput.focus();
        });
      });
    }

    /* ───────── 动作 ───────── */
    async function refreshCatalog(btn){
      if(busy) return;
      busy=true; btn.disabled=true; btn.textContent='刷新中…';
      try{
        const res=await W.catalogRefresh(view.realm);
        if(ctx.stale()) return;
        U.toast((res&&res.msg)||'目录刷新完成', res&&res.ok?'ok':'warn');
        await fetchModels();
        if(ctx.stale()) return;
        paint();
      }catch(e){
        U.toast('刷新目录失败：'+errMsg(e),'bad');
      }finally{
        busy=false;
        if(btn.isConnected){ btn.disabled=false; btn.textContent='刷新目录'; }
      }
    }
    async function triggerPricing(btn){
      if(busy) return;
      busy=true; btn.disabled=true;
      try{
        const res=await W.pricingRefresh();
        if(ctx.stale()) return;
        U.toast((res&&res.msg)||'取价请求已提交', res&&res.ok?'ok':'warn');
        if(res&&res.ok){
          await fetchPricing();
          if(ctx.stale()) return;
          paintPricing();
          startPricePolling();
        }
      }catch(e){
        U.toast('取价失败：'+errMsg(e),'bad');
      }finally{
        busy=false;
        if(btn.isConnected) btn.disabled=false;
      }
    }
    async function saveMapping(btn){
      const modelInput=el.querySelector('#mapModel');
      const orInput=el.querySelector('#mapOr');
      if(!modelInput||!orInput) return;
      const model=(modelInput.value||'').trim();
      const orId=(orInput.value||'').trim();
      if(!model){ U.toast('请先填写 hub 模型 id','warn'); modelInput.focus(); return; }
      if(!orId){ U.toast('请填写 OpenRouter id；要删除映射请用「删除映射」','warn'); orInput.focus(); return; }
      btn.disabled=true;
      try{
        const res=await W.pricingMapping({model:model, or_id:orId});
        if(ctx.stale()) return;
        U.toast((res&&res.msg)||'已提交', res&&res.ok?((res.known)?'ok':'warn'):'bad');
        if(res&&res.ok){
          orInput.value='';
          await fetchPricing();
          if(ctx.stale()) return;
          paintPricing();
          startPricePolling();
        }
      }catch(e){
        U.toast('保存映射失败：'+errMsg(e),'bad');
      }finally{
        if(btn.isConnected) btn.disabled=false;
      }
    }
    async function deleteMapping(btn){
      const modelInput=el.querySelector('#mapModel');
      if(!modelInput) return;
      const model=(modelInput.value||'').trim();
      if(!model){ U.toast('请先在模型 id 输入框填要删除映射的模型','warn'); modelInput.focus(); return; }
      if(!window.confirm('确认删除「'+model+'」的手填定价映射？删除后将按自动匹配取价。')) return;
      btn.disabled=true;
      try{
        const res=await W.pricingMapping({model:model, or_id:''});
        if(ctx.stale()) return;
        U.toast((res&&res.msg)||'已删除映射', res&&res.ok?'ok':'bad');
        if(res&&res.ok){
          await fetchPricing();
          if(ctx.stale()) return;
          paintPricing();
          startPricePolling();
        }
      }catch(e){
        U.toast('删除映射失败：'+errMsg(e),'bad');
      }finally{
        if(btn.isConnected) btn.disabled=false;
      }
    }
    function startPricePolling(){
      if(pricePolling) return;
      pricePolling=true; pollTicks=0;
      ctx.poll(async function(){
        if(ctx.stale()){ pricePolling=false; return; }
        await fetchPricing();
        if(ctx.stale()) return;
        paintPricing();
        pollTicks++;
        const p=view.pricing;
        if(p&&!p.running&&pollTicks>=2){
          pricePolling=false;
          // 取价结束：把 4s 轮询换成低频空转，离开页面时由路由统一清理
          ctx.poll(function(){},3600000);
        }
      },4000);
    }

    /* ───────── 组装 ───────── */
    function bind(){
      const search=el.querySelector('#modelSearch');
      if(search) search.addEventListener('input',function(){ view.query=search.value; paintModels(); });

      el.querySelectorAll('button[data-realm]').forEach(function(btn){
        btn.addEventListener('click',async function(){
          const r=btn.getAttribute('data-realm');
          if(!r||r===view.realm||busy) return;
          busy=true;
          view.realm=r;
          const note=el.querySelector('#modelFilterNote');
          if(note) note.textContent='切换目录版本中…';
          await fetchModels();
          if(ctx.stale()){ busy=false; return; }
          paint();
          busy=false;
        });
      });

      const btnCatalog=el.querySelector('#btnCatalog');
      if(btnCatalog) btnCatalog.addEventListener('click',function(){ refreshCatalog(btnCatalog); });
      const btnPrice=el.querySelector('#btnPrice');
      if(btnPrice) btnPrice.addEventListener('click',function(){ triggerPricing(btnPrice); });
      const btnSave=el.querySelector('#btnMapSave');
      if(btnSave) btnSave.addEventListener('click',function(){ saveMapping(btnSave); });
      const btnDel=el.querySelector('#btnMapDelete');
      if(btnDel) btnDel.addEventListener('click',function(){ deleteMapping(btnDel); });
      const orInput=el.querySelector('#mapOr');
      if(orInput) orInput.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'){ ev.preventDefault(); if(btnSave) btnSave.click(); }
      });
    }

    function paint(){
      if(ctx.stale()) return;
      const src=view.models;
      const data=(src&&Array.isArray(src.data))?src.data:[];
      const cat=(src&&src.catalog)?src.catalog:null;
      const catPill=cat
        ? U.pill('目录来源 '+(SOURCE_LABELS[cat.source]||cat.source||'未知'), cat.source==='remote'?'ok':'mute')
        : U.pill('目录来源 未拉取','mute');
      const catTime=(cat&&cat.fetched_at)?('<span class="dim">拉取于 '+U.esc(U.ts(cat.fetched_at))+'</span>'):'';
      const realmBtn=function(r,label){
        return '<button class="btn mini'+(view.realm===r?' pri':'')+'" data-realm="'+r+'">'+label+'</button>';
      };
      el.innerHTML=
        '<h1>模型</h1>'+
        '<p class="sub">模型目录 / 定价估算 / 手填映射 · 目录版本 <b class="mono">'+U.esc(view.realm||'—')+'</b></p>'+
        '<div class="toolbar">'+
          '<label>目录版本</label>'+realmBtn('intl','intl · 国际版')+realmBtn('cn','cn · 国内版')+
          catPill+catTime+
          '<span class="pill mute">'+data.length+' 个模型</span>'+
          '<span style="flex:1"></span>'+
          '<button class="btn" id="btnCatalog"'+(view.realm?'':' disabled')+'>刷新目录</button>'+
          '<button class="btn pri" id="btnPrice">立即取价</button>'+
        '</div>'+
        '<h2>模型目录</h2>'+
        '<div class="toolbar">'+
          '<input id="modelSearch" placeholder="搜索模型 id / 名称 / 能力…" style="min-width:300px" value="'+U.esc(view.query)+'">'+
          '<span class="dim" id="modelFilterNote"></span>'+
        '</div>'+
        '<div id="modelsBox"></div>'+
        '<h2>定价估算</h2>'+
        '<div id="pricingBox"></div>'+
        '<h2>定价映射</h2>'+
        '<p class="sub">手填「hub 模型 → OpenRouter id」，保存后立即重新取价；删除手填映射后回到自动匹配。OpenRouter id 形如 <span class="mono">vendor/model</span>'+
          (view.pricing&&view.pricing.overrides_file?('，写入 <span class="mono">'+U.esc(view.pricing.overrides_file)+'</span>'):'')+'。</p>'+
        '<div class="toolbar">'+
          '<input id="mapModel" list="modelOptions" placeholder="hub 模型 id" style="min-width:280px">'+
          '<span class="dim mono">→</span>'+
          '<input id="mapOr" placeholder="vendor/model" style="min-width:220px">'+
          '<button class="btn pri" id="btnMapSave">保存映射</button>'+
          '<button class="btn danger" id="btnMapDelete">删除映射</button>'+
        '</div>'+
        '<datalist id="modelOptions">'+data.map(function(m){ return '<option value="'+U.esc(m.id)+'"></option>'; }).join('')+'</datalist>';
      bind();
      paintModels();
      paintPricing();
    }

    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('拉取模型目录与定价状态…');
    await Promise.all([fetchModels(),fetchPricing()]);
    if(ctx.stale()) return;
    paint();
  }
});
