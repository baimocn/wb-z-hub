# Z·HUB — 本地网关前端（工业化重构版）

## 架构

```
zhub-ui/
├── index.html            入口：按序加载 styles → core → pages（新增页面=新增文件+一行 script）
├── styles/
│   ├── tokens.css        设计令牌（三层：原始→语义→组件；ckm-design-system 架构）
│   ├── base.css          reset/排版/骨架
│   └── components.css    组件样式（卡片/表格/徽章/按钮/模态/Toast）
├── js/core/
│   ├── api.js            API 单一事实源：wb + zc 全部端点（页面禁止裸 fetch）
│   ├── ui.js             UI 工具：esc/num/ts/pct/pill/table/cards/modal/toast/bars
│   └── router.js         页面注册表 + hash 路由 + 导航序号守卫（防慢接口竞态）
├── js/pages/*.js         页面模块，自注册 HUB.register({route,title,group,order,render})
└── docs/api-inventory.md 后端端点清单（方法/路径/载荷/所属页面）
```

## 页面模块契约

```js
HUB.register({
  route:'wb-media', group:'wb', title:'媒体', order:40,
  async render(el, ctx){
    const data=await HUB.api.wb.mediaModels();
    if(ctx.stale()) return;                    // 慢接口竞态守卫
    el.innerHTML=HUB.ui.table(...);
    ctx.poll(render, 8000);                    // 可选轮询
  }
});
```

- `group`：'wb' | 'zc' | 'system'（导航分组）
- 一切视图用 `HUB.ui`，一切请求用 `HUB.api`；观感与数据契约各只有一个来源。

## 服务

由 zcode2api（127.0.0.1:3001）以 StaticFiles 挂载在 `/hub/`，`/` 重定向至此。
后端：wb 网关子进程（/wb 反代）+ zcode2api /admin/api。
