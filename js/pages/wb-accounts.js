/* 页面：账号池 —— 全量账号表 / 筛选 / 排序 / 启停 / 身份切换 / 凭证与积分刷新 / 导入 / 活动历史
 *
 * 组件层重构结构：
 *   1) state     —— 筛选 / 排序 / 选中 / 分区数据的单一事实源
 *   2) StatCards —— HUB.components.statCards 渲染概览指标
 *   3) FilterBar —— HUB.components.filterBar 渲染全部筛选（账号域/状态/池/分组、批量身份、发放域、历史范围、导入强制域）
 *   4) DataTable —— HUB.components.dataTable 渲染账号表（行动作）及其余全部列表
 *   5) shell     —— HUB.shell 管理标题 / 工具栏 / 内容区 / 轮询 / 事件监听生命周期
 * 契约：只经 HUB.api.wb.* 取数（禁止裸 fetch）；颜色只用 var(--…) 令牌；全量中文文案。 */
HUB.register({
  route:'wb-accounts', group:'wb', title:'账号池', order:10,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, wb=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. state：筛选 / 排序 / 选中 / 分区数据 ═══ */
    const state={
      realm:'all', status:'all', pool:'all', group:'', q:'',
      sortKey:'', sortDir:'asc',
      sel:{}, rows:[], meta:{}, lastSync:'',
      grants:null, grantRealm:'all', grantLimit:120,
      hist:null, histRange:'7d',
      bulkProduct:'workbuddy', importRealm:''
    };
    let working=false, groupSig=null;
    let fbar=null, pbar=null, gbar=null, hbar=null;
    let statBox=null, tableBox=null, tableFoot=null, selInfo=null, grantsBox=null, histBox=null;

    /* ═══ 2. 常量 ═══ */
    const PRODUCT_OPTS=[
      {value:'cli',label:'CLI'},{value:'workbuddy',label:'WorkBuddy'},{value:'vscode',label:'VSCode'}
    ];
    const GRANT_STATUS={
      active:['扣减中','ok'], available:['可用','info'],
      used_up:['已用完','mute'], expired:['已过期','bad']
    };
    const RANGE_LABEL={today:'今天', '1d':'24 小时', '7d':'7 天', '30d':'30 天', '90d':'90 天', all:'全部'};
    const REALM_OPTS=[{value:'all',label:'全部'},{value:'cn',label:'国内 cn'},{value:'intl',label:'国际 intl'}];
    const STATUS_OPTS=[
      {value:'all',label:'全部'},{value:'ok',label:'正常'},{value:'error',label:'异常'},
      {value:'cooldown',label:'冷却 / 熔断'},{value:'disabled',label:'已停用'},
      {value:'expired',label:'凭证过期'},{value:'banned',label:'封禁'}
    ];
    const POOL_OPTS=[{value:'all',label:'全部'},{value:'text',label:'文本池'},{value:'media',label:'媒体池'}];
    const HIST_OPTS=Object.keys(RANGE_LABEL).map(k=>({value:k,label:RANGE_LABEL[k]}));
    const IMPORT_REALM_OPTS=[{value:'',label:'自动'},{value:'cn',label:'国内 cn'},{value:'intl',label:'国际 intl'}];
    const TEXT_SORT={nickname:1, realm:1, pool:1, status:1};

    /* ═══ 3. 格式化工具 ═══ */
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
    function realmLabel(r){ return r==='cn'?'国内版':r==='intl'?'国际版':(r||'—'); }
    function productLabel(p){
      const k=String(p||'workbuddy').toLowerCase();
      const o=PRODUCT_OPTS.find(x=>x.value===k);
      return o?o.label:k;
    }
    function taskLabel(t){
      if(t==='checkin') return '签到';
      if(t==='daily_chat') return '每日活跃';
      return t||'—';
    }
    function triggerLabel(t){
      const map={scheduler:'调度器',manual:'手动',account_add:'新增账号',account_import:'导入',unknown:'未知'};
      return map[t]||t||'—';
    }
    function yesno(b){ return b?U.pill('是','ok'):U.pill('否','mute'); }

    /* ═══ 4. 账号字段辅助 ═══ */
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

    /* ═══ 5. 筛选 / 排序 / 选中（全部读写 state） ═══ */
    function groupNames(){
      const out=[];
      state.rows.forEach(a=>{
        const g=String(a.group||'').trim();
        if(g&&out.indexOf(g)<0) out.push(g);
      });
      out.sort();
      return out;
    }
    function filteredRows(){
      const q=String(state.q||'').trim().toLowerCase();
      return state.rows.filter(a=>{
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
    function sortVal(a,key){
      switch(key){
        case 'nickname': return String(a.nickname||a.uid||'').toLowerCase();
        case 'realm': return a.realm||'';
        case 'pool': return a.poolScope||'text';
        case 'status': return acctStatus(a).key;
        case 'remain': { const n=remainOf(a); return n===null?-1:n; }
        case 'expire': return a.apiKey?Number.MAX_SAFE_INTEGER:(Number(a.expiresAt)||0);
        case 'signin': return Math.max(parseTime(a.lastCheckin)||0, parseTime(a.lastDailyChat)||0);
        default: return '';
      }
    }
    function sortedRows(){
      const rows=filteredRows();
      if(!state.sortKey) return rows;
      const key=state.sortKey, dir=state.sortDir==='asc'?1:-1;
      return rows.slice().sort((x,y)=>{
        const vx=sortVal(x,key), vy=sortVal(y,key);
        return (vx<vy?-1:vx>vy?1:0)*dir;
      });
    }
    function selectedRows(){ return filteredRows().filter(a=>!!state.sel[a.uid]); }
    function targetRows(){ const s=selectedRows(); return s.length?s:filteredRows(); }
    function clearSel(){ state.sel={}; }

    /* ═══ 6. 账号表单元格 ═══ */
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
      const c=creditOf(a);
      const ci=c?c.checkin:null;
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
      const cur=String(a.product||'workbuddy').toLowerCase();
      return '<select data-product="1" data-uid="'+U.esc(a.uid)+'" title="切换出站身份（product）" style="padding:3px 6px;font-size:11px">'+
        PRODUCT_OPTS.map(o=>'<option value="'+U.esc(o.value)+'"'+(o.value===cur?' selected':'')+'>'+U.esc(o.label)+'</option>').join('')+
        '</select>';
    }

    /* ═══ 7. DataTable 列定义 ═══ */
    /* 账号表：下标与 ACC_COLUMNS 对齐，'' 表示该列不可排序 */
    const SORT_KEYS=['','nickname','realm','pool','status','remain','expire','signin','',''];
    const ACC_COLUMNS=[
      {key:'sel', label:'', render:(v,a)=>'<input type="checkbox" data-sel="1" data-uid="'+U.esc(a.uid)+'"'+(state.sel[a.uid]?' checked':'')+'>'},
      {key:'nickname', label:'昵称', render:(v,a)=>nameCell(a)},
      {key:'realm', label:'域', render:(v,a)=>realmCell(a)},
      {key:'pool', label:'池', render:(v,a)=>poolCell(a)},
      {key:'status', label:'状态', render:(v,a)=>statusCell(a)},
      {key:'credits', label:'积分', render:(v,a)=>creditsCell(a)},
      {key:'expiresAt', label:'有效期', render:(v,a)=>expiryCell(a)},
      {key:'signin', label:'签到', render:(v,a)=>signinCell(a)},
      {key:'product', label:'出站身份', render:(v,a)=>productCell(a)},
      {key:'lastError', label:'最近错误', render:(v,a)=>errorCell(a)}
    ];
    function expireHtml(r){
      if(r.no_expiry) return '永久';
      if(r.expire_iso||r.expire_at){
        let h=U.esc(fmtDate(r.expire_iso||r.expire_at));
        if(r.days_left!==null&&r.days_left!==undefined) h+='<div class="dim" style="font-size:10.5px">还剩 '+U.esc(String(r.days_left))+' 天</div>';
        return h;
      }
      return '—';
    }
    function grantActionHtml(r){
      if(!r.action) return '<span class="dim">—</span>';
      return '<span style="font-size:11px">'+U.esc(taskLabel(r.action.task))+'</span> '+
        (r.action.ok?U.pill('成功','ok'):U.pill('失败','bad'))+
        (typeof r.action.delta_seconds==='number'?'<span class="dim" style="font-size:10.5px"> '+(r.action.delta_seconds>0?'+':'')+r.action.delta_seconds+'s</span>':'');
    }
    const GRANT_COLUMNS=[
      {key:'t', label:'发放时间', render:(v,r)=>U.esc(fmtShort(r.create_at||r.create_iso))},
      {key:'nickname', label:'账号', render:(v,r)=>U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>'},
      {key:'realm', label:'域', render:(v,r)=>U.esc(r.realm==='cn'?'国内':'国际')},
      {key:'name', label:'积分包', render:(v,r)=>{
        let pkg=U.esc(r.name||'—');
        const sub=[r.product,r.grant_reason].filter(Boolean).join(' · ');
        if(sub) pkg+='<div class="dim" style="font-size:10.5px">'+U.esc(trunc(sub,36))+'</div>';
        return pkg;
      }},
      {key:'size', label:'面额', render:(v,r)=>'<span class="mono">'+U.esc(numText(r.size))+'</span>'},
      {key:'remain', label:'剩余', render:(v,r)=>'<span class="mono">'+U.esc(numText(r.remain))+'</span>'},
      {key:'used', label:'已用', render:(v,r)=>'<span class="mono">'+U.esc(numText(r.used))+'</span>'},
      {key:'expire', label:'到期', render:(v,r)=>expireHtml(r)},
      {key:'status', label:'状态', render:(v,r)=>{ const st=GRANT_STATUS[r.status]||[r.status||'—','mute']; return U.pill(st[0],st[1]); }},
      {key:'action', label:'关联动作', render:(v,r)=>grantActionHtml(r)}
    ];
    const HIST_COLUMNS=[
      {key:'ts', label:'时间', render:(v,r)=>U.esc(fmtFull(r.ts))},
      {key:'nickname', label:'账号', render:(v,r)=>U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>'},
      {key:'realm', label:'域', render:(v,r)=>U.esc(r.realm==='cn'?'国内':r.realm==='intl'?'国际':'—')},
      {key:'task', label:'任务', render:(v,r)=>U.esc(taskLabel(r.task))},
      {key:'trigger', label:'触发', render:(v,r)=>U.esc(triggerLabel(r.trigger))},
      {key:'ok', label:'结果', render:(v,r)=>r.ok?U.pill('成功','ok'):U.pill('失败','bad')},
      {key:'message', label:'说明', render:(v,r)=>U.esc(r.message||'—')}
    ];
    const TEST_COLUMNS=[
      {key:'nickname', label:'账号', render:(v,r)=>U.esc(r.nickname||'—')+'<div class="dim mono" style="font-size:10px">'+U.esc(String(r.uid||'').slice(0,10))+'</div>'},
      {key:'realm', label:'域', render:(v,r)=>U.esc(r.realm==='cn'?'国内':'国际')},
      {key:'ok', label:'结果', render:(v,r)=>r.ok?U.pill('通过','ok'):U.pill('失败','bad')},
      {key:'elapsed_ms', label:'耗时', render:(v,r)=>'<span class="mono">'+(r.elapsed_ms===undefined?'—':U.esc(String(r.elapsed_ms))+' ms')+'</span>'},
      {key:'model', label:'模型', render:(v,r)=>U.esc(r.model||'—')},
      {key:'detail', label:'回复 / 错误', render:(v,r)=>U.esc(trunc(r.ok?(r.reply||'OK'):(r.error||('HTTP '+(r.status||'?'))),70))+(r.network?' '+U.pill('本机网络','warn'):'')}
    ];
    const PREVIEW_COLUMNS=[
      {key:'st', label:'结果', render:v=>v},
      {key:'id', label:'UID / 序号', render:v=>v},
      {key:'reason', label:'原因', render:v=>v}
    ];
    const DETAIL_COLUMNS=[
      {key:'k', label:'字段', render:v=>U.esc(v)},
      {key:'v', label:'值', render:v=>v}
    ];

    /* ═══ 8. 布局（shell 结构，只建一次；后续只更新持久盒子） ═══ */
    function buildLayout(){
      const bar=shell.toolbar();
      bar.innerHTML=
        '<div class="toolbar">'+
          '<input id="wbacc-q" placeholder="搜索昵称 / uid / 备注 / 错误" value="'+U.esc(state.q)+'" style="min-width:240px">'+
          '<span id="wbacc-fbar"></span>'+
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
          '<span id="wbacc-pbar"></span>'+
          '<button class="btn mini" data-act="bulk-product">应用身份</button>'+
          '<button class="btn mini" data-act="credits-refresh">刷新积分</button>'+
          '<button class="btn mini" data-act="import-open">导入</button>'+
          '<button class="btn mini" data-act="desktop-open">桌面导入</button>'+
          '<button class="btn mini" data-act="apikey-open">新增 API Key</button>'+
        '</div>';
      const c=shell.content();
      c.innerHTML=
        '<div id="wbacc-cards"></div>'+
        '<div id="wbacc-table" style="overflow-x:auto"></div>'+
        '<div class="dim" id="wbacc-tfoot" style="font-size:11px;margin-top:6px"></div>'+
        '<h2>积分发放记录</h2>'+
        '<p class="sub">只读快照：积分由上游的任务 / 签到发放，面板不能手工授予；这里展示每次发放（grant）与关联动作，刷新只更新快照。</p>'+
        '<div class="toolbar">'+
          '<span id="wbacc-gbar"></span>'+
          '<button class="btn mini" data-act="grants-reload">重新载入快照</button>'+
          '<button class="btn mini" data-act="credits-refresh">刷新积分</button>'+
          '<span class="dim" style="font-size:11px">只读内存快照，不发上游请求</span>'+
        '</div>'+
        '<div id="wbacc-grants"></div>'+
        '<h2>活动历史</h2>'+
        '<p class="sub">签到 / 每日活跃的真实尝试记录（最近在前），可按时间范围筛选。</p>'+
        '<div class="toolbar">'+
          '<span id="wbacc-hbar"></span>'+
          '<button class="btn mini" data-act="hist-reload">刷新</button>'+
        '</div>'+
        '<div id="wbacc-history"></div>';
      statBox=c.querySelector('#wbacc-cards');
      tableBox=c.querySelector('#wbacc-table');
      tableFoot=c.querySelector('#wbacc-tfoot');
      selInfo=bar.querySelector('#wbacc-selinfo');
      fbar=bar.querySelector('#wbacc-fbar');
      pbar=bar.querySelector('#wbacc-pbar');
      gbar=c.querySelector('#wbacc-gbar');
      hbar=c.querySelector('#wbacc-hbar');
      grantsBox=c.querySelector('#wbacc-grants');
      histBox=c.querySelector('#wbacc-history');
    }

    /* ═══ 9. FilterBar 装配 ═══ */
    function accountFilters(){
      return [
        {key:'realm', label:'域', options:REALM_OPTS},
        {key:'status', label:'状态', options:STATUS_OPTS},
        {key:'pool', label:'池', options:POOL_OPTS},
        {key:'group', label:'分组', options:[{value:'',label:'全部分组'}].concat(groupNames().map(g=>({value:g,label:g})))}
      ];
    }
    function onFilterChange(){
      clearSel();
      paintTable();
    }
    function mountFilterBars(){
      C.filterBar(fbar, accountFilters(), state, onFilterChange);
      groupSig=groupNames().join('\n');
      C.filterBar(pbar, [{key:'bulkProduct',label:'身份',options:PRODUCT_OPTS}], state, ()=>{});
      C.filterBar(gbar, [{key:'grantRealm',label:'域',options:REALM_OPTS}], state, ()=>{ state.grantLimit=120; renderGrants(); });
      C.filterBar(hbar, [{key:'histRange',label:'范围',options:HIST_OPTS}], state, ()=>loadHistory());
    }
    /* 分组集合变化时重建账号筛选栏（select 值始终由 state 驱动） */
    function syncFilters(){
      if(!fbar) return;
      const groups=groupNames();
      if(state.group&&groups.indexOf(state.group)<0) state.group='';
      const sig=groups.join('\n');
      if(groupSig===sig) return;
      groupSig=sig;
      C.filterBar(fbar, accountFilters(), state, onFilterChange);
    }

    /* ═══ 10. 视图渲染 ═══ */
    function paint(){
      if(!shell.alive) return;
      paintCards();
      paintTable();
    }
    function paintCards(){
      let enabled=0,cn=0,intl=0,text=0,media=0,expired=0,banned=0,cooling=0,apiKeys=0,cached=0,sum=0;
      state.rows.forEach(a=>{
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
      C.statCards(statBox,[
        {label:'账号总数', value:state.rows.length, sub:U.esc(enabled+' 启用 / '+(state.rows.length-enabled)+' 停用')},
        {label:'已缓存积分', value:U.num(sum), sub:U.esc(cached+' 个账号有积分快照')},
        {label:'文本池 / 媒体池', value:text+' / '+media, sub:U.esc('就绪 '+numText(state.meta.text_ready||0)+' 文本 · '+numText(state.meta.media_ready||0)+' 媒体')},
        {label:'风险账号', value:expired+banned, sub:U.esc('凭证过期 '+expired+' · 封禁 '+banned+' · 冷却 '+cooling)},
        {label:'国内 / 国际', value:cn+' / '+intl, sub:U.esc('静态 Key '+apiKeys+' 个')}
      ]);
    }
    function rowActions(a){
      const uid=String(a.uid||'');
      return [
        {label:'测试', onClick:()=>guard(()=>testOne(uid))},
        {label:'刷新', onClick:()=>guard(()=>refreshOne(uid))},
        {label:a.enabled?'停用':'启用', onClick:()=>guard(()=>toggleOne(uid))},
        {label:'详情', onClick:()=>openDetail(uid)},
        {label:'删除', kind:'danger', onClick:()=>guard(()=>deleteOne(uid))}
      ];
    }
    function paintTable(){
      if(!shell.alive||!tableBox) return;
      syncFilters();
      const rows=sortedRows();
      C.dataTable(tableBox,{
        columns:ACC_COLUMNS, rows:rows, rowKey:'uid',
        actions:rowActions, emptyText:'没有符合条件的账号'
      });
      markSortHead();
      tableFoot.textContent='显示 '+rows.length+' / 共 '+state.rows.length+' 个账号 · 最后同步 '+(state.lastSync||'—')+' · 每 20 秒自动同步 · 点击表头可排序';
      paintSelInfo();
    }
    /* 表头排序指示：dataTable 的 th 与 ACC_COLUMNS 按下标一一对应 */
    function markSortHead(){
      const ths=tableBox.querySelectorAll('thead th');
      ths.forEach((th,i)=>{
        const key=SORT_KEYS[i];
        if(!key) return;
        const lbl=ACC_COLUMNS[i].label;
        th.textContent=lbl+(state.sortKey===key?(state.sortDir==='asc'?' ▲':' ▼'):'');
        th.title='点击按「'+lbl+'」排序';
        th.style.cursor='pointer';
      });
    }
    function paintSelInfo(){
      if(!selInfo) return;
      const sel=selectedRows(), filt=filteredRows();
      selInfo.className='pill '+(sel.length?'info':'mute');
      selInfo.textContent=sel.length?('已选 '+sel.length+' 个'):('未选择 · 目标 '+filt.length+' 个');
    }
    function sectionError(e,act){
      return '<div class="empty">加载失败：'+U.esc(errMsg(e))+
        '<div style="margin-top:8px"><button class="btn mini" data-act="'+U.esc(act)+'">重试</button></div></div>';
    }
    function setModalBody(m,html){
      if(!m) return;
      const b=m.querySelector('.modal-body');
      if(b) b.innerHTML=html;
    }

    /* ═══ 11. 数据加载（账号轮询 / 发放快照 / 活动历史） ═══ */
    async function reloadAccounts(silent){
      const d=await wb.accounts('all');
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
        const d=await wb.accounts('all');
        if(ctx.stale()) return;
        state.rows=d.accounts||[];
        state.meta=d;
        state.lastSync=clock();
        paint();
      }catch(e){ /* 轮询失败保持旧视图，不打扰 */ }
    }
    async function loadGrants(){
      grantsBox.innerHTML=U.loadHtml('拉取积分发放记录…');
      try{
        const d=await wb.creditsGrants();
        if(ctx.stale()) return;
        state.grants=d;
        renderGrants();
      }catch(e){
        if(ctx.stale()) return;
        grantsBox.innerHTML=sectionError(e,'grants-reload');
      }
    }
    function renderGrants(){
      if(!shell.alive) return;
      const d=state.grants;
      if(!d){ grantsBox.innerHTML=U.loadHtml('拉取积分发放记录…'); return; }
      const s=d.summary||{};
      const all=d.rows||[];
      const rows=all.filter(r=>state.grantRealm==='all'||r.realm===state.grantRealm);
      const shown=rows.slice(0,state.grantLimit);
      grantsBox.innerHTML='<div class="toolbar">'+
        '<span class="pill mute">快照 '+U.esc(fmtFull(d.generated_iso))+'</span>'+
        '<span class="pill mute">最近拉取 '+U.esc(d.fetched_iso?fmtFull(d.fetched_iso):'—')+'</span>'+
        '<span class="pill info">共 '+numText(s.count||0)+' 包</span>'+
        '<span class="pill mute">面额 '+numText(s.size||0)+'</span>'+
        '<span class="pill ok">剩余 '+numText(s.remain||0)+'</span>'+
        '<span class="pill warn">已用 '+numText(s.used||0)+'</span>'+
        '<span class="pill mute">'+numText(s.accounts||0)+' 个账号</span>'+
        '<span class="dim" style="font-size:11px">当前 '+U.esc(state.grantRealm==='all'?'全部域':realmLabel(state.grantRealm))+' 显示 '+rows.length+' 行</span>'+
        '</div><div id="wbacc-grants-t"></div>'+
        (rows.length>shown.length?'<div class="toolbar" style="margin-top:6px"><button class="btn mini" data-act="grants-more">显示全部 '+rows.length+' 行</button><span class="dim" style="font-size:11px">当前仅显示前 '+shown.length+' 行</span></div>':'');
      C.dataTable(grantsBox.querySelector('#wbacc-grants-t'),{
        columns:GRANT_COLUMNS, rows:shown,
        emptyText:'暂无积分发放记录（可点「刷新积分」拉取最新快照）'
      });
    }
    async function loadHistory(){
      histBox.innerHTML=U.loadHtml('拉取活动历史…');
      try{
        const d=await wb.activityHistory(state.histRange,200);
        if(ctx.stale()) return;
        state.hist=d;
        renderHistory();
      }catch(e){
        if(ctx.stale()) return;
        histBox.innerHTML=sectionError(e,'hist-reload');
      }
    }
    function renderHistory(){
      if(!shell.alive) return;
      const d=state.hist;
      if(!d){ histBox.innerHTML=U.loadHtml('拉取活动历史…'); return; }
      const rows=d.rows||[];
      const okCount=rows.filter(r=>!!r.ok).length;
      histBox.innerHTML='<div class="toolbar">'+
        '<span class="pill mute">共 '+numText(d.total||0)+' 条</span>'+
        '<span class="pill info">'+U.esc(RANGE_LABEL[state.histRange]||state.histRange)+'</span>'+
        '<span class="pill ok">成功 '+okCount+'</span>'+
        '<span class="pill bad">失败 '+(rows.length-okCount)+'</span>'+
        '<span class="dim" style="font-size:11px">显示最近 '+rows.length+' 条</span>'+
        '</div><div id="wbacc-hist-t"></div>';
      C.dataTable(histBox.querySelector('#wbacc-hist-t'),{
        columns:HIST_COLUMNS, rows:rows, emptyText:'该范围内没有活动记录'
      });
    }

    /* ═══ 12. 动作（guard 串行化 + 失败兜底） ═══ */
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
    async function bulkSet(enabled){
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可操作的账号','warn'); return; }
      const label=sel.length?('已选 '+list.length+' 个'):('当前筛选的 '+list.length+' 个');
      if(!enabled&&!window.confirm('停用'+label+'账号？停用后不参与调度，任务也会停止。')) return;
      if(enabled&&list.length>20&&!window.confirm('启用'+label+'账号？')) return;
      const d=await wb.accountsSetAll(enabled,list.map(a=>a.uid));
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      paint();
      const changed=(d.changed===undefined||d.changed===null)?list.length:d.changed;
      U.toast('已'+(enabled?'启用':'停用')+' '+changed+' 个账号','ok');
    }
    async function bulkRefresh(){
      const list=targetRows();
      if(!list.length){ U.toast('没有可刷新的账号','warn'); return; }
      if(!window.confirm('刷新 '+list.length+' 个账号的凭证与昵称？将逐个请求上游。')) return;
      U.toast('凭证刷新中…','info');
      const d=await wb.accountsRefresh(list.map(a=>a.uid));
      const results=d.results||[];
      const ok=results.filter(r=>r.ok).length;
      try{ await reloadAccounts(true); }catch(e){}
      if(!ctx.stale()) U.toast('凭证刷新完成：'+ok+' / '+results.length+' 成功',ok===results.length?'ok':'warn');
    }
    async function bulkSetProduct(){
      const product=state.bulkProduct;
      const sel=selectedRows();
      const list=sel.length?sel:filteredRows();
      if(!list.length){ U.toast('没有可切换的账号','warn'); return; }
      if((list.length>20||list.length===state.rows.length)&&
         !window.confirm('将把 '+list.length+' 个账号的出站身份切换为 '+productLabel(product)+'，继续？')) return;
      const d=await wb.accountsProduct({product:product,uids:list.map(a=>a.uid)});
      if(ctx.stale()) return;
      if(d.accounts) state.rows=d.accounts;
      paint();
      U.toast('已切换 '+len(d.changed)+' 个账号 → '+productLabel(product),'ok');
    }
    async function refreshCredits(){
      const sel=selectedRows();
      const payload={};
      let label='全池';
      if(sel.length){ payload.uids=sel.map(a=>a.uid); label=sel.length+' 个已选账号'; }
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
      const list=targetRows();
      if(!list.length){ U.toast('没有可测试的账号','warn'); return; }
      if(!window.confirm('将逐个测试 '+list.length+' 个账号（含停用账号），可能耗时较久，继续？')) return;
      const m=U.openModal({
        title:'账号测试', wide:true,
        body:U.loadHtml('测试中… 共 '+list.length+' 个账号'),
        actions:[{label:'关闭'}]
      });
      try{
        const d=await wb.accountsTest({uids:list.map(a=>a.uid)});
        if(d.accounts&&!ctx.stale()){ state.rows=d.accounts; paint(); }
        setModalBody(m,'<div id="wbacc-test-cards"></div><div id="wbacc-test-body"></div>');
        renderTestResult(m,d);
      }catch(e){
        setModalBody(m,'<div class="empty">测试失败：'+U.esc(errMsg(e))+'</div>');
      }
    }
    function renderTestResult(m,d){
      const s=d.summary||{};
      const net=d.network||{};
      C.statCards(m.querySelector('#wbacc-test-cards'),[
        {label:'已测', value:s.tested||0, sub:U.esc('区域 '+(s.realm==='cn'?'国内':s.realm==='intl'?'国际':'—'))},
        {label:'通过', value:s.passed||0},
        {label:'失败', value:s.failed||0},
        {label:'耗时', value:(s.elapsed_ms||0)+' ms', sub:U.esc(s.model||'')}
      ]);
      m.querySelector('#wbacc-test-body').innerHTML=
        '<div class="toolbar">'+(net.ok?U.pill('本机网络正常','ok'):U.pill('本机网络异常','bad'))+
        '<span class="dim" style="font-size:11px">'+U.esc(net.error||net.detail||('目标 '+(net.host||'—')))+'</span></div>'+
        '<div id="wbacc-test-t"></div>';
      C.dataTable(m.querySelector('#wbacc-test-t'),{
        columns:TEST_COLUMNS, rows:d.results||[], emptyText:'没有可测试的账号'
      });
    }

    /* ═══ 13. 弹窗：详情 / 导入 / 桌面导入 / 新增 API Key ═══ */
    function detailRows(a){
      const c=creditOf(a)||{};
      const rows=[];
      const add=(k,v)=>rows.push({k:k,v:v});
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
        add('模型冷却',a.modelCooldowns.map(x=>U.esc(x.model)+' → '+U.esc(fmtShort(x.expiresAt))).join('<br>'));
      }
      if(a.accountBanned) add('封禁',U.pill('上游封禁','bad')+' '+(a.bannedAt?U.esc(fmtFull(a.bannedAt)):''));
      add('文件',U.esc(a.file||'—'));
      return rows;
    }
    function openDetail(uid){
      const a=findRow(uid);
      if(!a){ U.toast('账号已不在当前列表','warn'); return; }
      const m=U.openModal({
        title:'账号详情 · '+(a.nickname||uid.slice(0,8)),
        wide:true,
        body:'<div class="toolbar">'+U.pill(acctStatus(a).label,acctStatus(a).kind)+
          U.pill(realmLabel(a.realm),'info')+U.pill(a.poolScope==='media'?'媒体池':'文本池','mute')+
          U.pill(productLabel(a.product),'mute')+'</div><div id="wbacc-detail-t" style="margin-top:6px"></div>',
        actions:[
          {label:'刷新凭证',onClick:async()=>{
            const d=await wb.accountsRefresh([uid]);
            const r=(d.results||[])[0];
            U.toast(r&&r.ok?'凭证刷新成功':'凭证刷新失败',r&&r.ok?'ok':'bad');
            try{ await reloadAccounts(true); }catch(e){}
            return false;
          }},
          {label:'刷新积分',onClick:async()=>{
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
      C.dataTable(m.querySelector('#wbacc-detail-t'),{
        columns:DETAIL_COLUMNS, rows:detailRows(a), emptyText:'—'
      });
    }
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
      const group=fieldVal('wbacc-import-group');
      const ov=document.getElementById('wbacc-import-overwrite');
      const overwrite=!!(ov&&ov.checked);
      if(!dry&&overwrite&&!window.confirm('将覆盖 uid 相同的现有账号（用文档里的凭证替换），确定导入？')) return 'stay';
      const payload={data:doc,dryRun:!!dry,overwrite:overwrite};
      if(state.importRealm) payload.realm=state.importRealm;
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
      (r.added||[]).forEach(uid=>rows.push({st:U.pill('新增','ok'),id:'<span class="mono">'+U.esc(String(uid))+'</span>',reason:'—'}));
      (r.updated||[]).forEach(uid=>rows.push({st:U.pill('覆盖','warn'),id:'<span class="mono">'+U.esc(String(uid))+'</span>',reason:'—'}));
      (r.skipped||[]).forEach(x=>rows.push({st:U.pill('跳过','mute'),id:'<span class="mono">'+U.esc(String(x.uid||'—'))+'</span>',reason:U.esc(x.reason||'')}));
      (r.invalid||[]).forEach(x=>rows.push({st:U.pill('无效','bad'),id:'<span class="mono">#'+U.esc(String(x.index===undefined?'?':x.index))+'</span>',reason:U.esc(x.reason||'')}));
      const shown=rows.slice(0,60);
      box.innerHTML='<div class="toolbar" style="margin-top:8px">'+
        '<span class="pill info">'+(dry?'预览（未写入）':'已导入')+'</span>'+
        '<span class="pill mute">文档 '+(d.count===undefined?'—':numText(d.count))+' 行</span>'+
        U.pill('新增 '+len(r.added),'ok')+U.pill('覆盖 '+len(r.updated),'warn')+
        U.pill('跳过 '+len(r.skipped),'mute')+U.pill('无效 '+len(r.invalid),'bad')+
        '</div><div id="wbacc-import-pv"></div>'+
        (rows.length>60?'<div class="dim" style="font-size:11px;margin-top:4px">仅显示前 60 行，共 '+rows.length+' 行</div>':'');
      C.dataTable(box.querySelector('#wbacc-import-pv'),{
        columns:PREVIEW_COLUMNS, rows:shown, emptyText:'没有可处理的账号行'
      });
    }
    function openImport(){
      const m=U.openModal({
        title:'导入账号（粘贴凭证 / 导出文档）', wide:true,
        body:'<p class="sub">支持导出文档、裸数组、单个 accessToken。静态 <span class="mono">ck_/pt_</span> Key 请走「新增 API Key」。'+
          '可先勾选「覆盖」再预览；预览与真实导入共用同一套校验规则。</p>'+
          '<textarea id="wbacc-import-text" rows="10" placeholder=\'{"format":"workbuddy-accounts","accounts":[...]} 或 [{...}] 或 accessToken\' '+
          'style="width:100%;font-family:var(--font-mono);font-size:11.5px"></textarea>'+
          '<div class="toolbar" style="margin-top:8px"><span id="wbacc-import-rbar"></span>'+
          '<label>分组</label><input id="wbacc-import-group" placeholder="可留空" style="width:140px">'+
          '<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="wbacc-import-overwrite"> 覆盖同名账号</label>'+
          '</div><div id="wbacc-import-preview"></div>',
        actions:[
          {label:'取消'},
          {label:'预览',onClick:async()=>{ await doImport(true); return true; }},
          {label:'导入',kind:'pri',onClick:async()=>{ const r=await doImport(false); return r!=='done'; }}
        ]
      });
      C.filterBar(m.querySelector('#wbacc-import-rbar'),[{key:'importRealm',label:'强制域',options:IMPORT_REALM_OPTS}],state,()=>{});
    }
    function renderDesktop(m,d){
      const at=d.atrest||{};
      const items=d.detected||[];
      const inPool={};
      (d.pool_uids||[]).forEach(uid=>{ inPool[uid]=true; });
      const cols=[
        {key:'file', label:'文件', render:(v,it)=>U.esc(it.file||'—')+'<div class="dim mono" style="font-size:10px" title="'+U.esc(it.path||'')+'">'+U.esc(trunc(it.path||'',48))+'</div>'},
        {key:'realm', label:'域', render:(v,it)=>U.esc(it.realm==='cn'?'国内版':'国际版')},
        {key:'valid', label:'状态', render:(v,it)=>
          (it.valid?U.pill('可导入','ok'):it.needsKey?U.pill('需解码密钥','warn'):U.pill('不可读','bad'))+
          (it.valid&&inPool[it.uid]?' '+U.pill('已在池','mute'):'')},
        {key:'nickname', label:'昵称', render:(v,it)=>U.esc(it.nickname||'—')},
        {key:'uid', label:'UID', render:(v,it)=>'<span class="mono">'+U.esc(String(it.uid||'').slice(0,12)||'—')+'</span>'},
        {key:'expiresAt', label:'有效期', render:(v,it)=>U.esc(it.expiresAt?fmtDate(it.expiresAt):'—')},
        {key:'error', label:'错误', render:(v,it)=>U.esc(trunc(it.error||'',40))}
      ];
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
      html+='<div id="wbacc-desktop-t" style="margin-top:8px"></div>'+
        '<details style="margin-top:12px"><summary class="dim" style="cursor:pointer">凭据已加密？手工导入解码密钥 / 清除内存密钥</summary>'+
        '<p class="dim" style="font-size:11.5px">macOS / Linux 无法从进程回收时，可粘贴一次 at-rest 解码密钥；密钥只留在网关内存，不落盘。</p>'+
        '<textarea id="wbacc-atrest-key" rows="3" style="width:100%;font-family:var(--font-mono)" placeholder="at-rest 解码密钥"></textarea>'+
        '<div class="toolbar" style="margin-top:8px">'+
        '<button class="btn mini" data-dt="keytext">导入解码密钥</button>'+
        '<button class="btn mini danger" data-dt="forget">清除内存密钥</button>'+
        '</div></details>';
      setModalBody(m,html);
      C.dataTable(m.querySelector('#wbacc-desktop-t'),{
        columns:cols, rows:items, rowKey:'uid',
        emptyText:'本机未发现桌面客户端凭据（或未安装）',
        actions:it=>(it.valid&&!inPool[it.uid])
          ?[{label:'导入',onClick:()=>importDesktopPath(m,it.path).catch(e=>U.toast('操作失败：'+errMsg(e),'bad'))}]
          :[]
      });
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
      shell.listen(m,'click',ev=>{
        const b=ev.target.closest('[data-dt]');
        if(!b) return;
        const op=b.getAttribute('data-dt');
        (async()=>{
          try{
            if(op==='scan') await scanDesktop(m,false);
            else if(op==='all') await importDesktopAll(m);
            else if(op==='recover') await atrestOp(m,{recoverKey:true});
            else if(op==='forget') await atrestOp(m,{forgetKey:true});
            else if(op==='keytext') await atrestOp(m,{keyText:fieldVal('wbacc-atrest-key')});
          }catch(e){ U.toast('操作失败：'+errMsg(e),'bad'); }
        })();
      });
      scanDesktop(m,true);
    }
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
          {label:'添加',kind:'pri',onClick:async()=>{
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

    /* ═══ 14. 事件（shell.listen 委托，自动清理） ═══ */
    function onPageClick(ev){
      const t=ev.target.closest('[data-act]');
      if(!t||!el.contains(t)) return;
      switch(t.getAttribute('data-act')){
        case 'selall': filteredRows().forEach(a=>{ state.sel[a.uid]=true; }); paintTable(); return;
        case 'selnone': clearSel(); paintTable(); return;
        case 'reload': guard(()=>reloadAccounts(false)); return;
        case 'bulk-enable': guard(()=>bulkSet(true)); return;
        case 'bulk-disable': guard(()=>bulkSet(false)); return;
        case 'bulk-refresh': guard(bulkRefresh); return;
        case 'bulk-test': guard(bulkTest); return;
        case 'bulk-product': guard(bulkSetProduct); return;
        case 'credits-refresh': guard(refreshCredits); return;
        case 'import-open': openImport(); return;
        case 'desktop-open': openDesktop(); return;
        case 'apikey-open': openApiKey(); return;
        case 'grants-reload': loadGrants(); return;
        case 'grants-more': state.grantLimit=100000; renderGrants(); return;
        case 'hist-reload': loadHistory(); return;
      }
    }
    function onHeadClick(ev){
      const th=ev.target.closest('th');
      if(!th||!tableBox||!tableBox.contains(th)) return;
      const ths=Array.prototype.slice.call(tableBox.querySelectorAll('thead th'));
      const key=SORT_KEYS[ths.indexOf(th)];
      if(!key) return;
      if(state.sortKey===key) state.sortDir=state.sortDir==='asc'?'desc':'asc';
      else { state.sortKey=key; state.sortDir=TEXT_SORT[key]?'asc':'desc'; }
      paintTable();
    }
    function onPageChange(ev){
      const sel=ev.target.closest('[data-sel]');
      if(sel){
        const uid=sel.getAttribute('data-uid');
        if(sel.checked) state.sel[uid]=true; else delete state.sel[uid];
        paintSelInfo();
        return;
      }
      const p=ev.target.closest('[data-product]');
      if(p) guard(()=>setProduct(p.getAttribute('data-uid'),p.value));
    }
    function onPageInput(ev){
      if(ev.target.id!=='wbacc-q') return;
      state.q=ev.target.value;
      clearSel();
      paintTable();
    }

    /* ═══ 15. 首屏：拉取 → shell 布局 → 挂组件 → 轮询 ═══ */
    shell.setTitle('账号池','正在拉取账号池…');
    let first;
    try{ first=await wb.accounts('all'); }
    catch(e){
      if(ctx.stale()) return;
      shell.setTitle('账号池','加载失败');
      shell.setContent(U.errHtml(e));
      return;
    }
    if(ctx.stale()) return;
    state.rows=first.accounts||[];
    state.meta=first;
    state.lastSync=clock();

    shell.setTitle('账号池','WB 全量账号 · 存储 '+trunc(String(state.meta.storage||'—'),64)+
      ' · 文本就绪 '+numText(state.meta.text_ready||0)+' · 媒体就绪 '+numText(state.meta.media_ready||0));
    buildLayout();
    mountFilterBars();
    shell.listen(el,'click',onPageClick);
    shell.listen(el,'click',onHeadClick);
    shell.listen(el,'change',onPageChange);
    shell.listen(el,'input',onPageInput);
    shell.onCleanup(()=>{ working=false; });

    paint();
    loadGrants();
    loadHistory();
    shell.poll(pollAccounts,20000);
  }
});
