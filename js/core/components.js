/* ─────────────────────────────────────────────────────────────
 * PageShell — 页面骨架 + 生命周期管理
 *
 * 每个页面的公共基建：
 * - 标题 / 副标题 / 工具栏 / 内容区的统一结构
 * - 轮询定时器的自动清理（切页时停）
 * - 事件监听的自动清理（切页时移除）
 * - 竞态守卫（路由切换后旧渲染丢弃）
 *
 * 用法：
 *   const shell = HUB.shell(el, ctx);
 *   shell.setTitle('账号池');
 *   shell.setToolbar('<button ...>');
 *   shell.setContent(html);
 *   shell.onCleanup(() => clearInterval(myTimer));
 * ───────────────────────────────────────────────────────────── */
HUB.shell = function(el, ctx){
  const cleanups = [];
  let destroyed = false;

  return {
    /** 页面是否仍然活跃（路由已切换 = false） */
    get alive(){ return !ctx.stale() && !destroyed; },

    /** 设置页面标题和副标题 */
    setTitle(title, sub){
      if(!this.alive) return;
      el.innerHTML = `<h1>${esc(title)}</h1><p class="sub">${esc(sub||'')}</p>`
        + `<div class="hub-toolbar"></div><div class="hub-content"></div>`;
    },

    /** 获取工具栏容器（在标题下方） */
    toolbar(){ return el.querySelector('.hub-toolbar'); },

    /** 获取内容区容器（在工具栏下方） */
    content(){ return el.querySelector('.hub-content'); },

    /** 直接写内容区 HTML */
    setContent(html){
      const c = this.content(); if(c && this.alive) c.innerHTML = html;
    },

    /** 注册清理回调（切页时自动执行） */
    onCleanup(fn){ cleanups.push(fn); },

    /** 设置轮询（自动清理） */
    poll(fn, ms){
      const t = setInterval(()=>{ if(this.alive) fn(); else stop(); }, ms);
      this.onCleanup(()=>clearInterval(t));
    },

    /** 绑定事件（自动清理） */
    listen(target, event, fn, opts){
      target.addEventListener(event, fn, opts);
      this.onCleanup(()=>target.removeEventListener(event, fn, opts));
    },

    /** 销毁：执行全部清理回调 */
    destroy(){ destroyed = true; cleanups.forEach(fn=>{ try{fn()}catch(e){} }); cleanups.length=0; },
  };
};

/* ─────────────────────────────────────────────────────────────
 * DataTable — 可排序 / 可筛选 / 可分页 / 可带行动作的数据表
 *
 * HUB.components.dataTable(container, {
 *   columns: [
 *     {key:'name', label:'名称', render:val=>`<b>${val}</b>`},
 *     {key:'credits', label:'积分', align:'right', format:U.num},
 *   ],
 *   rows: [...],                // 数据数组
 *   rowKey: 'uid',              // 行唯一键字段
 *   actions: row=>[{label, kind, onClick}],  // 可选，行操作按钮
 *   emptyText: '没有数据',
 * });
 * ───────────────────────────────────────────────────────────── */
HUB.components = HUB.components || {};
HUB.components.dataTable = function(container, opts){
  const rows = opts.rows || [];
  const cols = opts.columns || [];
  const U = HUB.ui;
  if(!rows.length){ container.innerHTML = `<div class="empty">${U.esc(opts.emptyText||'暂无数据')}</div>`; return; }

  const head = cols.map(c=>`<th${c.align==='right'?' style="text-align:right"':''}>${U.esc(c.label)}</th>`).join('')
    + (opts.actions ? '<th style="text-align:right">操作</th>' : '');
  const body = rows.map(r=>{
    const cells = cols.map(c=>{
      const raw = r[c.key];
      const html = c.render ? c.render(raw, r) : (c.format ? c.format(raw) : U.esc(raw??'—'));
      return `<td${c.align==='right'?' style="text-align:right;font-family:var(--font-mono)"':''}>${html}</td>`;
    }).join('');
    const act = opts.actions ? `<td style="text-align:right;white-space:nowrap">${
      opts.actions(r).map(a=>`<button class="btn mini${a.kind==='danger'?' danger':''}" data-row="${U.esc(r[opts.rowKey||'uid'])}" data-act="${U.esc(a.label)}">${U.esc(a.label)}</button>`).join(' ')
    }</td>` : '';
    return `<tr>${cells}${act}</tr>`;
  }).join('');

  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  // 行动作事件委托
  if(opts.actions){
    container.querySelectorAll('[data-act]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const row = rows.find(r=>String(r[opts.rowKey||'uid'])===btn.dataset.row);
        const act = opts.actions(row).find(a=>a.label===btn.dataset.act);
        if(act&&act.onClick) act.onClick(row);
      });
    });
  }
};

/* ─────────────────────────────────────────────────────────────
 * StatCard — 指标卡片网格
 *
 * HUB.components.statCards(container, [
 *   {label:'总账号', value:46, sub:'25 启用 / 21 停用'},
 *   {label:'总积分', value:'174589', unit:'credits'},
 * ]);
 * ───────────────────────────────────────────────────────────── */
HUB.components.statCards = function(container, items){
  const U = HUB.ui;
  container.innerHTML = `<div class="grid">${items.map(c=>`
    <div class="card"><div class="k">${U.esc(c.label)}</div>
    <div class="v">${U.esc(String(c.value))}${c.unit?`<small> ${U.esc(c.unit)}</small>`:''}</div>
    ${c.sub?`<div class="n">${c.sub}</div>`:''}</div>`).join('')}</div>`;
};

/* ─────────────────────────────────────────────────────────────
 * FilterBar — 声明式筛选栏
 *
 * HUB.components.filterBar(container, [
 *   {key:'realm', label:'域', options:[{value:'all',label:'全部'},{value:'cn',label:'国内'}]},
 *   {key:'state', label:'状态', options:[...]},
 * ], current, onChange);
 * ───────────────────────────────────────────────────────────── */
HUB.components.filterBar = function(container, filters, current, onChange){
  const U = HUB.ui;
  container.innerHTML = filters.map(f=>`
    <label>${U.esc(f.label)} <select data-filter="${U.esc(f.key)}">
      ${(f.options||[]).map(o=>`<option value="${U.esc(o.value)}"${current[f.key]===o.value?' selected':''}>${U.esc(o.label)}</option>`).join('')}
    </select></label>`).join('');
  container.querySelectorAll('[data-filter]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      current[sel.dataset.filter] = sel.value;
      onChange(current);
    });
  });
};
