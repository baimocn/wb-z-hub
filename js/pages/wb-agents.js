/* 页面：智能体 —— 可用客户端 / 各客户端配置 / 网关模型清单分配
 * 端点：GET /wb/agents · GET /wb/agents/available · GET|POST /wb/agents/model-selection
 * 说明：model-selection 的保存端点尚未在 js/core/api.js 中封装（共享文件不可改），
 *       因此仍通过统一 API 客户端 HUB.api.POST 发出，不使用裸 fetch。 */
(function(){
const REALM_NAME={cn:'国内版',intl:'国际版'};

function bigN(v){
  const n=Number(v);
  if(v===null||v===undefined||v===''||!isFinite(n)) return '—';
  return `<span class="mono">${n.toLocaleString('zh-CN')}</span>`;
}
function fmtWhen(v){
  if(v===null||v===undefined||v==='') return '—';
  const text=typeof v==='number'?HUB.ui.ts(v):String(v);
  return `<span class="mono">${HUB.ui.esc(text)}</span>`;
}
function sameSet(a,b){
  if(a.size!==b.size) return false;
  let ok=true;
  a.forEach(x=>{ if(!b.has(x)) ok=false; });
  return ok;
}
function errPill(label,res){
  if(res.status!=='rejected') return '';
  const raw=res.reason&&res.reason.message?res.reason.message:String(res.reason||'未知错误');
  return HUB.ui.pill(label+'失败：'+String(raw).slice(0,70),'bad');
}

HUB.register({
  route:'wb-agents', group:'wb', title:'智能体', order:50,

  async render(el, ctx){
    const U=HUB.ui, wb=HUB.api.wb;
    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('拉取智能体目录…');

    const [availR, agentsR, selR]=await Promise.allSettled([
      wb.agentsAvailable(), wb.agents(), wb.agentsModelSelection()
    ]);
    if(ctx.stale()) return;

    if(availR.status==='rejected'&&agentsR.status==='rejected'&&selR.status==='rejected'){
      el.innerHTML=U.errHtml(agentsR.reason);
      return;
    }

    const avail=availR.status==='fulfilled'?availR.value:null;
    const data=agentsR.status==='fulfilled'?agentsR.value:null;
    const sel=selR.status==='fulfilled'?selR.value:null;

    const clients=data&&Array.isArray(data.clients)?data.clients:[];
    const models=data&&Array.isArray(data.models)?data.models:[];
    const keys=data&&Array.isArray(data.keys)?data.keys:[];
    const realm=(data&&data.realm)||'';
    const gateway=data&&data.gateway&&data.gateway.base_url?data.gateway.base_url:'';
    const disabledReason=(data&&data.reason)||'';
    const available=avail?!!avail.enabled:!!(data&&data.enabled);

    const selList=sel&&Array.isArray(sel.selected_models)
      ? sel.selected_models
      : (data&&Array.isArray(data.selected_models)?data.selected_models:[]);
    const chosen=new Set(selList.map(String));
    const baseline=new Set(chosen);

    const installed=clients.filter(c=>c.installed).length;
    const configured=clients.filter(c=>c.configured).length;
    const appliedCount=clients.filter(c=>c.applied).length;
    const extCount=clients.filter(c=>c.applied&&c.applied.external_change).length;

    const clientLabels={};
    clients.forEach(c=>{ if(c&&c.id) clientLabels[c.id]=c.label||c.id; });
    const embIds=data&&Array.isArray(data.model_embedding_clients)?data.model_embedding_clients:[];
    const embLabels=embIds.map(id=>clientLabels[id]||id);
    const nonEmbLabels=clients.filter(c=>embIds.indexOf(c.id)<0).map(c=>c.label||c.id);

    /* ── 顶部状态 ─────────────────────────────────────────── */
    const topPills=[
      available?U.pill('本机可写客户端配置','ok'):U.pill('本机不可用','bad'),
      realm?U.pill('出口 '+(REALM_NAME[realm]||realm),'info'):'',
      gateway?U.pill('网关 '+gateway,'mute'):'',
      data?U.pill(data.models_configured?'清单已保存':'清单从未保存','mute'):''
    ].filter(Boolean).join(' ');

    const errs=[errPill('可用性探测',availR),errPill('智能体目录',agentsR),errPill('模型清单',selR)]
      .filter(Boolean).join(' ');

    const banner=available?'':`<div class="empty">一键配置只对「网关所在机器」上打开的看板开放${
      disabledReason?'：'+U.esc(disabledReason):''}。远程看板仍可查看模型清单并保存分配。</div>`;

    const cardsHtml=data?U.cards([
      {k:'一键配置能力', v:available?U.pill('可用','ok'):U.pill('不可用','bad'),
       n:available?'仅网关本机可写入客户端配置':U.esc(disabledReason||'来源地址不是网关本机')},
      {k:'客户端', v:clients.length, vsmall:'个', n:`本机检测到 ${installed} · 已有写入记录 ${configured}`},
      {k:'模型目录', v:models.length, vsmall:'个', n:`出口 ${U.esc(REALM_NAME[realm]||realm||'未知')} · 网关清单已选 <span id="ag-card-sel" class="mono">${chosen.size}</span>`},
      {k:'网关 Key', v:keys.length, vsmall:'个启用', n:(data.global_key_set?'全局 Key 已设':'全局 Key 未设')+' · 鉴权'+(data.auth_required?'开启':'关闭')},
      {k:'写入记录', v:appliedCount, vsmall:'个客户端', n:extCount?('外部改动 '+extCount+' 个'):'全部与本机写入一致'}
    ]):U.cards([
      {k:'一键配置能力', v:available?U.pill('可用','ok'):U.pill('不可用','bad'), n:U.esc(disabledReason||'—')},
      {k:'智能体目录', v:'—', n:'接口未返回（见上方错误）'}
    ]);

    /* ── 客户端表格 ───────────────────────────────────────── */
    const clientRows=clients.map(c=>{
      const app=c.applied||null;
      return [
        `${U.esc(c.label||c.id)}<div class="dim mono" style="font-size:11px">${U.esc(c.id||'')}</div>`,
        U.pill(c.protocol||'—',c.protocol==='anthropic'?'info':'mute'),
        c.installed?U.pill('已安装','ok'):U.pill('未检测到','mute'),
        c.configured
          ?(app&&app.external_change?U.pill('已接通 · 外部改动','warn'):U.pill('已接通','ok'))
          :U.pill('未接通','mute'),
        `<span class="mono">${(c.config_paths||[]).length}</span> 个`,
        app?fmtWhen(app.at):'—',
        `<button class="btn mini" data-client="${U.esc(c.id||'')}">详情</button>`
      ];
    });
    const clientsHtml=clients.length
      ? U.table(['客户端','协议','本机检测','一键配置','配置文件','最近写入','操作'],clientRows)
      : `<div class="empty">${data?'后端未返回任何客户端定义':U.esc(disabledReason||'智能体目录不可用')}</div>`;

    /* ── 模型清单：目录 + 历史已选但目录外的模型 ─────────── */
    const catalogIds=new Set(models.filter(m=>m&&m.id).map(m=>String(m.id)));
    const extraIds=[...chosen].filter(id=>!catalogIds.has(id)).sort();
    const seenIds=new Set();
    const modelRows=[];
    const capHtml=m=>{
      const parts=[];
      if(m.supports_vision) parts.push(U.pill('视觉','info'));
      const eff=Array.isArray(m.reasoning_efforts)?m.reasoning_efforts:[];
      if(eff.length) parts.push(U.pill('思考 '+eff.join('/'),'mute'));
      return parts.join(' ')||'<span class="dim">—</span>';
    };
    extraIds.forEach(id=>{
      seenIds.add(id);
      modelRows.push([
        `<input type="checkbox" aria-label="选择 ${U.esc(id)}" data-mid="${U.esc(id)}"${chosen.has(id)?' checked':''}>`,
        `<span class="mono">${U.esc(id)}</span>`,
        '<span class="dim">（目录外）</span>',
        '—','—',
        U.pill('当前出口未列出','warn')
      ]);
    });
    models.forEach(m=>{
      const id=m&&m.id?String(m.id):'';
      if(!id||seenIds.has(id)) return;
      seenIds.add(id);
      modelRows.push([
        `<input type="checkbox" aria-label="选择 ${U.esc(id)}" data-mid="${U.esc(id)}"${chosen.has(id)?' checked':''}>`,
        `<span class="mono">${U.esc(id)}</span>`,
        U.esc(m.name||'—'),
        bigN(m.context_window),
        bigN(m.max_output),
        capHtml(m)
      ]);
    });
    const modelsHtml=modelRows.length
      ? U.table(['选','模型 ID','名称','上下文','输出上限','能力'],modelRows,{empty:'模型目录为空'})
      : '<div class="empty">模型目录为空：请检查出口目录或稍后重试</div>';

    /* ── Key 表格 ─────────────────────────────────────────── */
    const keyRows=keys.map(k=>[
      `<span class="mono">${U.esc(k.id||'—')}</span>`,
      U.esc(k.name||'未命名'),
      k.realm?U.pill(k.realm,'info'):U.pill('未绑定','mute')
    ]);
    if(data&&data.global_key_set){
      keyRows.push(['<span class="mono">__global</span>',U.pill('全局 Key','ok')+' 环境变量配置',U.pill('默认出口','mute')]);
    }
    const keysHtml=keyRows.length
      ? U.table(['Key','名称','出口绑定'],keyRows)
      : '<div class="empty">没有启用中的网关 Key</div>';

    /* ── 组装 ─────────────────────────────────────────────── */
    el.innerHTML=`
      <h1>智能体</h1>
      <p class="sub">客户端一键配置与模型分配 · 勾选的模型才会被写入客户端配置</p>
      <div class="toolbar">${topPills}${errs?' '+errs:''}<button class="btn mini" id="ag-refresh">重新拉取</button></div>
      ${banner}
      ${cardsHtml}

      <h2>客户端与配置</h2>
      <p class="sub">「已接通」表示本网关写过配置并可回滚；外部改动会单独标出。</p>
      <div id="ag-clients">${clientsHtml}</div>

      <h2>模型分配 · 网关模型清单</h2>
      <p class="sub">只有勾选的模型会被一键配置写进客户端；清单为空时，读取清单的客户端会拒绝写入。</p>
      <div class="toolbar">
        <input id="ag-q" type="search" aria-label="筛选模型" placeholder="筛选模型 ID / 名称" style="min-width:220px;max-width:320px;flex:1">
        <button class="btn mini" id="ag-all">全选筛选结果</button>
        <button class="btn mini" id="ag-none">清空勾选</button>
        <button class="btn mini" id="ag-undo" disabled>撤销改动</button>
        <span id="ag-count">${U.pill('已选 '+chosen.size,'mute')}</span>
        ${U.pill('目录 '+models.length,'mute')}
        <span id="ag-dirty">${U.pill('与网关一致','ok')}</span>
        <span id="ag-filter" style="display:none"></span>
        <button class="btn danger" id="ag-save" disabled>保存模型清单</button>
      </div>
      <div id="ag-models">${modelsHtml}</div>
      <p class="sub" style="margin-top:var(--sp-3)">读取此清单的客户端：${
        embLabels.length?U.esc(embLabels.join(' / ')):'无'
      }${nonEmbLabels.length?'；'+U.esc(nonEmbLabels.join(' / '))+' 不读取模型清单':''}</p>

      <h2>可用网关 Key</h2>
      <p class="sub">仅列出启用中的 Key；一键配置优先用全局 Key，否则用第一个启用的 Key。</p>
      <div id="ag-keys">${keysHtml}</div>`;

    /* ── 交互：客户端详情 ─────────────────────────────────── */
    function openClient(id){
      const c=clients.filter(x=>x&&x.id===id)[0];
      if(!c) return;
      const app=c.applied||null;
      const paths=(c.config_paths||[]).map(p=>U.esc(p)).join('\n')||'—';
      const appHtml=app
        ? U.table(['字段','值'],[
            ['写入时间',fmtWhen(app.at)],
            ['Base URL',app.base_url?`<span class="mono">${U.esc(app.base_url)}</span>`:'—'],
            ['默认模型',app.model?`<span class="mono">${U.esc(app.model)}</span>`:'—'],
            ['写入文件','<span class="mono">'+String(app.files||0)+'</span> 个'],
            ['一致性',app.external_change?U.pill('文件已被外部修改','warn'):U.pill('无外部改动','ok')]
          ])
        : '<div class="empty">没有本网关的写入记录</div>';
      U.openModal({
        title:(c.label||c.id)+' · 配置详情',
        wide:true,
        body:`
          <p class="sub" style="margin-bottom:var(--sp-3)">${U.esc(c.desc||c.label||'')}</p>
          <div class="toolbar">
            ${c.installed?U.pill('本机已安装','ok'):U.pill('未检测到安装','mute')}
            ${U.pill('协议 '+(c.protocol||'—'),'info')}
            ${c.configured?U.pill('本网关已接通','ok'):U.pill('本网关未接通','mute')}
          </div>
          <h2 style="margin-top:var(--sp-2)">配置文件</h2>
          <pre class="raw">${paths}</pre>
          <h2>最近一次一键写入</h2>
          ${appHtml}
          <p class="sub" style="margin-top:var(--sp-4)">本页为状态视图：写入与回滚由网关本机的配置器执行，控制台只负责核对与模型清单分配。</p>`,
        actions:[{label:'关闭'}]
      });
    }
    el.querySelectorAll('[data-client]').forEach(btn=>{
      btn.onclick=()=>openClient(btn.getAttribute('data-client'));
    });

    /* ── 交互：模型勾选 / 筛选 / 保存 ─────────────────────── */
    const box=el.querySelector('#ag-models');
    const countEl=el.querySelector('#ag-count');
    const dirtyEl=el.querySelector('#ag-dirty');
    const saveBtn=el.querySelector('#ag-save');
    const undoBtn=el.querySelector('#ag-undo');
    const allBtn=el.querySelector('#ag-all');
    const noneBtn=el.querySelector('#ag-none');
    const qInput=el.querySelector('#ag-q');
    const filterPill=el.querySelector('#ag-filter');

    function paintBoxes(){
      if(!box) return;
      box.querySelectorAll('input[data-mid]').forEach(i=>{
        i.checked=chosen.has(i.getAttribute('data-mid'));
      });
    }
    function syncState(){
      const dirty=!sameSet(chosen,baseline);
      if(countEl) countEl.innerHTML=U.pill('已选 '+chosen.size,'mute');
      const cardSel=el.querySelector('#ag-card-sel');
      if(cardSel) cardSel.textContent=String(chosen.size);
      if(dirtyEl) dirtyEl.innerHTML=dirty?U.pill('有未保存改动','warn'):U.pill('与网关一致','ok');
      if(saveBtn) saveBtn.disabled=!dirty;
      if(undoBtn) undoBtn.disabled=!dirty;
    }
    function applyFilter(){
      if(!box||!qInput) return;
      const q=String(qInput.value||'').trim().toLowerCase();
      let shown=0, total=0;
      box.querySelectorAll('tbody tr').forEach(tr=>{
        total++;
        const hit=!q||String(tr.textContent||'').toLowerCase().indexOf(q)>=0;
        tr.style.display=hit?'':'none';
        if(hit) shown++;
      });
      if(filterPill){
        filterPill.style.display=q?'':'none';
        filterPill.innerHTML=q?U.pill('筛选 '+shown+' / '+total,'mute'):'';
      }
    }

    if(box){
      box.addEventListener('change',e=>{
        const t=e.target;
        if(!t||t.tagName!=='INPUT'||t.type!=='checkbox') return;
        const id=t.getAttribute('data-mid');
        if(!id) return;
        if(t.checked) chosen.add(id); else chosen.delete(id);
        syncState();
      });
    }
    if(qInput) qInput.addEventListener('input',applyFilter);

    if(allBtn) allBtn.onclick=()=>{
      if(!box) return;
      let n=0;
      box.querySelectorAll('tbody tr').forEach(tr=>{
        if(tr.style.display==='none') return;
        const i=tr.querySelector('input[data-mid]');
        if(!i) return;
        chosen.add(i.getAttribute('data-mid'));
        i.checked=true;
        n++;
      });
      syncState();
      U.toast(n?('已勾选 '+n+' 个可见模型'):'当前筛选下没有模型','ok');
    };
    if(noneBtn) noneBtn.onclick=()=>{
      chosen.clear();
      paintBoxes();
      syncState();
    };
    if(undoBtn) undoBtn.onclick=()=>{
      chosen.clear();
      baseline.forEach(x=>chosen.add(x));
      paintBoxes();
      syncState();
      U.toast('已撤销未保存的改动','info');
    };

    if(saveBtn) saveBtn.onclick=()=>{
      if(sameSet(chosen,baseline)){ U.toast('没有需要保存的改动','warn'); return; }
      const list=[...chosen];
      const preview=list.slice(0,8).join('、')+(list.length>8?' 等':'');
      const okConfirm=window.confirm(
        '确认覆盖保存「网关模型清单」？\n\n'+
        (list.length?('将写入 '+list.length+' 个模型：'+preview):'将清空清单（等于全部取消，读取清单的客户端会拒绝一键配置）')+
        '\n\n此操作会覆盖上一次保存的清单。'
      );
      if(!okConfirm) return;
      saveBtn.disabled=true;
      const oldLabel=saveBtn.textContent;
      saveBtn.textContent='保存中…';
      /* 保存端点未在 api.js 封装，仍走统一 API 客户端（非裸 fetch） */
      HUB.api.POST('/wb/agents/model-selection',{models:list}).then(r=>{
        if(ctx.stale()) return;
        const saved=r&&Array.isArray(r.selected_models)?r.selected_models:list;
        chosen.clear();
        saved.forEach(x=>chosen.add(String(x)));
        baseline.clear();
        chosen.forEach(x=>baseline.add(x));
        paintBoxes();
        saveBtn.textContent=oldLabel;
        syncState();
        U.toast('已保存 '+chosen.size+' 个模型到网关清单','ok');
      }).catch(e=>{
        if(ctx.stale()) return;
        saveBtn.textContent=oldLabel;
        syncState();
        U.toast(e&&e.message?e.message:'保存失败','bad');
      });
    };

    const refreshBtn=el.querySelector('#ag-refresh');
    if(refreshBtn) refreshBtn.onclick=()=>{
      if(!sameSet(chosen,baseline)&&!window.confirm('有未保存的模型勾选改动，重新拉取会丢弃，继续？')) return;
      render(el,ctx);
    };

    syncState();
    applyFilter();
  }
});
})();
