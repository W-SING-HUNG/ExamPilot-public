# 安全政策

## 报告漏洞

如果你发现安全漏洞，**请不要通过公开 Issue 提交**。

请通过 GitHub 的 private vulnerability reporting（仓库 → Security → Report a vulnerability）联系维护者，或发送邮件至仓库所有者在 GitHub 个人资料中公布的地址。

请在报告中包含：

- 受影响的版本与文件
- 复现步骤
- 潜在影响范围
- 你建议的修复方式（如有）

我们会在确认后尽快修复，并在 CHANGELOG 中致谢。

## 密钥处理

本项目的密钥边界如下：

| 位置 | 内容 | 是否进入 Git / 前端构建 |
| --- | --- | --- |
| `.env`（本地） | AI 网关凭据 | 否，`.gitignore` 已忽略 |
| `server/ai-config.json` | AI 网关凭据 | 否，`.gitignore` 已忽略 |
| 环境变量 `AI_API_KEY` 等 | AI 网关凭据 | 否 |
| 前端 `src/**` | **不含任何密钥** | — |

设计约束：

- AI 网关凭据只保存在服务端（Node 代理进程）内，前端通过 `/api/ai/*` 间接调用。
- 代理未配置时返回 `ok:false` 与明确原因，**不会伪造可用性**，也不会把密钥回显到响应中。
- `.env.example` 只含占位符，绝无真实凭据。

### 如果你怀疑密钥已泄漏

1. **立即在网关侧轮换（revoke / rotate）该 Key** —— 这是唯一有效的处置。
2. 检查 `.env`、`server/ai-config.json` 与 shell 历史是否被意外提交。
3. 若已进入 Git 历史，仅删除文件不够，需要重写历史；由于本仓库为单人维护，可直接联系维护者协助。

## AI 网关安全说明

- 请只使用你自己的网关地址，不要指向不可信的第三方端点。
- 代理对上游响应只做内容提取，不执行其中的指令；但 LLM 输出本质上不可信，应用层已把 AI 评阅明确标注为「参考评阅，非官方标准分数」。
- 建议为网关 Key 设置速率限制与配额，避免滥用。

## 依赖安全

- CI 使用 `npm ci` 安装锁定版本依赖。
- 建议开启 GitHub 的 Dependabot 安全更新。
- **常规依赖版本升级默认暂停**（`.github/dependabot.yml` 的 `open-pull-requests-limit: 0`）：
  本项目交付的是经过测试与验证的固定依赖集，自动提交的主/次版本升级会比人工验证更快地堆积，
  而未经验证的依赖变更正是不能进入 `main` 的内容。依赖**安全**告警与安全更新保持启用，
  暂停的只是常规版本更新；升级应由维护者主动发起，并附 `npm audit` 与完整测试结果后合入。
- 发现依赖漏洞请开 Issue 或 PR，附上 `npm audit` 输出。

## 数据与隐私

- 全部学习数据存储在浏览器 IndexedDB，不上传任何服务器。
- 导出文件由用户自行保管，请勿分享包含个人学习记录的备份。
- 代码库的公开信息边界与提交前门禁见
  [docs/information-governance.md](docs/information-governance.md)。
- 提交前运行 `npm run check:public-info` 检查凭据、本地路径与内部记录（CI 已强制）。
