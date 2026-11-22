/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 领取（zc-claim）—— 组件层重构版
 *
 * 覆盖端点（全部经 HUB.api.zc.*，无裸 fetch）：
 *   GET  /admin/api/claim/preview         → zc.claimPreview
 *   POST /admin/api/claim                 → zc.claim
 *   GET  /admin/api/claim/captcha-config  → zc.claimCaptchaConfig
 *   POST /admin/api/claim/manual          → zc.claimManual
 *
 * 三块职责分离：
 *   1) 预览     —— filterBar 筛选 + DataTable（行内「手动领取」入口）
 *   2) 手动领取 —— 独立 Modal（账号 / 套餐 / region / verifyParam）
 *   3) 一键领取 —— 工具栏红色按钮 + 二次确认（真实消耗）
 *
 * 生命周期：HUB.shell 管标题 / 工具栏 / 内容区 / 监听。
 * 本页刻意不调用 shell.poll —— preview 会先对每个 JWT 账号上报当日激活事件
 * 再查套餐（zcode2api/app/routes/admin_api.py:482-513），定时轮询等于持续向
 * 上游刷活跃信号；只在进入页面、手动刷新、领取完成后拉取。
 * 弹窗挂在 body 上，而 router 目前不调用 shell.destroy()：用一次性 hashchange
 * 监听兜底，切页时关掉本页弹窗（destroy 若接入则 onCleanup 同样生效）。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'zc-claim', group:'zc', title:'ZC 领取', order:75,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, zc=HUB.api.zc;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. 常量 / 状态（render 闭包内，切页随闭包丢弃） ═══ */
    const SUB='可领套餐预览 · 手动领取（浏览器内滑块验证）· 一键领取（真实消耗）';
    const FILTERS=[
      {key:'scope', label:'领取', options:[
        {value:'all', label:'全部账号'},
        {value:'has', label:'有待领套餐'},
        {value:'none', label:'无待领套餐'},
        {value:'error', label:'查询失败'}
      ]},
      {key:'act', label:'激活', options:[
        {value:'all', label:'全部'},
        {value:'ok', label:'已激活'},
        {value:'bad', label:'未激活 / 失败'}
      ]}
    ];
    const state={scope:'all', act:'all'};   /* 筛选单一事实源 */
    let entries=[];                          /* preview[] 原样数据 */
    let captcha=null, captchaErr=null;       /* claim/captcha-config 的成功 / 失败态 */
    let lastRun=null;                        /* {kind, at, summary, outcomes} */
    let busy=false;                          /* 四个端点共用的一把请求锁 */
    let boxes={};                            /* shell 布局里的持久盒子 */
    let modalNode=null;                      /* 本页打开的弹窗（用于切页兜底关闭） */

    /* ═══ 2. 格式化工具（全部先转字符串再入 HTML） ═══ */
    function str(v){ return v==null? '':String(v); }
    function errMsg(e){ return str(e&&e.message? e.message : e)||'未知错误'; }
    function msTs(ms){
      const n=Number(ms);
      return n>0? new Date(n).toLocaleString('zh-CN',{hour12:false}) : '—';
    }
    function nowStr(){ return new Date().toLocaleString('zh-CN',{hour12:false}); }
    function hostOf(u){
      const s=str(u);
      if(!s) return '—';
      try{ return new URL(s).host||s; }
      catch(e){ return s.length>28? s.slice(0,28)+'…' : s; }
    }
    function grantsHtml(grants){
      if(!grants||!grants.length) return '';
      return grants.map(function(g){
        const period=str(g.period);
        return U.esc(str(g.name)||'授权')+' × <span class="mono">'+U.esc(U.num(g.units))+'</span>'
          +(period&&period!=='one_time'? ' <span class="dim">'+U.esc(period)+'</span>' : '');
      }).join(' · ');
    }
    function recordRun(kind, r){
      const s=(r&&r.summary)||{ok:0, fail:0};
      lastRun={
        kind:kind,
        outcomes:(r&&r.outcomes)||[],
        summary:s,
        at:nowStr()
      };
    }

    /* ═══ 3. 表格单元格（预览 / 最近一次领取共用渲染约定） ═══ */
    function activationCell(row){
      if(row.error) return '<span title="'+U.esc(row.error)+'">'+U.pill('查询失败','bad')+'</span>';
      if(row.activated) return U.pill('已激活','ok');
      return '<span title="'+U.esc(row.activation_error)+'">'+U.pill('激活上报失败','warn')+'</span>';
    }
    function plansCell(row){
      if(row.error) return U.pill(row.error,'bad');
      const plans=row.plans||[];
      if(!plans.length) return '<span class="dim">无待领套餐</span>';
      const shown=plans.slice(0,3).map(function(p){
        const pid=str(p.plan_id);
        const label=str(p.name)||pid||'未命名套餐';
        const g=grantsHtml(p.grants);
        return '<div style="margin-bottom:2px"><b>'+U.esc(label)+'</b>'
          +(pid&&label!==pid? ' <span class="mono dim" style="font-size:var(--fs-xs)">'+U.esc(pid)+'</span>' : '')
          +' '+U.pill('优先级 '+(str(p.priority)||'0'),'mute')+'</div>'
          +(g? '<div class="dim" style="font-size:var(--fs-xs);margin-bottom:4px">'+g+'</div>' : '');
      }).join('');
      return shown+(plans.length>3? '<div class="dim" style="font-size:var(--fs-xs)">另有 '+(plans.length-3)+' 个套餐</div>' : '');
    }
    const PREVIEW_COLUMNS=[
      {key:'account_name', label:'账号', render:function(v,row){
        const name=row.account_name||str(row.account_id).slice(0,8)||'—';
        return '<div><b>'+U.esc(name)+'</b></div>'
          +'<div class="mono dim" style="font-size:var(--fs-xs)">'+U.esc(row.account_id)+'</div>';
      }},
      {key:'activated', label:'激活状态', render:function(v,row){ return activationCell(row); }},
      {key:'plans', label:'可领套餐', render:function(v,row){ return plansCell(row); }},
      {key:'plan_count', label:'计划数', align:'right', render:function(v,row){
        return '<span class="mono">'+U.num(row.plan_count)+'</span>';
      }}
    ];
    const LAST_COLUMNS=[
      {key:'account_name', label:'账号', render:function(v,o){
        return '<b>'+U.esc(str(o.account_name)||'—')+'</b>'
          +'<div class="mono dim" style="font-size:var(--fs-xs)">'+U.esc(str(o.account_id))+'</div>';
      }},
      {key:'ok', label:'结果', render:function(v,o){
        return o.ok? U.pill('成功','ok') : U.pill('失败','bad');
      }},
      {key:'plan_name', label:'套餐', render:function(v,o){
        return o.plan_name? '<b>'+U.esc(str(o.plan_name))+'</b>' : '—';
      }},
      {key:'grants', label:'授权项', render:function(v,o){ return grantsHtml(o.grants)||'—'; }},
      {key:'message', label:'说明', render:function(v,o){
        const msg=str(o.message);
        const code=(o.code==null)? '' : ' <span class="mono dim">code '+U.esc(str(o.code))+'</span>';
        const next=o.next_at? '<div class="dim" style="font-size:var(--fs-xs)">名额恢复 '+U.esc(msTs(o.next_at))+'</div>' : '';
        return (msg? U.esc(msg) : '—')+code+next;
      }}
    ];

    /* ═══ 4. 筛选 / 行数据派生 ═══ */
    function filtered(){
      return entries.filter(function(e){
        const plans=e.plans||[];
        if(state.scope==='has'&&(e.error||!plans.length)) return false;
        if(state.scope==='none'&&(e.error||plans.length)) return false;
        if(state.scope==='error'&&!e.error) return false;
        if(state.act==='ok'&&!e.activated) return false;
        if(state.act==='bad'&&e.activated) return false;
        return true;
      });
    }
    function viewRows(){
      return filtered().map(function(e){
        const plans=e.plans||[];
        return {
          account_id:str(e.account_id),
          account_name:str(e.account_name),
          plans:plans,
          plan_count:plans.length,
          activated:!!e.activated,
          error:str(e.error),
          activation_error:str(e.activation_error)
        };
      });
    }

    /* ═══ 5. shell 布局（标题下工具栏 + 内容区骨架，只建一次） ═══ */
    function buildLayout(){
      const bar=shell.toolbar();
      bar.innerHTML=
        '<div class="toolbar">'
        +'<button class="btn" data-act="reload">重新拉取预览</button>'
        +'<button class="btn" data-act="manual">手动领取</button>'
        +'<button class="btn danger" data-act="claimAll">一键领取（真实消耗）</button>'
        +'<span class="pill bad" id="zc-busy">真实消耗 · 不可撤销</span>'
        +'<span class="spacer"></span>'
        +'<span class="pill mute" id="zc-count"></span>'
        +'<span id="zc-filter"></span>'
        +'</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="zc-cards"></div>'
        +'<h2>领取预览</h2>'
        +'<p class="sub">预览会先向上游上报当日激活事件再查套餐，因此本页不做定时轮询；只在进入页面、手动刷新与领取完成后拉取。</p>'
        +'<div id="zc-table" style="overflow-x:auto"></div>'
        +'<div id="zc-last"></div>'
        +'<h2>验证码配置 <span class="pill mute">claim/captcha-config</span></h2>'
        +'<div class="toolbar">'
        +'<button class="btn mini" data-act="refreshCap">刷新配置</button>'
        +'<span class="dim" style="font-size:var(--fs-xs)">参数按领取出口（BILLING_EGRESS）下发，手动领取必须使用同一出口签发的 verifyParam</span>'
        +'</div>'
        +'<div id="zc-cap"></div>';
      boxes={
        cards:c.querySelector('#zc-cards'),
        table:c.querySelector('#zc-table'),
        last:c.querySelector('#zc-last'),
        cap:c.querySelector('#zc-cap'),
        count:bar.querySelector('#zc-count'),
        busyPill:bar.querySelector('#zc-busy')
      };
      C.filterBar(bar.querySelector('#zc-filter'), FILTERS, state, function(){ paintTable(); });
    }

    /* ═══ 6. 视图渲染（statCards / dataTable） ═══ */
    function paintAll(){
      if(!shell.alive) return;
      paintCards();
      paintTable();
      paintLast();
      paintCaptcha();
    }
    function paintCards(){
      if(!boxes.cards) return;
      const claimable=entries.filter(function(e){ return !e.error&&(e.plans||[]).length; });
      let total=0, top=null;
      entries.forEach(function(e){
        const plans=e.plans||[];
        total+=plans.length;
        plans.forEach(function(p){
          if(!top||Number(p.priority)>Number(top.priority)) top=p;
        });
      });
      C.statCards(boxes.cards,[
        {label:'JWT 账号', value:U.num(entries.length), sub:'参与预览的账号数'},
        {label:'可领账号', value:U.num(claimable.length), sub:'至少有一个待领套餐'},
        {label:'待领套餐', value:U.num(total), sub:'全部账号合计'},
        {label:'最高优先级', value:top? str(top.priority) : '—',
          sub:top? U.esc(str(top.name)||str(top.plan_id)) : '当前无待领套餐'}
      ]);
    }
    function paintTable(){
      if(!boxes.table) return;
      const rows=viewRows();
      C.dataTable(boxes.table,{
        columns:PREVIEW_COLUMNS,
        rows:rows,
        rowKey:'account_id',
        actions:function(row){
          return [{label:'手动领取', onClick:function(){ openManual(row); }}];
        },
        emptyText:entries.length
          ? '当前筛选条件下没有账号'
          : '没有 JWT 账号可预览（需先在 ZC 账号池添加 Coding Plan 账号）'
      });
      if(boxes.count) boxes.count.textContent='显示 '+rows.length+' / '+entries.length;
    }
    function paintLast(){
      if(!boxes.last) return;
      if(!lastRun){ boxes.last.innerHTML=''; return; }
      const s=lastRun.summary||{ok:0, fail:0};
      boxes.last.innerHTML=
        '<h2>最近一次领取 · '+U.esc(lastRun.kind)+'</h2>'
        +'<div class="toolbar">'
        +U.pill('成功 '+s.ok+' · 失败 '+s.fail, s.fail? 'warn' : 'ok')
        +'<span class="pill mute">'+U.esc(lastRun.at)+'</span>'
        +'</div>'
        +'<div id="zc-last-table" style="overflow-x:auto"></div>';
      C.dataTable(boxes.last.querySelector('#zc-last-table'),{
        columns:LAST_COLUMNS,
        rows:lastRun.outcomes,
        rowKey:'account_id',
        emptyText:'本次没有返回任何账号结果'
      });
    }
    function paintCaptcha(){
      if(!boxes.cap) return;
      const cap=captcha||{};
      const stateText=captchaErr? '获取失败' : captcha? (cap.enabled? '已启用' : '未启用') : '未知';
      C.statCards(boxes.cap,[
        {label:'验证码', value:stateText,
          sub:captchaErr? U.esc(errMsg(captchaErr)) : '手动领取的前置条件'},
        {label:'scene_id', value:str(cap.scene_id)||'—', sub:'阿里滑块场景 ID'},
        {label:'region', value:str(cap.region)||'—', sub:'随领取出口（BILLING_EGRESS）变化'},
        {label:'prefix', value:hostOf(cap.prefix),
          sub:cap.prefix
            ? '<span class="mono" style="font-size:var(--fs-xs);word-break:break-all">'+U.esc(str(cap.prefix))+'</span>'
            : 'SDK 资源前缀未下发'}
      ]);
    }
    function syncBusy(){
      const btns=el.querySelectorAll('[data-act]');
      for(let i=0;i<btns.length;i++) btns[i].disabled=busy;
      if(boxes.busyPill){
        boxes.busyPill.className='pill '+(busy? 'warn' : 'bad');
        boxes.busyPill.textContent=busy? '处理中…' : '真实消耗 · 不可撤销';
      }
    }

    /* ═══ 7. 数据拉取：预览 / 验证码配置（互不连坐） ═══ */
    async function refreshPreview(silent){
      if(busy){
        if(!silent) U.toast('已有请求进行中，请稍候','warn');
        return;
      }
      busy=true; syncBusy();
      try{
        const pv=await zc.claimPreview();
        if(!shell.alive) return;
        entries=(pv&&pv.preview)||[];
        if(!silent) U.toast('预览已刷新','ok');
      }catch(e){
        if(!shell.alive) return;
        if(!silent) U.toast('预览刷新失败：'+errMsg(e),'bad');
        return;
      }finally{
        busy=false;
        if(shell.alive){ syncBusy(); paintAll(); }
      }
    }
    async function refreshCaptcha(){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      busy=true; syncBusy();
      try{
        const c=await zc.claimCaptchaConfig();
        if(!shell.alive) return;
        captcha=c; captchaErr=null;
        U.toast('验证码配置已刷新','ok');
      }catch(e){
        if(!shell.alive) return;
        captchaErr=e;
        U.toast('验证码配置刷新失败：'+errMsg(e),'bad');
      }finally{
        busy=false;
        if(shell.alive){ syncBusy(); paintAll(); }
      }
    }

    /* ═══ 8. 弹窗基建（U.openModal 的 async onClick 不会自动关闭，需显式关） ═══ */
    function openModal(opts){
      modalNode=U.openModal(opts);
      return modalNode;
    }
    function closeOurModal(){
      if(modalNode&&modalNode.isConnected) U.closeModal();
      modalNode=null;
    }
    function footButtons(m){
      const list=m.querySelectorAll('.foot .btn');
      const out=[];
      for(let i=0;i<list.length;i++) out.push(list[i]);
      return out;
    }

    /* ═══ 9. 手动领取 Modal：账号 → 套餐级联 + verifyParam ═══ */
    function accountOptionsHtml(selected){
      const list=entries.filter(function(e){ return str(e.account_id); });
      const opts=['<option value="">请选择账号</option>'];
      list.forEach(function(e){
        const id=str(e.account_id);
        const name=str(e.account_name)||id.slice(0,8);
        opts.push('<option value="'+U.esc(id)+'"'+(id===selected? ' selected' : '')+'>'
          +U.esc(name)+'（'+U.esc(id.slice(0,8))+'）'+(e.error? '（预览失败）' : '')+'</option>');
      });
      return opts.join('');
    }
    function plansFor(accountId){
      const hit=entries.filter(function(e){ return str(e.account_id)===accountId; })[0];
      return (hit&&hit.plans)||[];
    }
    function planOptionsHtml(accountId, selected){
      const opts=['<option value="">自动选择最优</option>'];
      plansFor(accountId).forEach(function(p){
        const pid=str(p.plan_id);
        opts.push('<option value="'+U.esc(pid)+'"'+(pid===selected? ' selected' : '')+'>'
          +U.esc(str(p.name)||pid)+'（优先级 '+U.esc(str(p.priority)||'0')+'）</option>');
      });
      return opts.join('');
    }
    function openManual(row){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      const accounts=entries.filter(function(e){ return str(e.account_id); });
      if(!accounts.length){ U.toast('没有 JWT 账号可手动领取，请先在 ZC 账号池添加 Coding Plan 账号','warn'); return; }

      let accountId=row? str(row.account_id) : '';
      if(accountId&&!accounts.some(function(e){ return str(e.account_id)===accountId; })) accountId='';
      if(!accountId&&accounts.length===1) accountId=str(accounts[0].account_id);
      const planId=(row&&row.plans&&row.plans.length)? str(row.plans[0].plan_id) : '';
      const region=str(captcha&&captcha.region);

      const m=openModal({
        title:'手动领取 · 需浏览器内完成滑块验证',
        wide:true,
        body:
          '<div class="toolbar" style="margin-bottom:var(--sp-2)">'
          +U.pill('真实消耗 · 占用上游活动名额','bad')
          +'<span class="pill mute">POST claim/manual</span>'
          +'</div>'
          +'<div class="toolbar" style="align-items:flex-end">'
          +'<label>账号<br><select id="zc-m-acc" style="min-width:240px">'+accountOptionsHtml(accountId)+'</select></label>'
          +'<label>套餐<br><select id="zc-m-plan" style="min-width:220px">'+planOptionsHtml(accountId, planId)+'</select></label>'
          +'<label>验证码 region<br><input id="zc-m-region" value="'+U.esc(region)+'" placeholder="如 cn / sgp" style="width:130px"></label>'
          +'</div>'
          +'<label style="display:block;margin-top:var(--sp-3)">verifyParam（必填）'
          +'<br><input id="zc-m-verify" placeholder="粘贴阿里滑块成功回调的 verifyParam" style="width:100%"></label>'
          +'<p class="dim" style="font-size:var(--fs-xs);margin:var(--sp-2) 0 0">'
          +'verifyParam 需在浏览器内完成阿里滑块验证取得（本页不代为求解），仅随本次请求转发，提交后即清空；'
          +'region 默认取 claim/captcha-config'+(region? '（'+U.esc(region)+'）' : '（未下发）')+'。</p>'
          +'<p class="dim" style="font-size:var(--fs-xs);margin:var(--sp-1) 0 0">'
          +'失败回执会带上游业务码（如 <span class="mono">1005</span> = 今日名额用完），可在「最近一次领取」中核对。</p>',
        actions:[
          {label:'取消'},
          {label:'提交领取（真实消耗）', kind:'danger', onClick:async function(){
            await submitManual(m);
          }}
        ]
      });

      const accSel=m.querySelector('#zc-m-acc');
      const planSel=m.querySelector('#zc-m-plan');
      if(accSel&&planSel){
        shell.listen(accSel,'change',function(){
          if(!m.isConnected||!shell.alive) return;
          planSel.innerHTML=planOptionsHtml(accSel.value,'');
        });
      }
      if(accSel) accSel.focus();
    }
    async function submitManual(m){
      const accSel=m.querySelector('#zc-m-acc');
      const planSel=m.querySelector('#zc-m-plan');
      const regIn=m.querySelector('#zc-m-region');
      const verIn=m.querySelector('#zc-m-verify');
      if(!accSel||!planSel||!regIn||!verIn) return;

      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      const accountId=str(accSel.value).trim();
      const verify=str(verIn.value).trim();
      if(!accountId){ U.toast('请先选择账号','warn'); return; }
      if(!verify){ U.toast('请先粘贴滑块回调的 verifyParam','warn'); return; }

      const hit=entries.filter(function(e){ return str(e.account_id)===accountId; })[0];
      const accountName=hit? (str(hit.account_name)||accountId) : accountId;
      const planId=str(planSel.value).trim();
      if(!window.confirm('手动领取将对账号「'+accountName+'」执行真实领取（'+(planId||'自动选择最优套餐')+'），消耗上游活动名额。确认继续？')) return;

      const payload={account_id:accountId, captcha_verify_param:verify};
      const region=str(regIn.value).trim();
      if(region) payload.captcha_region=region;
      if(planId) payload.plan_id=planId;
      verIn.value='';   /* 一次性凭证：读入后立即从 DOM 清掉，避免重试时复用 */

      const btns=footButtons(m);
      const submitBtn=btns.length? btns[btns.length-1] : null;
      const submitLabel=submitBtn? submitBtn.textContent : '';
      btns.forEach(function(b){ b.disabled=true; });
      if(submitBtn) submitBtn.textContent='提交中…';

      busy=true; syncBusy();
      try{
        const r=await zc.claimManual(payload);
        if(!shell.alive) return;
        recordRun('手动领取 · '+accountName, r);
        const s=lastRun.summary;
        U.toast('手动领取完成：成功 '+s.ok+' · 失败 '+s.fail, s.fail? 'warn' : 'ok');
        closeOurModal();
      }catch(e){
        if(!shell.alive) return;
        U.toast('手动领取失败：'+errMsg(e),'bad');
        /* 失败保留弹窗，但 verifyParam 已被清空，需要重新做滑块验证后再提交 */
      }finally{
        busy=false;
        if(submitBtn&&submitBtn.isConnected) submitBtn.textContent=submitLabel;
        btns.forEach(function(b){ if(b.isConnected) b.disabled=false; });
        if(shell.alive){ syncBusy(); paintAll(); }
      }
      if(shell.alive) await refreshPreview(true);
    }

    /* ═══ 10. 一键领取（真实消耗）：二次确认 → claim → 静默回拉预览 ═══ */
    function confirmClaimAll(){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      if(!entries.length){ U.toast('没有可领取的 JWT 账号','warn'); return; }
      const m=openModal({
        title:'一键领取 · 二次确认',
        body:
          '<div class="toolbar" style="margin-bottom:var(--sp-2)">'
          +U.pill('真实消耗 · 不可撤销','bad')
          +'</div>'
          +'<p>将对 <b class="mono">'+U.esc(U.num(entries.length))+'</b> 个 JWT 账号执行领取：每个账号自动选择优先级最高的可领套餐。</p>'
          +'<p class="sub" style="margin:var(--sp-2) 0 0">这是真实消耗：会占用上游活动名额并产生不可撤销的领取记录；凭证失效（废 JWT）的账号会被后端跳过。</p>',
        actions:[
          {label:'取消'},
          {label:'确认领取（真实消耗）', kind:'danger', onClick:async function(){
            const btns=footButtons(m);
            btns.forEach(function(b){ b.disabled=true; });
            await runClaimAll();
            closeOurModal();
            await refreshPreview(true);
          }}
        ]
      });
    }
    async function runClaimAll(){
      busy=true; syncBusy();
      try{
        const r=await zc.claim();
        if(!shell.alive) return;
        recordRun('一键领取', r);
        const s=lastRun.summary;
        U.toast('一键领取完成：成功 '+s.ok+' · 失败 '+s.fail, s.fail? 'warn' : 'ok');
      }catch(e){
        if(!shell.alive) return;
        U.toast('一键领取失败：'+errMsg(e),'bad');
      }finally{
        busy=false;
        if(shell.alive){ syncBusy(); paintAll(); }
      }
    }

    /* ═══ 11. 事件委托（shell.listen 自动清理） ═══ */
    function onPageClick(ev){
      const b=ev.target.closest? ev.target.closest('[data-act]') : null;
      if(!b||!el.contains(b)) return;
      const act=b.getAttribute('data-act');
      if(act==='reload'){ refreshPreview(false); return; }
      if(act==='manual'){ openManual(null); return; }
      if(act==='claimAll'){ confirmClaimAll(); return; }
      if(act==='refreshCap'){ refreshCaptcha(); }
    }

    /* ═══ 12. 首屏：预览失败 = 页错；验证码配置失败只降级该区块 ═══ */
    shell.setTitle('ZC 领取', SUB);
    shell.setContent(U.loadHtml('正在拉取可领套餐与验证码配置…'));

    const rs=await Promise.all([
      zc.claimPreview().then(function(r){ return {v:r}; }, function(e){ return {e:e}; }),
      zc.claimCaptchaConfig().then(function(r){ return {v:r}; }, function(e){ return {e:e}; })
    ]);
    if(ctx.stale()) return;
    if(rs[0].e){
      shell.setTitle('ZC 领取','加载失败');
      shell.setContent(U.errHtml(rs[0].e));
      return;
    }
    entries=(rs[0].v&&rs[0].v.preview)||[];
    if(rs[1].e) captchaErr=rs[1].e;
    else captcha=rs[1].v;

    buildLayout();
    shell.listen(el,'click',onPageClick);
    syncBusy();
    paintAll();

    /* 弹窗在 body 上，router 不调 destroy：监听下一次 hashchange（once 自移除）关掉本页弹窗 */
    shell.listen(window,'hashchange',function(){
      if(modalNode&&modalNode.isConnected) U.closeModal();
      modalNode=null;
    },{once:true});
    shell.onCleanup(function(){
      if(modalNode&&modalNode.isConnected) U.closeModal();
    });
  }
});
