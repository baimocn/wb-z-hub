/* 页面：基础设施 —— 出口槽位 / CodeArts 第三出口 / /health 健康卡 / 关服
 * 覆盖端点（HUB.api.wb）：proxySlots · codeartsOverview · codeartsModelsRefresh
 *                        codeartsCreditsRefresh · health · shutdown
 * 说明：api.js 未封装出口槽的写操作（save / test / discover / subbridge），
 * 故本页只呈现只读槽位表，增删改仍走原生看板（docs/api-inventory.md §10、§三.5）。 */
HUB.register({
  route:'wb-infra', group:'wb', title:'基础设施', order:80,
  async render(el, ctx){
    const U=HUB.ui, A=HUB.api.wb;

    /* 页内状态：关服后锁住轮询；loadSeq 丢弃过期响应（慢接口 + 轮询叠加） */
    let shuttingDown=false, loadSeq=0, bound=false;
    let lastModels=[];

    /* ── 小工具 ─────────────────────────────────────────── */
    const safe=p=>p.then(v=>({ok:true,value:v}), e=>({ok:false,error:e}));
    const text=v=>(v===null||v===undefined||v==='')?'—':String(v);
    const mono=v=>`<span class="mono">${U.esc(text(v))}</span>`;
    const nmono=v=>`<span class="mono">${U.num(v)}</span>`;
    const cr=v=>{
      if(v===null||v===undefined||v===''||isNaN(Number(v))) return '—';
      return Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
    };
    /* 出口地址可能带 user:pass@，只读表里把口令打码，host:port 仍可见 */
    const maskUrl=u=>String(u||'').replace(
      /^([a-zA-Z][\w+.-]*:\/\/)([^@/]+)@/,
      (s,scheme,cred)=>scheme+String(cred).split(':')[0]+':***@'
    );
    const h2=(title,meta)=>'<h2>'+U.esc(title)+
      (meta?' <small class="dim">'+meta+'</small>':'')+'</h2>';
    /* 表前小标题：.sub 本身只有下边距，这里补上边距把上一块表格隔开 */
    const caption=t=>'<div class="sub" style="margin-top:var(--sp-4)">'+U.esc(t)+'</div>';

    function failBox(title, res, hint){
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

    /* ── 健康卡 ─────────────────────────────────────────── */
    function healthSection(res){
      const head=h2('服务健康','GET /health · 匿名可通');
      if(!res.ok) return head+failBox('读取 /health 失败',res,'网关进程可能未启动。');
      const h=res.value||{};
      const tls=h.outbound_tls||{};
      const realms=Object.keys(h.accounts_by_realm||{});
      const caH=h.codearts||{};
      const media=h.media||{};

      let body=U.cards([
        {k:'<span>网关</span>'+U.pill(h.ok===true?'在线':'异常', h.ok===true?'ok':'bad'),
         v:h.ok===true?'UP':'DOWN', n:'进程存活即回 <span class="mono">ok:true</span>'},
        {k:'默认出口', v:U.esc(text(h.realm)), n:'WB 文本派发区域'},
        {k:'账号就绪', v:U.num(h.accounts_ready)+' / '+U.num(h.accounts), n:'全池可用 / 总数'},
        {k:'当前出口就绪', v:U.num(h.accounts_ready_current_realm), n:'当前区域可用号'},
        {k:'<span>加密</span>'+U.pill(h.crypto_ok?'PBKDF2 可用':'不可用', h.crypto_ok?'ok':'bad'),
         v:h.crypto_ok?'OK':'FAIL', n:U.esc(h.crypto_error||'面板口令散列正常')},
        {k:'出站 TLS', v:U.esc(text(tls.bridge_state)), n:U.esc('模式 '+text(tls.requested_mode)+
          (tls.last_fallback_reason?(' · 回退：'+tls.last_fallback_reason):''))},
      ]);

      body+='<div class="toolbar">'+
        U.pill(h.api_key_required?'API Key 必需':'匿名可调用', h.api_key_required?'warn':'info')+
        U.pill(!caH.configured?'CodeArts 未配置':(caH.ok?'CodeArts 在线':'CodeArts 异常'),
          !caH.configured?'mute':(caH.ok?'ok':'bad'))+
        (caH.configured?U.pill('CodeArts 账号 '+text(caH.healthy)+'/'+text(caH.accounts),'mute'):'')+
        U.pill('媒体入口 '+(media.enabled?'启用':'停用'), media.enabled?'ok':'bad')+
        (media.realm?U.pill('媒体出口 '+text(media.realm),'mute'):'')+
        '</div>';

      if(realms.length){
        const ready=h.accounts_ready_by_realm||{};
        body+=caption('按区域就绪')+U.table(['区域','账号','就绪','就绪率'],
          realms.map(r=>{
            const total=Number(h.accounts_by_realm[r])||0;
            const ok=Number(ready[r])||0;
            return [mono(r), nmono(total), nmono(ok), U.pct(total?ok/total*100:0)];
          }));
      }

      const mr=h.models_ready||{};
      const modelKeys=Object.keys(mr).sort();
      if(modelKeys.length&&realms.length){
        const shown=modelKeys.slice(0,12);
        body+=caption('按模型就绪'+(modelKeys.length>shown.length?
          '（共 '+modelKeys.length+' 个，示前 '+shown.length+'）':''))+
          U.table(['模型'].concat(realms), shown.map(m=>{
            const row=[mono(m)];
            realms.forEach(r=>row.push(nmono((mr[m]||{})[r])));
            return row;
          }));
      }

      if(media.enabled||media.tasks){
        const t=media.tasks||{};
        const rows=[
          ['启用', media.enabled?U.pill('是','ok'):U.pill('否','bad')],
          ['出口', mono(media.realm)],
          ['媒体槽', nmono(media.slots)],
          ['在飞', nmono(media.inflight)],
          ['视频并发上限', nmono(media.video_concurrency)],
        ];
        if(media.tasks){
          rows.push(['任务总数',nmono(t.total)]);
          rows.push(['待处理',nmono(t.pending)]);
          rows.push(['排队深度',nmono(t.queue_depth)]);
          rows.push(['工作线程',nmono(t.workers)]);
          rows.push(['并发 / 活跃 / 等待',
            nmono(t.concurrency)+' / '+nmono(t.active)+' / '+nmono(t.waiting)]);
          rows.push(['忙碌账号',nmono(t.busy_accounts)]);
          const bs=t.by_status||{};
          const statusKeys=Object.keys(bs).sort();
          if(statusKeys.length){
            rows.push(['按状态',statusKeys.map(k=>U.pill(k+' '+bs[k],'mute')).join(' ')]);
          }
        }
        body+=caption('媒体入口')+U.table(['项','值'],rows);
      }
      return head+body;
    }

    /* ── 代理槽位 ───────────────────────────────────────── */
    function slotLabel(slots,id,slotsOk){
      if(!id) return '<span class="dim">直连</span>';
      for(let i=0;i<slots.length;i++){
        if(slots[i].id===id) return mono(slots[i].label||slots[i].name||slots[i].id);
      }
      /* 槽位表读取失败时不能断定「已删除」，只回显绑定 id */
      return mono(id)+(slotsOk?' '+U.pill('已删除','warn'):'');
    }
    function slotsSection(res){
      if(!res.ok){
        return h2('代理槽位','GET /proxy/slots')+
          failBox('读取出口槽失败',res,hintFor(res));
      }
      const slots=(res.value&&res.value.slots)||[];
      const head=h2('代理槽位',slots.length+' 个 · GET /proxy/slots');
      const bar='<div class="toolbar">'+
        U.pill('只读视图','mute')+
        U.pill('绑定数 = WB + CodeArts 启用账号','mute')+
        U.pill('增删改与探测在原生看板完成','mute')+
        '</div>';
      const rows=slots.map(s=>{
        const kind=s.ip_type==='residential'?'住宅':(s.ip_type==='datacenter'?'机房':text(s.ip_type));
        const exit=s.ip
          ? '<div class="mono">'+U.esc(s.ip)+'</div><div class="dim">'+
            U.esc([s.country,kind==='—'?'':kind].filter(Boolean).join(' · ')||'国家未知')+
            (s.isp?' · '+U.esc(s.isp):'')+'</div>'
          : '<span class="dim">未探测</span>';
        return [
          '<b>'+U.esc(text(s.label||s.name||s.id))+'</b><div class="dim mono">'+U.esc(text(s.id))+'</div>',
          '<span class="mono">'+U.esc(maskUrl(s.url))+'</span>',
          exit,
          s.enabled===false?U.pill('已停用','mute'):U.pill('启用','ok'),
          nmono(s.bound||0),
          '<span class="mono">'+U.ts(s.probed_at)+'</span>'
        ];
      });
      return head+bar+U.table(['槽位','代理地址','出口','状态','绑定','探测时间'],rows,
        {empty:'还没有代理槽位。到原生看板的「设置 → 出口槽」添加或自动发现。'});
    }

    /* ── CodeArts 第三出口 ──────────────────────────────── */
    function codeartsSection(res, slots, slotsOk){
      const head=h2('CodeArts 出口','GET /codearts/overview');
      if(!res.ok) return head+failBox('读取 CodeArts 总览失败',res,hintFor(res));
      const ca=res.value||{};
      const st=ca.stats||{};
      const health=ca.health||{};
      const accounts=ca.accounts||[];
      const models=ca.models||[];

      let body='<div class="toolbar">'+
        U.pill(ca.online?'在线':'离线', ca.online?'ok':'bad')+
        U.pill(health.ok?'健康检查通过':'健康检查未通过', health.ok?'ok':'bad')+
        U.pill('base '+text(ca.base_url),'mute')+
        '<button class="btn" data-act="ca-models">刷新模型清单</button>'+
        '<button class="btn" data-act="ca-credits">刷新积分</button>'+
        '</div>';

      body+=U.cards([
        {k:'<span>在线</span>'+U.pill(ca.online?'在线':'离线', ca.online?'ok':'bad'),
         v:ca.online?'ON':'OFF', n:'出口 '+U.esc(text(ca.base_url))},
        {k:'健康账号', v:U.num(st.healthy)+' / '+U.num(st.total),
         n:'冷却 '+U.num(st.cooling)+' · 停用 '+U.num(st.disabled)},
        {k:'剩余积分', v:cr(st.credits), vsmall:'credit',
         n:'总额 '+cr(st.credits_total)+' · 已用 '+cr(st.credits_used)},
        {k:'模型', v:U.num(models.length), n:'CodeArts 目录并集'},
      ]);

      const accountRows=accounts.map(a=>{
        const state=a.disabled?U.pill('已停用','mute')
          :(a.cooling?U.pill('冷却中','warn'):U.pill('正常','ok'));
        const credit=a.credits?cr(a.credits.remain):'—';
        const creditNote=a.credits&&a.credits.amount!=null
          ?'<div class="dim">总额 '+cr(a.credits.amount)+'</div>':'';
        const checkin=a.checkin&&a.checkin.ok
          ?U.pill('已签到','ok')+'<div class="dim mono">'+U.esc(text(a.checkin.checked_at))+'</div>'
          :U.pill('未签到','mute');
        return [
          '<b>'+U.esc(text(a.nickname||a.name||a.uid))+'</b><div class="dim mono">'+U.esc(text(a.uid))+'</div>',
          state,
          '<span class="mono">'+U.esc(credit)+'</span>'+creditNote,
          nmono(a.models),
          slotLabel(slots,a.proxy_slot,slotsOk),
          checkin,
          '<span class="mono">'+U.esc(text(a.token_remaining))+'</span>'
        ];
      });
      body+=caption('账号（'+accounts.length+'）')+
        U.table(['账号','状态','剩余积分','模型','出口槽','签到','令牌剩余'],accountRows,
          {empty:'还没有 CodeArts 账号。OAuth 添加在原生看板完成。'});

      if(models.length){
        const shown=models.slice(0,10);
        body+=caption('模型目录（'+(models.length>shown.length?'示前 '+shown.length+' / ':'')+
          models.length+' 个）')+
          U.table(['模型 ID','名称','说明'],shown.map(m=>[
            mono(m.id), U.esc(text(m.name||m.id)), U.esc(text(m.description))
          ]));
        if(models.length>shown.length){
          body+='<div class="toolbar"><button class="btn" data-act="ca-all-models">查看全部 '+
            models.length+' 个模型</button></div>';
        }
      }
      return head+body;
    }

    /* ── 危险操作 ───────────────────────────────────────── */
    function dangerSection(){
      return h2('危险操作')+
        '<div class="card">'+
          '<div class="k">关闭网关服务'+U.pill('不可撤销','bad')+'</div>'+
          '<div class="n">向 <span class="mono">POST /shutdown</span> 发送关闭指令：'+
            '<span class="mono">/wb</span> 进程先回包再退出，反代、面板、调度器与媒体任务线程一并停止；'+
            '需在服务器上重新启动进程才能恢复。</div>'+
          '<div style="margin-top:var(--sp-3)">'+
            '<button class="btn danger" data-act="shutdown">关闭网关服务</button>'+
          '</div>'+
        '</div>';
    }

    /* ── 渲染 ───────────────────────────────────────────── */
    function renderPage(d){
      const at=new Date().toLocaleTimeString('zh-CN',{hour12:false});
      const slotList=d.slots.ok?((d.slots.value&&d.slots.value.slots)||[]):[];
      return '<h1>基础设施</h1>'+
        '<p class="sub">代理出口 · CodeArts 第三出口 · 健康卡 · 关服开关</p>'+
        '<div class="toolbar">'+
          '<button class="btn" data-act="reload">立即刷新</button>'+
          U.pill('读数 '+at,'mute')+
          U.pill('每 30s 自动刷新','mute')+
        '</div>'+
        healthSection(d.health)+
        slotsSection(d.slots)+
        codeartsSection(d.ca,slotList,d.slots.ok)+
        dangerSection();
    }
    function shutdownHtml(r){
      const flag=(r&&r.shutting_down)?'shutting_down=true':'ok=true';
      return '<h1>基础设施</h1>'+
        '<p class="sub">关服指令已发出 · 页面轮询已停止</p>'+
        '<div class="card">'+
          '<div class="k">网关状态'+U.pill('已请求关闭','bad')+'</div>'+
          '<div class="v">OFFLINE</div>'+
          '<div class="n"><span class="mono">'+U.esc(flag)+'</span> · 进程将在 0.4s 内退出；'+
            '确认进程已重启后可重新检测。</div>'+
          '<div style="margin-top:var(--sp-3)">'+
            '<button class="btn" data-act="recheck">重新检测</button>'+
          '</div>'+
        '</div>';
    }

    /* ── 加载 ───────────────────────────────────────────── */
    async function load(){
      if(shuttingDown) return;
      const my=++loadSeq;
      const results=await Promise.all([
        safe(A.proxySlots()), safe(A.codeartsOverview()), safe(A.health())
      ]);
      if(my!==loadSeq) return;          /* 已有更新的加载，丢弃本次 */
      if(ctx.stale()) return;           /* 已离开本页 */
      const s=results[0], c=results[1], h=results[2];
      lastModels=c.ok?((c.value&&c.value.models)||[]):[];
      el.innerHTML=renderPage({slots:s,ca:c,health:h});
    }

    /* ── 动作 ───────────────────────────────────────────── */
    function showModels(){
      if(!lastModels.length){ U.toast('当前没有可展示的模型清单','warn'); return; }
      U.openModal({
        title:'CodeArts 模型清单（'+lastModels.length+' 个）',
        wide:true,
        body:U.table(['模型 ID','名称','说明'],lastModels.map(m=>[
          mono(m.id), U.esc(text(m.name||m.id)), U.esc(text(m.description))
        ])),
        actions:[{label:'关闭'}]
      });
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
        await load();
      }catch(e){
        U.toast((act==='ca-models'?'模型清单':'积分')+'刷新失败：'+e.message,'bad');
      }finally{
        if(btn&&btn.isConnected){ btn.disabled=false; btn.textContent=old; }
      }
    }

    async function doShutdown(){
      try{
        const r=await A.shutdown();
        shuttingDown=true;
        U.toast('已发送关闭指令，网关正在退出','ok');
        if(ctx.stale()) return;
        el.innerHTML=shutdownHtml(r);
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

    async function onAction(ev){
      const t=ev.target;
      const btn=t&&t.closest?t.closest('[data-act]'):null;
      if(!btn||!el.contains(btn)) return;
      const act=btn.getAttribute('data-act');
      if(act==='shutdown'){ openShutdown(); return; }
      if(act==='recheck'){ shuttingDown=false; await load(); return; }
      if(act==='reload'){ await load(); return; }
      if(act==='ca-all-models'){ showModels(); return; }
      if(act==='ca-models'||act==='ca-credits'){ await refresh(act,btn); return; }
    }

    function bind(){
      if(bound) return;
      bound=true;
      el.addEventListener('click',onAction);
    }

    /* ── 启动 ───────────────────────────────────────────── */
    if(ctx.stale()) return;
    el.innerHTML=U.loadHtml('拉取基础设施状态…');
    bind();
    await load();
    if(ctx.stale()) return;
    ctx.poll(function(){
      if(!document.hidden&&!shuttingDown) load();
    },30000);
  }
});
