# 架构

ExamPilot 采用「纯逻辑内核 + React 表现层 + 本地持久化 + 可选 AI 代理」的分层结构。核心原则：**一套题库、一套学习记录、一套统计引擎**，所有训练模式（分章练习 / 专项 / 主观题 / 错题复刷 / 复习计划 / 全真模拟）都复用同一套内核，不存在第二套进度系统。

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│  UI 层  src/pages/*, src/components/*                        │
│  只负责渲染与交互，不含业务规则                                │
├─────────────────────────────────────────────────────────────┤
│  状态层  src/store/StoreContext.tsx                          │
│  统一学习记录的读写入口；hash 路由 src/store/router.ts         │
├─────────────────────────────────────────────────────────────┤
│  业务内核  src/lib/                                          │
│   scoring.ts    评分（严格集合判定）                           │
│   scheduler.ts  间隔复习、选题、组卷                           │
│   analysis.ts   统计、诊断、薄弱点                             │
│   io.ts         导入导出校验                                   │
│   bank.ts       题库加载（示例题库 / 本地完整题库）              │
│   ai.ts         AI 客户端（仅指向本地代理）                     │
├─────────────────────────────────────────────────────────────┤
│  持久化  src/db/database.ts  Dexie / IndexedDB               │
│   records(题目级进度) history(作答流水) mocks aiReviews settings│
├─────────────────────────────────────────────────────────────┤
│  AI 代理  server/index.mjs  零依赖 Node http 服务             │
│   持有密钥，向前端暴露 /api/ai/*，绝不回显密钥                 │
└─────────────────────────────────────────────────────────────┘
```

## 数据流

### 一次作答

```
用户选择答案
  → QuestionRunner.submit()
  → scoring.scoreAnswer(q, answer)        # 严格判定，null 表示不自动评分
  → StoreContext.submitAnswer()
      → scheduler.applyAttempt(rec, ok)   # 更新间隔、状态、下次复习时间
      → Dexie 事务写入 records + history   # 同一个事务，保证一致
  → UI 展示结果与解析（客观题答案来自题库，不经 AI）
```

### 模拟考试

```
MockExam 配置 → scheduler.buildPaper() 组卷
  → 答题（答案仅存组件状态）
  → 交卷：逐题 scoreAnswer() 计分
        → 同一 StoreContext.submitAnswer() 写入共享记录
        → saveMockRun() 存档该场考试
  → 逐题复盘
```

关键点：模拟考试**不创建独立进度系统**，交卷即写入与练习完全相同的 `records` / `history` 表。

### 诊断

```
computeDiagnosis(questions, records)
  → 章节统计（覆盖率 / 正确率 / 掌握 / 难点）
  → 题型统计
  → 薄弱点排序（覆盖率 40% + 正确率 60% 加权）
  → 学习活动（近 N 天）
```

所有指标由 `records` 真实汇总得出，不含任何估算或预测。

## 题库加载

```
src/lib/bank.ts
   ├─ window.__EXAMPILOT_BANK__     运行时导入（「导入导出」）
   ├─ LOCAL_BANK                   npm run bank:local 生成的本地加载器（git-ignored）
   └─ data/sample-bank.json        公开示例题库（17 题，自行编写）
```

`tools/bank-local.mjs` 负责校验 `data/bank.json`（唯一 ID、题型合法、客观题有选项与答案、判断题为布尔值）并生成本地加载器；无本地题库时写入 null 加载器，保证干净检出可安装、可构建、可测试。

## 持久化 schema

| 表 | 主键 | 说明 |
| --- | --- | --- |
| `records` | `qid` | 题目级进度：attempts / correctCount / wrongCount / intervalDays / ease / nextReviewAt / status |
| `history` | `id` | 作答流水：qid / mode / sessionId / answer / isCorrect / submittedAt / usedAI |
| `mocks` | `id` | 模拟考试存档：config / submissions / score / maxScore / perQuestion |
| `aiReviews` | `id` | AI 评阅记录：qid / userAnswer / result |
| `settings` | `id` | 偏好设置 |

`records.status` 取值：`new` / `learning` / `mastered` / `struggling`，由 `applyAttempt` 依据真实尝试次数与错误次数推导。

## AI 代理

```
浏览器 ──POST /api/ai/qa──▶ server/index.mjs ──POST {baseUrl}/chat/completions──▶ 你的网关
                              持有 AI_API_KEY（不进前端）
```

- 协议：OpenAI 兼容 `chat/completions`
- 降级：未配置 / 网关错误 / 超时 / 响应不可解析，统一返回 `ok:false` + 明确原因，前端据此提示，**不影响客观题评分与本地记录**
- 评阅输出：强制要求 JSON（score / hitPoints / missedPoints / deductions / suggestions / structureNote），并附加免责声明

## 测试策略

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 纯逻辑 | `src/lib/*.test.ts` | 评分、调度、统计、导入导出、题库完整性 |
| 服务端 | `tests/ai-proxy.test.mjs` | 未配置 / 成功 / 网关 500 / 非 JSON / 超时 / CORS / 404 |
| 端到端 | `tests/browser.test.mjs` | 首页、导航、练习、判分、模拟考试、错题本、诊断、导入导出校验、AI 降级、主观题、题库查阅、主题 |

测试分层刻意与分层架构对应：逻辑层不依赖浏览器，服务端不依赖真实网关，E2E 只验证关键用户流程。
