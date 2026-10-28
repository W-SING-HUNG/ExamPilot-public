# ExamPilot 云同步设计（网页版，协议 v1）

## 1. 目标与边界
- 同一 Cloudflare Access 验证邮箱 = 同一学习空间；不同邮箱严格隔离。
- 客户端离线优先：本地先写、立即显示，后台上传；服务器确认后才算“已同步”。
- 电脑版（desktop edition）不受影响：`main.tsx` 只有在 `IS_WEB_EDITION` 时使用 `CloudStoreProvider`。

## 2. 选型结论
| 方案 | 结论 | 原因 |
|---|---|---|
| Dexie Cloud | 不用 | 需要 Dexie Cloud 服务器（自托管需商业许可/付费托管），且有自己的账号体系，与 Access 冲突 |
| Replicache / Zero | 不用 | 需要自建 push/pull 服务端 + 许可证密钥；协议思想（mutation id、rebase）被采用 |
| PowerSync | 不用 | 需 PowerSync 服务 + Postgres/Mongo 源库，超出免费 Workers+D1 架构 |
| WatermelonDB | 不用 | 基于 SQLite/LokiJS，替换 Dexie 改动过大；其同步算法要点被采用 |
| **自研：操作日志 + Dexie + Workers + D1** | 采用 | 免费、可审计、与现有代码完全兼容；每个机制都对应上面项目里成熟的做法 |

### 借鉴的源码（实际阅读过）
- `Nozbe/WatermelonDB` `src/sync/impl/synchronize.js`：先拉后推；在同一个本地写事务里应用远端变更并推进 `lastPulledAt`；并发同步检测。→ `engine.pullOnce` 在一个 Dexie 事务里写入远端操作并推进游标，并带“游标未被其他标签页推进”的检查。
- `WatermelonDB` `markAsSynced.js`：只有内容在请求期间没变的记录才标记已同步。→ 文档（草稿/考试）回包时比较发送时的内容。
- `rocicorp/mono` `replicache/src/sync/push.ts`、`db/rebase.ts`：带 ID 的变更、服务器去重、未确认变更在已确认状态之上重放。→ 每个操作有全局唯一 ID；`foldLog` 把已确认操作（按服务器 seq）与本机待传操作（按创建顺序）一起折叠。
- `MikeLautensack/local-first-todo-app-demo` push/pull：只作为反例参考（无鉴权、内存存储、处理与 lastMutationID 非原子）。
- `powersync-ja/powersync-js` `CrudBatch.complete()`：上传成功后才从队列移除。→ 操作只有在服务器返回 ok/dup 后才变为 acked，拉取到 seq 后变 confirmed。
- `dexie/Dexie.js` `addons/dexie-cloud/src/middlewares/createMutationTrackingMiddleware.ts`：变更与待同步记录在同一事务。→ 这里“变更本身就是待同步记录”（一次原子写入）。

未直接复制任何上述项目的代码；全部代码为本项目自行实现。

## 3. 数据模型
### 服务器（D1，`worker/migrations/0001_init.sql`）
- `accounts(id, epoch, seq, reset_seq, bank_fp, status)`：账号、重置纪元、日志序号。
- `identities(provider, email → account_id, sub)`：已验证邮箱到账号的唯一映射（主键保证同一邮箱只有一个账号）。
- `ops(account_id, seq, op_id, client_id, epoch, kind, body, created_at, received_at)`：只增不改的操作日志；`PRIMARY KEY(account_id, seq)`、`UNIQUE(account_id, op_id)`。
- `docs(account_id, key, version, seq, deleted, body, holder, last_op_id)`：草稿与进行中的考试（带版本号）。
- `clients`、`usage_daily`：设备与用量（配额保护、可观测）。
- `occ_guard`：乐观并发守卫（见 5）。
### 客户端（每账号一个 IndexedDB：`exampilot-cloud-<accountId>`）
- `ops`（本地日志 + 待传队列）、`docs`、`meta`（游标/纪元）、`quarantine`（被隔离、未计入的数据）。
- 旧数据库 `exampilot-xigai` 只读，永不删除。

## 4. 操作类型
`attempt`（一次作答）、`mock`（交卷：成绩 + 本场全部作答，一个操作）、`import`（迁移/备份恢复：记录基线 + 历史）、`ai_review`、`hide_history`（清空历史）、`clear_qids`（清除错题）、`delete_mock`、`settings`（字段补丁）、`reset`。

## 5. 正确性要点
- **派生而非存储**：做题记录、正确率、掌握状态、复习间隔都由 `foldLog` 从操作日志确定性计算（按作答时间重放原有 `applyAttempt`），两台设备拿到同样的日志就得到完全一样的结果。
- **幂等**：操作 ID 唯一；服务器 `UNIQUE(account_id, op_id)` + 计划阶段去重；折叠阶段再按作答 ID 去重。
- **原子与并发**：一次推送 = 一个 D1 `batch()`（官方文档：batch 是一个 SQL 事务）。第一条语句是守卫：账号 seq 若在读取后变化则向 NOT NULL 列插入 NULL 使整个 batch 回滚，随后重新规划（最多 8 次，带抖动）。实测：并发推送 seq 连续无缺口。
- **删除传播**：清空历史/清除错题只作用于发起设备“看得到”的行（seq ≤ upto 或本机之前的操作），其他设备并发的新作答不会被误删。
- **重置**：`reset` 让纪元 +1；旧纪元的操作被服务器拒绝（`stale_epoch`），客户端放入隔离区并提示，不会复活数据，也不会丢弃。
- **设置**：字段级，按服务器顺序后写者胜，不看客户端时钟。
- **草稿**：文档 CAS（baseVersion）；旧版本不能覆盖新版本，冲突时提示用户选择。
- **考试**：`exam.current` 文档；开始时服务器把截止时间限定为“≤ 服务器当前时间 + 时长”；接管 = leaseGen+1（围栏令牌），旧设备保存/交卷被拒；交卷操作 ID 固定为 `mock:<runId>`，只结算一次；超时后提交的作答若与截止时保存的不同，以截止时的作答重新评分。

## 6. 身份与安全
- 身份只来自 `Cf-Access-Jwt-Assertion`：RS256 验签（JWKS 按 kid 缓存，未知 kid 触发刷新以适应轮换）、iss、aud、exp/nbf、type=app、email。
- 请求体里的 accountId 只用于比对（不一致 409），用于发现“旧标签页属于另一个账号”的情况。
- 写请求要求同源 Origin + JSON + 自定义头；体积/条数上限；每分钟限流；每账号每日 2 万操作配额。
- 不记录日志（Worker observability 关闭），不在错误中返回用户内容。

## 7. 旧数据迁移
扫描旧库 → 区分正式题与演示题 → 显示已验证邮箱和摘要 → 用户确认 → 先写本地备份并读回校验 → 生成内容派生 ID 的 import 操作 → 上传。重复执行不重复计数（ID 去重 + 记录内容去重 + 历史 ID 并集合并）。

## 8. 成本（Free 方案）
见交付报告中的估算与实测。轮询：页面可见且 5 分钟内有操作时 20 秒一次，否则 60 秒，隐藏时停止；失败指数退避（最长 2 分钟）。

## 9. 回滚
- 前端/Worker：`wrangler rollback --name exampilot-class` 回到上一个版本（旧版本不读 D1，云端数据原样保留）。
- 数据库：D1 Time Travel（Free 方案 7 天）+ `wrangler d1 export` 全量导出。
