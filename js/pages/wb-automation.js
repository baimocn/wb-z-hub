/* ─────────────────────────────────────────────────────────────
 * 页面：自动化（wb-automation）—— 只读
 *
 * 两块内容（原先混在一个 paint() 里，现按数据域拆开）：
 *   调度时间表：调度器指标卡 / 生效时段表 / 模型额度窗口 / 调度日志
 *   任务进度  ：成长福利指标卡 / 逐账号进度卡片 / 成长任务明细
 *
 * 端点（全部经 HUB.api.wb，无裸 fetch）：
 *   wb.scheduler()      GET /wb/scheduler        调度器状态、额度窗口、日志
 *   wb.tasks()          GET /wb/tasks            成长任务、汇总、账号进度缓存
 *   wb.tasksProgress()  GET /wb/tasks/progress   前 6 个账号的实时进度
 *   wb.settings()       GET /wb/settings         自动化时段与开关（只读回显）
 *
 * 动作类端点（/tasks/run|night|claim|travel|streak-bonus、
 * /scheduler/trigger|toggle、/quota-scan/run）在 js/core/api.js 中没有封装，
 * 模块契约禁止裸 fetch，因此本页只读呈现状态并提供设置页入口；
 * 缺口见 docs/api-inventory.md 第三节第 6 条。
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'wb-automation', group:'wb', title:'自动化', order:60,
  async render(el, ctx){
    const U=HUB.ui, C=HUB.components, wb=HUB.api.wb;
    const shell=HUB.shell(el, ctx);

    /* ═══ 1. 常量 ═══ */
    const POLL_MS=30000;
    const PROGRESS_BATCH=6;   /* /tasks/progress 单批上限，与后端一致 */
    const FILTERS=[
      {key:'checkin', label:'签到', options:[
        {value:'', label:'全部'}, {value:'yes', label:'已签到'},
        {value:'no', label:'未签到'}, {value:'unknown', label:'不可判定'}
      ]},
      {key:'source', label:'进度来源', options:[
        {value:'', label:'全部'}, {value:'fetched', label:'上游拉取'},
        {value:'cached', label:'缓存'}, {value:'error', label:'失败'},
        {value:'none', label:'无进度'}
      ]}
    ];

    /* ═══ 2. 状态（render 闭包内，切页随闭包丢弃） ═══ */
    const S={
      sched:null, tasks:null, settings:null,
      progs:{}, progErr:'', err:'',
      filter:{checkin:'', source:''},
      busy:false, painted:false
    };
    let boxes={};   /* 持久 DOM 引用，布局只建一次，轮询只改这些盒子 */

    /* ═══ 3. 工具 ═══ */
    const pad2=h=>String(h).padStart(2,'0');
    const uid8=uid=>String(uid||'').slice(0,8)||'—';
    function hoursText(list){
      return (Array.isArray(list)&&list.length)?list.map(h=>pad2(h)+':00').join(' / '):'—';
    }
    function timesText(list){
      return (Array.isArray(list)&&list.length)?list.join(' / '):'—';
    }
    function clock(t){
      const raw=String(t==null?'':t);
      const m=raw.match(/\d{1,2}:\d{2}(:\d{2})?/);
      return m?m[0]:(raw||'—');
    }
    function dur(sec){
      const s=Math.max(0,Math.round(Number(sec)||0));
      if(s<60) return s+' 秒';
      const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
      return h?(h+' 时 '+m+' 分'):(m+' 分');
    }
    function clipMsg(e){
      const m=String((e&&e.message)||e||'未知错误');
      return m.length>140?m.slice(0,140)+'…':m;
    }
    function checkinCell(a){
      if(a.checkin_today===true){
        return U.pill('已签','ok')+(a.checkin_credit?' <span class="mono dim">+'+U.esc(a.checkin_credit)+'</span>':'');
      }
      if(a.checkin_today===false) return U.pill('未签','mute');
      return U.pill('—','mute');
    }
    function checkinState(a){
      return a.checkin_today===true?'yes':(a.checkin_today===false?'no':'unknown');
    }
    function sourceCell(p){
      if(!p) return U.pill('无进度','mute');
      if(p.state==='fetched') return U.pill('上游拉取','info');
      if(p.state==='cached') return U.pill('缓存','mute');
      if(p.state==='error') return U.pill('失败','bad');
      return U.pill(p.state||'未知','mute');
    }
    function sourceState(p){ return (p&&p.state)?p.state:'none'; }
    function taskPill(t, reached){
      if(t.status==='claimed') return U.pill('已领取','ok');
      if(reached) return U.pill('待领奖','warn');
      if(t.status==='accepted'||t.status==='in_progress') return U.pill('进行中','info');
      if(t.status==='not_accepted') return U.pill('未接取','mute');
      return U.pill(t.status||'未知','mute');
    }
    function progressOf(a){
      const p=S.progs[a.uid]||null;
      const d=(p&&p.done!=null)?p.done:a.tasks_done;
      const t=(p&&p.total!=null)?p.total:a.tasks_total;
      const at=(p&&p.updated_at)?p.updated_at:a.progress_at;
      return {p, d, t, at, ok:(d!=null&&t!=null&&Number(t)>0)};
    }

    /* ═══ 4. 布局（shell 结构只建一次） ═══ */
    function buildLayout(){
      const bar=shell.toolbar(), content=shell.content();
      bar.innerHTML=
        '<div class="toolbar">'
        +'<button class="btn" id="wa-refresh">刷新</button>'
        +'<span class="spacer"></span>'
        +'<span id="wa-pills"></span>'
        +'<a class="btn mini" href="#/settings">自动化开关与时段 →</a>'
        +'</div>';
      content.innerHTML=
        '<div id="wa-cards"></div>'

        +'<h2>调度时间表</h2>'
        +'<p class="sub" id="wa-mode">调度器状态读取中…</p>'
        +'<div id="wa-mode-intl"></div>'
        +'<div id="wa-mode-warn"></div>'
        +'<div id="wa-sched"></div>'

        +'<h2>模型额度窗口</h2>'
        +'<p class="sub">调度器探针读到的上游 429 重置窗口（最多 10 条，按到点时间排序）。</p>'
        +'<div id="wa-windows"></div>'

        +'<h2>调度日志</h2>'
        +'<div id="wa-log"></div>'

        +'<h2>任务进度</h2>'
        +'<p class="sub">成长福利汇总与逐账号任务进度；进度接口单批最多 '+PROGRESS_BATCH+' 个账号，其余账号显示缓存值。</p>'
        +'<div id="wa-growth-cards"></div>'
        +'<div class="toolbar" id="wa-filter"></div>'
        +'<div id="wa-prog-cards"></div>'
        +'<div id="wa-prog-note"></div>'

        +'<h2>成长任务</h2>'
        +'<p class="sub" id="wa-growth-sub"></p>'
        +'<div id="wa-growth-table"></div>';
      boxes={
        refresh:bar.querySelector('#wa-refresh'),
        pills:bar.querySelector('#wa-pills'),
        cards:content.querySelector('#wa-cards'),
        mode:content.querySelector('#wa-mode'),
        modeIntl:content.querySelector('#wa-mode-intl'),
        modeWarn:content.querySelector('#wa-mode-warn'),
        sched:content.querySelector('#wa-sched'),
        windows:content.querySelector('#wa-windows'),
        log:content.querySelector('#wa-log'),
        growthCards:content.querySelector('#wa-growth-cards'),
        filter:content.querySelector('#wa-filter'),
        progCards:content.querySelector('#wa-prog-cards'),
        progNote:content.querySelector('#wa-prog-note'),
        growthSub:content.querySelector('#wa-growth-sub'),
        growthTable:content.querySelector('#wa-growth-table')
      };
    }
    function setBusy(on){
      if(!boxes.refresh) return;
      boxes.refresh.disabled=on;
      boxes.refresh.textContent=on?'刷新中…':'刷新';
    }

    /* ═══ 5. 调度时间表：指标卡 / 生效时段 / 额度窗口 / 日志 ═══ */
    function paintPills(){
      if(!shell.alive||!boxes.pills||!S.sched) return;
      const sched=S.sched, tasks=S.tasks||{}, settings=S.settings;
      const sc=(settings&&settings.schedule)?settings.schedule:null;
      const accts=tasks.accounts||[];
      const dc=sched.daily_chat||{};
      const dcLive=(dc.live||[]).length;
      const swPills=sc
        ? U.pill('每日活跃 '+(settings.daily_activity===true?'开':'关'), settings.daily_activity===true?'ok':'mute')
          +' '+U.pill('网页活跃对话 '+(settings.daily_chat_web===true?'开':'关'), settings.daily_chat_web===true?'ok':'mute')
        : U.pill('自动化开关不可读','mute');
      boxes.pills.innerHTML=
        U.pill(sched.enabled?'调度器已启用':'调度器已暂停', sched.enabled?'ok':'warn')
        +' '+U.pill('任务账号 '+accts.length,'mute')
        +(dcLive?' '+U.pill('网页活跃运行中 '+dcLive,'info'):'')
        +(S.progErr?' '+U.pill('进度刷新失败','bad'):'')
        +(S.err?' '+U.pill('刷新失败','bad'):'')
        +' '+swPills;
    }

    function paintScheduler(){
      if(!shell.alive||!boxes.cards||!S.sched) return;
      const sched=S.sched, tasks=S.tasks||{}, settings=S.settings;
      const sc=(settings&&settings.schedule)?settings.schedule:null;
      const accts=tasks.accounts||[];

      let checkinOk=0, checkinKnown=0, aggDone=0, aggTotal=0, aggAccts=0;
      accts.forEach(a=>{
        if(a.checkin_today===true){ checkinOk++; checkinKnown++; }
        else if(a.checkin_today===false){ checkinKnown++; }
        const g=progressOf(a);
        if(g.ok){ aggDone+=Number(g.d)||0; aggTotal+=Number(g.t)||0; aggAccts++; }
      });
      C.statCards(boxes.cards,[
        {label:'调度器', value:sched.enabled?'启用':'已暂停', sub:'整点排程 · 额度窗口探针'},
        {label:'下次巡检', value:clock(sched.next_run_time), sub:U.esc(sched.next_run_time||'待调度')},
        {label:'上次巡检', value:clock(sched.last_run_time), sub:U.esc(sched.last_run_time||'尚未运行')},
        {label:'任务账号', value:String(accts.length), sub:'今日已签 '+checkinOk+' · 可判定 '+checkinKnown},
        {label:'成长任务进度', value:(aggTotal?(aggDone+' / '+aggTotal):'—'),
          sub:(aggAccts?(aggAccts+' 个账号有进度'):(S.progErr?'进度接口失败':'暂无进度缓存'))}
      ]);

      boxes.mode.textContent=sched.mode_cn||sched.mode||sched.msg||'调度器未运行';
      boxes.modeIntl.innerHTML=sched.mode_intl?'<p class="sub">'+U.esc(sched.mode_intl)+'</p>':'';
      boxes.modeWarn.innerHTML=sc?'':'<p class="sub">'
        +U.pill('/settings 读取失败，签到 / 旅行 / 保活 / 夜猫 时段无法确认','warn')+'</p>';

      const dc=sched.daily_chat||{};
      const dcTimes=(dc.times&&dc.times.length)?dc.times:((sc&&sc.daily_chat_effective)||[]);
      const dcDone=dc.done_slots||[];
      const dcLive=(dc.live||[]).length;
      const hoursCell=key=>sc?'<span class="mono">'+U.esc(hoursText(sc[key]))+'</span>':'<span class="dim">—</span>';
      const dcWindow='<span class="mono">'+U.esc(timesText(dcTimes))+'</span>'
        +(dc.random?' '+U.pill('当日随机','mute'):'');
      const dcNote='国际版每日活跃'
        +(dcTimes.length
          ?('；今日已跑 '+dcDone.length+' / '+dcTimes.length+' 时段'+(dc.next_slot?'，下次 '+U.esc(dc.next_slot):''))
          :'；未配置时段')
        +(dcLive?('；运行中 '+dcLive+' 个账号'):'');
      C.dataTable(boxes.sched,{
        rowKey:'code',
        emptyText:'暂无调度条目',
        columns:[
          {key:'task', label:'任务', render:v=>'<b>'+U.esc(v)+'</b>'},
          {key:'code', label:'代码', render:v=>'<span class="mono">'+U.esc(v)+'</span>'},
          {key:'windowHtml', label:'生效窗口', render:v=>v||'<span class="dim">—</span>'},
          {key:'note', label:'说明', render:v=>'<span class="dim">'+U.esc(v)+'</span>'}
        ],
        rows:[
          {task:'每日签到', code:'checkin', windowHtml:hoursCell('checkin'), note:'Buddy 加油站签到，每次 +100 积分'},
          {task:'猫猫旅行', code:'travel', windowHtml:hoursCell('travel'), note:'派猫出行，归来后待领奖（奖励积分）'},
          {task:'Token 保活', code:'keepalive', windowHtml:hoursCell('keepalive'), note:'集中刷新凭证，避免 Token 过期掉线'},
          {task:'夜猫任务', code:'cat', windowHtml:hoursCell('cat'), note:'夜猫子任务，完成条件限定 23:00–08:00'},
          {task:'网页活跃', code:'daily_chat', windowHtml:dcWindow, note:dcNote}
        ]
      });

      C.dataTable(boxes.windows,{
        rowKey:'uid',
        emptyText:'暂无到点的额度窗口',
        columns:[
          {key:'uid8', label:'账号', render:(v,r)=>'<span class="mono">'+U.esc(v||uid8(r.uid))+'</span>'},
          {key:'model', label:'模型', render:v=>'<span class="mono">'+U.esc(v||'—')+'</span>'},
          {key:'reset_in', label:'距重置', render:v=>'<span class="mono">'+U.esc(dur(v))+'</span>'},
          {key:'attempts', label:'尝试', render:v=>'<span class="mono">'+U.esc(String(v==null?0:v))+'</span>'},
          {key:'last_result', label:'上次结果', render:v=>v?U.esc(v):'<span class="dim">—</span>'},
          {key:'cap', label:'上限', render:v=>v?U.pill('已封顶','warn'):'<span class="dim">—</span>'}
        ],
        rows:sched.windows||[]
      });

      const logLines=(sched.logs||[]).slice(-20);
      boxes.log.innerHTML=logLines.length
        ?'<pre class="raw">'+U.esc(logLines.join('\n'))+'</pre>'
        :'<div class="empty">暂无调度日志</div>';
    }

    /* ═══ 6. 任务进度：成长汇总 / 筛选 / 逐账号卡片 / 成长任务 ═══ */
    const GROWTH_COLUMNS=[
      {key:'name', label:'任务', render:(v,r)=>'<b>'+U.esc(v||r.task_code||'—')+'</b>'
        +(r.description?'<div class="dim">'+U.esc(r.description)+'</div>':'')},
      {key:'task_code', label:'代码', render:v=>'<span class="mono">'+U.esc(v||'—')+'</span>'},
      {key:'current', label:'进度', render:(v,r)=>{
        const cur=Number(r.current)||0, tgt=Number(r.target)||0;
        if(r.status==='claimed') return '<span class="dim">已达成</span>';
        return tgt>0?('<span class="mono">'+cur+' / '+tgt+'</span> '+U.pct(cur/tgt*100)):'<span class="dim">—</span>';
      }},
      {key:'reward_credit', label:'奖励', render:(v,r)=>{
        const parts=[];
        if(r.reward_credit) parts.push('<span class="mono">+'+U.esc(r.reward_credit)+'</span> 积分');
        if(r.reward_energy) parts.push('<span class="mono dim">+'+U.esc(r.reward_energy)+'</span> 能量');
        return parts.length?parts.join(' '):'<span class="dim">—</span>';
      }},
      {key:'status', label:'状态', render:(v,r)=>{
        const cur=Number(r.current)||0, tgt=Number(r.target)||0;
        const reached=(r.status==='completed')||(tgt>0&&cur>=tgt);
        return taskPill(r,reached)+(r.reason?'<div class="dim">'+U.esc(r.reason)+'</div>':'');
      }}
    ];

    function matchAccount(a, p){
      if(S.filter.checkin&&checkinState(a)!==S.filter.checkin) return false;
      if(S.filter.source&&sourceState(p)!==S.filter.source) return false;
      return true;
    }

    function paintProgressCards(){
      if(!shell.alive||!boxes.progCards) return;
      const tasks=S.tasks||{};
      const accts=tasks.accounts||[];
      if(!accts.length){
        boxes.progCards.innerHTML='<div class="empty">'+U.esc(tasks.msg||'未找到参与任务的国内版账号')+'</div>';
        boxes.progNote.innerHTML='';
        return;
      }
      const shown=accts.filter(a=>matchAccount(a,S.progs[a.uid]||null));
      if(!shown.length){
        boxes.progCards.innerHTML='<div class="empty">当前筛选没有匹配的账号</div>';
      }else{
        C.statCards(boxes.progCards, shown.map(a=>{
          const g=progressOf(a);
          return {
            label:a.nickname||uid8(a.uid),
            value:g.ok?(g.d+' / '+g.t):'—',
            sub:'<div class="mono dim" title="'+U.esc(a.uid||'')+'">'+U.esc(uid8(a.uid))+'</div>'
              +'<div class="mono">剩余积分 '+(a.credits_remain==null?'—':U.esc(U.num(a.credits_remain)))+'</div>'
              +(g.ok?'<div>'+U.pct(Number(g.d)/Number(g.t)*100)+'</div>':'')
              +'<div>'+checkinCell(a)+' '+sourceCell(g.p)+'</div>'
              +(g.p&&g.p.state==='error'&&g.p.error?'<div class="dim">'+U.esc(g.p.error)+'</div>':'')
              +'<div class="dim">更新于 '+(g.at?U.esc(U.ts(g.at)):'—')+'</div>'
          };
        }));
      }
      const note=[];
      if(accts.length>PROGRESS_BATCH) note.push('进度接口单批最多 '+PROGRESS_BATCH+' 个账号，其余账号显示缓存值。');
      if(S.progErr) note.push('进度刷新失败：'+S.progErr);
      boxes.progNote.innerHTML=note.length?'<p class="sub">'+U.esc(note.join(' '))+'</p>':'';
    }

    function paintProgress(){
      if(!shell.alive||!boxes.growthCards) return;
      const tasks=S.tasks||{}, sum=tasks.summary||{}, travel=sum.travel||{};
      const accts=tasks.accounts||[];
      if(!accts.length){
        boxes.growthCards.innerHTML='<div class="empty">'+U.esc(tasks.msg||'未找到参与任务的国内版账号')+'</div>';
        boxes.growthSub.textContent='';
        boxes.growthTable.innerHTML='';
        paintProgressCards();
        return;
      }

      const tierText=['7d','14d','28d'].map(k=>k+':'+((sum.tier_statuses||{})[k]||'—')).join(' · ');
      let travelV='未知', travelN='状态未知';
      if(travel.state==='arrived'){
        travelV='待领奖';
        travelN='归来奖励'+(travel.reward_credit?' +'+U.esc(travel.reward_credit)+' 积分':'待领');
      }else if(travel.state==='traveling'){
        travelV='旅行中'; travelN='预计稍后归来';
      }else if(travel.daily_limit_reached){
        travelV='今日已完成'; travelN='次日 00:00 刷新';
      }else if(travel.state){
        travelV='在家待命'; travelN='随时可出发旅行';
      }
      C.statCards(boxes.growthCards,[
        {label:'连续打卡', value:(sum.streak_days==null?'—':String(sum.streak_days)), unit:'天',
          sub:'连登档位 '+U.esc(tierText)},
        {label:'能量', value:(sum.energy==null?'—':String(sum.energy)), sub:'成长任务上报累计（当前余额）'},
        {label:'补签卡', value:(sum.makeup_cards==null?'—':String(sum.makeup_cards)), unit:'张', sub:'可补签漏掉的日期'},
        {label:'抽奖机会', value:(sum.lottery_chances==null?'—':String(sum.lottery_chances)), unit:'次', sub:'成长抽奖'},
        {label:'猫猫旅行', value:travelV, sub:travelN}
      ]);

      const acct=tasks.account||null;
      boxes.growthSub.innerHTML='当前任务视图：<b>'
        +U.esc(acct?(acct.nickname||uid8(acct.uid)):'—')+'</b> · 后端默认取首个国内版任务号';
      C.dataTable(boxes.growthTable,{
        rowKey:'task_code',
        emptyText:'该账号暂无成长任务',
        columns:GROWTH_COLUMNS,
        rows:tasks.tasks||[]
      });
      paintProgressCards();
    }

    /* ═══ 7. 数据加载（首屏失败抛出，轮询失败保留旧视图） ═══ */
    async function load(manual){
      if(S.busy) return;
      S.busy=true;
      if(manual) setBusy(true);
      try{
        const res=await Promise.all([
          wb.scheduler(),
          wb.tasks(),
          wb.settings().catch(()=>null)
        ]);
        if(!shell.alive) return;
        S.sched=res[0]||{};
        S.tasks=res[1]||{};
        S.settings=res[2]||null;
        S.err='';

        const accts=S.tasks.accounts||[];
        const uids=accts.map(a=>a.uid).filter(Boolean).slice(0,PROGRESS_BATCH);
        S.progErr='';
        if(uids.length){
          try{
            const p=await wb.tasksProgress(uids);
            if(!shell.alive) return;
            const map={};
            ((p&&p.items)||[]).forEach(it=>{ if(it&&it.uid) map[it.uid]=it; });
            S.progs=map;
          }catch(e){
            if(!shell.alive) return;
            S.progErr=clipMsg(e);
          }
        }else{
          S.progs={};
        }

        if(!shell.alive) return;
        paintPills();
        paintScheduler();
        paintProgress();
        S.painted=true;
        if(manual) U.toast('已刷新','ok');
      }catch(e){
        if(!shell.alive) return;
        S.err=clipMsg(e);
        if(!S.painted) throw e;
        paintPills();
        U.toast('刷新失败：'+S.err,'bad');
      }finally{
        S.busy=false;
        if(manual) setBusy(false);
      }
    }

    /* ═══ 8. 事件与启动 ═══ */
    shell.setTitle('自动化','调度时间表 · 任务进度。本页只读：调度开关与任务时段在设置页维护，任务执行由后台调度器承担。');
    buildLayout();
    C.filterBar(boxes.filter, FILTERS, S.filter, ()=>{ paintProgressCards(); });
    boxes.cards.innerHTML=U.loadHtml('拉取调度状态…');
    boxes.sched.innerHTML=U.loadHtml('拉取调度时间表…');

    shell.listen(boxes.refresh,'click',()=>{ if(!S.busy) load(true); });
    await load(false);
    shell.poll(()=>load(false), POLL_MS);
  }
});
