# 网页版 AI（按账号授权）

## 原则
- 默认所有账号没有 AI：不显示任何 AI 入口，不发任何 AI 请求（只有一次 `GET /api/ai/status`）。
- 只有服务器决定谁能用：D1 `ai_grants.enabled=1`。查询失败一律按“不能用”处理。
- 管理员（`ai_admins`）只能用 `node tools/web/ai-admin.mjs <staging|production> add <邮箱>` 绑定到已登录过的账号；网页上没有任何接口能创建管理员。管理员 ≠ AI 使用权。
- 网关：Sub2API OpenAI 兼容。`AI_BASE_URL` / `AI_MODEL` 是 Worker 变量（`tools/web/deploy-sync.mjs` 写入），`AI_API_KEY` 只是 Worker Secret，部署不会覆盖它。浏览器拿不到 Key、Base URL、掩码 Key；`/api/ai/config` 永远 404。
- 没有每日/每月/Token/金额配额。只有技术保护：请求体大小、单账号并发、每分钟突发、超时、拒绝上游重定向。

## 接口
- `GET /api/ai/status` → `{allowed, admin, configured, model}`
- `POST /api/ai/qa`（SSE 或 JSON，与本地 `server/index.mjs` 同协议，契约测试 `tests/web-ai/contract.test.ts`）
- `POST /api/ai/grade`（严格 JSON 校验，非法结果失败，不编分数）
- `GET/POST /api/admin/ai-users`（仅管理员）

## 同步
- AI 聊天用同步 op：`ai_msg`（同一 msg.id 的 generating → done/cancelled/error，最终状态不会被回退）与 `ai_conv_del`（删除后离线消息不会复活）。
- 学习数据“重置”不删 AI 聊天；重置后新设备仍能收到设置与 AI 聊天（pull 对 settings/ai_* 不按 reset 截断）。
- AI 评阅仍走原 `ai_review` op（幂等，不重复计次）。

## 测试
- `npx vitest run tests/web-ai`（权限、凭据、流式、评阅、管理、跨设备同步、契约）
- staging 浏览器 E2E：`.web-build/ai-e2e.mjs`、`.web-build/ai-xdev.mjs`（staging 用 mock 网关 Worker `exampilot-ai-mock`，仅服务绑定可达）。
- 真实网关测 staging：`EXAMPILOT_STAGING_REAL_AI=1 node tools/web/deploy-sync.mjs staging`。

## 回滚
- 先用开关，不动代码：在管理员页关闭对应账号的 AI，立即生效，会话数据与学习数据都保留。
- 代码回滚：`npx wrangler rollback --name exampilot-class <上一个版本>`（AI 上线前为 9094027d）。只回滚代码，不回滚数据库。
- 数据库：**不要**执行 `0002_ai.down.sql`，也不要用 Time Travel 把库恢复到升级前——两者都会丢掉升级后产生的数据（授权、审计、以及升级后写入的学习记录）。0002 只新增表，旧 Worker 可直接在新结构上运行（已用旧版 worker+客户端在迁移后的库上实测：学习记录读写正常、AI 聊天 op 原样保留、回到新版后全部可见）。
- 旧 Worker 会以 `unknown kind` 拒收仍开着的新版页面推送的 AI 聊天 op（逐条拒收，不阻塞学习记录同步；该条留在浏览器本地隔离区，不删除）。
- 升级前备份：`wrangler d1 export` 导出的 SQL（沙箱 `backups/`，带 SHA-256）和 Time Travel 书签，仅在数据库损坏这种极端情况下使用。