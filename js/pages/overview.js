/* 页面：概览 —— 参考实现（其余页面模块照此契约编写） */
HUB.register({
  route:'overview', group:'system', title:'概览', order:0,
  async render(el, ctx){
    const {wb,zc}=HUB.api;
    const [wa, zs, realm, set, meta] = await Promise.all([
      wb.accounts('all'), zc.accounts(), wb.realmGet(), wb.settings(), zc.meta()
    ]);
    if(ctx.stale()) return;
    const rows=wa.accounts||[];
    const byRealm=r=>rows.filter(a=>a.realm===r);
    const credits=rs=>rs.reduce((s,a)=>s+((a.credits||{}).remain||0),0);
    const keys=(set&&set.api_keys||[]).filter(k=>k.enabled).length;
    const holds=(set&&set.restriction_holds)||{};
    const zcRows=zs.accounts||[];
    const zcOk=zcRows.filter(a=>a.status==='active').length;
    const zcCool=zcRows.filter(a=>a.status==='cooling').length;
    const zcQuota=zcRows.reduce((s,a)=>{const q=a.quota&&Object.values(a.quota)[0];return s+(q?q.remaining:0);},0);
    const U=HUB.ui;
    el.innerHTML=`
    <h1>概览</h1><p class="sub">双域健康一屏看完 · WB 默认出口 <b class="mono">${U.esc(realm&&realm.current||'—')}</b> · zcode 网关 ${U.esc(meta.version||'—')}</p>
    ${U.cards([
      {k:'WORKBUDDY · 国内版', v:credits(byRealm('cn')).toFixed(0), vsmall:'credits', n:byRealm('cn').filter(a=>a.enabled).length+' 启用 / '+byRealm('cn').length+' 总数'},
      {k:'WORKBUDDY · 国际版', v:credits(byRealm('intl')).toFixed(0), vsmall:'credits', n:byRealm('intl').filter(a=>a.enabled).length+' 启用 / '+byRealm('intl').length+' 总数'},
      {k:'WB API Keys', v:keys, n:holds.cn?('风控冻结 cn '+holds.cn+'s'):'无风控冻结'},
      {k:'ZCODE · 正常/冷却', v:zcOk, vsmall:'/ '+zcRows.length, n:zcCool?('冷却 '+zcCool+' 个（自动恢复）'):'无冷却'},
      {k:'ZCODE · 剩余额度', v:U.num(zcQuota), vsmall:'tokens', n:zcRows.length+' 个账号合计'},
      {k:'统一入口', v:'127.0.0.1:3001', n:'对话 /wb/v1（wb）· /v1（zcode）'},
    ])}
    <div class="toolbar">
      <span class="pill ${holds.cn?'warn':'ok'}">${holds.cn?('WB 文本派发冻结中 '+holds.cn+'s（防连坐）'):'WB 派发正常'}</span>
      <span class="pill mute">wb 账号 ${rows.length} · zc 账号 ${zcRows.length}</span>
    </div>`;
  }
});
