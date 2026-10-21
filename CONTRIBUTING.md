# 贡献指南

感谢你愿意为 ExamPilot 习概 做出贡献。本项目坚持轻量化：只做有实际价值的工程，不搞形式主义。

## 开发环境

- Node.js 20+
- npm 10+
- （浏览器 E2E 测试需要本机 Chrome）

```bash
git clone <your-fork>
cd ExamPilot
npm install
npm run dev
```

## 分支模型

| 分支 | 用途 |
| --- | --- |
| `main` | 稳定分支，仅接受 PR 合入，禁止直接推送与强制推送 |
| `feat/*` | 新功能 |
| `fix/*` | 缺陷修复 |
| `refactor/*` | 不改变外部行为的重构 |
| `docs/*` | 文档变更 |
| `chore/*` | 构建 / 依赖 / 配置 |

```bash
git checkout -b feat/my-feature main
```

## 提交规范（Conventional Commits）

```
<type>(<scope>): <subject>

<body>

<footer>
```

`type`：`feat` | `fix` | `refactor` | `docs` | `test` | `chore` | `perf` | `build` | `ci`

示例：

```
feat(mock): 支持按章节范围组卷

- 组卷配置新增章节多选
- 复用同一套学习记录，不新建进度系统

Closes #12
```

## 提交流程

1. 从 `main` 切出分支
2. 完成修改，确保本地全部检查通过
3. 推送分支，创建 Pull Request 并填写模板
4. CI 全绿后由维护者合入

## 本地检查（提交前必跑）

```bash
npm run typecheck        # TypeScript 类型检查
npm run lint             # ESLint
npm run format:check     # Prettier 格式
npm run check:public-info # 公开信息合规（暂存内容 + 提交元数据 + 禁止路径）
npm run test:public-info # 公开信息门禁自身的回归测试
npm test                 # 单元测试（公开示例题库）
npm run test:ai          # AI 代理契约测试
npm run build            # 生产构建
```

浏览器 E2E（可选，需要 dev server）：

```bash
npm run dev &
npm run test:browser
```

## 代码约定

- **题库与代码分离**：完整课程题库（`data/bank.json`、`data/local-bank.json`、`src/lib/local-bank.generated.ts`）与原始 PDF **永不提交**。公开仓库只含 `data/sample-bank.json`。
- **不伪造数据**：不得编造题库答案、掌握率或预测成绩；主观题必须保留「无标准答案」标记。
- **不覆盖题库事实**：题目、选项、答案一旦入库不得改写，只能修正解析错误并在 CHANGELOG 说明。
- **密钥只进服务端**：任何 API Key 不得出现在前端代码、构建产物或提交历史中。
- **测试要真实**：不要把没跑过的测试写成 PASS；测试命令必须对应 `package.json` 中真实存在的脚本。
- **公开信息最小披露**：内部研发过程、本地环境与协作方式不进入公开内容，见下方「公开信息治理」。

## 公开信息治理

公开交付遵循 [docs/information-governance.md](docs/information-governance.md)：

- 公开内容只包含产品功能、技术实现、可复现的测试结果与正式维护记录。
- 不得写入本地绝对路径、私人文件名、个人邮箱或内部工作过程。
- 描述验证结果时写明命令、范围与提交，不使用无证据的验收表述。
- 提交前运行 `npm run check:public-info`（检查暂存内容、提交元数据与禁止提交的文件路径）；该检查已纳入 CI，命中即失败。

> **不要重命名 CI 的 Job 名称。** `main` 的分支保护要求三个特定检查名称，重命名会使必需检查缺失、阻塞合并。新增检查请作为 Job 内的**步骤**添加。

## 新增题库 schema 变更

若必须改动作数据结构，请：

1. 在 `src/lib/types.ts` 更新类型
2. 同步更新 `data/sample-bank.json` 与 `tools/bank-local.mjs` 的校验逻辑
3. 在 CHANGELOG 记录破坏性变更与迁移方式

## 报告问题

请使用 Issue 模板，附上复现步骤、期望行为与实际行为。涉及安全问题请见 [SECURITY.md](SECURITY.md)，不要公开提交细节。

## 发布证据核验规则

对外报告 CI 状态、Release 测试结果或「CI 已通过」之前，必须逐项核对以下内容。**不得把未核对或核对不符的运行报告为 PASS。**

引用一条 Actions Run 作为主分支 CI 证据时，必须确认：

| 核对项 | 要求 |
| --- | --- |
| workflow 名称 | 必须是 `CI`（即 `.github/workflows/ci.yml`） |
| event | 必须是 `push`（PR 为 `pull_request`，二者含义不同，需说明） |
| actor | 必须是仓库成员，**不能是 `dependabot[bot]`** |
| head_sha | 必须与所声称的 commit SHA 一致 |
| Job 结果 | 三个核心 Job 全部 `success`，逐一点名列出 |

### 常见误报来源

Dependabot 会在**同一个 commit** 上触发额外的运行，特征为：

- workflow 名形如 `npm_and_yarn in / for <package> - Update #<id>`（或 `github_actions in / ...`）
- `event: dynamic`
- actor 为 `dependabot[bot]`
- 只有 1 个名为 `Dependabot` 的 Job

这类运行**不是**主分支 CI，即使结论是 `success` 也不能作为「main CI 通过」的证据。同理，PR 上的 CI 运行不能代表 main 分支状态。

### 核对方式

```bash
# 列出 main 上的运行，注意 name / event / actor 三列
gh api repos/<owner>/<repo>/actions/runs?branch=main \
  --jq '.workflow_runs[] | "\(.id)  \(.name)  event=\(.event)  actor=\(.actor.login)  \(.conclusion)"'

# 查看单条运行的 Job 明细
gh api repos/<owner>/<repo>/actions/runs/<run_id>/jobs \
  --jq '.jobs[] | "\(.name) -> \(.conclusion)"'
```

### 其他发布证据

- Release 必须核对 `prerelease` 字段与 `target_commitish`
- Tag 必须核对指向的 commit SHA（annotated tag 需再取一层 tag object）
- 报告「已启用」的 GitHub 设置必须来自 API 实测响应；端点返回 404 或状态为 `disabled` 时，
  必须如实报告「无法启用」并说明观察到的响应，**不得描述为已确认的原因或已启用**
