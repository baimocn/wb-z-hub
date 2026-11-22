# Z·HUB — 本地 AI 网关统一控制台

零依赖前端 + 双域后端（WorkBuddy / ZCode），一套代码管理本地 AI 网关的账号池、用量、媒体生成、自动化与运维。

## 架构

```
zhub-ui/
├── index.html               前端入口（SPA，无 iframe，无构建工具，无 npm 依赖）
├── styles/                  设计令牌三层架构（原始→语义→组件）
├── js/core/                 API 单一事实源 + UI 工具 + 路由
├── js/pages/                17 个页面模块（自注册，新增页面=新增文件+一行 script）
├── docs/api-inventory.md    后端 152 个端点清单
├── backend/
│   ├── zcode2api/           ZCode 网关后端（FastAPI，管理 JWT 账号池 / 额度 / 领取 / 验证码）
│   └── wb-gateway/          WorkBuddy 网关后端（http.server，管理 WB 账号池 / 签到 / 媒体 / 代理）
└── README.md
```

## 前端

零构建、零 npm 依赖、零 iframe。纯原生 JS + CSS 变量。

```bash
# 由后端 StaticFiles 挂载，或任意静态服务器
python -m http.server 8080
open http://localhost:8080
```

### 页面模块契约

```js
HUB.register({
  route:'wb-media', group:'wb', title:'媒体', order:40,
  async render(el, ctx){
    const data=await HUB.api.wb.mediaModels();
    if(ctx.stale()) return;         // 慢接口竞态守卫
    el.innerHTML=HUB.ui.table(...); // HUB.ui 构建视图
    ctx.poll(render, 8000);         // 可选轮询
  }
});
```

- 一切请求走 `HUB.api`（单一事实源），一切视图走 `HUB.ui`（观感统一）
- 17 个页面模块覆盖后端全部 152 个端点

## 后端

### ZCode 网关（backend/zcode2api）

FastAPI 应用，管理 ZCode（zai）账号池：
- JWT 账号生命周期（OAuth 登录 / 刷新 / 禁用 / 指纹轮换）
- 套餐额度追踪与自动领取（含验证码求解）
- 请求代理（Anthropic Messages / OpenAI Chat 兼容）
- 会话亲和 + 多出口隔离 + 风控退避

```bash
pip install -r backend/zcode2api/requirements.txt
cd backend/zcode2api && python cli.py serve
```

### WorkBuddy 网关（backend/wb-gateway）

Python 单文件网关（wb_proxy.py ~29k 行），管理 WorkBuddy/CodeBuddy 账号池：
- 账号凭证（OAuth / 静态 Key）、签到、活跃、每日对话
- 文本对话代理 + 媒体生成（生图 / 生视频）
- 定价目录 / 用量聚合 / 调度器

## 设计系统

三层令牌（原始→语义→组件），暗色控制台风格。全部颜色/间距/字号/圆角走 CSS 变量，组件层零硬编码。

## 许可

见各子项目 LICENSE 文件。
