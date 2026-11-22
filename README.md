# WB-Z-HUB

本地 AI 网关控制台。管你手里所有 Z.ai / WorkBuddy 的号，一个页面看完。

## 这是什么

你有一堆 ZCode / WorkBuddy 的号，散落在不同出口、不同套餐、不同状态。这个项目把它们拢到一个页面里：

- 谁的额度还剩多少、谁被限了、谁该续凭证了
- 发请求不再随机挑号——同一会话粘住同一个号，上游缓存才能命中
- 生图 / 生视频不用切客户端，网页上填参数直接提交
- 自动签到 / 活跃打卡 / 每日对话，定时跑，不用手动维护

前端无构建无 npm 无 iframe，纯 HTML + CSS + 原生 JS。打开浏览器就能用。

## 快速启动

```bash
# ZCode 网关（端口 3001，前端由它挂载）
cd backend/zcode2api
pip install -r requirements.txt
python cli.py serve

# WorkBuddy 网关（端口 18790，由 zcode2api 自动拉起）
cd backend/wb-gateway
python wb_proxy.py --port 18790

# 打开
# http://127.0.0.1:3001/hub/
```

## 怎么加一个页面

不需要碰路由、不需要碰导航、不需要碰构建配置。

在 `js/pages/` 下新建一个 `.js` 文件，写一个 `HUB.register`，完事：

```js
HUB.register({
  route:'my-page', group:'wb', title:'我的页面', order:50,
  async render(el, ctx){
    const data = await HUB.api.wb.usage();   // 请求走 HUB.api
    if(ctx.stale()) return;                  // 用户切走就别写了
    el.innerHTML = HUB.ui.cards([           // 视图用 HUB.ui
      {k:'请求量', v: data.requests},
    ]);
  }
});
```

然后在 `index.html` 里加一行 `<script src="js/pages/my-page.js"></script>`。路由、导航、竞态守卫、缓存，路由器全帮你处理了。

## 设计决策（以及踩过的坑）

**为什么不用 React/Vue？** 这个控制台就一个人用，引入框架意味着 node_modules、构建配置、热更新服务——维护成本大于收益。原生 JS 写 17 个页面，每个文件独立，改哪个不影响别的。

**为什么 API 要走单一事实源？** 之前页面各自 fetch，一个端点改了路径，你得翻 17 个文件找哪里用了它。现在所有端点集中在 `js/core/api.js`，后端改了你只需要改一处。

**为什么有竞态守卫？** 概览页同时拉 4 个接口（最慢的 /wb/accounts 要 650ms+），用户切到别的页面后，慢接口返回了，把新页面的 DOM 覆盖掉。路由器的 `NAV` 序号 + `ctx.stale()` 就是防这个的——过期的响应直接丢弃。

**为什么 wb 代理每个请求要 600ms？** wb_proxy 是单线程 http.server，每次请求从磁盘读 accounts/settings。代理层已经做了健康检查缓存（否则每请求还要多 600ms 建 AsyncClient），剩下的 600ms 是它自己的，改不动。

**3012 有两种。** `unusual activity` 是账号级风控（冷却+出口冻结）；`This client is not supported` 是请求级拒绝（该请求形态上游不认，换个号也没用）。混在一起处理会冷却健康号，把你的正常会话也打成 503。

**缓存有 30 秒 TTL。** 切页时命中缓存瞬时渲染，但数据最多滞后 30 秒。POST/DELETE 会自动失效缓存。日志和监控不缓存（实时）。

## 已知限制

- 单文件 `wb_proxy.py` 约 29k 行——历史原因，改起来要小心
- 账号凭证存在本地 JSON 文件里（accounts/*.json），没有加密——本地单用户场景够用
- 前端无 TypeScript、无测试框架——模块简单到类型标注的收益覆盖不了维护成本
- 工作流引擎并发跑 16 个子代理时容易把 Start Plan 的号打到 3012——控制在 3 并发以内

## 许可

见各子项目 LICENSE 文件。
