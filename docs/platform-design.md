# ExamPilot 平台设计（邀请制 / Pro / 推荐 / 生命周期）

> 状态：部署在 staging 环境，正式站未启用。

## 1. 组件
| 组件 | 是否受 Access 保护 | 作用 |
|---|---|---|
| 学习站 Worker（exampilot-class / exampilot-sync-staging） | 整站受保护 | 学习应用、/api/sync、/api/ai、/api/me、/api/admin，cron 每 15 分钟一次 |
| 欢迎站 Worker（exampilot-welcome / -staging） | 公开（noindex） | 介绍页、/apply /status /invite /account、/api/public/*（和学习站共用 D1，访问不到题库和学习 API） |
| D1 | — | 学习数据加平台表（0003_platform.sql） |
| Cloudflare Access | — | 邮箱 OTP 登录；白名单由平台按差异自动同步 |

## 2. 入口与 Access
- Access 不会给白名单外的邮箱发验证码，所以白名单外的人看不到拒绝页。引导靠两条路：①欢迎站首页的“申请加入”按钮；②登录页页脚文字。②是组织级设置，修改会影响到正式站。
- 应用的 `custom_deny_url` 指向欢迎站的 `/join`，再 302 跳到 `/apply`。被撤权后仍带着旧 Access 会话的人，或者被身份规则拒绝的人，会落到这里。
- 不设任何 Bypass。学习站全部路径仍受 Access 保护（部署脚本每次都会探测）。
- 自动授权流程：GET 策略 → 只增删 `{email}` 规则 → PUT 完整 include → 再 GET 复核。策略里出现非邮箱规则（everyone、域名、组）时立即停止，并给超级管理员发站内警报。不在 members 表里的邮箱保持不动。超级管理员邮箱永不移除。用 D1 作业锁串行执行，失败后 members.access_state 记为 failed，由 cron 重试。只有 D1 和 Access 都完成才算“已授权”。
- 撤权后旧 Access 会话立即失效：每个受保护 API 都会先走 `gate()`，要求 members.status=active。
- Token：只在 Worker Secret `CF_ACCESS_TOKEN` 里，权限只有 Account › Access: Apps and Policies › Edit。staging 使用专用 token；正式环境需单独签发一个。

## 3. 数据（0003_platform.sql，只增加不修改）
members、email_otps、rate_buckets、applications（部分唯一索引保证每个邮箱只有一条 pending）、invites（只存 token 哈希，每个邮箱只有一条 pending）、member_groups/links/tags、referral_links（随机 token）、referrals（referee_email UNIQUE）、pro_grants（权益流水，idem_key UNIQUE）、pro_suspensions（每人最多一条进行中）、pro_state（缓存投影）、appeals（每条推荐最多一次申诉）、admin_notices/reads、mail_outbox（dedupe_key UNIQUE）、deletion_log、audit_log、site_settings、job_locks。
- 回填：已有 identities 全部写入 members，ai_admins 中的人设为 super。ai_grants.enabled=1 转成永久 Pro（来源 legacy）。
- 兼容：旧代码不读新表。新代码把 Pro 状态镜像回 ai_grants，超级管理员身份镜像回 ai_admins，因此回滚到旧代码后权限保持一致。
- 回滚：先回滚代码；0003 的 down 迁移只删平台表，执行前必须先导出。

## 4. Pro 计算规则
- 永久授权有效期间，有限天数不计时（不消耗），到期日显示为“永久”。
- 有限授权按 (starts_at, id) 排成 FIFO 队列，顺序消耗。叠加方式是追加，例如管理员给 30 天、推荐 2×7 天，合计 44 天。
- 强制暂停：freeze 模式下暂停计时，continue 模式下照常计时；两种模式都禁止调用 AI。暂停期间产生的推荐奖励先冻结（held），解除暂停时从解除时刻开始生效。
- 撤销某一笔授权：只扣掉它尚未使用的部分（记录在 revoked_unused_ms），不会出现负数，也不形成欠款。
- 普通撤销只撤 admin/legacy 来源的授权，推荐奖励保留。
- 纠错不删除原记录，而是给原记录打上撤销标记，并写审计。人工补发分“推荐补发”（referral_manual）和“管理员赠送”（admin）两种来源。
- 提醒：到期前 3 天、前 1 天各发一次，到期时发通知，同一个到期日只发一次。如果授权时就已经晚于某个提醒点，就跳过那一次提醒。
- AI 权限每次请求都按流水重新计算，不读缓存。

## 5. 推荐
- 激活事件：成员审核通过后第一次通过验证登录（gate 记录 activated_at）。邀请路径和申请路径都以这一事件为准。奖励的幂等键是 `ref:<id>`。
- 自我推荐：同一邮箱、Gmail 点号或 + 别名，一律拒绝。
- 异常信号（只提示，不自动判定）：同一链接 24 小时内超过 5 次、推荐人历史拒绝率高、此前有被判无效的推荐。IP、校园网、共用设备不作为依据。
- 被标记的奖励先冻结，交超级管理员复核：判合法则发放；判违规则撤销未使用部分，用户可申诉一次，申诉成立则把撤走的部分补回。

## 6. 账号生命周期
- 管理员撤权、用户主动注销、6 个日历月不活跃（提前 30 天提醒），三种情况都是先停用，7 天后删除。7 天内恢复（或撤销注销）就取消删除。
- 不活跃按服务器记录的真实登录时间计算。长期保留的账号不参与不活跃清理；关闭长期保留后重新从提醒开始走流程。
- 删除前逐项复核：状态、期限、版本号（期间被恢复就中止）、账号只属于本人、不是最高管理员。删除范围：该账号在 ops/docs/clients/usage/ai_*/identities/accounts 里的行，以及平台个人行。审计和流水保留，但邮箱替换为哈希。
- 备份：D1 Time Travel 免费版保留 7 天。所以“删除”指在线库已删除，历史恢复点到期前仍保留旧数据。删除台账另外写进一个独立的 D1（DELETIONS_DB，恢复主库的 Time Travel 不会影响它）；恢复备份后调用 `POST /api/admin/deletions/reconcile`，把台账里已删除但又回来的账号再删一遍。不会用整库回滚代替单个用户的删除。

## 7. 邮件
- Cloudflare Email Sending 要给任意收件人发信，需要 Workers Paid 加 CF 托管域名，所以不用。
- 方案：Brevo 免费版（每天 300 封，REST API）。BREVO_API_KEY 放在 Worker Secret，MAIL_PROVIDER=brevo，MAIL_FROM 填已验证的发件人。
- 邮件先进入 outbox，靠 dedupe_key 保证幂等，失败按 1/5/30 分钟、2/6 小时退避，之后标为 dead。邮件失败不回滚账号操作。没有配置发件服务时状态记为 held，后台如实显示“未接通发信”。
- 管理员只收站内通知，不发邮件。

## 8. 安全
Turnstile 在服务端校验 → OTP 6 位、10 分钟、一次有效，存加盐 HMAC，每个验证码最多试 5 次，同一邮箱每分钟 1 次、每小时 5 次，同一 IP 每小时 20 次 → 验证通过后发 30 分钟的签名 HttpOnly SameSite=Strict cookie。POST 请求检查同源 Origin、自定义头和 JSON 内容类型。发送验证码的接口无论邮箱是否已注册都返回相同结果。邀请 token 用 24 字节随机数，库里只存哈希，7 天有效，只能接受一次。所有管理接口都在服务端校验角色，审核管理员只能访问申请和邀请相关接口。CSV 导出防公式注入并写审计。安全响应头/CSP 沿用既有配置，欢迎站另配一套独立 CSP。
