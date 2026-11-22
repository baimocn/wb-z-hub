/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 领取
 * 端点：GET  /admin/api/claim/preview          → zc.claimPreview
 *       POST /admin/api/claim                  → zc.claim
 *       GET  /admin/api/claim/captcha-config   → zc.claimCaptchaConfig
 *       POST /admin/api/claim/manual           → zc.claimManual
 * 说明：preview 会先对每个 JWT 账号上报当日激活事件再查套餐
 *       （zcode2api/app/routes/admin_api.py:482-513），因此本页不做定时轮询，
 *       只在进入页面与用户主动刷新/领取后拉取。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'zc-claim', group:'zc', title:'ZC 领取', order:75,
  async render(el, ctx){
    const U=HUB.ui, Z=HUB.api.zc;
    const S=function(v){ return v==null ? '' : String(v); };
    let data=null, captcha=null, captchaErr=null, lastRun=null, busy=false;
    const form={accountId:'', planId:'', verify:'', region:''};

    /* ── 数据小工具 ── */
    function entries(){ return (data&&data.preview)||[]; }
    function msTs(ms){
      const n=Number(ms);
      return n>0 ? new Date(n).toLocaleString('zh-CN',{hour12:false}) : '—';
    }
    function grantsHtml(grants){
      if(!grants||!grants.length) return '';
      return grants.map(function(g){
        const period=S(g.period);
        return U.esc(S(g.name)||'授权')+' × <span class="mono">'+U.esc(U.num(g.units))+'</span>'
          +(period&&period!=='one_time'?' <span class="dim">'+U.esc(period)+'</span>':'');
      }).join(' · ');
    }
    function readForm(){
      const get=function(id){ return document.getElementById(id); };
      const acc=get('zc-acc'), plan=get('zc-plan'), reg=get('zc-region'), ver=get('zc-verify');
      if(acc) form.accountId=acc.value;
      if(plan) form.planId=plan.value;
      if(reg) form.region=reg.value;
      if(ver) form.verify=ver.value;
    }
    function accountOptions(){
      const list=entries();
      if(!list.length){ form.accountId=''; form.planId=''; return '<option value="">无 JWT 账号</option>'; }
      if(form.accountId && !list.some(function(e){ return S(e.account_id)===form.accountId; })){
        form.accountId=''; form.planId='';
      }
      return '<option value="">请选择账号</option>'+list.map(function(e){
        const id=S(e.account_id);
        const nm=S(e.account_name)||id.slice(0,8);
        return '<option value="'+U.esc(id)+'"'+(form.accountId===id?' selected':'')+'>'
          +U.esc(nm)+'（'+U.esc(id.slice(0,8))+'）</option>';
      }).join('');
    }
    function planOptions(){
      const id=S(form.accountId);
      const entry=entries().filter(function(e){ return S(e.account_id)===id; })[0];
      const plans=(entry&&entry.plans)||[];
      if(form.planId && !plans.some(function(p){ return S(p.plan_id)===form.planId; })) form.planId='';
      let html='<option value="">自动选择最优</option>';
      plans.forEach(function(p){
        const pid=S(p.plan_id);
        html+='<option value="'+U.esc(pid)+'"'+(form.planId===pid?' selected':'')+'>'
          +U.esc(S(p.name)||pid)+'（优先级 '+U.esc(S(p.priority))+'）</option>';
      });
      return html;
    }

    /* ── 单元格 ── */
    function activationCell(e){
      if(e.error) return '<span title="'+U.esc(S(e.error))+'">'+U.pill('查询失败','bad')+'</span>';
      if(e.activated) return U.pill('已激活','ok');
      return '<span title="'+U.esc(S(e.activation_error))+'">'+U.pill('激活上报失败','warn')+'</span>';
    }
    function plansCell(e){
      if(e.error) return '<span class="pill bad">'+U.esc(S(e.error))+'</span>';
      const plans=e.plans||[];
      if(!plans.length) return '<span class="dim">无待领套餐</span>';
      const shown=plans.slice(0,3).map(function(p){
        const g=grantsHtml(p.grants);
        const pid=S(p.plan_id);
        const label=S(p.name)||pid;
        const idLine=(pid&&label!==pid)?' <span class="mono dim" style="font-size:10.5px">'+U.esc(pid)+'</span>':'';
        return '<div style="margin-bottom:2px"><b>'+U.esc(label)+'</b>'+idLine+' '
          +U.pill('优先级 '+(S(p.priority)||'0'),'mute')+'</div>'
          +(g?'<div class="dim" style="font-size:10.5px;margin-bottom:4px">'+g+'</div>':'');
      }).join('');
      return shown+(plans.length>3?'<div class="dim" style="font-size:10.5px">另有 '+(plans.length-3)+' 个套餐</div>':'');
    }
    function lastRunHtml(){
      if(!lastRun) return '';
      const rows=(lastRun.outcomes||[]).map(function(x){
        const msg=S(x.message);
        const code=(x.code==null)?'':(' <span class="mono dim">code '+U.esc(S(x.code))+'</span>');
        const next=x.next_at?('<div class="dim" style="font-size:10.5px">名额恢复 '+U.esc(msTs(x.next_at))+'</div>'):'';
        return [
          '<b>'+U.esc(S(x.account_name)||'—')+'</b><div class="mono dim" style="font-size:10.5px">'+U.esc(S(x.account_id))+'</div>',
          x.ok?U.pill('成功','ok'):U.pill('失败','bad'),
          x.plan_name?'<b>'+U.esc(S(x.plan_name))+'</b>':'—',
          grantsHtml(x.grants)||'—',
          (msg?U.esc(msg):'—')+code+next
        ];
      });
      const s=lastRun.summary||{ok:0,fail:0};
      return '<h2>最近一次领取 · '+U.esc(lastRun.kind)+'</h2>'
        +'<div class="toolbar">'
        +U.pill('成功 '+s.ok+' · 失败 '+s.fail, s.fail?'warn':'ok')
        +'<span class="pill mute">'+U.esc(lastRun.at)+'</span></div>'
        +U.table(['账号','结果','套餐','授权项','说明'], rows, {empty:'本次没有返回任何账号结果'});
    }

    /* ── 绘制 ── */
    function draw(){
      if(ctx.stale()) return;
      readForm();
      const list=entries();
      const claimable=list.filter(function(e){ return !e.error && (e.plans||[]).length>0; });
      const totalPlans=list.reduce(function(n,e){ return n+(e.plans||[]).length; },0);
      let top=null;
      list.forEach(function(e){
        (e.plans||[]).forEach(function(p){
          if(!top||Number(p.priority)>Number(top.priority)) top=p;
        });
      });
      const rows=list.map(function(e){
        const id=S(e.account_id);
        const plans=e.plans||[];
        const first=plans.length?plans[0]:null;
        return [
          '<b>'+U.esc(S(e.account_name)||id.slice(0,8))+'</b><div class="mono dim" style="font-size:10.5px">'+U.esc(id)+'</div>',
          activationCell(e),
          plansCell(e),
          '<span class="mono">'+plans.length+'</span>',
          id
            ?'<button class="btn mini" data-act="pick" data-account="'+U.esc(id)+'" data-plan="'+U.esc(first?S(first.plan_id):'')+'" title="填入下方手动领取表单（需 verifyParam）">手动领取</button>'
            :'—'
        ];
      });
      const capPill=captchaErr
        ? U.pill('获取失败','bad')
        : (captcha ? (captcha.enabled?U.pill('已启用','ok'):U.pill('未启用','warn')) : U.pill('未知','mute'));
      const capScene=U.esc(captcha ? (S(captcha.scene_id)||'—') : '—');
      const capRegion=U.esc(captcha ? (S(captcha.region)||'—') : '—');
      const capPrefix=U.esc(captcha ? (S(captcha.prefix)||'—') : '—');

      el.innerHTML=`
      <h1>ZC 领取</h1>
      <p class="sub">可领套餐预览 · 一键领取（真实消耗）· 阿里滑块配置与手动领取</p>
      ${U.cards([
        {k:'JWT 账号', v:U.num(list.length), n:'参与预览的账号数'},
        {k:'可领账号', v:U.num(claimable.length), vsmall:'/ '+list.length, n:'至少有一个待领套餐'},
        {k:'待领套餐', v:U.num(totalPlans), n:'全部账号合计'},
        {k:'最高优先级', v:top?U.esc(S(top.priority)):'—', n:top?U.esc(S(top.name)||S(top.plan_id)):'当前无待领套餐'},
        {k:'验证码', v:capPill, n:captchaErr?U.esc(S(captchaErr.message)):('scene_id '+capScene)}
      ])}
      <div class="toolbar">
        <button class="btn" data-act="refresh"${busy?' disabled':''}>重新拉取预览</button>
        <button class="btn danger" data-act="claim-all"${busy?' disabled':''}>一键领取（真实消耗）</button>
        ${busy?U.pill('处理中…','warn'):U.pill('真实消耗 · 不可撤销','bad')}
        <span class="dim" style="font-size:11.5px">预览会向上游上报当日激活事件，请勿频繁刷新</span>
      </div>
      ${lastRunHtml()}
      <h2>领取预览</h2>
      ${U.table(['账号','激活状态','可领套餐','计划数','操作'], rows, {empty:'没有 JWT 账号可预览（需先在账号页添加 Coding Plan 账号）'})}
      <h2>验证码配置 <span class="pill mute">claim/captcha-config</span></h2>
      <div class="toolbar">
        <button class="btn mini" data-act="refresh-cap"${busy?' disabled':''}>刷新配置</button>
        <span class="dim" style="font-size:11.5px">参数按领取出口下发，手动领取必须使用同一出口签发的 verifyParam</span>
      </div>
      ${U.cards([
        {k:'验证码', v:capPill, n:captchaErr?'配置拉取失败':'手动领取的前置条件'},
        {k:'scene_id', v:'<span style="font-size:13px">'+capScene+'</span>', n:'阿里滑块场景 ID'},
        {k:'region', v:'<span style="font-size:13px">'+capRegion+'</span>', n:'随出口 IP 变化'},
        {k:'prefix', v:'<span class="mono" style="font-size:12px;word-break:break-all">'+capPrefix+'</span>', n:'SDK 资源前缀'}
      ])}
      <h2>手动领取</h2>
      <p class="sub">verifyParam 需先在浏览器内完成阿里滑块验证取得（本页不代为求解）；仅随本次请求转发，提交后即清空。</p>
      <form id="zc-manual-form" class="toolbar" style="align-items:flex-end">
        <label>账号<br><select id="zc-acc" style="min-width:230px">${accountOptions()}</select></label>
        <label>套餐<br><select id="zc-plan" style="min-width:210px">${planOptions()}</select></label>
        <label>验证码 region<br><input id="zc-region" value="${U.esc(form.region)}" placeholder="如 cn / sgp" style="width:120px"></label>
        <label style="flex:1 1 320px;min-width:280px">verifyParam（必填）<br><input id="zc-verify" value="${U.esc(form.verify)}" placeholder="粘贴阿里滑块成功回调的 verifyParam" style="width:100%"></label>
        <button class="btn danger" type="submit"${busy?' disabled':''}>手动领取（真实消耗）</button>
      </form>
      <p class="sub" style="margin-top:var(--sp-2)">失败回执会带上游业务码（如 <span class="mono">1005</span> = 今日名额用完），可在「最近一次领取」中核对。</p>`;
    }

    /* ── 动作 ── */
    async function refreshPreview(silent){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      busy=true; draw();
      try{
        const pv=await Z.claimPreview();
        if(ctx.stale()) return;
        data=pv;
        if(!silent) U.toast('预览已刷新','ok');
      }catch(e){
        if(ctx.stale()) return;
        if(!silent) U.toast('预览刷新失败：'+(e.message||e),'bad');
      }finally{
        busy=false;
        if(!ctx.stale()) draw();
      }
    }

    async function refreshCaptcha(){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      busy=true; draw();
      try{
        const c=await Z.claimCaptchaConfig();
        if(ctx.stale()) return;
        captcha=c; captchaErr=null;
        if(!S(form.region).trim()&&c.region) form.region=S(c.region);
        U.toast('验证码配置已刷新','ok');
      }catch(e){
        if(ctx.stale()) return;
        captchaErr=e;
        U.toast('验证码配置刷新失败：'+(e.message||e),'bad');
      }finally{
        busy=false;
        if(!ctx.stale()) draw();
      }
    }

    function confirmClaimAll(){
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      const list=entries();
      if(!list.length){ U.toast('没有可领取的 JWT 账号','warn'); return; }
      let modal=null;
      modal=U.openModal({
        title:'一键领取 · 二次确认',
        body:'<p>将对 <b class="mono">'+list.length+'</b> 个 JWT 账号执行领取：每个账号自动选择优先级最高的可领套餐。</p>'
          +'<p class="sub" style="margin:8px 0 0">这是<b style="color:var(--danger)">真实消耗</b>：会占用上游活动名额并产生不可撤销的领取记录；废 JWT 账号会被跳过。</p>',
        actions:[
          {label:'取消'},
          {label:'确认领取（真实消耗）', kind:'danger', onClick:async function(){
            const btns=modal.querySelectorAll('.foot .btn');
            for(let i=0;i<btns.length;i++) btns[i].disabled=true;
            await runClaimAll();
          }}
        ]
      });
    }

    async function runClaimAll(){
      busy=true; draw();
      try{
        const r=await Z.claim();
        if(ctx.stale()) return;
        const s=(r&&r.summary)||{ok:0,fail:0};
        lastRun={kind:'一键领取', outcomes:(r&&r.outcomes)||[], summary:s, at:new Date().toLocaleString('zh-CN',{hour12:false})};
        U.toast('一键领取完成：成功 '+s.ok+' · 失败 '+s.fail, s.fail?'warn':'ok');
      }catch(e){
        if(ctx.stale()) return;
        U.toast('一键领取失败：'+(e.message||e),'bad');
      }finally{
        busy=false;
        if(!ctx.stale()) draw();
      }
      if(!ctx.stale()) await refreshPreview(true);
    }

    async function submitManual(){
      readForm();
      if(busy){ U.toast('已有请求进行中，请稍候','warn'); return; }
      const accountId=S(form.accountId).trim();
      const verify=S(form.verify).trim();
      if(!accountId){ U.toast('请先选择账号','warn'); return; }
      if(!verify){ U.toast('请先粘贴滑块回调的 verifyParam','warn'); return; }
      const entry=entries().filter(function(e){ return S(e.account_id)===accountId; })[0];
      const accountName=entry?(S(entry.account_name)||accountId):accountId;
      const planId=S(form.planId).trim();
      if(!window.confirm('手动领取将对账号「'+accountName+'」执行真实领取（'+(planId||'自动选择最优套餐')+'），消耗上游活动名额。确认继续？')) return;
      busy=true;
      const vi=document.getElementById('zc-verify');
      if(vi) vi.value='';          // 先清 DOM，再 draw() 里的 readForm 才不会把旧值读回来
      form.verify='';
      draw();
      try{
        const payload={account_id:accountId, captcha_verify_param:verify};
        const region=S(form.region).trim();
        if(region) payload.captcha_region=region;
        if(planId) payload.plan_id=planId;
        const r=await Z.claimManual(payload);
        if(ctx.stale()) return;
        const s=(r&&r.summary)||{ok:0,fail:0};
        lastRun={kind:'手动领取 · '+accountName, outcomes:(r&&r.outcomes)||[], summary:s, at:new Date().toLocaleString('zh-CN',{hour12:false})};
        U.toast('手动领取完成：成功 '+s.ok+' · 失败 '+s.fail, s.fail?'warn':'ok');
      }catch(e){
        if(ctx.stale()) return;
        U.toast('手动领取失败：'+(e.message||e),'bad');
      }finally{
        busy=false;
        if(!ctx.stale()) draw();
      }
      if(!ctx.stale()) await refreshPreview(true);
    }

    /* ── 事件（挂在 el 上，innerHTML 重绘不会丢） ── */
    function onClick(ev){
      const t=ev.target;
      const btn=(t&&t.closest)?t.closest('[data-act]'):null;
      if(!btn) return;
      const act=btn.getAttribute('data-act');
      if(act==='refresh') refreshPreview(false);
      else if(act==='refresh-cap') refreshCaptcha();
      else if(act==='claim-all') confirmClaimAll();
      else if(act==='pick'){
        readForm();
        form.accountId=btn.getAttribute('data-account')||'';
        form.planId=btn.getAttribute('data-plan')||'';
        draw();
        const acc=document.getElementById('zc-acc');
        if(acc) acc.focus();
        U.toast('已填入手动领取表单，补全 verifyParam 后提交');
      }
    }
    function onChange(ev){
      const t=ev.target;
      if(!t||!t.id) return;
      if(t.id==='zc-acc'){
        form.accountId=t.value; form.planId='';
        const ps=document.getElementById('zc-plan');
        if(ps) ps.value='';   // 清掉旧账号的套餐选择，避免带错 plan_id 提交
        draw();
      }
      else if(t.id==='zc-plan'){ form.planId=t.value; }
      else if(t.id==='zc-region'){ form.region=t.value; }
    }
    function onInput(ev){
      const t=ev.target;
      if(t&&t.id==='zc-verify') form.verify=t.value;
    }
    function onSubmit(ev){
      if(!ev.target||ev.target.id!=='zc-manual-form') return;
      ev.preventDefault();
      submitManual().catch(function(e){ U.toast('手动领取异常：'+((e&&e.message)||e),'bad'); });
    }
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('submit', onSubmit);

    /* ── 首次加载：预览失败即页错；验证码配置失败只降级该区块 ── */
    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('正在拉取可领套餐与验证码配置…');
    const rs=await Promise.all([
      Z.claimPreview().then(function(r){ return {v:r}; }, function(e){ return {e:e}; }),
      Z.claimCaptchaConfig().then(function(r){ return {v:r}; }, function(e){ return {e:e}; })
    ]);
    if(ctx.stale()) return;
    if(rs[0].e){ el.innerHTML=U.errHtml(rs[0].e); return; }
    data=rs[0].v;
    if(rs[1].e){ captchaErr=rs[1].e; }
    else{ captcha=rs[1].v; if(captcha&&captcha.region) form.region=S(captcha.region); }
    draw();
  }
});
