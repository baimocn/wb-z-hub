/* 页面：自动化 —— 调度时间表 / 成长任务福利 / 逐账号进度（只读页）
 * 动作类端点（/tasks/run|night|claim|travel|streak-bonus、/scheduler/toggle、
 * /quota-scan/run）在 js/core/api.js 中没有封装，模块契约禁止裸 fetch，
 * 因此这里只读呈现状态并提供设置页入口；缺口见 docs/api-inventory.md 第三节第 6 条。 */
HUB.register({
  route:'wb-automation', group:'wb', title:'自动化', order:60,
  async render(el, ctx){
    const U=HUB.ui, WB=HUB.api.wb;
    let busy=false, painted=false;

    /* ── 局部格式化（不引共享文件，保持模块自洽） ── */
    const pad2=function(h){ h=String(h); return h.length<2?('0'+h):h; };
    const hoursText=function(list){
      if(!Array.isArray(list)||!list.length) return '—';
      return list.map(function(h){ return pad2(h)+':00'; }).join(' / ');
    };
    const timesText=function(list){
      if(!Array.isArray(list)||!list.length) return '—';
      return list.join(' / ');
    };
    const clock=function(t){
      const raw=String(t==null?'':t);
      const m=raw.match(/\d{1,2}:\d{2}(:\d{2})?/);
      return m?m[0]:(raw||'—');
    };
    const dur=function(sec){
      const s=Math.max(0,Math.round(Number(sec)||0));
      if(s<60) return s+' 秒';
      const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
      return h?(h+' 时 '+m+' 分'):(m+' 分');
    };
    const uid8=function(uid){ return String(uid||'').slice(0,8)||'—'; };

    function checkinCell(a){
      if(a.checkin_today===true){
        return U.pill('已签','ok')+(a.checkin_credit?' <span class="mono dim">+'+U.esc(a.checkin_credit)+'</span>':'');
      }
      if(a.checkin_today===false) return U.pill('未签','mute');
      return U.pill('—','mute');
    }
    function taskPill(t, reached){
      if(t.status==='claimed') return U.pill('已领取','ok');
      if(reached) return U.pill('待领奖','warn');
      if(t.status==='accepted'||t.status==='in_progress') return U.pill('进行中','info');
      if(t.status==='not_accepted') return U.pill('未接取','mute');
      return U.pill(t.status||'未知','mute');
    }

    async function load(manual){
      if(busy) return;
      busy=true;
      try{
        const res=await Promise.all([
          WB.scheduler(),
          WB.tasks(),
          WB.settings().catch(function(){ return null; })
        ]);
        const sched=res[0]||{}, tasks=res[1]||{}, settings=res[2]||null;
        const accts=tasks.accounts||[];
        const uids=accts.map(function(a){ return a.uid; }).slice(0,6);
        let progs=[], progErr='';
        if(uids.length){
          try{
            const p=await WB.tasksProgress(uids);
            progs=(p&&p.items)||[];
          }catch(e){ progErr=(e&&e.message)||String(e); }
        }
        if(ctx.stale()) return;
        paint(sched, tasks, settings, progs, progErr);
        if(manual) U.toast('已刷新','ok');
      }catch(e){
        if(ctx.stale()) return;
        if(!painted) throw e;
        U.toast('刷新失败：'+((e&&e.message)||e),'bad');
      }finally{
        busy=false;
      }
    }

    function paint(sched, tasks, settings, progs, progErr){
      const sc=(settings&&settings.schedule)?settings.schedule:null;
      const dc=sched.daily_chat||{};
      const accts=tasks.accounts||[];
      const tlist=tasks.tasks||[];
      const sum=tasks.summary||{};
      const travel=sum.travel||{};
      const pmap={};
      progs.forEach(function(p){ if(p&&p.uid) pmap[p.uid]=p; });

      const acctObj=tasks.account||null;
      const acctName=acctObj?(acctObj.nickname||uid8(acctObj.uid)):'—';
      const dcTimes=(dc.times&&dc.times.length)?dc.times:((sc&&sc.daily_chat_effective)||[]);
      const dcDone=dc.done_slots||[];
      const dcLive=(dc.live||[]).length;

      let checkinOk=0, checkinKnown=0, aggDone=0, aggTotal=0, aggAccts=0;
      accts.forEach(function(a){
        if(a.checkin_today===true){ checkinOk++; checkinKnown++; }
        else if(a.checkin_today===false){ checkinKnown++; }
        const p=pmap[a.uid]||null;
        const d=(p&&p.done!=null)?p.done:a.tasks_done;
        const t=(p&&p.total!=null)?p.total:a.tasks_total;
        if(d!=null&&t!=null&&Number(t)>0){
          aggDone+=Number(d)||0; aggTotal+=Number(t)||0; aggAccts++;
        }
      });

      const swPills=sc
        ? (U.pill('每日活跃 '+(settings.daily_activity===true?'开':'关'), settings.daily_activity===true?'ok':'mute')
          +' '+U.pill('网页活跃对话 '+(settings.daily_chat_web===true?'开':'关'), settings.daily_chat_web===true?'ok':'mute'))
        : U.pill('自动化开关不可读','mute');

      const topCards=U.cards([
        {k:'调度器', v:(sched.enabled?'启用':'已暂停'), n:'整点排程 · 额度窗口探针'},
        {k:'下次巡检', v:U.esc(clock(sched.next_run_time)), n:U.esc(sched.next_run_time||'待调度')},
        {k:'上次巡检', v:U.esc(clock(sched.last_run_time)), n:U.esc(sched.last_run_time||'尚未运行')},
        {k:'任务账号', v:String(accts.length), n:'今日已签 '+checkinOk+' · 可判定 '+checkinKnown},
        {k:'成长任务进度', v:(aggTotal?(aggDone+' / '+aggTotal):'—'),
          n:(aggAccts?(aggAccts+' 个账号有进度'):(progErr?'进度接口失败':'暂无进度缓存'))}
      ]);

      const dcWindowCell='<span class="mono">'+U.esc(timesText(dcTimes))+'</span>'
        +(dc.random?' '+U.pill('当日随机','mute'):'');
      const dcNote='国际版每日活跃'
        +(dcTimes.length
          ?('；今日已跑 '+dcDone.length+' / '+dcTimes.length+' 时段'+(dc.next_slot?'，下次 '+U.esc(dc.next_slot):''))
          :'；未配置时段')
        +(dcLive?('；运行中 '+dcLive+' 个账号'):'');
      const hourCell=function(key){
        if(!sc) return '<span class="dim">—</span>';
        return '<span class="mono">'+U.esc(hoursText(sc[key]))+'</span>';
      };

      const schedRows=[
        ['<b>每日签到</b>','checkin',hourCell('checkin'),'Buddy 加油站签到，每次 +100 积分'],
        ['<b>猫猫旅行</b>','travel',hourCell('travel'),'派猫出行，归来后待领奖（奖励积分）'],
        ['<b>Token 保活</b>','keepalive',hourCell('keepalive'),'集中刷新凭证，避免 Token 过期掉线'],
        ['<b>夜猫任务</b>','cat',hourCell('cat'),'夜猫子任务，完成条件限定 23:00–08:00'],
        ['<b>网页活跃</b>','daily_chat',dcWindowCell,dcNote]
      ].map(function(r){
        return [r[0],'<span class="mono">'+U.esc(r[1])+'</span>',r[2],'<span class="dim">'+U.esc(r[3])+'</span>'];
      });

      const tierText=['7d','14d','28d'].map(function(k){
        const st=(sum.tier_statuses||{})[k];
        return k+':'+(st||'—');
      }).join(' · ');
      let travelV='未知', travelN='状态未知';
      if(travel.state==='arrived'){ travelV='待领奖'; travelN='归来奖励'+(travel.reward_credit?(' +'+U.esc(travel.reward_credit)+' 积分'):'待领'); }
      else if(travel.state==='traveling'){ travelV='旅行中'; travelN='预计稍后归来'; }
      else if(travel.daily_limit_reached){ travelV='今日已完成'; travelN='次日 00:00 刷新'; }
      else if(travel.state){ travelV='在家待命'; travelN='随时可出发旅行'; }

      const growthCards=U.cards([
        {k:'连续打卡', v:(sum.streak_days==null?'—':U.esc(String(sum.streak_days))), vsmall:'天', n:('连登档位 '+U.esc(tierText))},
        {k:'能量', v:(sum.energy==null?'—':U.esc(String(sum.energy))), n:'成长任务上报累计（当前余额）'},
        {k:'补签卡', v:(sum.makeup_cards==null?'—':U.esc(String(sum.makeup_cards))), vsmall:'张', n:'可补签漏掉的日期'},
        {k:'抽奖机会', v:(sum.lottery_chances==null?'—':U.esc(String(sum.lottery_chances))), vsmall:'次', n:'成长抽奖'},
        {k:'猫猫旅行', v:travelV, n:travelN}
      ]);

      const acctRows=accts.map(function(a){
        const p=pmap[a.uid]||null;
        const d=(p&&p.done!=null)?p.done:a.tasks_done;
        const t=(p&&p.total!=null)?p.total:a.tasks_total;
        const at=(p&&p.updated_at)?p.updated_at:a.progress_at;
        let progCell='<span class="dim">—</span>';
        if(d!=null&&t!=null&&Number(t)>0){
          progCell='<span class="mono">'+U.esc(d+' / '+t)+'</span> '+U.pct(Number(d)/Number(t)*100);
        }
        let srcCell='<span class="dim">—</span>';
        if(p){
          if(p.state==='fetched') srcCell=U.pill('上游拉取','info');
          else if(p.state==='cached') srcCell=U.pill('缓存','mute');
          else if(p.state==='error') srcCell=U.pill('失败','bad')+(p.error?'<div class="dim">'+U.esc(p.error)+'</div>':'');
        }
        return [
          '<b>'+U.esc(a.nickname||'—')+'</b>',
          '<span class="mono" title="'+U.esc(a.uid||'')+'">'+U.esc(uid8(a.uid))+'</span>',
          (a.credits_remain==null?'<span class="dim">—</span>':'<span class="mono">'+U.esc(U.num(a.credits_remain))+'</span>'),
          progCell,
          checkinCell(a),
          srcCell,
          (at?'<span class="mono">'+U.esc(U.ts(at))+'</span>':'<span class="dim">—</span>')
        ];
      });

      const taskRows=tlist.map(function(t){
        const cur=Number(t.current)||0, tgt=Number(t.target)||0;
        const reached=(t.status==='completed')||(tgt>0&&cur>=tgt);
        const progCell=(t.status==='claimed')
          ? '<span class="dim">已达成</span>'
          : (tgt>0?('<span class="mono">'+cur+' / '+tgt+'</span> '+U.pct(cur/tgt*100)):'<span class="dim">—</span>');
        const reward=((t.reward_credit?'<span class="mono">+'+U.esc(t.reward_credit)+'</span> 积分':'')
          +(t.reward_energy?' <span class="mono dim">+'+U.esc(t.reward_energy)+'</span> 能量':''))||'<span class="dim">—</span>';
        const desc=t.description?'<div class="dim">'+U.esc(t.description)+'</div>':'';
        const reason=t.reason?'<div class="dim">'+U.esc(t.reason)+'</div>':'';
        return [
          '<b>'+U.esc(t.name||t.task_code||'—')+'</b>'+desc,
          '<span class="mono">'+U.esc(t.task_code||'—')+'</span>',
          progCell,
          reward,
          taskPill(t,reached)+reason
        ];
      });

      const winRows=(sched.windows||[]).map(function(w){
        return [
          '<span class="mono">'+U.esc(w.uid8||uid8(w.uid))+'</span>',
          '<span class="mono">'+U.esc(w.model||'—')+'</span>',
          '<span class="mono">'+U.esc(dur(w.reset_in))+'</span>',
          '<span class="mono">'+U.esc(String(w.attempts==null?0:w.attempts))+'</span>',
          (w.last_result?U.esc(w.last_result):'<span class="dim">—</span>'),
          (w.cap?U.pill('已封顶','warn'):'<span class="dim">—</span>')
        ];
      });

      const logLines=(sched.logs||[]).slice(-20);

      if(ctx.stale()) return;
      el.innerHTML=
        '<h1>自动化</h1>'
        +'<p class="sub">调度时间表 · 成长任务福利 · 逐账号进度。本页只读：调度开关与任务时段在设置页维护，任务执行由后台调度器承担。</p>'
        +topCards
        +'<div class="toolbar">'
          +'<button class="btn mini" data-act="refresh">刷新</button>'
          +U.pill(sched.enabled?'调度器已启用':'调度器已暂停', sched.enabled?'ok':'warn')
          +' '+U.pill('任务账号 '+accts.length,'mute')
          +(dcLive?' '+U.pill('网页活跃运行中 '+dcLive,'info'):'')
          +(progErr?' '+U.pill('进度刷新失败','bad'):'')
          +' '+swPills
          +' <a class="btn mini" href="#/settings">自动化开关与时段 →</a>'
        +'</div>'
        +'<h2>调度时间表</h2>'
        +'<p class="sub">'+U.esc(sched.mode_cn||sched.mode||sched.msg||'调度器未运行')+'</p>'
        +(sched.mode_intl?'<p class="sub">'+U.esc(sched.mode_intl)+'</p>':'')
        +(sc?'':'<p class="sub">'+U.pill('/settings 读取失败，签到 / 旅行 / 保活 / 夜猫 时段无法确认','warn')+'</p>')
        +U.table(['任务','代码','生效窗口','说明'],schedRows)
        +'<h2>账号任务进度</h2>'
        +(accts.length
          ?(U.table(['账号','UID','剩余积分','任务进度','签到','进度来源','更新于'],acctRows)
            +(accts.length>6?'<p class="sub">进度接口单批最多 6 个账号，其余账号显示缓存值。</p>':''))
          :'<div class="empty">'+U.esc(tasks.msg||'未找到参与任务的国内版账号')+'</div>')
        +'<h2>成长任务</h2>'
        +(accts.length
          ?('<p class="sub">当前任务视图：<b>'+U.esc(acctName)+'</b> · 后端默认取首个国内版任务号</p>'
            +growthCards
            +U.table(['任务','代码','进度','奖励','状态'],taskRows,{empty:'该账号暂无成长任务'}))
          :'<div class="empty">'+U.esc(tasks.msg||'未找到参与任务的国内版账号')+'</div>')
        +(winRows.length
          ?('<h2>模型额度窗口</h2>'
            +'<p class="sub">调度器探针读到的上游 429 重置窗口（最多 10 条，按到点时间排序）。</p>'
            +U.table(['账号','模型','距重置','尝试','上次结果','上限'],winRows))
          :'')
        +'<h2>调度日志</h2>'
        +(logLines.length
          ?'<pre class="raw">'+U.esc(logLines.join('\n'))+'</pre>'
          :'<div class="empty">暂无调度日志</div>');
      painted=true;
    }

    el.addEventListener('click',function(e){
      const t=e.target;
      const btn=(t&&t.closest)?t.closest('[data-act="refresh"]'):null;
      if(!btn) return;
      if(busy) return;
      btn.disabled=true;
      btn.textContent='刷新中…';
      load(true);
    });

    await load(false);
    ctx.poll(load,30000);
  }
});
