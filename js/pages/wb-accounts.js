/* 页面：账号池 —— 全量账号表 / 筛选 / 启停 / 身份切换 / 凭证与积分刷新 / 导入 / 活动历史
 * 契约：只经 HUB.api.wb.* 取数，只用 HUB.ui.* 构建视图；每次 DOM 写入前过 ctx.stale()。 */
HUB.register({
  route:'wb-accounts', group:'wb', title:'账号池', order:10,
  async render(el, ctx){
    const U=HUB.ui, API=HUB.api, wb=API.wb;
    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('拉取账号池…');

    /* ── 页面状态（每次进入页面独立一份，不跨路由泄漏） ── */
    const state={
      realm:'all', status:'all', pool:'all', group:'', q:'',
      sel:{}, rows:[], meta:{}, lastSync:'',
      grants:null, grantRealm:'all', grantLimit:120,
      hist:null, histRange:'7d'
    };
    let working=false;

    const PRODUCTS={cli:'CLI', workbuddy:'WorkBuddy', vscode:'VSCode'};
    const GRANT_STATUS={
      active:['扣减中','ok'], available:['可用','info'],
      used_up:['已用完','mute'], expired:['已过期','bad']
    };
    const RANGE_LABEL={today:'今天', '1d':'24 小时', '7d':'7 天', '30d':'30 天', '90d':'90 天', all:'全部'};

    /* ── 格式化 ── */
    function p2(n){ return (n<10?'0':'')+n; }
    function parseTime(v){
      if(v===null||v===undefined||v==='') return NaN;
      if(typeof v==='number') return v>1e12?v:v*1000;
      const s=String(v).trim();
      if(!s) return NaN;
      if(/^\d+(\.\d+)?$/.test(s)){ const n=Number(s); return n>1e12?n:n*1000; }
      return Date.parse(s.replace(' ','T'));
    }
    function fmtShort(v){
      const t=parseTime(v); if(!isFinite(t)) return '—';
      const d=new Date(t);
      return p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    }
    function fmtFull(v){
      const t=parseTime(v); if(!isFinite(t)) return '—';
      const d=new Date(t);
      return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    }
    function fmtDate(v){
      const t=parseTime(v); if(!isFinite(t)) return '—';
      const d=new Date(t);
      return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
    }
    function isToday(v){
      const t=parseTime(v); if(!isFinite(t)) return false;
      const d=new Date(t), n=new Date();
      return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
    }
    function humanLeft(sec){
      const s=Number(sec)||0;
      if(s<=0) return '已过期';
      const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
      if(d>0) return d+' 天'+(h>0?' '+h+' 小时':'');
      if(h>0) return h+' 小时';
      return Math.max(1,m)+' 分钟';
    }
    function numText(n){
      n=Number(n);
      if(!isFinite(n)) return '—';
      return n.toLocaleString('zh-CN',{maximumFractionDigits:2});
    }
    function trunc(s,n){
      s=String(s===null||s===undefined?'':s);
      return s.length>n?s.slice(0,n)+'…':s;
    }
    function errMsg(e){ return String(e&&e.message?e.message:e); }
    function len(v){ return (v&&typeof v.length==='number')?v.length:0; }
    function clock(){ try{ return new Date().toLocaleTimeString('zh-CN',{hour12:false}); }catch(e){ return ''; } }
    function option(value,label,cur){
      return '<option value="'+U.esc(value)+'"'+(String(value)===String(cur)?' selected':'')+'>'+U.esc(label)+'</option>';
    }
    function productLabel(p){
      const k=String(p||'workbuddy').toLowerCase();
      return PRODUCTS[k]||k;
    }
    function realmLabel(r){ return r==='cn'?'国内版':r==='intl'?'国际版':(r||'—'); }
    function taskLabel(t){
      if(t==='checkin') return '签到';
      if(t==='daily_chat') return '每日活跃';
      return t||'—';
    }
    function triggerLabel(t){
      const map={scheduler:'调度器',manual:'手动',account_add:'新增账号',account_import:'导入',unknown:'未知'};
      return map[t]||t||'—';
    }
    function sectionError(e,act){
      return '<div class="empty">加载失败：'+U.esc(errMsg(e))+
        '<div style="margin-top:8px"><button class="btn mini" data-act="'+U.esc(act)+'">重试</button></div></div>';
    }
    function loadTd(text){ return '<div class="dim">'+U.esc(text)+'</div>'; }

    /* ── 账号字段辅助 ── */
    function findRow(uid){
      for(let i=0;i<state.rows.length;i++){ if(state.rows[i].uid===uid) return state.rows[i]; }
      return null;
    }
    function creditOf(a){ const c=a&&a.credits; return (c&&typeof c==='object')?c:null; }
    function remainOf(a){
      const c=creditOf(a); if(!c) return null;
      const n=Number(c.remain);
      return isFinite(n)?n:null;
    }
    function tierText(a){
      const t=a&&a.tier;
      if(!t||typeof t!=='object') return '';
      return t.paid?(t.package||'付费'):'免费';
    }
    function acctStatus(a){
      if(a.accountBanned) return {key:'banned',label:'封禁',kind:'bad'};
      if(a.tokenExpired||a.needRelogin) return {key:'expired',label:'凭证过期',kind:'bad'};
      if(!a.enabled) return {key:'disabled',label:'已停用',kind:'mute'};
      if(a.inCooldown||a.breakerFor||a.degradeFor) return {key:'cooldown',label:a.breakerFor?'熔断':'冷却',kind:'warn'};
      if(a.lastError) return {key:'error',label:'异常',kind:'warn'};
      return {key:'ok',label:'正常',kind:'ok'};
    }
    function yesno(b){ return b?U.pill('是','ok'):U.pill('否','mute'); }

    /* ── 账号表单元格 ── */
    function nameCell(a){
      const uid=String(a.uid||'');
      const sub=[uid.slice(0,10)];
      if(a.apiKey) sub.push(a.credentialMask||'static');
      let html='<div>'+U.esc(a.nickname||uid.slice(0,8)||'?')+'</div>'+
        '<div class="dim mono" style="font-size:10.5px">'+U.esc(sub.join(' · '))+'</div>';
      if(a.group) html+='<div style="margin-top:3px">'+U.pill(a.group,'mute')+'</div>';
      if(a.note) html+='<div class="dim" title="'+U.esc(a.note)+'" style="font-size:10.5px;margin-top:2px">'+U.esc(trunc(a.note,28))+'</div>';
      return html;
    }
    function realmCell(a){
      const cn=a.realm==='cn';
      return U.pill(cn?'国内版':'国际版',cn?'warn':'info')+
        '<div class="dim" title="'+U.esc(a.domain||'')+'" style="font-size:10.5px;margin-top:2px">'+U.esc(trunc(a.domain||'—',22))+'</div>';
    }
    function poolCell(a){
      const media=a.poolScope==='media';
      return U.pill(media?'媒体池':'文本池',media?'warn':'mute');
    }
    function statusCell(a){
      const st=acctStatus(a);
      const bits=[];
      if(a.cooldownFor) bits.push('冷却 '+a.cooldownFor+'s');
      if(a.breakerFor) bits.push('熔断 '+a.breakerFor+'s');
      if(a.degradeFor) bits.push('降权 '+a.degradeFor+'s');
      if(a.reserveBlocked) bits.push('保底拦截');
      if(a.dailyLimitBlocked) bits.push('日限额');
      if(a.creditLimitReached) bits.push('积分限');
      return U.pill(st.label,st.kind)+(bits.length?
        '<div class="dim" style="font-size:10.5px;margin-top:2px">'+U.esc(bits.join(' · '))+'</div>':'');
    }
    function creditsCell(a){
      const c=creditOf(a);
      const n=remainOf(a);
      if(n===null) return '<span class="dim">未刷新</span>';
      const pct=parseFloat(c.remain_percent);
      let html='<span class="mono">'+U.esc(numText(n))+'</span>';
      if(isFinite(pct)) html+='<div style="margin-top:3px">'+U.pct(pct)+'</div>';
      const tier=tierText(a);
      html+='<div class="dim" style="font-size:10.5px;margin-top:2px">'+U.esc(tier||'—')+' · '+U.esc(fmtShort(c.updated_iso||c.updated_at))+'</div>';
      return html;
    }
    function expiryCell(a){
      if(a.apiKey) return U.pill('静态 Key','mute');
      const exp=Number(a.expiresAt||0);
      if(!exp) return '<span class="dim">—</span>';
      const left=Math.round(exp-Date.now()/1000);
      if(a.tokenExpired||left<=0){
        return U.pill('已过期','bad')+'<div class="dim" style="font-size:10.5px;margin-top:2px">'+U.esc(fmtDate(exp))+'</div>';
      }
      return '<span class="mono">'+U.esc(humanLeft(left))+'</span>'+
        '<div class="dim" style="font-size:10.5px;margin-top:2px" title="'+U.esc(fmtFull(exp))+'">'+U.esc(fmtDate(exp))+'</div>';
    }
    function signinCell(a){
      if(a.realm==='intl'||a.canDailyChat){
        const done=isToday(a.lastDailyChat);
        return U.pill(done?'今日已活跃':'今日未活跃',done?'ok':'warn')+
          '<div class="dim" style="font-size:10.5px;margin-top:2px">最近 '+U.esc(fmtShort(a.lastDailyChat))+'</div>';
      }
      const ci=creditOf(a)?creditOf(a).checkin:null;
      const checked=isToday(a.lastCheckin)||!!(ci&&ci.today_checked_in);
      let extra='';
      if(ci&&ci.streak_days) extra='连续 '+ci.streak_days+' 天';
      else if(a.lastCheckin) extra='最近 '+fmtShort(a.lastCheckin);
      const kind=a.canCheckin?(checked?'ok':'warn'):'mute';
      return U.pill(checked?'今日已签':'今日未签',kind)+
        (extra?'<div class="dim" style="font-size:10.5px;margin-top:2px">'+U.esc(extra)+'</div>':'');
    }
    function errorCell(a){
      if(!a.lastError) return '<span class="dim">—</span>';
      const title=String(a.lastError)+(a.lastErrorDetail?'\n'+a.lastErrorDetail:'');
      let extra='';
      if(a.fails) extra='失败 '+a.fails+'/'+(a.failWindow||'?');
      else if(a.lastFailFor) extra='最近 '+humanLeft(a.lastFailFor)+'前';
      return '<span style="color:var(--ink-2)" title="'+U.esc(title)+'">'+U.esc(trunc(a.lastError,56))+'</span>'+
        (extra?'<div class="dim" style="font-size:10.5px;margin-top:2px">'+U.esc(extra)+'</div>':'');
    }
    function productCell(a){
      const cur=a.product||'workbuddy';
      let html='<select data-act="product" data-uid="'+U.esc(a.uid)+'" title="切换出站身份（product）" style="padding:3px 6px;font-size:11px">';
      html+=option('cli',PRODUCTS.cli,cur)+option('workbuddy',PRODUCTS.workbuddy,cur)+option('vscode',PRODUCTS.vscode,cur);
      html+='</select>';
      return html;
    }
    function actionsCell(a){
      const uid=U.esc(a.uid);
      return '<div style="display:flex;gap:4px;flex-wrap:wrap">'+
        '<button class="btn mini" data-act="test" data-uid="'+uid+'" title="向该账号发一条最小请求">测试</button>'+
        '<button class="btn mini" data-act="refresh" data-uid="'+uid+'" title="刷新凭证与昵称">刷新</button>'+
        '<button class="btn mini'+(a.enabled?'':' pri')+'" data-act="toggle" data-uid="'+uid+'">'+(a.enabled?'停用':'启用')+'</button>'+
        '<button class="btn mini" data-act="detail" data-uid="'+uid+'">详情</button>'+
        '<button class="btn mini danger" data-act="del" data-uid="'+uid+'">删除</button>'+
        '</div>';
    }
    function rowCells(a){
      return [
        '<input type="checkbox" data-act="sel" data-uid="'+U.esc(a.uid)+'"'+(state.sel[a.uid]?' checked':'')+'>',
        nameCell(a), realmCell(a), poolCell(a), statusCell(a), creditsCell(a),
        expiryCell(a), signinCell(a), productCell(a), errorCell(a), actionsCell(a)
      ];
    }

    /* ── 账号筛选 / 卡片 / 表格 ── */
    function groupNames(){
      const out=[];
      state.rows.forEach(function(a){
        const g=String(a.group||'').trim();
        if(g&&out.indexOf(g)<0) out.push(g);
      });
      out.sort();
      return out;
    }
    function filteredRows(){
      const q=String(state.q||'').trim().toLowerCase();
      return state.rows.filter(function(a){
        if(state.realm!=='all'&&a.realm!==state.realm) return false;
        if(state.pool!=='all'&&(a.poolScope||'text')!==state.pool) return false;
        if(state.group&&(a.group||'')!==state.group) return false;
        if(state.status!=='all'&&acctStatus(a).key!==state.status) return false;
        if(q){
          const hay=[a.nickname,a.uid,a.note,a.group,a.domain,a.product,a.lastError].join(' ').toLowerCase();
          if(hay.indexOf(q)<0) return false;
        }
        return true;
      });
    }
    function selectedRows(){ return filteredRows().filter(function(a){ return !!state.sel[a.uid]; }); }
    function targetRows(){ const s=selectedRows(); return s.length?s:filteredRows(); }
    function clearSel(){ state.sel={}; }
    function cardsHtml(){
      let enabled=0,cn=0,intl=0,text=0,media=0,expired=0,banned=0,cooling=0,apiKeys=0,cached=0,sum=0;
      state.rows.forEach(function(a){
        if(a.enabled) enabled++;
        if(a.realm==='cn') cn++; else if(a.realm==='intl') intl++;
        if(a.poolScope==='media') media++; else text++;
        if(a.tokenExpired||a.needRelogin) expired++;
        if(a.accountBanned) banned++;
        if(a.inCooldown||a.breakerFor||a.degradeFor) cooling++;
        if(a.apiKey) apiKeys++;
        const r=remainOf(a);
        if(r!==null){ cached++; sum+=r; }
      });
      return U.cards([
        {k:'账号总数', v:state.rows.length, n:enabled+' 启用 / '+(state.rows.length-enabled)+' 停用'},
        {k:'已缓存积分', v:U.num(sum), vsmall:'credits', n:cached+' 个账号有积分快照'},
        {k:'文本池 / 媒体池', v:text+' / '+media, n:'就绪 '+numText(state.meta.text_ready||0)+' 文本 · '+numText(state.meta.media_ready||0)+' 媒体'},
        {k:'风险账号', v:expired+banned, n:'凭证过期 '+expired+' · 封禁 '+banned+' · 冷却 '+cooling},
        {k:'国内 / 国际', v:cn+' / '+intl, n:'静态 Key '+apiKeys+' 个'}
      ]);
    }
    function syncGroupSelect(){
      const sel=document.getElementById('wbacc-group');
      if(!sel) return;
      const groups=groupNames();
      if(state.group&&groups.indexOf(state.group)<0) state.group='';
      const sig=groups.join('\n');
      if(sel.getAttribute('data-sig')===sig) return;
      sel.setAttribute('data-sig',sig);
      let html=option('','全部分组','');
      groups.forEach(function(g){ html+=option(g,g,state.group); });
      sel.innerHTML=html;
    }
    function renderSelInfo(){
      const node=document.getElementById('wbacc-selinfo');
      if(!node) return;
      const sel=selectedRows(), filt=filteredRows();
      node.className='pill '+(sel.length?'info':'mute');
      node.textContent=sel.length?('已选 '+sel.length+' 个'):('未选择 · 目标 '+filt.length+' 个');
    }
    function renderTable(){
      if(ctx.stale()) return;
      syncGroupSelect();
      const rows=filteredRows();
      const box=document.getElementById('wbacc-table');
      if(!box) return;
      const table=U.table(
        ['','昵称','域','池','状态','积分','有效期','签到','出站身份','最近错误','操作'],
        rows.map(rowCells),
        {empty:'没有符合条件的账号'}
      );
      box.innerHTML='<div style="overflow-x:auto">'+table+'</div>'+
        '<div class="dim" style="font-size:11px;margin-top:6px">显示 '+rows.length+' / 共 '+state.rows.length+
        ' 个账号 · 最后同步 '+U.esc(state.lastSync||'—')+' · 每 20 秒自动同步</div>';
      renderSelInfo();
    }
    function paint(){
      if(ctx.stale()) return;
      const cards=document.getElementById('wbacc-cards');
      if(cards) cards.innerHTML=cardsHtml();
      renderTable();
    }

    /* ── 数据加载 ── */
    async function pull(){
      const d=await wb.accounts('all');
      return d;
    }
    async function reloadAccounts(silent){
      const d=await pull();
      if(ctx.stale()) return;
      state.rows=d.accounts||[];
      state.meta=d;
      state.lastSync=clock();
      paint();
      if(!silent) U.toast('账号池已刷新','ok');
    }
    async function pollAccounts(){
      if(working||document.hidden) return;
      if(document.getElementById('hub-modal')) return;
      const focus=document.activeElement;
      if(focus&&(focus.tagName==='INPUT'||focus.tagName==='TEXTAREA')) return;
      try{
        const d=await pull();
        if(ctx.stale()) return;
        state.rows=d.accounts||[];
        state.meta=d;
        state.lastSync=clock();
        paint();
      }catch(e){ /* 轮询失败保持旧视图，不打扰 */ }
    }

    /* ── 积分发放记录 ── */
    async function loadGrants(){
      const box=document.getElementById('wbacc-grants');
      if(box) box.innerHTML=U.loadHtml('拉取积分发放记录…');
      try{
        const d=await wb.creditsGrants();
        if(ctx.stale()) return;
        state.grants=d;
        renderGrants();
      }catch(e){
        if(ctx.stale()) return;
        const b=document.getElementById('wbacc-grants');
        if(b) b.innerHTML=sectionError(e,'grants-reload');
      }
    }
    function renderGrants(){
      if(ctx.stale()) return;
      const box=document.getElementById('wbacc-grants');
      if(!box) return;
      const d=state.grants;
      if(!d){ box.innerHTML=U.loadHtml('拉取积分发放记录…'); return; }
      const s=d.summary||{};
      const all=d.rows||[];
      const rows=all.filter(function(r){ return state.grantRealm==='all'||r.realm===state.grantRealm; });
      const shown=rows.slice(0,state.grantLimit);
      const head='<div class="toolbar">'+
        '<span class="pill mute">快照 '+U.esc(fmtFull(d.generated_iso))+'</span>'+
        '<span class="pill mute">最近拉取 '+U.esc(d.fetched_iso?fmtFull(d.fetched_iso):'—')+'</span>'+
        '<span class="pill info">共 '+numText(s.count||0)+' 包</span>'+
        '<span class="pill mute">面额 '+numText(s.size||0)+'</span>'+
        '<span class="pill ok">剩余 '+numText(s.remain||0)+'</span>'+
        '<span class="pill warn">已用 '+numText(s.used||0)+'</span>'+
        '<span class="pill mute">'+numText(s.accounts||0)+' 个账号</span>'+
        '<span class="dim" style="font-size:11px">当前 '+U.esc(state.grantRealm==='all'?'全部域':realmLabel(state.grantRealm))+' 显示 '+rows.length+' 行</span>'+
        '</div>';
      const table=U.table(
        ['发放时间','账号','域','积分包','面额','剩余','已用','到期','状态','关联动作'],
        shown.map(function(r){
          const st=GRANT_STATUS[r.status]||[r.status||'—','mute'];
          let pkg=U.esc(r.name||'—');
          const sub=[r.product,r.grant_reason].filter(Boolean).join(' · ');
          if(sub) pkg+='<div class="dim" style="font-size:10.5px">'+U.esc(trunc(sub,36))+'</div>';
          let expire='—';
          if(r.no_expiry) expire='永久';
          else if(r.expire_iso||r.expire_at){
            expire=U.esc(fmtDate(r.expire_iso||r.expire_at));
            if(r.days_left!==null&&r.days_left!==undefined) expire+='<div class="dim" style="font-size:10.5px">还剩 '+U.esc(String(r.days_left))+' 天</div>';
          }
          let action='<span class="dim">—</span>';
          if(r.action){
            action='<span style="font-size:11px">'+U.esc(taskLabel(r.action.task))+'</span> '+
              (r.action.ok?U.pill('成功','ok'):U.pill('失败','bad'))+
              (typeof r.action.delta_seconds==='number'?'<span class="dim" style="font-size:10.5px"> '+(r.action.delta_seconds>0?'+':'')+r.action.delta_seconds+'s</span>':'');
          }
          return [
            U.esc(fmtShort(r.create_at||r.create_iso)),
            U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>',
            U.esc(r.realm==='cn'?'国内':'国际'),
            pkg,
            '<span class="mono">'+U.esc(numText(r.size))+'</span>',
            '<span class="mono">'+U.esc(numText(r.remain))+'</span>',
            '<span class="mono">'+U.esc(numText(r.used))+'</span>',
            expire,
            U.pill(st[0],st[1]),
            action
          ];
        }),
        {empty:'暂无积分发放记录（可点「刷新积分」拉取最新快照）'}
      );
      let foot='';
      if(rows.length>shown.length){
        foot='<div class="toolbar" style="margin-top:6px"><button class="btn mini" data-act="grants-more">显示全部 '+rows.length+' 行</button>'+
          '<span class="dim" style="font-size:11px">当前仅显示前 '+shown.length+' 行</span></div>';
      }
      box.innerHTML=head+'<div style="overflow-x:auto">'+table+'</div>'+foot;
    }

    /* ── 活动历史 ── */
    async function loadHistory(){
      const box=document.getElementById('wbacc-history');
      if(box) box.innerHTML=U.loadHtml('拉取活动历史…');
      try{
        const d=await wb.activityHistory(state.histRange,200);
        if(ctx.stale()) return;
        state.hist=d;
        renderHistory();
      }catch(e){
        if(ctx.stale()) return;
        const b=document.getElementById('wbacc-history');
        if(b) b.innerHTML=sectionError(e,'hist-reload');
      }
    }
    function renderHistory(){
      if(ctx.stale()) return;
      const box=document.getElementById('wbacc-history');
      if(!box) return;
      const d=state.hist;
      if(!d){ box.innerHTML=U.loadHtml('拉取活动历史…'); return; }
      const rows=d.rows||[];
      const okCount=rows.filter(function(r){ return !!r.ok; }).length;
      const head='<div class="toolbar">'+
        '<span class="pill mute">共 '+numText(d.total||0)+' 条</span>'+
        '<span class="pill info">'+U.esc(RANGE_LABEL[state.histRange]||state.histRange)+'</span>'+
        '<span class="pill ok">成功 '+okCount+'</span>'+
        '<span class="pill bad">失败 '+(rows.length-okCount)+'</span>'+
        '<span class="dim" style="font-size:11px">显示最近 '+rows.length+' 条</span>'+
        '</div>';
      const table=U.table(
        ['时间','账号','域','任务','触发','结果','说明'],
        rows.map(function(r){
          return [
            U.esc(fmtFull(r.ts)),
            U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>',
            U.esc(r.realm==='cn'?'国内':r.realm==='intl'?'国际':'—'),
            U.esc(taskLabel(r.task)),
            U.esc(triggerLabel(r.trigger)),
            r.ok?U.pill('成功','ok'):U.pill('失败','bad'),
            U.esc(r.message||'—')
          ];
        }),
        {empty:'该范围内没有活动记录'}
      );
      box.innerHTML=head+'<div style="overflow-x:auto">'+table+'</div>';
    }

    /* ── 提示 / 忙碌闸 ── */
    function setModalBody(m,html){
      if(!m) return;
      const b=m.querySelector('.modal-body');
      if(b) b.innerHTML=html;
    }
    async function guard(fn){
      if(working){ U.toast('已有操作进行中，请稍候…','warn'); return; }
      working=true;
      try{ await fn(); }
      catch(e){
        if(!ctx.stale()){ U.toast('操作失败：'+errMsg(e),'bad'); paint(); }
      }
      finally{ working=false; }
    }
    function fieldVal(id){
      const n=document.getElementById(id);
      return n?String(n.value||'').trim():'';
    }
    function patchAccount(acc){
      if(!acc) return;
      for(let i=0;i<state.rows.length;i++){
        if(state.rows[i].uid===acc.uid){ state.rows[i]=acc; return; }
      }
      state.rows.push(acc);
    }

    /* ── 单个动作 ── */
    async function setProduct(uid,product){
      const d=await wb.accountsProduct({product:product,uid:uid});
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      paint();
      U.toast('已切换为 '+productLabel(product),'ok');
    }
    async function testOne(uid){
      const a=findRow(uid);
      U.toast('测试中… '+(a?a.nickname:uid.slice(0,8)),'info');
      const d=await wb.accountsTest({uid:uid});
      if(ctx.stale()) return;
      if(d.ok) U.toast('测试通过 · '+(d.elapsed_ms||0)+'ms · '+trunc(d.reply||'OK',60),'ok');
      else U.toast('测试失败 · '+(d.error||('HTTP '+(d.status||'?')))+(d.network?'（本机网络异常）':''),'bad');
      try{ await reloadAccounts(true); }catch(e){}
    }
    async function refreshOne(uid){
      const d=await wb.accountsRefresh([uid]);
      const r=(d.results||[])[0];
      if(!ctx.stale()) U.toast(r&&r.ok?'凭证刷新成功':('凭证刷新失败：'+((r&&r.error)||'未知')),r&&r.ok?'ok':'bad');
      try{ await reloadAccounts(true); }catch(e){}
    }
    async function toggleOne(uid){
      const a=findRow(uid);
      if(!a) return;
      const turningOff=a.enabled;
      if(turningOff&&!window.confirm('停用账号 '+(a.nickname||uid.slice(0,8))+'？停用后不参与调度，任务也会停止。')) return;
      const d=await wb.accountsSet({uid:uid,enabled:!turningOff});
      if(ctx.stale()) return;
      if(d.account) patchAccount(d.account);
      paint();
      U.toast((turningOff?'已停用 ':'已启用 ')+(a.nickname||uid.slice(0,8)),'ok');
    }
    async function deleteOne(uid){
      const a=findRow(uid);
      if(!a) return;
      if(!window.confirm('删除账号「'+(a.nickname||uid.slice(0,8))+'」（uid '+uid.slice(0,12)+'）？\n此操作不可撤销，凭证文件会被删除。')) return;
      const d=await wb.accountsDelete({uid:uid});
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      delete state.sel[uid];
      paint();
      U.toast(d.deleted?'账号已删除':'账号不存在（可能已被移除）',d.deleted?'ok':'warn');
      loadGrants();
    }

    /* ── 批量动作 ── */
    async function bulkSet(enabled){
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可操作的账号','warn'); return; }
      const label=sel.length?('已选 '+list.length+' 个'):('当前筛选的 '+list.length+' 个');
      if(!enabled&&!window.confirm('停用'+label+'账号？停用后不参与调度，任务也会停止。')) return;
      if(enabled&&list.length>20&&!window.confirm('启用'+label+'账号？')) return;
      const d=await wb.accountsSetAll(enabled,list.map(function(a){ return a.uid; }));
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      paint();
      const changed=(d.changed===undefined||d.changed===null)?list.length:d.changed;
      U.toast('已'+(enabled?'启用':'停用')+' '+changed+' 个账号','ok');
    }
    async function bulkRefresh(){
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可刷新的账号','warn'); return; }
      if(!window.confirm('刷新 '+list.length+' 个账号的凭证与昵称？将逐个请求上游。')) return;
      U.toast('凭证刷新中…','info');
      const d=await wb.accountsRefresh(list.map(function(a){ return a.uid; }));
      const results=d.results||[];
      const ok=results.filter(function(r){ return r.ok; }).length;
      try{ await reloadAccounts(true); }catch(e){}
      if(!ctx.stale()) U.toast('凭证刷新完成：'+ok+' / '+results.length+' 成功',ok===results.length?'ok':'warn');
    }
    async function bulkProduct(){
      const selEl=document.getElementById('wbacc-bulk-product');
      const product=selEl?selEl.value:'workbuddy';
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可切换的账号','warn'); return; }
      if((list.length>20||list.length===state.rows.length)&&
         !window.confirm('将把 '+list.length+' 个账号的出站身份切换为 '+productLabel(product)+'，继续？')) return;
      const d=await wb.accountsProduct({product:product,uids:list.map(function(a){ return a.uid; })});
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      paint();
      U.toast('已切换 '+len(d.changed)+' 个账号 → '+productLabel(product),'ok');
    }
    async function refreshCredits(){
      const sel=selectedRows();
      const payload={};
      let label='全池';
      if(sel.length){ payload.uids=sel.map(function(a){ return a.uid; }); label=sel.length+' 个已选账号'; }
      else if(state.realm!=='all'){ payload.realm=state.realm; label=realmLabel(state.realm)+' 全部账号'; }
      if(!window.confirm('刷新积分会向上游逐个查询（有拟人间隔），'+label+'可能耗时较久，继续？')) return;
      U.toast('积分刷新中…','info');
      const d=await wb.accountsCredits(payload);
      if(ctx.stale()) return;
      if(d.busy) U.toast('已有一轮积分刷新在跑，返回的是当前快照','warn');
      else{
        if(d.accounts) state.rows=d.accounts;
        paint();
        U.toast('积分刷新完成','ok');
      }
      loadGrants();
    }
    async function bulkTest(){
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可测试的账号','warn'); return; }
      if(!window.confirm('将逐个测试 '+list.length+' 个账号（含停用账号），可能耗时较久，继续？')) return;
      const m=U.openModal({
        title:'账号测试', wide:true,
        body:U.loadHtml('测试中… 共 '+list.length+' 个账号'),
        actions:[{label:'关闭'}]
      });
      try{
        const d=await wb.accountsTest({uids:list.map(function(a){ return a.uid; })});
        if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
        setModalBody(m,testResultHtml(d));
      }catch(e){
        setModalBody(m,'<div class="empty">测试失败：'+U.esc(errMsg(e))+'</div>');
      }
    }
    function testResultHtml(d){
      const s=d.summary||{};
      const net=d.network||{};
      const rows=(d.results||[]).map(function(r){
        return [
          U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>',
          U.esc(r.realm==='cn'?'国内':'国际'),
          r.ok?U.pill('通过','ok'):U.pill('失败','bad'),
          '<span class="mono">'+(r.elapsed_ms===undefined?'—':U.esc(String(r.elapsed_ms))+' ms')+'</span>',
          U.esc(r.model||'—'),
          U.esc(trunc(r.ok?(r.reply||'OK'):(r.error||('HTTP '+(r.status||'?'))),70))+(r.network?' '+U.pill('本机网络','warn'):'')
        ];
      });
      return U.cards([
        {k:'已测', v:s.tested||0, n:'区域 '+(s.realm==='cn'?'国内':s.realm==='intl'?'国际':'—')},
        {k:'通过', v:s.passed||0},
        {k:'失败', v:s.failed||0},
        {k:'耗时', v:(s.elapsed_ms||0)+' ms', n:s.model||''}
      ])+
      '<div class="toolbar">'+(net.ok?U.pill('本机网络正常','ok'):U.pill('本机网络异常','bad'))+
        '<span class="dim" style="font-size:11px">'+U.esc(net.error||net.detail||('目标 '+(net.host||'—')))+'</span></div>'+
      '<div style="overflow-x:auto">'+U.table(['账号','域','结果','耗时','模型','回复 / 错误'],rows,{empty:'没有可测试的账号'})+'</div>';
    }

    /* ── 详情弹窗 ── */
    function detailHtml(a){
      const c=creditOf(a)||{};
      const rows=[];
      function add(k,v){ rows.push([U.esc(k),v]); }
      add('UID','<span class="mono">'+U.esc(a.uid||'—')+'</span>');
      add('昵称',U.esc(a.nickname||'—'));
      add('域',U.esc(realmLabel(a.realm))+' · <span class="mono">'+U.esc(a.domain||'—')+'</span>');
      add('平台 / 身份',U.esc(a.platform||'—')+' · '+U.esc(productLabel(a.product)));
      add('来源',U.esc(a.source||'—'));
      add('分组',U.esc(a.group||'—'));
      add('池归属',a.poolScope==='media'?'媒体池':'文本池');
      add('权重',U.esc(String(a.weight===undefined||a.weight===null?1:a.weight)));
      add('调度 / 任务',yesno(a.enabled)+' / '+yesno(a.tasksEnabled));
      add('备注',a.note?U.esc(a.note):'—');
      add('凭证',a.apiKey?('静态 Key <span class="mono">'+U.esc(a.credentialMask||'')+'</span>'):'OAuth Token');
      add('刷新令牌 / 设备令牌',yesno(a.hasRefreshToken)+' / '+yesno(a.hasDeviceToken));
      add('代理',a.proxySlot?('槽 '+U.esc(a.proxySlot)):(a.proxy?U.esc(a.proxy):'直连'));
      if(a.enterpriseId) add('企业 ID','<span class="mono">'+U.esc(a.enterpriseId)+'</span>');
      const tier=tierText(a);
      if(tier) add('档位',U.esc(tier));
      const rn=remainOf(a);
      add('积分',rn===null?'未刷新':('<span class="mono">'+U.esc(numText(rn))+'</span> 剩余 / <span class="mono">'+U.esc(numText(c.used))+'</span> 已用 / <span class="mono">'+U.esc(numText(c.size))+'</span> 面额'));
      if(c.updated_iso) add('积分快照',U.esc(fmtFull(c.updated_iso)));
      if(c.earliest_expiring){
        const ep=c.earliest_expiring;
        add('最早到期包',U.esc(ep.name||'—')+' · 剩 <span class="mono">'+U.esc(numText(ep.remain))+'</span> · '+
          U.esc(ep.days_left===null||ep.days_left===undefined?'—':String(ep.days_left)+' 天'));
      }
      if(a.reserveCredits||a.reserveBlocked) add('保底积分',U.esc(String(a.reserveCredits||0))+(a.reserveBlocked?' · <span style="color:var(--danger)">已拦截</span>':''));
      if(a.dailyTokenLimit) add('日 Token 限额',U.esc(String(a.dailyTokenLimit))+' · 今日 '+U.esc(String(a.dailyTokensToday===null||a.dailyTokensToday===undefined?'—':a.dailyTokensToday))+(a.dailyLimitBlocked?' · <span style="color:var(--danger)">已拦截</span>':''));
      if(a.dailyCreditLimit) add('日积分限额',U.esc(String(a.dailyCreditLimit))+' · 今日 '+U.esc(String(a.dailyCreditsToday===null||a.dailyCreditsToday===undefined?'—':a.dailyCreditsToday)));
      add('Token 有效期',a.apiKey?'静态 Key 无过期时间':(a.expiresAt?U.esc(fmtFull(a.expiresAt))+(a.tokenExpired?' · <span style="color:var(--danger)">已过期</span>':''):'—'));
      add('最近签到',U.esc(fmtFull(a.lastCheckin)));
      add('最近每日活跃',U.esc(fmtFull(a.lastDailyChat)));
      add('最近活动上报',U.esc(fmtFull(a.lastActivityReport)));
      add('最近错误',a.lastError?('<span style="color:var(--danger)">'+U.esc(a.lastError)+'</span>'+
        (a.lastErrorDetail?'<div class="dim mono" style="margin-top:2px">'+U.esc(a.lastErrorDetail)+'</div>':'')):'—');
      add('失败计数',U.esc(String(a.fails||0))+' / '+U.esc(String(a.failWindow||'—'))+
        (a.lastFailFor?(' · 最近 '+U.esc(humanLeft(a.lastFailFor))+'前'):''));
      if(a.modelCooldowns&&a.modelCooldowns.length){
        add('模型冷却',a.modelCooldowns.map(function(x){ return U.esc(x.model)+' → '+U.esc(fmtShort(x.expiresAt)); }).join('<br>'));
      }
      if(a.accountBanned) add('封禁',U.pill('上游封禁','bad')+' '+(a.bannedAt?U.esc(fmtFull(a.bannedAt)):''));
      add('文件',U.esc(a.file||'—'));
      return '<div class="toolbar">'+U.pill(acctStatus(a).label,acctStatus(a).kind)+
        U.pill(realmLabel(a.realm),'info')+U.pill(a.poolScope==='media'?'媒体池':'文本池','mute')+
        U.pill(productLabel(a.product),'mute')+'</div>'+
        '<div style="overflow-x:auto">'+U.table(['字段','值'],rows)+'</div>';
    }
    function openDetail(uid){
      const a=findRow(uid);
      if(!a){ U.toast('账号已不在当前列表','warn'); return; }
      U.openModal({
        title:'账号详情 · '+(a.nickname||uid.slice(0,8)),
        wide:true, body:detailHtml(a),
        actions:[
          {label:'刷新凭证',onClick:async function(){
            const d=await wb.accountsRefresh([uid]);
            const r=(d.results||[])[0];
            U.toast(r&&r.ok?'凭证刷新成功':'凭证刷新失败','ok');
            try{ await reloadAccounts(true); }catch(e){}
            return false;
          }},
          {label:'刷新积分',onClick:async function(){
            const d=await wb.accountsCredits({uid:uid});
            if(d.busy) U.toast('已有一轮积分刷新在跑，返回当前快照','warn');
            else{
              if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
              U.toast('积分已刷新','ok');
              loadGrants();
            }
            return false;
          }},
          {label:'关闭'}
        ]
      });
    }

    /* ── 导入文档弹窗 ── */
    function parseDoc(text){
      const s=String(text||'').trim();
      if(!s) throw new Error('请粘贴凭证或导出文档');
      if(s.charAt(0)==='{'||s.charAt(0)==='['){
        try{ return JSON.parse(s); }
        catch(e){ throw new Error('JSON 解析失败：'+e.message); }
      }
      return {accessToken:s};
    }
    async function doImport(dry){
      const ta=document.getElementById('wbacc-import-text');
      if(!ta) throw new Error('弹窗已关闭');
      const doc=parseDoc(ta.value);
      const realm=fieldVal('wbacc-import-realm');
      const group=fieldVal('wbacc-import-group');
      const ov=document.getElementById('wbacc-import-overwrite');
      const overwrite=!!(ov&&ov.checked);
      if(!dry&&overwrite&&!window.confirm('将覆盖 uid 相同的现有账号（用文档里的凭证替换），确定导入？')) return 'stay';
      const payload={data:doc,dryRun:!!dry,overwrite:overwrite};
      if(realm) payload.realm=realm;
      if(group) payload.group=group;
      const d=await wb.accountsImport(payload);
      renderImportPreview(d,dry);
      if(dry) return 'preview';
      if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
      loadGrants();
      const r=d.result||{};
      U.toast('导入完成：新增 '+len(r.added)+' · 覆盖 '+len(r.updated)+' · 跳过 '+len(r.skipped)+' · 无效 '+len(r.invalid),'ok');
      return 'done';
    }
    function renderImportPreview(d,dry){
      const box=document.getElementById('wbacc-import-preview');
      if(!box) return;
      const r=d.result||{};
      const rows=[];
      (r.added||[]).forEach(function(uid){ rows.push([U.pill('新增','ok'),'<span class="mono">'+U.esc(String(uid))+'</span>','—']); });
      (r.updated||[]).forEach(function(uid){ rows.push([U.pill('覆盖','warn'),'<span class="mono">'+U.esc(String(uid))+'</span>','—']); });
      (r.skipped||[]).forEach(function(x){
        rows.push([U.pill('跳过','mute'),'<span class="mono">'+U.esc(String(x.uid||'—'))+'</span>',U.esc(x.reason||'')]);
      });
      (r.invalid||[]).forEach(function(x){
        rows.push([U.pill('无效','bad'),'<span class="mono">#'+U.esc(String(x.index===undefined?'?':x.index))+'</span>',U.esc(x.reason||'')]);
      });
      const shown=rows.slice(0,60);
      const head='<div class="toolbar" style="margin-top:8px">'+
        '<span class="pill info">'+(dry?'预览（未写入）':'已导入')+'</span>'+
        '<span class="pill mute">文档 '+(d.count===undefined?'—':numText(d.count))+' 行</span>'+
        U.pill('新增 '+len(r.added),'ok')+U.pill('覆盖 '+len(r.updated),'warn')+
        U.pill('跳过 '+len(r.skipped),'mute')+U.pill('无效 '+len(r.invalid),'bad')+
        '</div>';
      box.innerHTML=head+(shown.length?
        '<div style="overflow-x:auto">'+U.table(['结果','UID / 序号','原因'],shown)+'</div>':
        '<div class="empty">没有可处理的账号行</div>')+
        (rows.length>shown.length?'<div class="dim" style="font-size:11px;margin-top:4px">仅显示前 60 行，共 '+rows.length+' 行</div>':'');
    }
    function openImport(){
      const body='<p class="sub">支持导出文档、裸数组、单个 accessToken。静态 <span class="mono">ck_/pt_</span> Key 请走「新增 API Key」。'+
        '可先勾选「覆盖」再预览；预览与真实导入共用同一套校验规则。</p>'+
        '<textarea id="wbacc-import-text" rows="10" placeholder=\'{"format":"workbuddy-accounts","accounts":[...]} 或 [{...}] 或 accessToken\' '+
        'style="width:100%;font-family:var(--font-mono);font-size:11.5px"></textarea>'+
        '<div class="toolbar" style="margin-top:8px">'+
        '<label>强制域</label><select id="wbacc-import-realm">'+option('','自动','')+option('cn','国内 cn','')+option('intl','国际 intl','')+'</select>'+
        '<label>分组</label><input id="wbacc-import-group" placeholder="可留空" style="width:140px">'+
        '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="wbacc-import-overwrite"> 覆盖同名账号</label>'+
        '</div><div id="wbacc-import-preview"></div>';
      U.openModal({
        title:'导入账号（粘贴凭证 / 导出文档）', wide:true, body:body,
        actions:[
          {label:'取消'},
          {label:'预览',onClick:async function(){ await doImport(true); return true; }},
          {label:'导入',kind:'pri',onClick:async function(){ const r=await doImport(false); return r!=='done'; }}
        ]
      });
    }

    /* ── 桌面客户端导入弹窗 ── */
    function renderDesktop(m,d){
      const at=d.atrest||{};
      const items=d.detected||[];
      const inPool={};
      (d.pool_uids||[]).forEach(function(uid){ inPool[uid]=true; });
      const rows=items.map(function(it){
        const st=it.valid?U.pill('可导入','ok'):(it.needsKey?U.pill('需解码密钥','warn'):U.pill('不可读','bad'));
        let act='<span class="dim">—</span>';
        if(it.valid){
          act=inPool[it.uid]?U.pill('已在池','mute'):
            '<button class="btn mini" data-dt="path" data-path="'+U.esc(it.path)+'">导入</button>';
        }
        return [
          U.esc(it.file||'—')+'<div class="dim mono" style="font-size:10px" title="'+U.esc(it.path||'')+'">'+U.esc(trunc(it.path||'',48))+'</div>',
          U.esc(it.realm==='cn'?'国内版':'国际版'),
          st,
          U.esc(it.nickname||'—'),
          '<span class="mono">'+U.esc(String(it.uid||'').slice(0,12)||'—')+'</span>',
          U.esc(it.expiresAt?fmtDate(it.expiresAt):'—'),
          U.esc(trunc(it.error||'',40)),
          act
        ];
      });
      let html='<div class="toolbar">'+
        '<button class="btn mini" data-dt="scan">重新扫描</button>'+
        '<button class="btn mini" data-dt="all">导入扫描到的全部</button>'+
        (at.huntSupported?'<button class="btn mini" data-dt="recover">从进程回收密钥</button>':'')+
        (at.keyCached?U.pill('解码密钥已缓存','ok'):U.pill('未缓存解码密钥','mute'))+
        '<span class="pill mute">平台 '+U.esc(at.platform||'—')+'</span>'+
        '</div>';
      if(!at.huntSupported&&at.huntHint) html+='<div class="dim" style="font-size:11.5px">'+U.esc(at.huntHint)+'</div>';
      if(at.error) html+='<div class="dim" style="font-size:11.5px;color:var(--danger)">'+U.esc(at.error)+'</div>';
      if(at.keyId) html+='<div class="dim mono" style="font-size:11px">keyId '+U.esc(at.keyId)+'</div>';
      html+='<div style="overflow-x:auto;margin-top:8px">'+
        U.table(['文件','域','状态','昵称','UID','有效期','错误','操作'],rows,{empty:'本机未发现桌面客户端凭据（或未安装）'})+
        '</div>'+
        '<details style="margin-top:12px"><summary class="dim" style="cursor:pointer">凭据已加密？手工导入解码密钥 / 清除内存密钥</summary>'+
        '<p class="dim" style="font-size:11.5px">macOS / Linux 无法从进程回收时，可粘贴一次 at-rest 解码密钥；密钥只留在网关内存，不落盘。</p>'+
        '<textarea id="wbacc-atrest-key" rows="3" style="width:100%;font-family:var(--font-mono)" placeholder="at-rest 解码密钥"></textarea>'+
        '<div class="toolbar" style="margin-top:8px">'+
        '<button class="btn mini" data-dt="keytext">导入解码密钥</button>'+
        '<button class="btn mini danger" data-dt="forget">清除内存密钥</button>'+
        '</div></details>';
      setModalBody(m,html);
    }
    async function scanDesktop(m,silent){
      if(!silent) setModalBody(m,U.loadHtml('扫描中…'));
      try{
        const d=await wb.accountsImportDesktop({});
        renderDesktop(m,d);
      }catch(e){
        setModalBody(m,'<div class="empty">扫描失败：'+U.esc(errMsg(e))+'</div>');
      }
    }
    async function importDesktopAll(m){
      if(!window.confirm('导入扫描到的全部桌面凭据？可读且有效的凭据会被加入账号池。')) return;
      const d=await wb.accountsImportDesktop({all:true});
      const n=len(d.imported);
      U.toast('已导入 '+n+' 个桌面凭据',n?'ok':'warn');
      if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
      loadGrants();
      scanDesktop(m,false);
    }
    async function importDesktopPath(m,path){
      const d=await wb.accountsImportDesktop({path:path});
      const a=(d.imported||[])[0];
      U.toast('已导入 '+(a?(a.nickname||String(a.uid||'').slice(0,8)):'1 个凭据'),'ok');
      if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
      loadGrants();
      scanDesktop(m,false);
    }
    async function atrestOp(m,payload){
      const d=await wb.accountsImportDesktop(payload);
      if(d.ok===false) U.toast(d.msg||'操作失败','bad');
      else U.toast(d.msg||'完成','ok');
      scanDesktop(m,false);
    }
    function openDesktop(){
      const m=U.openModal({
        title:'从桌面客户端导入', wide:true,
        body:U.loadHtml('扫描本机桌面客户端凭据…'),
        actions:[{label:'关闭'}]
      });
      m.addEventListener('click',function(ev){
        const b=ev.target.closest('[data-dt]');
        if(!b) return;
        const op=b.getAttribute('data-dt');
        (async function(){
          try{
            if(op==='scan') await scanDesktop(m,false);
            else if(op==='all') await importDesktopAll(m);
            else if(op==='recover') await atrestOp(m,{recoverKey:true});
            else if(op==='forget') await atrestOp(m,{forgetKey:true});
            else if(op==='keytext') await atrestOp(m,{keyText:fieldVal('wbacc-atrest-key')});
            else if(op==='path') await importDesktopPath(m,b.getAttribute('data-path'));
          }catch(e){ U.toast('操作失败：'+errMsg(e),'bad'); }
        })();
      });
      scanDesktop(m,true);
    }

    /* ── 新增静态 API Key 弹窗 ── */
    function openApiKey(){
      const body='<p class="sub">CodeBuddy 平台签发的静态 Key（<span class="mono">ck_</span>/<span class="mono">pt_</span> 前缀）。'+
        '后端会先打一次企业额度端点探测，失败不会落盘。</p>'+
        '<div class="dim" style="font-size:11.5px;margin-bottom:4px">API Key</div>'+
        '<input id="wbacc-new-key" type="password" autocomplete="off" placeholder="ck_... 或 pt_..." style="width:100%;margin-bottom:8px">'+
        '<div class="dim" style="font-size:11.5px;margin-bottom:4px">昵称（可留空）</div>'+
        '<input id="wbacc-new-nick" placeholder="例如 企业号-A" style="width:100%;margin-bottom:8px">'+
        '<div class="dim" style="font-size:11.5px;margin-bottom:4px">UID（Key 无法推导时必填）</div>'+
        '<input id="wbacc-new-uid" placeholder="可留空" style="width:100%">';
      U.openModal({
        title:'新增静态 API Key 账号', body:body,
        actions:[
          {label:'取消'},
          {label:'添加',kind:'pri',onClick:async function(){
            const key=fieldVal('wbacc-new-key');
            if(!key) throw new Error('请粘贴 API Key');
            const payload={key:key};
            const nick=fieldVal('wbacc-new-nick');
            const uid=fieldVal('wbacc-new-uid');
            if(nick) payload.nickname=nick;
            if(uid) payload.uid=uid;
            const d=await wb.accountsAddApiKey(payload);
            try{ await reloadAccounts(true); }catch(e){}
            loadGrants();
            if(!ctx.stale()) U.toast('已添加 '+(d.nickname||String(d.uid||'').slice(0,8))+(d.updated?'（覆盖原有账号）':''),'ok');
            return false;
          }}
        ]
      });
    }

    /* ── 事件分发 ── */
    function onPageClick(ev){
      const t=ev.target.closest('[data-act]');
      if(!t||!el.contains(t)) return;
      const act=t.getAttribute('data-act');
      const uid=t.getAttribute('data-uid')||'';
      if(act==='selall'){
        filteredRows().forEach(function(a){ state.sel[a.uid]=true; });
        renderTable();
        return;
      }
      if(act==='selnone'){ clearSel(); renderTable(); return; }
      if(act==='reload'){ guard(function(){ return reloadAccounts(false); }); return; }
      if(act==='bulk-enable'){ guard(function(){ return bulkSet(true); }); return; }
      if(act==='bulk-disable'){ guard(function(){ return bulkSet(false); }); return; }
      if(act==='bulk-refresh'){ guard(bulkRefresh); return; }
      if(act==='bulk-test'){ guard(bulkTest); return; }
      if(act==='bulk-product'){ guard(bulkProduct); return; }
      if(act==='credits-refresh'){ guard(refreshCredits); return; }
      if(act==='import-open'){ openImport(); return; }
      if(act==='desktop-open'){ openDesktop(); return; }
      if(act==='apikey-open'){ openApiKey(); return; }
      if(act==='grants-reload'){ loadGrants(); return; }
      if(act==='grants-more'){ state.grantLimit=100000; renderGrants(); return; }
      if(act==='hist-reload'){ loadHistory(); return; }
      if(act==='test'){ guard(function(){ return testOne(uid); }); return; }
      if(act==='refresh'){ guard(function(){ return refreshOne(uid); }); return; }
      if(act==='toggle'){ guard(function(){ return toggleOne(uid); }); return; }
      if(act==='detail'){ openDetail(uid); return; }
      if(act==='del'){ guard(function(){ return deleteOne(uid); }); return; }
    }
    function onPageChange(ev){
      const f=ev.target.closest('[data-filter]');
      if(f){
        const name=f.getAttribute('data-filter');
        const value=f.value;
        if(name==='grantRealm'){
          state.grantRealm=value;
          state.grantLimit=120;
          renderGrants();
          return;
        }
        if(name==='histRange'){
          state.histRange=value;
          loadHistory();
          return;
        }
        if(name==='q') state.q=value; else state[name]=value;
        clearSel();
        renderTable();
        return;
      }
      const a=ev.target.closest('[data-act]');
      if(!a) return;
      const act=a.getAttribute('data-act');
      if(act==='sel'){
        const uid=a.getAttribute('data-uid');
        if(a.checked) state.sel[uid]=true; else delete state.sel[uid];
        renderSelInfo();
        return;
      }
      if(act==='product'){
        const uid=a.getAttribute('data-uid');
        const product=a.value;
        guard(function(){ return setProduct(uid,product); });
      }
    }
    function onPageInput(ev){
      const f=ev.target.closest('[data-filter="q"]');
      if(!f) return;
      state.q=f.value;
      clearSel();
      renderTable();
    }

    /* ── 首屏 ── */
    try{
      const d=await pull();
      if(ctx.stale()) return;
      state.rows=d.accounts||[];
      state.meta=d;
      state.lastSync=clock();
    }catch(e){
      if(ctx.stale()) return;
      el.innerHTML=U.errHtml(e);
      return;
    }

    const storage=String(state.meta.storage||'—');
    el.innerHTML='<h1>账号池</h1>'+
      '<p class="sub">WB 全量账号 · 存储 <span class="mono" title="'+U.esc(storage)+'">'+U.esc(trunc(storage,64))+'</span>'+
      ' · 文本就绪 <span class="mono">'+U.esc(numText(state.meta.text_ready||0))+'</span>'+
      ' · 媒体就绪 <span class="mono">'+U.esc(numText(state.meta.media_ready||0))+'</span></p>'+
      '<div id="wbacc-cards"></div>'+
      '<div class="toolbar">'+
        '<input id="wbacc-q" data-filter="q" placeholder="搜索昵称 / uid / 备注 / 错误" value="'+U.esc(state.q)+'" style="min-width:240px">'+
        '<label>域</label><select data-filter="realm">'+option('all','全部','all')+option('cn','国内 cn','all')+option('intl','国际 intl','all')+'</select>'+
        '<label>状态</label><select data-filter="status">'+
          option('all','全部','all')+option('ok','正常','all')+option('error','异常','all')+
          option('cooldown','冷却 / 熔断','all')+option('disabled','已停用','all')+
          option('expired','凭证过期','all')+option('banned','封禁','all')+'</select>'+
        '<label>池</label><select data-filter="pool">'+option('all','全部','all')+option('text','文本池','all')+option('media','媒体池','all')+'</select>'+
        '<label>分组</label><select id="wbacc-group" data-filter="group">'+option('','全部分组','')+'</select>'+
        '<button class="btn mini" data-act="reload">刷新列表</button>'+
      '</div>'+
      '<div class="toolbar">'+
        '<span class="pill mute" id="wbacc-selinfo">未选择</span>'+
        '<button class="btn mini" data-act="selall">全选筛选结果</button>'+
        '<button class="btn mini" data-act="selnone">清空选择</button>'+
        '<button class="btn mini pri" data-act="bulk-enable">批量启用</button>'+
        '<button class="btn mini danger" data-act="bulk-disable">批量停用</button>'+
        '<button class="btn mini" data-act="bulk-refresh">批量刷新凭证</button>'+
        '<button class="btn mini" data-act="bulk-test">批量测试</button>'+
        '<label>身份</label><select id="wbacc-bulk-product">'+option('workbuddy',PRODUCTS.workbuddy,'workbuddy')+option('cli',PRODUCTS.cli,'workbuddy')+option('vscode',PRODUCTS.vscode,'workbuddy')+'</select>'+
        '<button class="btn mini" data-act="bulk-product">应用身份</button>'+
        '<button class="btn mini" data-act="credits-refresh">刷新积分</button>'+
        '<button class="btn mini" data-act="import-open">导入</button>'+
        '<button class="btn mini" data-act="desktop-open">桌面导入</button>'+
        '<button class="btn mini" data-act="apikey-open">新增 API Key</button>'+
      '</div>'+
      '<div id="wbacc-table"></div>'+
      '<h2>积分发放记录</h2>'+
      '<p class="sub">只读快照：积分由上游的任务 / 签到发放，面板不能手工授予；这里展示每次发放（grant）与关联动作，刷新只更新快照。</p>'+
      '<div class="toolbar">'+
        '<label>域</label><select data-filter="grantRealm">'+option('all','全部','all')+option('cn','国内 cn','all')+option('intl','国际 intl','all')+'</select>'+
        '<button class="btn mini" data-act="grants-reload">重新载入快照</button>'+
        '<button class="btn mini" data-act="credits-refresh">刷新积分</button>'+
        '<span class="dim" style="font-size:11px">只读内存快照，不发上游请求</span>'+
      '</div>'+
      '<div id="wbacc-grants">'+U.loadHtml('拉取积分发放记录…')+'</div>'+
      '<h2>活动历史</h2>'+
      '<p class="sub">签到 / 每日活跃的真实尝试记录（最近在前），可按时间范围筛选。</p>'+
      '<div class="toolbar">'+
        '<label>范围</label><select data-filter="histRange">'+
          option('today',RANGE_LABEL.today,'7d')+option('1d',RANGE_LABEL['1d'],'7d')+option('7d',RANGE_LABEL['7d'],'7d')+
          option('30d',RANGE_LABEL['30d'],'7d')+option('90d',RANGE_LABEL['90d'],'7d')+option('all',RANGE_LABEL.all,'7d')+'</select>'+
        '<button class="btn mini" data-act="hist-reload">刷新</button>'+
      '</div>'+
      '<div id="wbacc-history">'+U.loadHtml('拉取活动历史…')+'</div>';

    el.addEventListener('click',onPageClick);
    el.addEventListener('change',onPageChange);
    el.addEventListener('input',onPageInput);

    paint();
    loadGrants();
    loadHistory();
    ctx.poll(pollAccounts,20000);
  }
});
