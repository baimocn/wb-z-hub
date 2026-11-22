/* 页面：更新 —— 版本检查 / 安装队列 / 本地备份（结构对齐 overview.js） */
(function(){
const U=HUB.ui;

/* 安装任务状态（与 wb_update_request.VISIBLE_STATES 对齐） */
const INSTALL_STATES={
  idle:['空闲','mute'],
  queued:['已排队','warn'],
  downloading:['下载中','warn'],
  verifying:['校验中','warn'],
  backing_up:['备份中','warn'],
  stopping:['停止服务','warn'],
  applying:['写入中','warn'],
  restoring:['恢复中','warn'],
  restarting:['重启中','warn'],
  checking:['检查中','warn'],
  rolling_back:['回退中','warn'],
  succeeded:['安装成功','ok'],
  restored:['回退完成','ok'],
  rolled_back:['已回退','ok'],
  failed:['失败','bad'],
  unavailable:['状态不可用','bad']
};
const ACTIVE_STATES=['queued','downloading','verifying','backing_up','stopping',
  'applying','restoring','restarting','checking','rolling_back'];

function isActive(inst){
  return !!(inst&&ACTIVE_STATES.indexOf(String(inst.state||''))>=0);
}
function statePill(inst){
  if(!inst) return U.pill('无状态','mute');
  const hit=INSTALL_STATES[String(inst.state||'idle')];
  return hit?U.pill(hit[0],hit[1]):U.pill(String(inst.state||'未知'),'mute');
}
/* 后端的时间有两种形状：Unix 秒 / 已格式化的本地串 / ISO 串 */
function fmtTime(v){
  if(v===null||v===undefined||v==='') return '';
  const s=String(v);
  if(/^\d+$/.test(s)) return U.ts(Number(s));
  return s.replace('T',' ').slice(0,19);
}
function safeUrl(u){
  const s=String(u||'');
  return /^https?:\/\//i.test(s)?s:'';
}
function errText(e){ return (e&&e.message)?String(e.message):String(e||'未知错误'); }

HUB.register({
  route:'wb-updates', group:'wb', title:'更新', order:75,
  async render(el, ctx){
    const wb=HUB.api.wb;
    let latest=null;      /* {st, bk, stErr, bkErr} */
    let busy=false, again=false, painted=false;

    async function grab(fn){
      try{ return {value:await fn()}; }
      catch(e){ return {error:e}; }
    }

    async function load(){
      if(busy){ again=true; return; }
      busy=true;
      if(!painted){
        if(ctx.stale()){ busy=false; return; }
        el.innerHTML=U.loadHtml('正在读取版本与备份…');
      }
      const res=await Promise.all([grab(wb.updates), grab(wb.updatesBackups)]);
      busy=false;
      if(ctx.stale()) return;
      latest={
        st:res[0].value||null, bk:res[1].value||null,
        stErr:res[0].error||null, bkErr:res[1].error||null
      };
      paint();
      if(again){ again=false; load(); }
    }

    /* 后端 /updates/install 不读 body：安装目标固定为最近一次成功检查命中的 tag */
    function installBlock(st, inst){
      if(!st) return '状态不可用';
      if(st.last_error) return '请先成功检查更新';
      if(st.checking) return '检查进行中';
      if(!st.update_available) return '已是最新版本';
      if(!st.latest_tag) return '缺少候选 tag';
      if(!st.release_url) return '缺少发布页地址';
      if(st.install_enabled===false) return '安装执行器未配置';
      if(isActive(inst)) return '已有任务在运行';
      return '';
    }

    function confirmInstall(tag, version){
      const shown=tag||(version?('v'+version):'最新稳定版');
      U.openModal({
        title:'确认安装更新',
        body:'<p class="sub">即将把网关更新到 <b class="mono">'+U.esc(shown)+'</b>。</p>'+
          '<p class="sub">安装期间网关会停止服务并重启，进行中的请求会中断；执行器会先做整份本地备份，完成后可在下方备份列表看到。</p>'+
          '<p class="sub">安装目标由后端锁定为最近一次成功检查命中的稳定版，请求里的 tag 不参与决策。</p>'+
          '<p class="sub">当前候选 tag：<b class="mono">'+U.esc(shown)+'</b></p>',
        actions:[
          {label:'取消'},
          {label:'确认安装', kind:'danger', onClick:async function(){
            try{
              const r=await wb.updatesInstall(tag);
              if(ctx.stale()) return;
              U.toast((r&&r.message)||'更新任务已排队','ok');
            }catch(e){
              if(ctx.stale()) return;
              U.toast('安装失败：'+errText(e),'bad');
            }
            load();
          }}
        ]
      });
    }

    async function checkNow(btn){
      if(btn){ btn.disabled=true; btn.textContent='检查中…'; }
      let msg='检查完成', kind='ok';
      try{
        const r=await wb.updatesCheck();
        if(r&&r.ok===false){
          msg=(r.msg||'检查失败'); kind='warn';
        }else if(r&&r.skipped){
          msg='检查跳过：'+r.skipped; kind='warn';
        }else if(r&&r.update_available){
          msg='发现新版本 '+(r.latest_tag||('v'+r.latest_version));
        }else{
          msg='已是最新版本';
        }
      }catch(e){
        msg='检查失败：'+errText(e); kind='bad';
      }
      if(ctx.stale()) return;
      U.toast(msg,kind);
      await load();
    }

    function paint(){
      if(ctx.stale()||!latest) return;
      const st=latest.st, bk=latest.bk;
      const inst=(st&&st.installation)?st.installation:null;
      const backups=(bk&&bk.backups)?bk.backups:[];
      const completeCount=backups.filter(function(b){ return b.complete===true; }).length;
      const curRaw=(st&&st.current_version)?String(st.current_version):'';
      const latestV=(st&&st.latest_version)?String(st.latest_version):'';
      const latestTag=(st&&st.latest_tag)?String(st.latest_tag):'';
      const published=fmtTime(st&&st.published_at);
      const url=safeUrl(st&&st.release_url);
      const block=installBlock(st,inst);
      const instActive=isActive(inst);
      const instLabel=inst?((INSTALL_STATES[String(inst.state||'idle')]||['未知'])[0]):'空闲';
      const instPill=statePill(inst);

      let html='<h1>更新</h1>'+
        '<p class="sub">版本检查 / 安装队列 / 本地备份 · 只安装最近一次成功检查命中的稳定版</p>';

      if(st){
        html+=U.cards([
          {k:'当前版本', v:curRaw?('v'+U.esc(curRaw)):'—', n:'运行中的网关构建'},
          {k:'最新版本', v:latestV?('v'+U.esc(latestV)):'—', n:published?('发布 '+U.esc(published)):(latestV?'':'尚无检查结果')},
          {k:'更新可用', v:st.update_available?'是':'否', n:latestTag?('候选 '+U.esc(latestTag)):'无候选版本'},
          {k:'本地备份', v:bk?String(backups.length):'—', vsmall:bk?'份':'',
           n:bk?('完整 '+completeCount+' 份'+(bk.keep_backups_max?(' · 上限 '+U.esc(bk.keep_backups_max)):'')):'备份列表不可用'},
          {k:'安装任务', v:instLabel, n:(inst&&inst.version)?('目标 v'+U.esc(inst.version)):'无排队任务'}
        ]);
      }else{
        html+='<div class="empty">版本状态读取失败：'+U.esc(errText(latest.stErr))+'</div>';
      }

      html+='<div class="toolbar">'+
        '<button class="btn pri" id="upd-check" type="button">检查更新</button>'+
        '<button class="btn" id="upd-refresh" type="button">刷新</button>';
      if(st){
        html+=U.pill(st.enabled?'自动检查 开':'自动检查 关', st.enabled?'ok':'mute');
        html+=U.pill(st.install_enabled?'安装执行器 就绪':'安装执行器 未配置', st.install_enabled?'ok':'warn');
        if(st.checking) html+=U.pill('检查进行中','warn');
        if(st.last_error) html+=U.pill('最近检查失败','bad');
        if(latestV){
          html+=st.update_available?U.pill('可升级 '+(latestTag||('v'+latestV)),'warn'):U.pill('已是最新','ok');
        }else{
          html+=U.pill('尚未检查到版本','mute');
        }
      }
      html+='</div>';

      if(st){
        html+='<p class="sub">最近检查 <span class="mono">'+U.esc(fmtTime(st.last_attempt)||'—')+
          '</span> · 最近成功 <span class="mono">'+U.esc(fmtTime(st.last_success)||'—')+'</span>'+
          (st.last_error?(' · 最近错误 <span class="mono">'+U.esc(st.last_error)+'</span>'):'')+'</p>';
      }

      /* ── 可用版本 ── */
      html+='<h2>可用版本</h2>'+
        '<p class="sub">后端只评估最新稳定版，且安装接口不读取 tag；落库目标来自最近一次成功检查的结果。</p>';
      const verRows=[];
      verRows.push([
        '<span class="mono">'+(curRaw?('v'+U.esc(curRaw)):'—')+'</span>',
        '当前运行', '—', '—', '—', U.pill('当前','info')
      ]);
      if(latestV||latestTag){
        let action;
        if(!block){
          action='<button class="btn mini pri" type="button" data-install-tag="'+U.esc(latestTag||('v'+latestV))+
            '" data-install-version="'+U.esc(latestV)+'">安装</button>';
        }else{
          action='<span class="dim">'+U.esc(block)+'</span>';
        }
        verRows.push([
          '<span class="mono">'+(latestV?('v'+U.esc(latestV)):U.esc(latestTag))+'</span>',
          '稳定版',
          '<span class="mono">'+U.esc(latestTag||'—')+'</span>',
          U.esc(published||'—'),
          url?('<a href="'+U.esc(url)+'" target="_blank" rel="noopener">发布页 ↗</a>'):'—',
          action
        ]);
      }else{
        verRows.push(['—','稳定版','—','—','—',U.pill('尚未检查','mute')]);
      }
      html+=U.table(['版本','通道','标签','发布时间','发布页','操作'], verRows, {empty:'暂无版本信息，请先点「检查更新」'});

      /* ── 安装任务 ── */
      html+='<h2>安装任务</h2>';
      if(st){
        html+='<div class="toolbar">'+instPill+
          U.pill('目标 '+(inst&&inst.version?('v'+inst.version):'—'),'mute')+
          U.pill(st.install_enabled?'执行器就绪':'执行器未配置', st.install_enabled?'ok':'warn')+
          (instActive?U.pill('进行中','info'):'')+'</div>';
        if(inst&&inst.message){
          html+='<p class="sub">'+U.esc(inst.message)+
            (inst.updated_at?(' · 更新于 <span class="mono">'+U.esc(inst.updated_at)+'</span>'):'')+'</p>';
        }
        if(instActive){
          html+='<p class="sub">任务进行中，本页每 5 秒自动刷新；服务重启期间接口可能短暂失败。</p>';
        }
      }else{
        html+='<div class="empty">暂无安装任务状态</div>';
      }

      /* ── 本地备份 ── */
      html+='<h2>本地备份</h2>';
      if(bk){
        const keep=(bk.keep_backups===null||bk.keep_backups===undefined)?'—':bk.keep_backups;
        const keepMax=(bk.keep_backups_max===null||bk.keep_backups_max===undefined)?'—':bk.keep_backups_max;
        const src=bk.source==='systemd'?'系统服务':(bk.source==='local'?'本地目录':'未注册');
        html+='<p class="sub">保留 <span class="mono">'+U.esc(keep)+'</span> / 上限 <span class="mono">'+
          U.esc(keepMax)+'</span> 份 · 来源 '+U.esc(src)+
          ' · 回退执行器 '+(bk.rollback_enabled?U.pill('就绪','ok'):U.pill('未启用','warn'))+
          ' · 回退需在服务端执行（后端 /updates/rollback 未纳入 HUB.api）</p>';
        const bkRows=backups.map(function(b){
          const entrySrc=b.source==='systemd'?'系统服务':(b.source==='local'?'本地目录':src);
          const integrity=b.complete===true
            ?U.pill('完整','ok')
            :(U.pill('不完整','bad')+(b.reason?(' <span class="dim">'+U.esc(b.reason)+'</span>'):''));
          return [
            '<span class="mono">'+(b.version?('v'+U.esc(b.version)):'—')+'</span>',
            '<span class="mono">'+(Number(b.size_mb)||0).toFixed(1)+' MB</span>',
            '<span class="mono">'+U.esc(b.files||0)+'</span>',
            '<span class="mono">'+U.esc(fmtTime(b.created_at)||'—')+'</span>',
            integrity,
            U.esc(entrySrc)
          ];
        });
        html+=U.table(['版本','大小','文件数','创建时间','完整性','来源'], bkRows,
          {empty:'没有保留的备份（保留份数为 '+U.esc(keep)+'）'});
      }else{
        html+='<div class="empty">备份列表读取失败：'+U.esc(errText(latest.bkErr))+'</div>';
      }

      el.innerHTML=html;
      painted=true;

      const bCheck=el.querySelector('#upd-check');
      if(bCheck) bCheck.onclick=function(){ checkNow(bCheck); };
      const bRefresh=el.querySelector('#upd-refresh');
      if(bRefresh) bRefresh.onclick=function(){ load(); };
      const bInstalls=el.querySelectorAll('[data-install-tag]');
      for(let i=0;i<bInstalls.length;i++){
        bInstalls[i].onclick=function(){
          confirmInstall(this.getAttribute('data-install-tag'), this.getAttribute('data-install-version'));
        };
      }

      if(instActive){
        ctx.poll(function(){
          if(latest&&isActive(latest.st&&latest.st.installation)) load();
        },5000);
      }
    }

    await load();
  }
});
})();
