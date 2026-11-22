/* 页面：系统 —— 版本/健康/状态 + 危险操作（出口切换/连坐解除/关闭网关） */
HUB.register({
  route:'system', group:'system', title:'系统', order:95,
  async render(el, ctx){
    el.innerHTML=HUB.ui.loadHtml('拉取系统状态…');
    const [meta, st, health, realm, set] = await Promise.all([
      HUB.api.zc.meta(), HUB.api.zc.status().catch(e=>({error:e.message})),
      HUB.api.wb.health().catch(e=>({error:e.message})), HUB.api.wb.realmGet(),
      HUB.api.wb.settings().catch(()=>null),
    ]);
    if(ctx.stale()) return;
    const z=(meta.upstreams&&meta.upstreams.zcode)||{};
    const w=(meta.upstreams&&meta.upstreams.workbuddy)||{};
    const holds=(set&&set.restriction_holds)||{};
    el.innerHTML=`
    <h1>系统</h1><p class="sub">版本 / 健康 / 状态 · 危险操作在此，均有二次确认</p>
    <div class="grid">
      <div class="card"><div class="k">zcode-hub 版本</div><div class="v">${HUB.ui.esc(meta.version||'—')}</div><div class="n">zcode ${HUB.ui.esc(z.client||'—')} · 提示词锁 ${HUB.ui.esc(z.prompt_aligned||'—')}</div></div>
      <div class="card"><div class="k">WB 版本探测</div><div class="v" style="font-size:13px;font-family:var(--font-mono)">${HUB.ui.esc(Object.entries(w.probed||{}).map(e=>e[0]+' '+e[1]).join(' · ')||'—')}</div><div class="n">versionfeed 自动跟版</div></div>
      <div class="card"><div class="k">WB 健康</div><div class="v" style="font-size:13px;font-family:var(--font-mono)">${HUB.ui.esc(typeof health==='string'?health:JSON.stringify(health).slice(0,60))}</div><div class="n">/wb/health</div></div>
      <div class="card"><div class="k">ZC 状态</div><div class="v" style="font-size:13px;font-family:var(--font-mono)">${HUB.ui.esc(typeof st==='object'?JSON.stringify(st).slice(0,60):String(st))}</div><div class="n">/admin/api/status</div></div>
      <div class="card"><div class="k">WB 默认出口</div><div class="v">${HUB.ui.esc(realm&&realm.current||'—')}</div><div class="n"><button class="btn mini" id="btnRealm">切换出口</button></div></div>
    </div>
    <h2 style="color:var(--danger)">危险操作</h2>
    <div class="toolbar">
      <button class="btn danger" id="btnUnhold">解除风控连坐暂停</button>
      <button class="btn danger" id="btnShutdown">关闭 WB 网关服务</button>
      <span class="pill ${holds.cn?'warn':'ok'}">${holds.cn?('连坐冻结 cn '+holds.cn+'s'):'无连坐冻结'}</span>
    </div>`;
    el.querySelector('#btnRealm').onclick=async()=>{
      const to=(realm&&realm.current)==='cn'?'intl':'cn';
      if(!window.confirm('WB 默认出口切换为 '+to+'？')) return;
      try{ await HUB.api.wb.realmSet(to); HUB.ui.toast('已切换到 '+to,'ok'); HUB.register; location.reload(); }
      catch(e){ HUB.ui.toast('失败: '+e.message,'bad'); }
    };
    el.querySelector('#btnUnhold').onclick=async()=>{
      if(!window.confirm('解除风控连坐暂停？')) return;
      try{ await HUB.api.wb.restrictionReset(); HUB.ui.toast('已解除','ok'); }
      catch(e){ HUB.ui.toast('失败: '+e.message,'bad'); }
    };
    el.querySelector('#btnShutdown').onclick=async()=>{
      if(!window.confirm('确定关闭 WB 网关服务？进程退出后需重新运行启动脚本（看门狗也会自动拉起）。')) return;
      try{ await HUB.api.wb.shutdown(); HUB.ui.toast('关闭指令已发送','warn'); }
      catch(e){ HUB.ui.toast('已发送（连接随进程退出）','warn'); }
    };
  }
});
