/* ─────────────────────────────────────────────────────────────
 * 页面：ZC 账号池（zc-accounts）
 * 覆盖端点（全部经 HUB.api.zc.*，无裸 fetch）：
 *   accounts / accountAdd / accountDelete / accountEnabled /
 *   accountRotateFingerprint / accountsRefresh / accountRefresh /
 *   accountCodingLimits / loginStart / loginPoll
 * 视图全部经 HUB.ui：esc / num / ts / pct / pill / table / cards /
 *   openModal / toast / loadHtml / errHtml
 * ───────────────────────────────────────────────────────────── */
HUB.register({
  route:'zc-accounts', group:'zc', title:'ZC 账号池', order:70,
  async render(el, ctx){
    const U=HUB.ui;
    const state={filter:'all', q:''};
    let providers=['zai'];
    let totalRows=0;

    /* ── 状态映射：后端 Status 枚举 → 中文 + 语义色 ── */
    const ST={
      active:['正常','ok'],
      exhausted:['额度耗尽','warn'],
      cooling:['冷却中','warn'],
      invalid:['凭证失效','bad'],
      disabled:['已停用','mute']
    };

    /* ── 格式化小工具 ───────────────────────────── */
    function dur(sec){
      sec=Math.max(0,Math.floor(Number(sec)||0));
      if(!sec) return '0 秒';
      const d=Math.floor(sec/86400), h=Math.floor(sec%86400/3600),
            m=Math.floor(sec%3600/60), s=sec%60;
      if(d) return d+' 天 '+h+' 时';
      if(h) return h+' 时 '+m+' 分';
      if(m) return m+' 分 '+s+' 秒';
      return s+' 秒';
    }
    /* 归一 epoch 秒：兼容秒 / 毫秒 / ISO 字符串；无法解析返回 null */
    function epoch(v){
      if(v===null||v===undefined||v==='') return null;
      if(typeof v==='number') return v>1e12? v/1000 : v;
      const str=String(v);
      if(/^\d+(\.\d+)?$/.test(str)){ const n=Number(str); return n>1e12? n/1000 : n; }
      const t=Date.parse(str);
      return isNaN(t)? null : t/1000;
    }
    function when(v){
      const e=epoch(v);
      if(e===null) return v===null||v===undefined||v===''? '—' : String(v);
      return U.ts(e);
    }
    function safeUrl(u){
      try{
        const x=new URL(String(u));
        return (x.protocol==='http:'||x.protocol==='https:')? x.href : '';
      }catch(e){ return ''; }
    }
    function short(s,n){
      s=String(s===null||s===undefined? '':s);
      return s.length>n? s.slice(0,n)+'…' : s;
    }
    function numOr(v){
      if(v===null||v===undefined||v==='') return '<span class="dim">—</span>';
      return '<span class="mono">'+U.num(v)+'</span>';
    }
    function copyText(t){
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(t).then(function(){ U.toast('授权链接已复制','ok'); },
          function(){ U.toast('复制失败，请手动选中链接','warn'); });
      } else {
        U.toast('当前环境不支持剪贴板，请手动复制','warn');
      }
    }

    /* ── 账号数据派生 ───────────────────────────── */
    function quotaOf(a){
      const q=(a&&a.quota)||{};
      const now=Date.now()/1000;
      let rem=0,total=0,models=0,valid=0;
      const rows=[];
      Object.keys(q).forEach(function(k){
        const w=q[k]||{};
        const r=Number(w.remaining)||0;
        let t=Number(w.total)||0;
        if(!t) t=(Number(w.used)||0)+r;
        const exp=epoch(w.expires_at);
        const expired=exp!==null && exp<=now;
        models++;
        if(!expired){ valid++; rem+=r; total+=t; }
        rows.push(k+'：'+U.num(r)+' / '+U.num(t)+
          (exp!==null? (' · '+(expired?'已过期':'到期 ')+U.ts(exp)) : ''));
      });
      return {rem:rem,total:total,models:models,valid:valid,rows:rows};
    }
    function quotaCell(a){
      const q=quotaOf(a);
      if(!q.models) return '<span class="pill mute">无快照</span>';
      const tip=U.esc(q.rows.join('；'));
      if(!q.valid) return '<span title="'+tip+'">'+U.pill('窗口已过期','warn')+'</span>';
      const ratio=q.total>0? (q.rem/q.total*100) : 0;
      return '<span title="'+tip+'">'+U.pct(ratio)+'</span>'+
        '<div class="mono dim" style="font-size:11px;margin-top:2px">'+
        U.num(q.rem)+' / '+U.num(q.total)+'</div>';
    }
    function planCell(a){
      const kind=a.plan_kind==='coding-plan'? ['Coding Plan','ok']
                : a.plan_kind==='start-plan'? ['体验套餐','info']
                : ['套餐未知','mute'];
      const p=a.plan||null;
      const name=p? (p.name||p.plan_id||'') : '';
      return U.pill(kind[0],kind[1])+
        (name? '<div class="dim" style="font-size:11px;margin-top:2px">'+U.esc(short(name,22))+'</div>' : '');
    }
    function coolCell(a){
      const out=[];
      const until=Number(a.cooling_until)||0;
      if(until*1000>Date.now()){
        out.push(U.pill('冷却剩余 '+dur(until-Date.now()/1000),'warn'));
      } else if(a.status==='cooling'){
        out.push(U.pill('冷却中','warn'));
      }
      const knb=Number(a.key_no_balance_remaining_s)||0;
      if(knb>0) out.push(U.pill('Key 无余额 '+dur(knb),'warn'));
      if(Number(a.risk_strikes)>0) out.push(U.pill('风控 '+a.risk_strikes,'warn'));
      return out.length? out.join(' ') : '<span class="dim">—</span>';
    }
    function fpText(a){
      const fp=a.fingerprint;
      if(!fp||!fp.device_mid) return '未分配设备指纹';
      return [fp.platform, fp.os_version,
              'MID '+String(fp.device_mid).slice(0,10),
              fp.timezone].filter(Boolean).join(' · ');
    }
    function limitPct(l){
      const n=Number(l.number), u=Number(l.usage);
      if(isFinite(n)&&n>0&&isFinite(u)) return Math.max(0,Math.min(100,u/n*100));
      const p=Number(l.percentage);
      if(isFinite(p)) return Math.max(0,Math.min(100,p));
      return 0;
    }
    let lastList=[];
    function findAccount(id){
      for(let i=0;i<lastList.length;i++){ if(lastList[i].id===id) return lastList[i]; }
      return null;
    }

    /* ── 过滤（纯前端，不发请求） ───────────────── */
    function applyFilter(){
      const q=String(state.q||'').trim().toLowerCase();
      let shown=0;
      el.querySelectorAll('tbody tr[data-id]').forEach(function(tr){
        const okSt=state.filter==='all'||tr.getAttribute('data-status')===state.filter;
        const okQ=!q||String(tr.getAttribute('data-text')||'').toLowerCase().indexOf(q)>=0;
        const vis=okSt&&okQ;
        tr.style.display=vis? '':'none';
        if(vis) shown++;
      });
      const c=el.querySelector('#zc-count');
      if(c) c.textContent='显示 '+shown+' / '+totalRows;
    }

    /* ── 添加账号（扫码授权 + 直接粘贴凭证） ─────── */
    function openAdd(){
      const m=U.openModal({
        title:'添加 ZC 账号',
        body:
          '<p class="sub" style="margin-top:0">方式一：生成授权链接，在浏览器完成扫码 / 授权，成功后账号自动入池；方式二：直接粘贴已有 JWT 或 API Key。</p>'+
          '<h2 style="margin-top:0">① 扫码 / 授权登录</h2>'+
          '<div class="toolbar">'+
            '<input id="lg-label" placeholder="账号名前缀（可选）" style="min-width:220px">'+
            '<button class="btn pri" id="lg-start">生成授权链接</button>'+
          '</div>'+
          '<div id="lg-box" class="dim" style="font-size:12px">尚未发起授权。</div>'+
          '<h2>② 直接添加凭证</h2>'+
          '<div class="toolbar">'+
            '<select id="ad-provider">'+
              providers.map(function(p){ return '<option value="'+U.esc(p)+'">'+U.esc(p)+'</option>'; }).join('')+
            '</select>'+
            '<input id="ad-name" placeholder="账号名（可选）" style="min-width:200px">'+
          '</div>'+
          '<textarea id="ad-tokens" rows="4" placeholder="每行一个 JWT / API Key" style="width:100%;resize:vertical"></textarea>'+
          '<div class="toolbar" style="margin-top:8px"><button class="btn" id="ad-submit">添加凭证</button></div>'+
          '<p class="dim" style="font-size:11.5px;margin:6px 0 0">JWT 以点号分三段；新增后会自动刷新额度并后台跑安装序 / 自动领取。</p>',
        actions:[{label:'关闭'}]
      });

      const box=m.querySelector('#lg-box');
      const startBtn=m.querySelector('#lg-start');
      let timer=null, settled=false;
      function stopTimer(){ if(timer){ clearInterval(timer); timer=null; } }

      startBtn.onclick=async function(){
        const label=(m.querySelector('#lg-label').value||'').trim();
        stopTimer();
        settled=false;
        startBtn.disabled=true;
        box.innerHTML=U.loadHtml('正在向上游申请授权链接…');
        try{
          const r=await HUB.api.zc.loginStart({label:label});
          if(!m.isConnected) return;
          startBtn.disabled=false;
          const flowId=(r&&r.flow_id)||'';
          const exp=Number(r&&r.expires_in)||300;
          const deadline=Date.now()+exp*1000;
          const url=safeUrl(r&&r.authorize_url);
          const head='<div class="toolbar">'+
            '<span class="pill info" id="lg-state">等待授权</span>'+
            '<span class="pill mute" id="lg-left">剩余 '+dur(exp)+'</span>'+
          '</div>';
          if(!flowId){
            box.innerHTML=head+'<pre class="raw">'+U.esc(String((r&&r.authorize_url)||'上游未返回 flow_id'))+'</pre>';
            return;
          }
          if(url){
            box.innerHTML=head+
              '<p style="margin:2px 0 6px">'+
                '<a href="'+U.esc(url)+'" target="_blank" rel="noopener noreferrer">打开授权页 →</a> '+
                '<button class="btn mini" id="lg-copy">复制链接</button>'+
              '</p>'+
              '<pre class="raw" style="max-height:110px">'+U.esc(url)+'</pre>'+
              '<p class="dim" style="font-size:11.5px">在浏览器打开上述链接完成扫码 / 授权；本窗口每 2 秒自动轮询，成功后账号直接入池。</p>';
            const cp=box.querySelector('#lg-copy');
            if(cp) cp.onclick=function(){ copyText(url); };
          } else {
            box.innerHTML=head+'<pre class="raw">'+U.esc(String((r&&r.authorize_url)||'上游未返回可用的授权链接'))+'</pre>';
          }

          timer=setInterval(async function(){
            if(settled||!m.isConnected||ctx.stale()){ stopTimer(); return; }
            const leftEl=m.querySelector('#lg-left');
            if(leftEl) leftEl.textContent='剩余 '+dur((deadline-Date.now())/1000);
            let p;
            try{ p=await HUB.api.zc.loginPoll(flowId); }
            catch(e){ return; } /* 单次网络抖动保持轮询 */
            if(settled||!m.isConnected||ctx.stale()){ stopTimer(); return; }
            const st=(p&&p.status)||'pending';
            if(st==='pending'){
              const stEl=m.querySelector('#lg-state');
              if(stEl) stEl.textContent='等待授权…';
              return;
            }
            settled=true;
            stopTimer();
            if(st==='ready'){
              const acc=(p&&p.account)||{};
              box.innerHTML='<div class="toolbar">'+U.pill('授权成功，已入池','ok')+'</div>'+
                '<div class="mono" style="font-size:12px">'+U.esc(acc.name||'新账号')+
                (acc.id? (' · '+U.esc(acc.id)) : '')+'</div>'+
                '<p class="dim" style="font-size:11.5px">额度刷新与自动领取在后台进行；稍后可在列表点「刷新」查看最新额度。</p>';
              U.toast('账号已入池：'+(acc.name||'新账号'),'ok');
              draw(false);
              return;
            }
            box.innerHTML='<div class="toolbar">'+
              U.pill(st==='expired'? '授权会话已过期':'授权失败','bad')+'</div>'+
              '<p class="dim">'+U.esc((p&&p.message)||
                (st==='expired'? '请重新生成授权链接。':'上游拒绝本次授权。'))+'</p>';
          }, 2000);
        }catch(e){
          if(!m.isConnected) return;
          startBtn.disabled=false;
          box.innerHTML='<div class="toolbar">'+U.pill('发起失败','bad')+'</div>'+
            '<pre class="raw">'+U.esc((e&&e.message)||String(e))+'</pre>'+
            '<p class="dim" style="font-size:11.5px">上游登录初始化失败时请稍后重试。</p>';
        }
      };

      const addBtn=m.querySelector('#ad-submit');
      addBtn.onclick=async function(){
        const provider=m.querySelector('#ad-provider').value;
        const name=(m.querySelector('#ad-name').value||'').trim();
        const raw=m.querySelector('#ad-tokens').value||'';
        const tokens=raw.split(/[\s,]+/).filter(Boolean);
        if(!tokens.length){ U.toast('请输入至少一个 Token / API Key','warn'); return; }
        addBtn.disabled=true;
        try{
          const r=await HUB.api.zc.accountAdd({provider:provider, tokens:tokens, name:name||undefined});
          U.toast('已添加 '+((r&&r.count)||tokens.length)+' 个账号','ok');
          if(m.isConnected) U.closeModal();
          await draw(false);
        }catch(e){
          U.toast((e&&e.message)||String(e),'bad');
        }finally{
          if(addBtn.isConnected) addBtn.disabled=false;
        }
      };
    }

    /* ── Coding 平面额度（coding_limits） ────────── */
    async function showLimits(a){
      const m=U.openModal({
        title:'Coding 平面额度 · '+a.name,
        wide:true,
        body:U.loadHtml('查询上游额度…'),
        actions:[{label:'关闭'}]
      });
      let res;
      try{ res=await HUB.api.zc.accountCodingLimits(a.id); }
      catch(e){
        if(m.isConnected) m.querySelector('.modal-body').innerHTML=
          '<pre class="raw">'+U.esc((e&&e.message)||String(e))+'</pre>';
        return;
      }
      if(!m.isConnected) return;
      const body=m.querySelector('.modal-body');
      if(res&&res.error){
        body.innerHTML='<div class="toolbar">'+U.pill('查询失败','bad')+'</div>'+
          '<pre class="raw">'+U.esc(res.error)+'</pre>'+
          '<p class="dim" style="font-size:11.5px">Coding 平面（api.z.ai）与 Plan 通道是两套账本；体验套餐账号常返回「无 coding plan」，属正常现象。</p>';
        return;
      }
      const ls=(res&&res.limits)||[];
      body.innerHTML='<p class="sub">Coding 平面（api.z.ai monitor）额度 · 与 Plan 通道账本独立</p>'+
        U.table(
          ['类型','单位','配额','已用','剩余','占比','下次重置'],
          ls.map(function(l){
            const p=limitPct(l);
            return [
              U.esc(l.type||'—'),
              U.esc(l.unit||'—'),
              numOr(l.number),
              numOr(l.usage),
              numOr(l.remaining),
              U.pct(p)+' <span class="mono dim">'+p.toFixed(0)+'%</span>',
              '<span class="mono">'+U.esc(when(l.next_reset_time))+'</span>'
            ];
          }),
          {empty:'该账号未返回 coding 平面额度'}
        );
      if(!ls.length&&res&&res.raw){
        body.innerHTML+='<pre class="raw" style="margin-top:12px">'+
          U.esc(JSON.stringify(res.raw,null,2).slice(0,4000))+'</pre>';
      }
    }

    /* ── 行内动作 ───────────────────────────────── */
    async function run(btn, fn){
      const old=btn.textContent;
      btn.disabled=true;
      btn.textContent='处理中…';
      try{ await fn(); }
      catch(e){ U.toast((e&&e.message)||String(e),'bad'); }
      finally{ if(btn.isConnected){ btn.disabled=false; btn.textContent=old; } }
    }

    async function doRowAct(btn, a){
      const act=btn.getAttribute('data-act');
      if(act==='toggle'){
        await run(btn, async function(){
          await HUB.api.zc.accountEnabled(a.id, !a.enabled);
          U.toast((a.enabled? '已停用 ':'已启用 ')+a.name,'ok');
          await draw(false);
        });
        return;
      }
      if(act==='refresh'){
        await run(btn, async function(){
          const r=await HUB.api.zc.accountRefresh(a.id);
          if(r&&r.ok) U.toast('额度已刷新：'+a.name,'ok');
          else U.toast((r&&r.message)||'刷新失败','warn');
          await draw(false);
        });
        return;
      }
      if(act==='limits'){ showLimits(a); return; }
      if(act==='fp'){
        if(!window.confirm('换发「'+a.name+'」的客户端指纹？\n将重置安装状态并自动重跑安装序。')) return;
        await run(btn, async function(){
          const r=await HUB.api.zc.accountRotateFingerprint(a.id);
          const mid=r&&r.fingerprint&&r.fingerprint.device_mid;
          U.toast('指纹已换发'+(mid? '：'+String(mid).slice(0,8)+'…':''),'ok');
          await draw(false);
        });
        return;
      }
      if(act==='del'){
        if(!window.confirm('删除「'+a.name+'」？\n此操作不可恢复，该账号的冷却与额度记忆会一并清除。')) return;
        await run(btn, async function(){
          const r=await HUB.api.zc.accountDelete([a.id]);
          U.toast('已删除 '+((r&&r.deleted!==undefined)? r.deleted : 1)+' 个账号','ok');
          await draw(false);
        });
      }
    }

    /* ── 全量刷新 ───────────────────────────────── *
     * 说明：api.js 的 zc.accountsRefresh 固定发 {}，后端只在 all:true 或 ids[]
     * 时才刷（admin_api.py refresh()）。因此先走全量接口；若目标数为 0 且池内
     * 有 JWT 号，则退化为逐个 accountRefresh（仍然只经 HUB.api）。          */
    async function refreshAll(btn){
      btn.disabled=true;
      btn.textContent='刷新中…';
      try{
        const r=await HUB.api.zc.accountsRefresh();
        let ok=Number(r&&r.summary&&r.summary.ok)||0;
        let fail=Number(r&&r.summary&&r.summary.fail)||0;
        let count=Number(r&&r.count)||0;
        if(!count){
          const ids=lastList.filter(function(a){ return a.mode==='jwt'; })
                            .map(function(a){ return a.id; });
          if(!ids.length){ U.toast('没有可刷新的 JWT 账号','warn'); return; }
          let done=0;
          for(let i=0;i<ids.length;i++){
            if(ctx.stale()) break;
            try{
              const one=await HUB.api.zc.accountRefresh(ids[i]);
              if(one&&one.ok) ok++; else fail++;
            }catch(e){ fail++; }
            done++;
            if(btn.isConnected) btn.textContent='刷新中 '+done+'/'+ids.length;
          }
          count=ids.length;
        }
        if(ctx.stale()) return;
        U.toast('刷新完成：成功 '+ok+' / 失败 '+fail+'（目标 '+count+'）','ok');
        await draw(false);
      }catch(e){
        U.toast((e&&e.message)||String(e),'bad');
      }finally{
        if(btn.isConnected){ btn.disabled=false; btn.textContent='刷新全部额度'; }
      }
    }

    /* ── 主绘制 ─────────────────────────────────── */
    async function draw(showLoad){
      if(ctx.stale()) return;
      if(showLoad) el.innerHTML=U.loadHtml('拉取 ZC 账号…');
      let data;
      try{ data=await HUB.api.zc.accounts(); }
      catch(e){
        if(ctx.stale()) return;
        el.innerHTML=U.errHtml(e);
        return;
      }
      if(ctx.stale()) return;

      const list=(data&&data.accounts)||[];
      const st=(data&&data.stats)||{};
      if(data&&Array.isArray(data.providers)&&data.providers.length) providers=data.providers;
      lastList=list;
      totalRows=list.length;

      const selCount=list.filter(function(a){ return a.selectable; }).length;
      const fpCount=list.filter(function(a){
        return a.fingerprint&&a.fingerprint.device_mid;
      }).length;
      const failRate=Number(st.calls)>0? (Number(st.fail||0)/Number(st.calls)*100) : 0;

      const rows=list.map(function(a){
        const fp=fpText(a);
        return [
          '<div><b>'+U.esc(a.name)+'</b> '+
            U.pill(a.mode==='jwt'? 'JWT':'API Key', a.mode==='jwt'? 'info':'mute')+
            (a.provider&&a.provider!=='zai'? ' '+U.pill(a.provider,'mute') : '')+
          '</div>'+
          '<div class="dim mono" style="font-size:11px" title="'+U.esc(fp)+'">'+
            U.esc(a.id)+' · '+U.esc(a.token_masked||'')+
          '</div>'+
          '<div class="dim" style="font-size:11px">指纹 '+U.esc(short(fp,42))+'</div>',
          (function(){
            const s=ST[a.status]||[a.status||'未知','mute'];
            let out=U.pill(s[0],s[1]);
            if(a.status==='active'&&a.selectable===false) out+=' '+U.pill('不派发','mute');
            return out;
          })(),
          quotaCell(a),
          planCell(a),
          coolCell(a),
          '<span class="mono">'+U.num(a.use_count)+'</span>'+
            '<div class="dim" style="font-size:11px">失败 '+U.num(a.fail_count)+'</div>',
          a.last_error
            ? '<span class="dim" title="'+U.esc(a.last_error)+'">'+U.esc(short(a.last_error,46))+'</span>'
            : '<span class="dim">—</span>',
          '<div style="display:flex;gap:4px;flex-wrap:wrap">'+
            '<button class="btn mini" data-act="toggle" data-id="'+U.esc(a.id)+'">'+(a.enabled? '停用':'启用')+'</button>'+
            '<button class="btn mini" data-act="refresh" data-id="'+U.esc(a.id)+'"'+
              (a.mode!=='jwt'? ' disabled title="仅 JWT 账号可查额度"' : '')+'>刷新</button>'+
            '<button class="btn mini" data-act="limits" data-id="'+U.esc(a.id)+'">额度</button>'+
            '<button class="btn mini" data-act="fp" data-id="'+U.esc(a.id)+'">换指纹</button>'+
            '<button class="btn mini danger" data-act="del" data-id="'+U.esc(a.id)+'">删除</button>'+
          '</div>'
        ];
      });

      const filterOpts=[
        ['all','全部状态'],['active','正常'],['exhausted','额度耗尽'],
        ['cooling','冷却中'],['invalid','凭证失效'],['disabled','已停用']
      ].map(function(o){
        return '<option value="'+o[0]+'"'+(state.filter===o[0]? ' selected':'')+'>'+o[1]+'</option>';
      }).join('');

      el.innerHTML=
        '<h1>ZC 账号池</h1>'+
        '<p class="sub">zcode JWT / API Key 账号 · 启停 / 额度刷新 / 指纹换发 / 扫码入池'+
          ' · 数据时间 <b class="mono">'+U.ts(data&&data.ts)+'</b></p>'+
        U.cards([
          {k:'账号总数', v:String(st.total||0), n:'可派发 '+selCount+' 个 · '+U.esc(providers.join(' / '))},
          {k:'正常', v:String(st.active||0), n:'凭证失效 '+(st.invalid||0)+' · 停用 '+(st.disabled||0)},
          {k:'额度耗尽 / 冷却', v:String(st.exhausted||0)+' / '+String(st.cooling||0), n:'冷却到期自动恢复'},
          {k:'累计调用', v:U.num(st.calls||0), n:'失败 '+U.num(st.fail||0)+'（'+failRate.toFixed(1)+'%）'},
          {k:'累计已用额度', v:U.num(st.quota_used||0), n:'跨重启 / 换套餐保留'},
          {k:'设备指纹', v:String(fpCount)+' / '+String(list.length), n:'已分配指纹的账号'}
        ])+
        '<div class="toolbar">'+
          '<button class="btn pri" data-top="add">+ 添加账号</button>'+
          '<button class="btn" data-top="refreshAll">刷新全部额度</button>'+
          '<button class="btn" data-top="reload">重新加载</button>'+
          '<span class="pill mute" id="zc-count">显示 '+list.length+' / '+list.length+'</span>'+
          '<span style="flex:1"></span>'+
          '<label for="zc-filter">状态</label>'+
          '<select id="zc-filter">'+filterOpts+'</select>'+
          '<input id="zc-q" placeholder="搜名称 / ID / 凭证" value="'+U.esc(state.q)+'" style="min-width:200px">'+
        '</div>'+
        '<h2>账号明细</h2>'+
        U.table(
          ['账号','状态','额度（剩余 / 配额）','套餐','冷却 / 风控','调用','最近错误','操作'],
          rows,
          {empty:'账号池为空：点「+ 添加账号」扫码授权或粘贴凭证'}
        );

      /* 给表格行打标记，供前端过滤用（HUB.ui.table 不暴露 tr 属性） */
      const trs=el.querySelectorAll('tbody tr');
      list.forEach(function(a,i){
        const tr=trs[i];
        if(!tr) return;
        tr.setAttribute('data-id',a.id);
        tr.setAttribute('data-status',a.status||'');
        tr.setAttribute('data-text',
          (String(a.name||'')+' '+String(a.id||'')+' '+String(a.token_masked||'')+' '+String(a.provider||'')).toLowerCase());
      });

      /* 顶部动作 */
      el.querySelectorAll('button[data-top]').forEach(function(b){
        b.onclick=function(){
          const act=b.getAttribute('data-top');
          if(act==='add'){ openAdd(); return; }
          if(act==='reload'){ draw(true); return; }
          if(act==='refreshAll'){ refreshAll(b); }
        };
      });

      /* 行内动作 */
      el.querySelectorAll('button[data-act]').forEach(function(b){
        b.onclick=function(){
          const a=findAccount(b.getAttribute('data-id'));
          if(a) doRowAct(b,a);
        };
      });

      const f=el.querySelector('#zc-filter');
      if(f) f.onchange=function(){ state.filter=this.value; applyFilter(); };
      const q=el.querySelector('#zc-q');
      if(q) q.oninput=function(){ state.q=this.value; applyFilter(); };

      applyFilter();
    }

    await draw(true);
    if(ctx.stale()) return;

    /* 15s 自动刷新：模态框打开或输入焦点在表单上时跳过，避免打断操作 */
    ctx.poll(function(){
      if(document.getElementById('hub-modal')) return;
      const ae=document.activeElement;
      if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA'||ae.tagName==='SELECT')) return;
      draw(false);
    }, 15000);
  }
});
