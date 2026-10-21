<p align="center">
  <strong>ExamPilot 习概</strong><br/>
  《习近平新时代中国特色社会主义思想概论》期末智能复习系统
</p>

<p align="center">
  <a href="#"><img alt="version" src="https://img.shields.io/badge/version-0.2.0-blue"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-brightgreen">
</p>

<p align="center">
  <em>Open-source study cockpit for the "Introduction to Xi Jinping Thought on Socialism with Chinese Characteristics for a New Era" final exam.</em>
</p>

> **状态：v0.2.0。** 功能完整并通过自动化测试，但**仍缺乏大规模真实使用验证**——请不要把本版本当作已获长期使用检验的稳定产品。

---

ExamPilot 是一个开源、本地优先的期末复习应用：解析课程题库、按章节与题型组织训练、用间隔复习与错题再测提高覆盖率和正确率，并可选接入你自己的 LLM 网关做题目答疑与主观题参考评阅。


**题库不随仓库分发。** 公开仓库只包含一份自行编写的示例题库（17 题，涵盖全部 5 种题型），用于演示与 CI 测试；完整课程题库由你本地提供，仓库不包含、也未获授权再分发该题库。示例题按考点自行撰写，题干不复用未获授权的题库表述；其中 3 道主观题只有题干、没有参考答案，在应用内标记为「无官方标准答案」。

## 特性

界面按 7 个入口组织：**学习总览 / 复习计划 / 自由刷题 / 主观题训练 / 错题本 / 全真模拟**，以及底部的 **设置**。

- **学习总览** — 两个视图：*学习概览*（覆盖率、正确率、掌握数、待复习量、近 7 天曲线、薄弱点）与 *详细诊断*（按章节 / 题型 / 活动三视图、高频错误 TOP15、下一步建议）；练习历史从此进入
- **复习计划** — 间隔复习 + 错题再测 + 覆盖均衡合成当日任务
- **自由刷题** — 按章节 / 按题型 / 自定义三种模式共用一套筛选（章节 × 题型 × 题量），选题优先「到期复习 → 错题 → 未做」；同页可切到「查阅题库」只读检索，浏览不会产生作答记录
- **主观题训练** — 简答与材料分析题，提供答题结构参考，可提交 AI 参考评阅
- **错题本** — 只收录真实答错过的题，支持按章节与状态筛选复刷
- **全真模拟考试** — 考试规则配置一次即保存，之后直接开始；倒计时自动交卷、逐题复盘
- **设置** — 外观、复习间隔基数、AI 网关（可选）、数据备份与恢复、重置

练习历史（可筛选、可导出 CSV）与题库查阅（全文检索、来源页码、数据校验标记）保留为独立页面，从上述入口进入。

评分与统计严格基于真实作答：未作答不计为已练或已掌握；多选题必须选项集合完全一致；系统不生成预测分数。

## 快速开始

```bash
# 1. 安装依赖（postinstall 会自动生成题库加载器，无需额外步骤）
npm install

# 2. 启动开发服务器 → http://localhost:5173
npm run dev
```

此时应用使用内置示例题库，全部功能可用。

> 题库加载器 `src/lib/local-bank.generated.ts` 由构建脚本自动生成且不入库；`npm install`、`npm run dev`、`npm test`、`npm run typecheck` 与 `npm run build` 都会先确保它存在，因此在干净检出中无需手动干预。

### 启用完整课程题库（本地）

```bash
# 将完整题库放到 data/bank.json（schema 与 data/sample-bank.json 相同）
npm run bank:local   # 校验并安装到本地构建
npm run dev          # 重新启动
```

> `data/bank.json`、`data/local-bank.json` 与 `src/lib/local-bank.generated.ts` 均被 `.gitignore` 忽略，**永不提交**。

### AI 助手（可选）

```bash
cp .env.example .env    # 填写 AI_BASE_URL / AI_API_KEY / AI_MODEL
npm run server          # 启动 AI 代理 → http://127.0.0.1:8787
```

也可以在应用内「AI 助手」页面填写，配置写入 `server/ai-config.json`（同样被忽略）。

