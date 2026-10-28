# 网页版

网页版把桌面版的前端构建为 Cloudflare Workers 静态资源，并可选启用账号与跨设备同步。题库、评分与复习算法与桌面版一致。

## 组成

| 部分 | 作用 | 部署脚本 |
| --- | --- | --- |
| 学习站 | 主应用，受 Cloudflare Access 保护 | `npm run web:deploy` |
| 同步后端 | Worker + D1：账号、邀请、权限、学习记录同步 | `tools/web/deploy-sync.mjs` |
| 欢迎站 | 公开首页与申请入口，无需登录 | `tools/web/deploy-welcome.mjs` |

学习站默认只在 `*.workers.dev` 上提供，自定义域名需要显式开启；启用后 `web:deploy` 会核对匿名访问必须被 Access 拦截，否则拒绝上传。

## 构建

```bash
npm run build:web        # 用本机 data/bank.json 构建完整题库版 → dist-web/
npm run build:web:demo   # 只用示例题库构建 → dist-web/
npm run web:verify       # 题库指纹一致性 + 产物不含 .env / 密钥 / 学习记录 / source map
```

构建产物写入 `dist-web/`，不覆盖桌面版的 `dist/`。完整版构建会把产物中的示例题库剔除，`web:verify` 会逐一核对 17 道示例题的 ID 与题干均不在产物中。

## 部署

```bash
npm run web:deploy -- --dry-run   # 只生成配置并打印目标地址
npm run web:deploy                # 需要手动输入 YES
```

上传前后都会检查 Access：根路径、本次全部静态资源、题库路径与随机路径的匿名请求必须全部 302 到 `https://<团队>.cloudflareaccess.com/cdn-cgi/access/login/<本站地址>`。任一路径返回 200 或其他位置都会中止上传。

自检失败时按提示回滚：

```bash
npx wrangler rollback --config wrangler.web.jsonc
```

同步后端与欢迎站：

```bash
node tools/web/deploy-sync.mjs staging|production
node tools/web/deploy-welcome.mjs staging|production
```

所需环境变量见 [README「部署所需环境变量」](../README.md#部署所需环境变量)。脚本不内置任何账户、资源或域名默认值，缺少变量会直接报错退出。

## 账号与同步

- 学习站通过 Cloudflare Access 完成身份校验（邮箱验证码），应用侧只信任 Access 签发的断言。
- 首次进入需要邀请或申请审批；角色区分普通成员、审核者与管理员。
- 学习记录默认保存在浏览器 IndexedDB；启用同步后写入 D1，按账号隔离，删除有独立账本可追溯。
- 两台设备同时作答同一场模拟考试会申请“考试租约”，避免重复计时。

## AI 助手

网页版提供 AI 助手：题目答疑、主观题参考评阅与对话历史。

- 由服务端代理转发到你自备的 OpenAI 兼容网关，密钥只存在于 Worker Secret。
- 按账号做并发租约，同一账号的超额请求返回 `429 BUSY` 并带 `Retry-After`。
- 管理员可按账号关闭 AI，关闭后聊天与学习数据均保留。
- 未配置网关时 AI 入口不可用，刷题、评分与同步不受影响。

## 数据边界

- 题库指纹不同的备份不会混入学习进度。
- 同步只传输学习记录，不传输题库本身；题库随构建产物下发。
- 部署脚本拒绝把保留域名与 `example.*` 地址交给邮件服务商，测试地址不会产生真实投递。