协议：OpenAI 兼容 `POST {baseUrl}/chat/completions`。**不配置也能正常使用**——刷题、评分、本地记录完全不受影响。

## 测试

```bash
npm test              # 单元测试（评分 / 调度 / 统计 / 导入导出 / 题库完整性）
npm run test:ai       # AI 代理契约测试（模拟网关，无需真实 Key）
npm run test:browser  # 浏览器 E2E（需先 npm run dev）
npm run typecheck     # TypeScript 类型检查
npm run lint          # ESLint
npm run format:check  # Prettier
```

CI 在 PR 与 `main` 更新时自动执行以上全部检查（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)），**不依赖私人题库或真实 API Key**。

## 构建

```bash
npm run build     # → dist/（使用本机已安装的题库；演示与本地开发用）
npm run preview   # 本地预览生产构建
```

### 对外分发构建

```bash
npm run build:public   # 强制公开题库 → 构建 → 校验产物
```

`npm run build:public` 会**忽略本机已安装的完整题库**，只把公开示例题库打进产物，然后按「正向交付清单」校验产物本身：必须包含示例题库的每一道题，且不得包含其他题库的题干、题库元数据、Source Map、本机绝对路径或凭据。

这一步是必要的：`src/lib/bank.ts` 静态导入生成器，在一台装有完整课程题库的机器上直接 `npm run build`，**该题库会被打进 `dist/`**，而从仓库里看不出来。对外分发请始终使用 `build:public`（或对已有产物运行 `npm run verify:release`）。

## 技术栈

React 18 · TypeScript · Vite · Dexie（IndexedDB）· Node 内置 http（AI 代理，零运行时依赖）

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层架构与数据流 |
| [docs/study-strategy.md](docs/study-strategy.md) | 复习算法、学习科学依据、参数与限制 |
| [docs/information-governance.md](docs/information-governance.md) | 公开信息分级、审查范围与推送前门禁 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交规范、开发流程、如何测试 |
| [SECURITY.md](SECURITY.md) | 漏洞报告、密钥处理、AI 网关安全 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 项目结构

```
src/
  lib/          types, scoring, scheduler, analysis, io, ai, bank, meta   ← 纯逻辑，可单测
  db/           Dexie schema
  store/        StoreContext（统一学习记录）+ hash 路由 + 会话守卫
  components/   QuestionCard / QuestionRunner / AiGradePanel / SessionView / FloatingAiAssistant / ui
  pages/        7 个主导航页 + 详情页（练习历史 / 题库查阅 / 数据备份）
server/         AI 服务端代理（零依赖）
tests/          AI 契约测试 + 浏览器 E2E + P0 回归
tools/          题库解析、本地题库安装、一键启动脚本
data/           sample-bank.json（公开）· bank.json（本地，忽略）
docs/           架构与复习策略文档
```

## 当前限制

- **考试要求未知**：模拟考试的默认规则只是模板，请按真实考纲在「设置考试规则」中填一次
- **主观题无标准答案**：题库仅提供题干；AI 评阅为参考评阅，非官方分数
- **数据仅在本地**：无云端同步，换设备请用「设置 → 数据备份」导出后恢复
- **AI 网关未内置**：需你自行提供 OpenAI 兼容网关，在「设置 → AI 网关」配置
- **模拟考试规则保存在本机浏览器**（localStorage），不会进入学习数据备份，也不随「重置学习数据」清除

## 免责声明

本项目为学习辅助工具。客观题答案以你导入的题库为准；AI 生成内容仅供参考，不构成官方答案或分数。请遵守课程与考试的相关规定。

## License

本项目采用 [MIT License](LICENSE)。

**Copyright (c) 2026 翁成航 (Chenghang Weng)**

版权边界说明：

- 上述版权声明仅覆盖本仓库中由项目作者自行编写的源代码、文档与配置
- 仓库**不包含**任何课程题库内容；完整课程题库由用户自行本地提供，本项目未获授权也不主张其版权
- 第三方依赖（React、TypeScript、Vite、Dexie 等）遵循其各自的开源许可，详见 `package.json`
- 示例题库 `data/sample-bank.json` 由项目作者自行编写，随本项目以 MIT 许可分发
