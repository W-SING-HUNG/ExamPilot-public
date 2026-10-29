# 复习策略优化技术方案

> 本文档说明复习策略优化的设计依据、算法方案、验证方法与已知限制。
>
> 文中所有数值均由 `src/**/*.test.ts` 与 `tests/*.test.mjs` 中的可复现测试产生，可通过 `npm test` 与 `npm run test:browser` 重放。改动前的计划构建器与选题权重在 `src/lib/acceptance.test.ts` 中按原样复现，因此数值对比不依赖任何特定 commit。

---

## 1. 当前复习算法的实际工作方式

### 1.1 数据模型

`QRecord`（`src/lib/types.ts:21-33`）是唯一的学习状态载体，字段：`status` / `attempts` / `correctCount` / `wrongCount` / `lastSeenAt` / `lastCorrect` / `lastAnswer` / `intervalDays` / `ease` / `nextReviewAt`。所有训练模式（分章练习、专项、主观题、错题复刷、复习计划、模拟考试）共用这一套记录，无第二套进度系统。

### 1.2 写入路径（4 条，行为不一致）

| 路径 | 入口 | 是否调用 `applyAttempt` | `reviewIntervalBase` 是否生效 |
|---|---|---|---|
| 练习 / 专项 / 错题复刷 | `StoreContext.submitAnswer` | 是 | **是**（`Math.max(current.ease, settings.reviewIntervalBase)`） |
| 主观题 / AI 评阅 | `session.ts` `recordAttempt` / `saveAiReviewWithAttempt` | **否**，手工构造 | **否** |
| 模拟考试客观题 | `session.ts` `submitMockRun` | 是 | **否** |
| 模拟考试主观题 | `session.ts` `submitMockRun` | **否**，手工构造 | **否** |

### 1.3 掌握状态机（`scheduler.ts:26-55`）

```
wrongCount >= 3                              → struggling
attempts >= 3 && 历史正确率 >= 0.8 && intervalDays >= 3 && wrongCount === 0 → mastered
attempts >= 4 && correctCount - wrongCount >= 3                            → mastered
否则                                                                      → learning
```

`wrongCount` 只增不减；`status` 无「最近一次作答」概念，只累计。

### 1.4 间隔规则（`scheduler.ts:10-23`）

`ease` 默认 2.0，由记录自身携带，**不因作答结果改变**（答错不降级）。练习路径额外执行 `Math.max(current.ease, settings.reviewIntervalBase)`，其余三条路径不应用该下限。答对：`prev<=0 → 1 天`，否则 `min(round(prev*ease), 365)`。答错：`intervalDays = 0`，`nextReviewAt = now`（立即到期）。增长序列实测 `1,2,4,8,16,32,64,128,256,365,365…`。

### 1.5 选题权重（`scheduler.ts:113-124`）

实测权重表（`now` 为计划生成时刻）：

| 题目状态 | 权重 | 说明 |
|---|---|---|
| 未练 / 无记录 | **16.4** | +6 到期 +1.2 new ×2 untouched |
| 到期 + struggling | 11 | +6 +4 |
| 到期 + learning | 9 | +6 +2 |
| 到期 + mastered | 1.05 | 7 × 0.15 |
| mastered 刚答错 | 0.315 | 7 × 0.15 × 0.3 |
| mastered 未到期 | 0.15 | 1 × 0.15 |

权重 < 0.05 的题目被 `scheduler.ts:131` 硬性剔除。`lastSeenAt` 在 60 秒内才 ×0.3。

### 1.6 复习计划（`Plan.tsx:26-82`）

三个池：`due`（`attempts>0 && nextReviewAt<=now`）、`wrong`（`attempts>0 && wrongCount>0 && 不在 due`）、`fresh`（无记录或 `attempts===0`）。配额分别为 `max(3, size*0.3)` / `max(3, size*0.4)` / `max(4, size*0.5)`，按 due→wrong→fresh 顺序追加，`slice(0, size)` 截断，再追加 1 道 `Math.random()` 抽取的主观题。

### 1.7 诊断（`analysis.ts:55-158`）

章节统计先 `continue` 掉主观题，再在过滤后的集合里 `filter` 主观题（恒为空）。掌握指数 `= coverage*0.4 + rec*0.6`，其中 `rec = correctRate>0 ? correctRate : (attempted===0 ? 0 : 0.5)`。薄弱点取指数升序前 6。

---

## 2. 已证实的问题、源码位置与复现依据

> 严重度：🔴 造成系统性错误　🟠 明显功能缺陷　🟡 口径不一致 / 可解释性缺陷

### A. 掌握状态

**A1 🔴 `struggling` 是终态，永不恢复** — `scheduler.ts:34`
`wrongCount >= 3` 只增不减。实证：3 次答错 → `struggling`；再连续答对 30 次（间隔已增至 365 天）→ **仍为 `struggling`**（attempts=33, correct=30, wrong=3, lastCorrect=true）。
后果：错题本「难点题」筛选永远非空；`mastered` 对这类题永远不可达；与 `Plan.tsx:180`「优先复刷直到连续答对」及 `docs/study-strategy.md:30` 的表述直接矛盾。

**A2 🔴 `mastered` 状态下答错不改变状态，且该题几乎不会再出现** — `scheduler.ts:35-38`
实证：4 次答对 → `mastered`（interval 8 天）；第 5 次答错 → `intervalDays=0, nextReviewAt=now`，但 `correctCount-wrongCount = 4-1 = 3 >= 3` → **status 仍为 `mastered`**。
此时选题权重 = 7 × 0.15（× 0.3 若 60 秒内）= **0.315 ~ 1.05**，对比未练题 16.4，相对选中概率约 **2%–6%**。「答错后立即重测」这一间隔复习的核心诉求失效。

**A3 🟠 状态机与文档不符，且无「连续」概念** — `scheduler.ts:35-38` vs `docs/study-strategy.md:55-57`
文档状态机图画 `learning ──连续答对且间隔≥3天──▶ mastered`，实现用的是**全历史**正确率而非连续。`attempts>=4 && correctCount-wrongCount>=3` 分支可在 3 对 1 错时判 mastered。文档图实际上已暗示 struggling 是终态（无出边），但正文宣称可恢复——文档内部自相矛盾，代码与「可恢复」表述不符。

**A4 🟡 主观题记录永远停留在 `new`，`intervalDays` 永远 0** — `session.ts:94-101, 195-202, 266-274`
三条主观题写入路径均不调用 `applyAttempt`。实证：训练 8 次后 `status='new', intervalDays=0`。连带 `analysis.ts` 的 `TypeStat.mastered / struggling` 对简答、材料分析题**恒为 0**（结构性不可能非零，UI 上表现为「无数据」实为「不可能有」）。

### B. 间隔复习

**B1 🟡 `ease` 语义在各写入入口不一致，设置项 `reviewIntervalBase` 只在 1/4 入口生效** — `scheduler.ts:7,10-23` + `StoreContext.tsx:155`
`ease` **确实参与**间隔计算（`round(prev * ease)`），因此不是死参数；但它只由记录自身携带、**永不因作答结果改变**（答错不降级——这正是 SM-2 的核心特性，`docs/study-strategy.md:99` 已如实声明该限制，阶段 2 **不**升级为动态 ease）。
真正的问题是**入口不一致**：仅 `StoreContext.submitAnswer` 执行 `Math.max(current.ease, settings.reviewIntervalBase)`，`recordAttempt` / `saveAiReviewWithAttempt` / `submitMockRun` 三条路径完全不应用该下限。后果：`reviewIntervalBase > 1` 时，同一道题经「练习」与「模拟考试」两条路径会得到不同的间隔增长曲线。`docs/study-strategy.md:78` 声称该设置「叠加到 `ease`」——表述过宽，未说明仅一个入口生效。

**B2 🟡 2 倍增长过快，365 天封顶在一学期内即触达** — `scheduler.ts:22`
实证第 9 次答对间隔即 256 天。对约 4 个月的复习周期，mastered 题目实际只在第 1/2/4/8 天复现，之后直接跳到 16/32 天以上。`docs/study-strategy.md:100` 已承认此限制。

### C. 薄弱点诊断

**C1 🟠 章节统计先排除主观题、后从同一集合统计主观题 → `subj` 恒为 0，主观题从章节表消失** — `analysis.ts:59-60, 65`
```
59:  if (q.type === 'short' || q.type === 'material') continue   // byChapterMap 只剩客观题
65:  const subj = list.filter((q) => q.type === 'short' || ...)  // 在已过滤集合上再筛 → 恒为空
74:  total: obj.length + subj.length,                            // → 恒等于客观题数
```
实证：`sum(chapters.subj) = 0`（题库中主观题数量大于 0）；`sum(chapter.total)` 小于 `allQuestions.length`。
用户可见后果：Diagnosis 章节表「题量」列合计小于 Home 页显示的总题数——两处不一致；「全册」章（全部为主观题）在章节表中渲染为 `total=0` 的空行。

**C2 🔴 薄弱点把「已练但全错」章节排到「尚未覆盖」章节之后，最危险的章节被挤出榜单** — `analysis.ts:119, 123`
```js
119: .filter((c) => c.attempted < c.total * 0.99 || (c.attempted > 0 && c.correctRate < 0.8))
123: const rec = c.correctRate > 0 ? c.correctRate : c.attempted === 0 ? 0 : 0.5
```
三元表达式实际解析为 `correctRate>0 ? correctRate : (attempted===0 ? 0 : 0.5)`。对 `attempted>0 && correctRate===0`（已练但全部答错）的章节，**`rec` 被当作 0.5**。
实证：导论 49 题全部答错，真实正确率 0%，但 `score = round(1.0*0.4 + 0.5*0.6)*100 = 70`；而 6 个**未练**章节 score=0 排进前 6，**导论完全不在榜单上**（rank=0）。
即：一个每道题都答错的章节，被算法评为「优于从未学过的章节」从而被隐藏。

仅把 70 改为 40 并不能解决问题——若未练章节有 6 个以上，全错章节（score=40）仍会被全部挤出前 6 名的榜单。因此必须**区分「已练但错误率高」与「尚未覆盖」两类，并明确各自的展示与排序规则**，见 §4.5.1。

连带缺陷：`analysis.ts:126-127` 的 `if (cov >= 0.7 && rec < 0.6)` 在「全错且已全覆盖」时不成立（cov=1.0、rec=0.5），`detail` 退化为无信息量的「待进一步巩固」。
口径冲突：`Diagnosis.tsx:113` 表格列显示真实 `0%`，薄弱点卡片却隐含 70 分。

**C3 🟡 `overall.total` 用全部题数，`coverage` 分母只用客观题** — `analysis.ts:145, 147`
`total: questions.length`（全部题量）但 `coverage: attempted / obj.length`（分母仅客观题）。该字段无任何 UI 使用，属死字段，但语义混乱。

### D. 首次覆盖与复习计划

**D1 🔴 新用户场景计划题量系统性减半** — `Plan.tsx:56, 64, 72`
`due` 与 `wrong` 池为空时，`fresh` 配额上限仅 `max(4, round(size*0.5))`。实测（全部客观题均未练）：

| 用户选择 | 实际计划题量 |
|---|---|
| 10 题 | **6** |
| 20 题 | **11** |
| 30 题 | **16** |
| 50 题 | **26** |

用户点「50 题」只拿到 26 题。这直接违反「新用户应拿到所请求题量」这一预期行为。

**D2 🔴 到期复习被大量挤占，且积压不会顺延** — `Plan.tsx:56`
`due` 配额仅 `max(3, round(size*0.3))`。实测 60 道到期（struggling）+ 数百道未练：

| 计划规模 | 到期题进入计划 | 被丢弃 |
|---|---|---|
| 10 题 | 3 | 57 |
| 20 题 | 6 | 54 |
| 50 题 | 15 | 45 |

被丢弃的到期题 `nextReviewAt` 仍是过去，次日仍到期，但每日仍只调度 30% 配额——**到期队列无界积压**。`Plan.tsx:109` 页面描述「到期复习优先，错题再测其次，未做题目补漏」与 30%/40%/50% 的配额比例矛盾。

**D3 🟠 到期且答错的题被降级到低配额池** — `Plan.tsx:34`
`!due.includes(q)` 使「到期 + 答错」的题只进 `due` 池（30% 配额），不进 `wrong` 池（40%）。实测 20 道到期错题 + 20 道未到期错题、size=30 → 计划仅含 9 道到期题。另：`includes` 为 O(n)，题库规模下每次 filter 全扫。

**D4 🟡 主观题用 `Math.random()`，破坏可复现性** — `Plan.tsx:79`
其余全部使用 `mulberry32(seed)` 确定性抽样，唯独此处用 `Math.random()`。且 `records` 一变整份计划重算，主观题跟着变。

### E. 选题权重

**E1 🔴 权重表与注释相反：「未练」高于「到期」** — `scheduler.ts:100-124`
注释写「due for review (nextReviewAt <= now) highest」，实测未练 16.4 > 到期 struggling 11 > 到期 learning 9。混合池实测（3 未练 + 3 到期错题 + 3 到期 mastered，count=3，400 次抽样）：**未练 55.0%、到期错题 40.3%、到期 mastered 4.7%**。
两层叠加恶化：`Plan.tsx` 的 fresh 池本身已占 50% 配额，`selectQuestions` 又在池内把未练权重抬到 16.4。

**E2 🟠 60 秒去重窗口形同虚设** — `scheduler.ts:121`
只压制 60 秒内答过的题。实测 40 道到期错题，两次计划相隔 3 分钟 → **选题 100% 重复**。「同一天重复训练」场景下用户一天内两次进入计划拿到同一批题。

**E3 🟠 `weight() > 0.05` 硬截断导致整池为空时静默返回空会话** — `scheduler.ts:131`
实测 1：5 道全是 mastered 且刚答过 → `count=3` 返回 **0 题**。
实测 2：错题本「所有做过的」筛选，20 道全是刚答对的 mastered → 返回 **0 题**，而 UI 按钮显示「开始复刷（10 题）」，点击后进入空会话。这是「异常边界」处理不当的直接表现。

**E4 🟡 `wrongBoost` 不区分「正在挣扎」与「曾经错过多」** — `scheduler.ts:117`
`status === 'struggling' || wrongCount >= 2` 同一档。答错 2 次后已连续答对 5 次的题，与答错 10 次的题同权。结合 A1（struggling 集合单调增长）更突出。

### F. 主观题安排

**F1 🟡 主观题完全不参与间隔复习** — 同 A4
`nextReviewAt` 恒为「上次训练 + 24 小时」，间隔永不增长。合规面（须保持）：`analysis.ts:153-155` 的 `subjectiveAttempted` 用 `attempts > 0` 口径正确，`Diagnosis.tsx:161-165` 对主观题显示「AI 参考评阅」而非百分比——**不虚构正确率，这部分是正确的，不得破坏**。

**F2 🟡 主观题在 Plan 中仅 1 道、无覆盖目标** — `Plan.tsx:78-80`
主观题每天随机 1 道，无覆盖率概念，无间隔。

### G. 文档与代码不一致（`docs/study-strategy.md`）

| 行 | 文档表述 | 实际情况 |
|---|---|---|
| 44-48 | 列出权重 ×2 / ×0.15 / +6 / +4 / +2 | 数字准确，但**漏掉 `status==='new' → +1.2`**，而正是这一项叠加 ×2 使未练达 16.4、超过到期 struggling 的 11。遗漏了决定性的一项 |
| 48 | 「不会退化成只刷错题」 | 方向正确，但未提及反向风险：现已**过度偏向未做题目**，挤占到期复习 |
| 55-57 | 状态机图暗示可恢复，正文亦称可推导 | 图无 struggling 出边（实为终态），正文宣称可恢复——自相矛盾 |
| 78 | 「复习间隔基数 … 叠加到 `ease`」 | 仅 `submitAnswer` 一个入口生效；其余三个入口不经过 |
| 92 | 「掌握指数 = 覆盖率×0.4 + 正确率×0.6」 | 隐去 `attempted===0 ? 0 : 0.5` 的三元修正，而它正是 C2 的根源 |
| 99 | 「`ease` 固定 … 刻意保持简单」 | 与行 78「可调参数」并存易误读，须说明二者是「固定倍率 + 可设下限」的不同维度 |

另发现两处纯代码瑕疵（顺带修正，无行为影响）：`scheduler.ts:97-105` JSDoc 注释块重复开启（两个 `/**`）；`scheduler.ts:3-5` 的 `ReviewPolicy` 与 `analysis.ts:160` 的 `correctRateOfRecords` 为导出但无使用的死代码。

---

## 3. 优先级排序与最小必要修改范围

### P0 — 必须修（违反红线或系统性错误）

| # | 问题 | 文件 |
|---|---|---|
| 1 | A2： mastered 答错不降级 + 权重被压到 2% | `scheduler.ts` |
| 2 | C2： 薄弱点把全错章节当成 0.5 正确率 | `analysis.ts` |
| 3 | D1： 新用户计划题量减半 | `Plan.tsx` |
| 4 | D2： 到期复习被挤占 + 无界积压 | `Plan.tsx` |

### P1 — 应该修（明显功能缺陷）

| # | 问题 | 文件 |
|---|---|---|
| 5 | A1： struggling 永不恢复 | `scheduler.ts` |
| 6 | E1： 未练权重高于到期 | `scheduler.ts` |
| 7 | E3： 空池静默返回空会话 | `scheduler.ts` |
| 8 | C1：主观题从章节表消失 | `analysis.ts` |
| 9 | F1/A4： 主观题不参与间隔复习 | `session.ts` |

### P2 — 可以修（口径 / 可解释性）

| # | 问题 | 文件 |
|---|---|---|
| 10 | E2： 同日重复训练 100% 重复 | `scheduler.ts` + `plan.ts` |
| 11 | D3： 到期错题降级 + O(n²) | `plan.ts` |
| 12 | D4： 主观题 `Math.random()` | `Plan.tsx` |
| 13 | B1： ease 下限入口不一致 + 文档误导 | `scheduler.ts` + `session.ts` + `StoreContext.tsx` + 文档 |
| 14 | A3/E4： 状态机与权重可解释性 | `scheduler.ts` + 文档 |
| 15 | C3： `overall.total` 死字段 | `analysis.ts` |
| 16 | G1–G7： 文档与代码逐条对齐 | `docs/study-strategy.md` |

> 涉及三个写入入口的事项，实际工作量接近 P1；需在 `plan.ts` 中引入当日去重的事项，同样影响配额公式，一并在此说明。

### 最小必要修改范围

**按实际必要性确定范围，不为「四个源文件」的人为限制留下多入口行为不一致。** 凡涉及统一主观题数据写入的 store / session 层文件，均纳入必要范围。

| 层 | 文件 | 必要性 |
|---|---|---|
| 算法内核 | `src/lib/scheduler.ts` | 状态机、权重表、`applySubjectiveAttempt`、ease 下限统一 |
| 算法内核 | `src/lib/analysis.ts` | 章节统计、薄弱点分类、诊断口径 |
| 算法内核 | `src/lib/plan.ts`（新增） | 把 `buildPlan` 抽为纯函数以便测试 |
| 写入层 | `src/lib/session.ts` | **必须**：`recordAttempt` / `saveAiReviewWithAttempt` / `submitMockRun` 三处主观题写入 |
| 写入层 | `src/store/StoreContext.tsx` | **必须**：向 `session.ts` 三个函数统一传入 `settings.reviewIntervalBase`，保证 4 个入口 ease 下限一致（§4.6） |
| 页面 | `src/pages/Plan.tsx` | 配额、顺延提示、题量口径、改用纯函数 `buildPlan` |
| 页面 | `src/pages/Diagnosis.tsx` | `c.total` 语义、薄弱点类别标签 |
| 页面 | `src/pages/Practice.tsx` | `chapterStat.total` 展示 |
| 测试 | `src/lib/trajectory.test.ts`（新增）、`src/lib/plan.test.ts`（新增） | T1–T14 与配额单测 |
| 测试 | `src/lib/scheduler.test.ts`、`src/lib/analysis.test.ts` | 状态机 / 权重 / 薄弱点分类断言 |
| 测试 | `src/db/session.test.ts` | S1–S8 主观题间隔与幂等断言 |
| 测试 | `tests/browser.test.mjs` | E2E-1/2/3 |
| 文档 | `docs/study-strategy.md`、`CHANGELOG.md` | 逐条对齐 + 过渡期说明 |

**明确不动**：`src/db/*`（数据库 schema、事务基础设施、`restoreBackupInto`）、`src/lib/io.ts`（备份校验）、`src/lib/bank.ts` / `data/*`（题库身份绑定）、`src/lib/scoring.ts`（判分）、`src/lib/mock-grading.ts`、`src/components/*`、`server/*`、`tools/*`、CI 配置、`package.json`（不引入依赖）。

> 说明：`StoreContext.tsx` 与 `session.ts` 虽原不在「四个源文件」之列，但 §4.4.1 的三路径统一与 §4.6 的 ease 下限统一**只能**在这两层完成。若把它们排除在外，就会保留「同一道主观题在不同入口间隔行为不同」「同一道客观题在不同模式 ease 下限不同」的多入口不一致——这正是本次要消除的问题。因此纳入。

---

## 4. 推荐的算法方案及理由

> 总原则：**简单、可解释、可验证**。不引入完整 SM-2 变体、不引入遗忘曲线拟合、不引入知识追踪。所有规则都能用一句话向用户解释清楚。

### 4.1 掌握状态机：引入「最近一次作答」

**规则（三句话可解释）**：

```
最近一次答错 且 累计答错 >= 3   → struggling
最近一次答对 且 净答对 >= 3     → mastered
最近一次答对                    → learning
其他（含刚答错但累计不足）       → learning
```

其中「净答对」= `correctCount - wrongCount`。

**行为变化**：

| 轨迹 | 现状态 | 新状态 |
|---|---|---|
| 3 错 | struggling | struggling |
| 3 错 + 1 对 | struggling | learning |
| 3 错 + 30 对 | struggling | mastered |
| 4 对 | mastered | mastered |
| 4 对 + 1 错 | **mastered** | **learning** |
| 4 对 + 1 错 + 2 对 | learning | mastered |
| 主观题 N 次 | new | learning（见 4.4） |

**理由**：只用一个新增判据（`lastCorrect`），零 schema 变更；`wrongCount` 仍只增不减（历史不被篡改，`io.ts` 的 `correct+wrong <= attempts` 校验不变）；「struggling」从终态变为「最近仍在出错」，与「优先复刷直到连续答对」的产品表述一致；mastered 一次失误降为 learning 而非 struggling，避免一次手滑就被打成难点。

### 4.2 选题权重：让「到期」真正最高

**新权重表**（单调、可解释，按优先级排列）：

| 状态 | 权重 |
|---|---|
| 到期 且 答错过（`wrongCount > 0`） | 12 |
| 到期 且未错过 | 8 |
| 未到期 但答错过 | 6 |
| 到期 mastered | 6 |
| 未练（`attempts === 0`） | 4 |
| learning 未到期 | 2 |
| mastered 未到期 | 0.3 |
| （修正）60 秒内刚答过 | 上述 × 0.3 |

**两处关键修正**：
1. **到期 mastered 给正常优先级（6），不再 ×0.15**。「已掌握但到期」是正常的间隔复习，本该按计划出现；现在的实现把它压到权重底部，等于「掌握即永久消失」，违背间隔复习的初衷。
2. **删除 `weight() > 0.05` 硬截断**，改为「若所有候选权重都低于阈值，则本回合退化为等概率随机选取」。这保证错题本「所有做过的」在全是刚答对的 mastered 时仍能给出题目（修 E3），同时不改变正常情况下的优先级。

**保留**：未练题仍有 ×2 量级的相对优势（4 vs 2），覆盖均衡的项目约束不被破坏——只是不再**高于**到期复习。

### 4.3 复习计划配额：到期优先 + 余额补足

#### 4.3.1 配额的精确定义（客观题与主观题分离）

`size`（用户选择的「今日任务量」）**仅约束客观题名额**；主观题为**额外名额**，不计入 `size`，也不挤占客观题配额。

```
objTarget  = size                                    // 客观题名额，不含主观题
dueQuota   = min(due.length,   ceil(objTarget * 0.5))
wrongQuota = min(wrong.length, ceil(objTarget * 0.25))
freshQuota = min(fresh.length, objTarget - dueQuota - wrongQuota)
subQuota   = 1                                       // 主观题固定额外 1 道
```

**题库不足时的处理（不做静默缩水，也不假装凑满）**：

| 情形 | 处理 |
|---|---|
| `due.length + wrong.length + fresh.length < objTarget` | 计划题量 = 实际可用数；页面如实显示「今日任务共 N 题（题库可用 M 题）」，**不补重复题、不用主观题充数** |
| `fresh.length === 0`（题库已全覆盖） | `freshQuota = 0`，余额回填给 `due` → `wrong`；若两者也为 0，则计划仅含主观题 1 道，页面显示「客观题已全部到期完毕」 |
| `due.length === 0 && wrong.length === 0`（新用户） | `freshQuota = min(fresh.length, objTarget) = objTarget`，**修 D1** |
| 某池配额 `>` 池实际数量 | 未用满的配额按 `due → wrong → fresh` 顺序回填 |
| 主观题题库为空（`subjectiveQuestions.length === 0`） | `subQuota = 0`，不报错 |

**题量口径统一**：按钮文案、计划预览标题、「开始今日复习（N 题）」全部使用 `objPicks.length + subPicks.length`，与计划实际长度一致（当前 `Plan.tsx:81` 的 `.slice(0, size + 1)` 会造成预览数与按钮数不一致）。

**新用户场景**：due=0、wrong=0 → `freshQuota = min(客观题总量, size) = size`，计划 = `size` 客观题 + 1 主观题。**修 D1**。

**到期池内选择改为「最久未复习优先」（FIFO）**，而非随机。这是防止到期队列无界积压的关键：即使今日配额装不下全部到期题，也保证按到期顺序 drain，最老的先清。同时在页面增加一行诚实提示：「还有 N 道到期未排入今日任务，将按到期顺序顺延」——不让用户误以为到期已清空。该提示在 `N === 0` 时隐藏。

**主观题抽取**：固定 1 道，改用 `mulberry32` 确定性抽取（修 D4）。当 `subQuota = 1` 但主观题已练过时，仍按同一确定性规则抽取（不跳过已练题——主观题训练本就应反复进行，且间隔由 §4.4 控制）。

**去重**：`due` / `wrong` / `fresh` 三池互斥由构造保证（`wrong` 排除 `due`，`fresh` 排除已练习），追加时用 `Set` 去重（O(1)，修 D3 的 O(n²)）。主观题与客观题不可能重复（题型不同）。

#### 4.3.2 规模差异：完整题库 vs 公开示例题库

测试必须覆盖两种规模，因为配额与去重在小题库下的表现完全不同：

| 维度 | 完整题库（题量远大于示例） | 公开示例题库（17 题：14 客观 + 3 主观） |
|---|---|---|
| `size = 50` 新用户 | objPicks = 50，总 51 | objPicks = 14（池上限），总 15；**断言「不超池、不补重复」** |
| 到期 60 + 未练数百 | dueQuota = 25，到期命中 ≥ 25 | 到期不可能达 60；测试改用「到期 5 + 未练 9」验证同一公式 |
| 重叠率指标 | 适用（见 §6.2 条件） | **不适用**（见 §6.2 条件） |
| 主观题额外名额 | 1/67 | 1/3 |
| 空池退化 | 极少触发 | **必然触发**（如「所有做过的」仅 14 题，其中 mastered 刚答过）——须断言不抛错、不返回空 |

**两种规模共用同一套公式，不写分支**；差异只在测试断言上体现。

### 4.4 主观题参与间隔复习（不伪造任何正确率）

新增 `applySubjectiveAttempt(rec, now)`，与 `applyAttempt` 分离，**不修改客观题路径**（阶段 1 的回归测试全部依赖 `applyAttempt` 现有行为）：

```
intervalDays = min(prevIntervalDays > 0 ? round(prev * 1.5) : 1, 30)   // 1.5 倍增长，上限 30 天
nextReviewAt = now + intervalDays 天
status       = 'learning'          // 离开 'new'
correctCount / wrongCount          // 保持不变（恒 0）
lastCorrect                       // 保持 null
```

主观题间隔比客观题短（上限 30 天 vs 365 天）且增长更慢（1.5× vs 2×），因为**无自动评分反馈**，不应假设「练过一次就掌握」——这是保守且可解释的选择。`correctCount`/`wrongCount` 恒为 0，`analysis.ts` 的主观题 `correctRate` 仍为 0，`Diagnosis.tsx` 仍显示「AI 参考评阅」而非百分比——**红线完全保持**。

#### 4.4.1 三个实际写入路径逐一改造

三条路径都必须改用 `applySubjectiveAttempt`，否则会出现「同一道主观题在 A 入口练过会增长间隔、在 B 入口练过不会」的多入口行为不一致。

| 写入路径 | 位置 | 改造方式 | 幂等保护是否保留 |
|---|---|---|---|
| `recordAttempt()`（`isCorrect === null` 分支） | `session.ts:92-107` | 将手工构造的 `QRecord` 替换为 `applySubjectiveAttempt(current, now)`，并补写 `lastAnswer` | **保留**：仍在同一 `db.transaction` 内，且入口处 `hasAttempt(db, sessionId, qid)` 先行判断，重复提交 `created: false`、不推进间隔 |
| `submitMockRun()` 主观题分支 | `session.ts:193-217` | 同上替换 | **保留**：`db.mocks.get(runId)` 幂等闸门不变，重放返回 `already-submitted`，`written.records` 为 0，间隔不推进 |
| `saveAiReviewWithAttempt()` | `session.ts:264-285` | 同上替换 | **保留**：`hasAttempt()` 判断不变——**AI 评阅本身不新增训练次数、不推进间隔**；只有本会话首次作答该题时才写一次 |

**关键约束（必须逐条测试）**：

1. **AI 评阅不得重复推进间隔**：`saveAiReviewWithAttempt` 中 `if (!(await hasAttempt(...)))` 的条件**一字不改**。已在本会话作答过的主观题，再次点击「AI 参考评阅」只更新 `aiReviews` 行，`records.nextReviewAt` 不变。
2. **事务原子性不变**：三处均在既有 `db.transaction('rw', ...)` 内完成写入，`applySubjectiveAttempt` 是纯函数，不引入新的写入口，不改变事务边界。
3. **`lastCorrect` 恒为 `null`**：不得因训练次数增加而写入 `true`/`false`。
4. **`correctCount` / `wrongCount` 恒为 0，不得伪造**：`analysis.ts` 对主观题的 `correctRate` 仍为 0；`io.ts` 的 `correct+wrong <= attempts` 校验仍成立（0+0 ≤ attempts）。
5. **无官方答案不自动 mastered**：`applySubjectiveAttempt` 的 `status` **硬编码为 `'learning'`**，无论 `attempts` 多大都**永不进入 `'mastered'`**，也永不进入 `'struggling'`。这直接堵死「因训练次数增加而自动标记已掌握」的风险。
6. **间隔推进有上限**：`intervalDays` 封顶 30 天，`nextReviewAt` 不会漂移到 365 天量级，避免主观题「长期不再出现」。

#### 4.4.2 主观题间隔增长的回归测试

| 用例 | 构造 | 断言 |
|---|---|---|
| S1 | `recordAttempt` 连续 5 次（不同 `sessionId`） | `intervalDays` 依次为 1→2→3→4→6（round(1.5x)）；`nextReviewAt` 同比顺延 |
| S2 | 同一 `(sessionId, qid)` 重复 `recordAttempt` 3 次 | `attempts` 只 +1；`intervalDays` 只推进一次；`created: false` |
| S3 | `submitMockRun` 提交后**重放同一 `runId`** | 第二次 `status === 'already-submitted'`、`written.records === 0`；`intervalDays` 不变 |
| S4 | 先主观题作答，再 `saveAiReviewWithAttempt` 同一 `(sessionId, qid)` | `attempts` 不增加；`nextReviewAt` 不推进；`aiReviews` 行被更新 |
| S5 | `saveAiReviewWithAttempt` 在**未作答**过的题上首次调用 | `attempts` +1；间隔推进一次；`lastCorrect === null` |
| S6 | 主观题训练 30 次 | `status === 'learning'`（**永不 mastered**）；`correctCount === 0 && wrongCount === 0`；`intervalDays === 30`（封顶） |
| S7 | `applySubjectiveAttempt` 对已有客观题记录（`correctCount=5`）调用 | `correctCount` / `wrongCount` / `lastCorrect` **全部保持原值不被清零**（函数只动 interval / nextReviewAt / status / lastSeenAt） |
| S8 | 主观题记录经 `io.ts` 校验 | `parseExport` 通过（`status` 合法、计数非负、`correct+wrong <= attempts`） |

S7 是防御性用例：确保纯函数不会意外清零客观题计数（若误用 `applySubjectiveAttempt` 覆盖了 `applyAttempt` 的写入）。

### 4.5 诊断修正

**C1**：`byChapterMap` 不再跳过主观题；`subj` 从完整列表统计，`total = 客观题数 + 主观题数`。`coverage` 分母**仍只算客观题**（`docs/study-strategy.md:90` 对此表述准确，不动）。为保持口径清晰，`ChapterStat` 拆为 `objectiveTotal` / `subjectiveTotal` / `total = 两者之和`，`coverage = attempted / objectiveTotal`。
连带同步 `Practice.tsx:79-81` 的展示（「本章 N 题」含主观题，括号内仍只列客观题三种）。
副作用：`sum(chapter.total) === allQuestions.length`，章节表与 Home 页显示的总题数一致；「全册」章不再渲染为 `total=0` 的空行。

**C3**：删除无 UI 使用的 `overall.total` 死字段（或改为客观题总数并同步文档），消除「total 用全部、coverage 分母用客观题」的语义混乱。

#### 4.5.1 薄弱点诊断：区分「已练但错误率高」与「尚未覆盖」

**问题定性**：把两类语义不同的章节放进同一个加权分数里排序，必然导致一类被另一类掩盖。全错章节 score 无论取 40 还是 70，只要未练章节数量 ≥ 榜单容量，就会被挤出。因此**不调权重、不加权、不混排**，而是显式分成两组，各自独立排序、各自独立入榜。

**分类规则**（互斥、完备，基于 `attempted` 与 `objectiveTotal`）：

| 类别 | 判定 | 语义 |
|---|---|---|
| `weak`（已练但薄弱） | `attempted > 0 && attempted < objectiveTotal * 0.99` 或 `attempted > 0 && correctRate < 0.8` | 练过，但覆盖不足或正确率低——**需要优先清除** |
| `uncovered`（尚未覆盖） | `attempted === 0` | 从未练过——**需要先建立基线** |

已练且覆盖率 ≥ 99% 且正确率 ≥ 80% 的章节不进榜（无薄弱证据）。

**两组各自独立的评分公式**：

```
weak       : score = round((coverage * 0.4 + correctRate * 0.6) * 100)   // 正确率用真实值，0% 就是 0
uncovered  : score = 0                                                   // attempted === 0，无正确率数据
```

关键修正：`weak` 组**删除** `correctRate>0 ? correctRate : 0.5` 的三元兜底，`attempted > 0` 时 `correctRate` 恒为已计算出的真实值（含 0），不再虚构 0.5。

**注意 `uncovered` 组的排序不能用 `score`**：`attempted === 0` 时 `coverage` 恒为 0，若仍按覆盖率算分则组内全部并列 0，排序失去意义。因此 `uncovered` 组改用**未练题量**（`objectiveTotal`）作为排序依据——未覆盖的题越多，覆盖缺口越大，越应优先补。该组的 `score` 字段保留为 0，仅用于 UI 显示「暂无掌握数据」，**不作为掌握指数解读**。

**排序与入榜规则**（这是解决「被挤出」的核心）：

```
weak      组：按 score 升序（越差越前）；score 相同时按 objectiveTotal 降序
uncovered 组：按 objectiveTotal 降序（未练题越多越前）
最终榜单   ：weak 组全部优先入榜，uncovered 组用剩余名额补足
榜单容量   ：仍为 6（不改变现有 UI 网格布局，不做 UI/UX 重设计）
```

即：**只要 `weak` 组非空，全错章节必定出现在榜单中**（它属于 `weak` 且 score 最低）；`uncovered` 只在 `weak` 不足 6 个时补位。这符合「已暴露的错误比未暴露的未知更紧急」的直觉，也避免了「最危险的章节被数量更多的未练章节淹没」。

**为什么两组分数不直接比较**：`weak` 的 score 是「已知表现的加权」，`uncovered` 的 score 恒为 0（无数据）。若把两者放进同一个升序列表，未练章节会永远排在前面——这正是原实现的失败模式。因此**不混排**，改为分层入榜。

**数据结构**（`analysis.ts`）：

```ts
export interface WeakPoint {
  chapter: string
  score: number
  detail: string
  /** 已练但薄弱 / 尚未覆盖 —— 两类语义不同，不可混排 */
  kind: 'weak' | 'uncovered'
}
```

`Diagnosis` 的 `weakPoints: WeakPoint[]` 字段名与长度上限（6）不变，因此 `Home.tsx:149-175` 与 `Diagnosis.tsx:202-230` 的 `.map` 循环、`Tag`、`score < 50 ? 'bad'` 阈值全部无需改动；仅在卡片上增加一个类别标签（如「待清除」/「未覆盖」），并让 `detail` 文本如实说明依据。

**detail 文本规则**（去掉无信息量的兜底）：

```
weak       : 按真实数据输出「覆盖率仅 X%」/「正确率仅 X%」/「N 道难点题」，可组合
uncovered  : 「尚未开始练习」+（若有主观题）「含 N 道主观题」
```

**回归测试**（`analysis.test.ts` 新增，必须覆盖「挤出」场景本身）：

| 用例 | 构造 | 断言 |
|---|---|---|
| R1 | 1 个全错章节 + **8 个**未练章节 | 全错章节 **在榜**（`kind==='weak'` 且排第 1）；8 个未练章节最多占 5 个名额 |
| R2 | 仅 1 个未练章节、无 weak | 榜单含该章节，`kind==='uncovered'`、`score === 0`、detail 为「尚未开始练习」 |
| R3 | 6 个 weak + 8 个 uncovered | 榜单恰好 6 项且**全部** `kind==='weak'`，无 uncovered 混入 |
| R4 | 已练全覆盖且正确率 100% | 该章节不在榜；`correctRate` 在 detail/score 中不被改写 |
| R5 | 全错章节的 score | `score === round((cov*0.4 + 0*0.6)*100)`，cov=1.0 时**恰好 40**，且不依赖未练章节数量 |
| R6 | 全错章节 detail | 含「正确率仅 0%」，**不含**「待进一步巩固」 |
| R7 | uncovered 组排序 | 两个未练章节 `objectiveTotal` 为 10 与 50 → objectiveTotal=50 的排在前面 |
| R8 | 两组分数不混排 | 构造「1 个 weak（score 70）+ 1 个 uncovered」→ weak 排第 1；uncovered 的 score 为 0 但**不因 0 < 70 而排到前面** |
| R9 | `kind` 字段完整性 | 榜单中每一项都有 `kind`，且取值仅为 `'weak'` / `'uncovered'` |

R1 直接锁定「仍可能被 6 个未练章节挤出」这一失败模式；R5 锁定「40」这个数值本身不随场景漂移；R8 锁定「不混排」这一结构性约束（防止未来被「简化」成单一分数排序时问题复发）。

**文档同步**：`docs/study-strategy.md` 的「诊断指标」节改为完整写出两组分类、两个公式、排序与入榜规则，删除隐去兜底逻辑的旧表述。

### 4.6 ease 与复习间隔设置参数：阶段 2 的处理决定

**决定：统一生效范围，不引入动态 ease，不改默认值，不新增参数。**

即——保留现有「固定倍率 + 可设下限」的两层结构，但让 `reviewIntervalBase` 在**所有写入入口一致生效**。

| 维度 | 决定 | 理由 |
|---|---|---|
| `ease` 倍率 | **保留固定 2.0**，不实现答错降级 | `docs/study-strategy.md:99` 已如实声明该限制；动态 ease 需要更多作答样本才能稳定，与「简单、可解释」原则冲突，且会让用户在题少时看到难以解释的间隔跳变 |
| `reviewIntervalBase` 下限 | **统一到全部 4 个写入入口** | 现状是 1/4 入口生效，同一道题在不同模式下间隔曲线不同，属行为不一致；统一后语义清晰、无新增参数 |
| 默认值 | **不改**（`DEFAULT_EASE = 2.0`、`reviewIntervalBase = 1`） | 保证现有数据与既有测试的间隔序列不变 |
| 取值范围 | **不改**（`io.ts:402` 已校验 `>= 1`） | 备份兼容性不变 |
| 主观题间隔 | **单独一套**（1.5× 增长、30 天上限，见 §4.4） | 无自动评分反馈，不应与客观题共用同一曲线 |

**实现方式**：把 `Math.max(current.ease, reviewIntervalBase)` 收敛为一处。客观题三条路径（`submitAnswer` / `submitMockRun` 客观题分支 / `recordAttempt` 客观题分支）传入同一个下限值；`recordAttempt` / `saveAiReviewWithAttempt` / `submitMockRun` 主观题分支走 `applySubjectiveAttempt`，不受 `ease` 影响（它有自己的 1.5× 曲线）。

由于 `StoreContext.submitAnswer` 已从 `settings` 读取该值，而 `session.ts` 的三个函数当前签名不含 settings，需要给它们补一个可选参数（默认值取 `DEFAULT_EASE`，即 2.0）以保持向后兼容——**不改变 `DEFAULT_EASE` 本身**。调用方由 `StoreContext` 统一传入 `settings.reviewIntervalBase`，`session.ts` 内部不自行读取 settings（保持纯函数可测性）。

**文档同步（`docs/study-strategy.md` 行 76-78）**：把「复习间隔基数」的描述改为：
- 明确它是 `ease` 的**下限**，不是叠加项；
- 明确它对练习、专项、错题复刷、模拟考试、主观题之外的**全部客观题写入入口**一致生效；
- 明确主观题有独立的间隔规则，不适用该参数；
- 明确 `ease` 固定 2.0、答错不降级，属于已知限制而非可调项。

**回归测试**：`reviewIntervalBase = 3` 时，四条客观题路径对同一初态记录产出的 `intervalDays` 完全一致（当前只有练习路径一致，其余三条给出 2.0 曲线）。

### 4.7 同日重复训练（E2）

`Plan.tsx` 生成计划时，对 `lastSeenAt` 与 `now` 同属一个自然日、且当日已在该模式出现过的题目压低权重（× 0.2）；若因此导致某池可选题目不足，则回退到不考虑当日去重。目标：同日两次计划重叠率从 100% 降到 50% 以下，同时不出现空计划。

---

## 5. 与现有数据、页面、考试逻辑的兼容性

### 5.1 数据库与备份

- **不加字段、不改表结构、不升级 DB version**。所有改动都在纯函数逻辑内。
- `io.ts` 的 `QRecord` 校验（`status` 枚举、计数非负、`correct+wrong <= attempts`）全部仍满足：新状态机不会让 `wrongCount` 超过 `attempts`，`status` 取值域不变。
- **旧数据不被重算**：已有记录的 `status` 保持原值（可能是错误的 `struggling`），直到该题下次作答才按新规则更新。这比「启动时批量重算」（需要写事务、有失败风险）更安全，且复刷本来就是用户主动行为。需在 CHANGELOG 明确说明这一过渡期现象。

### 5.2 阶段 1 机制（不得破坏）

- `session.ts` 的 `db.transaction` 事务边界、`attemptIdFor` / `hasAttempt` 幂等、`submitMockRun` 的 runId 幂等——**全部保留**。`applySubjectiveAttempt` 是新增纯函数，只替换 `session.ts` 中三处手工构造 `QRecord` 的表达式；事务包裹、`hasAttempt` 前置判断、`db.mocks.get(runId)` 闸门**一行不动**（详见 §4.4.1 的逐路径表与 S1–S8 测试）。
- `restoreBackupInto` 的 all-or-nothing 语义不受影响。
- `StoreContext.submitAnswer` 现有的 `Math.max(current.ease, settings.reviewIntervalBase)` 行为**保留并扩展到其余入口**（§4.6），不改变 `DEFAULT_EASE = 2.0` 与默认 `reviewIntervalBase = 1`，因此现有数据的间隔序列不变。

### 5.3 页面

| 页面 | 影响 | 处理 |
|---|---|---|
| `Plan.tsx` | 按钮文案用 `plan.length`，自动一致；新增「顺延」提示行 | 小改 |
| `Diagnosis.tsx` | `c.total` 语义变化（含主观题）；detail 文本更准确 | 小改，展示更正确 |
| `Practice.tsx:79-81` | `chapterStat.total` 含主观题，括号内仍列三种客观题 | 小改 |
| `Home.tsx` | `diag.overall` 字段删除 `total`——该字段本就无 UI 引用 | 无需改 |
| `WrongBank.tsx` / `Special.tsx` / `Subjective.tsx` | 受益于 E1/E3 修正，无需改 | 无需改 |
| `MockExam.tsx` | `buildPaper` 不属本次范围（组卷逻辑已在阶段 1 修正并有回归测试） | 不改 |

**不做 UI/UX 重设计**：仅上述文字与数字口径修正，无布局、配色、交互流程变更。

### 5.4 考试逻辑

- `scoring.ts` 判分规则零改动（单选严格匹配、多选集合完全一致、判断布尔、未作答 null）。
- `mock-grading.ts` 零改动（未作答不计错、主观题不计分、分值区分）。
- `buildPaper` 零改动。模拟考试与练习继续共用同一套 `records`。

### 5.5 现有测试的预期影响

- `scheduler.test.ts:38`「3 次全对后 mastered」→ 新规则 `lastCorrect=true && net=3` → 仍通过 ✓
- `scheduler.test.ts:48`「1 对 3 错后 struggling」→ 新规则 `wrongCount=3>=3 && lastCorrect=false` → 仍通过 ✓
- `analysis.test.ts` 4 条断言均为空 Map 或全正确场景，`correctRate` 为 0 或 1，不受 C2 修正影响 ✓
- `db/session.test.ts`、`db/persistence.test.ts`、`db/roundtrip.test.ts`：依赖 `applyAttempt` 的计数行为（attempts/correct/wrong），新状态机不改计数 → 仍通过 ✓
- `tests/browser.test.mjs` 的 plan 测试只断言「≥2 题、sessionId 稳定、遇到主观题、AI 评阅幂等」，不依赖具体题量 → 仍通过 ✓（且新用户场景由 freshQuota=size 保证非空，更稳）

---

## 6. 合成学习轨迹与自动化验证设计

新增 `src/lib/trajectory.test.ts`（纯逻辑，node 环境，无需浏览器）。为可测试，先将 `Plan.tsx:26-82` 的 `buildPlan` 抽为纯函数（新文件 `src/lib/plan.ts` 或并入 `scheduler.ts`），页面只负责渲染。

### 6.1 场景矩阵

| ID | 场景 | 关键断言 |
|---|---|---|
| T1 | 完全没有学习记录的新用户 | 客观题名额 = `size`（不缩水）；总题量 = `size + 1`；恰含 1 道主观题；`dueCount=0` 不报错。**完整题库与示例题库各跑一遍** |
| T2 | 大量未练题目（全部客观题未练 + 60 到期） | 到期题进入数 = `min(60, ceil(size*0.5))`；未练题补足余额；**无到期题被静默丢弃而不提示**（顺延数正确显示） |
| T3 | 长期反复答错的题目（错 20 次） | `struggling`；再答对 5 次 → `learning`；再答对至净 3 → `mastered`；`wrongCount` 仍为 20（历史不清零） |
| T4 | 连续答对后再次答错 | 5 对 → mastered；1 错 → **learning**（非 struggling）；`intervalDays=0`；该题在下次选题中权重 ≥ 普通 learning |
| T5 | 已掌握题目到期 | mastered + interval 30d + 过期 → 权重与普通到期题同级（不再 ×0.15）；能进入计划 |
| T6 | 同一天重复训练 | 同一 records 状态，相隔 3 分钟两次 `buildPlan`：**完整题库**下重叠率 < 50%；**示例题库**下仅断言两次均非空、无同题重复出现 |
| T7 | 少量题库（示例题库 14 客观 + 3 主观） | 不超长、不抛错、无重复题；`size=50` → 客观题 14（池上限）+ 主观题 1 = 15；「所有做过的」全 mastered 刚答过时不返回空会话 |
| T8 | 完整题库 | 覆盖率 / 配额 / 统计一致性全部正确；`size=50` 新用户 = 51；性能可接受（< 1s） |
| T9 | 主观题与客观题混合 | 主观题经 `applySubjectiveAttempt` 后 `intervalDays` 增长（1→2→3→4→6）、`status` 离开 `new`、`correctCount===0 && wrongCount===0 && lastCorrect===null`；30 次后仍为 `learning`（非 mastered）；Diagnosis 对主观题 `correctRate` 仍为 0；`sum(chapter.total) === allQuestions.length` |
| T10 | 时间推进后的到期复习变化 | 固定 `now` 推进 1/3/7/30 天；到期集合单调演化；已答题目 `nextReviewAt` 正确顺延；未练题目始终可选；无题目「消失」 |
| T11 | 优化前后对比（核心指标） | 见 6.2 |
| T12 | 到期极端积压（500 到期 + size=20） | 到期题占满客观题配额（20/20），未练题余额为 0；顺延提示显示剩余 480 道 | 完整题库专属 |
| T13 | 题库全覆盖后（0 到期 + 0 未练） | 计划 = 1 道主观题；页面显示「客观题已全部到期完毕」；不抛错 | 示例题库即可构造 |
| T14 | 主观题题库为空 | `subQuota = 0`；计划仅客观题；不抛错 | 合成空主观题 bank |

### 6.2 T11 对比指标（作为断言，不只是日志）

对同一组合成轨迹，分别以「优化前权重表 + 优化前配额」和「优化后」运行，断言：

**适用条件（重要）**：以下指标中标注「完整题库」的，只在 `objectiveQuestions.length >= 200` 时断言；标注「示例题库」的，用公开示例题库（17 题）单独构造场景。**不设定在小题库或到期优先场景中无法实现的全局阈值。**

| 指标 | 当前实测 | 目标 | 适用条件 |
|---|---|---|---|
| 新用户 size=50 计划题量 | 26 | **= size + 1 = 51** | 完整题库 |
| 新用户 size=50 计划题量（示例题库） | 7 | **= 15**（14 客观 + 1 主观，即池上限） | 示例题库（14 客观） |
| 60 道到期 + size=20 的到期命中数 | 6 | **≥ 10**（= dueQuota 上限） | 完整题库（未练题充足，足以补余额） |
| 到期优先场景：到期 500 + size=20 的到期命中 | 6 | **≥ 10** | 完整题库（验证到期池占满配额时不被未练挤占） |
| 同日两次计划重叠率 | 100% | **< 50%** | **仅完整题库**（客观题足够多时两次抽样有空间错开）；示例题库下仅断言「两次均非空」 |
| 全错章节在薄弱点榜单的排名 | 不在榜（rank 0） | **在榜且排第 1**（`kind==='weak'`、score 最低） | 两种题库均断言；示例题库下构造「1 全错 + 8 未练」同样验证挤出场景 |
| `sum(chapter.total)` vs `allQuestions.length` | 不相等 | **相等** | 两种题库均断言 |
|  mastered 刚答错题的选中概率 | ~2% | **≥ 20%** | 完整题库（混合池 9 题：3 未练 + 3 到期错 + 3 到期 mastered） |
| 错题本「所有做过的」空会话 | 出现 | **不出现** | **两种题库均断言**；示例题库下用「14 题全是刚答对的 mastered」这一必然触发场景 |
| 统计一致性（`correct+wrong <= attempts`） | 恒真 | **恒真（回归保护）** | 两种题库均断言 |
| 主观题间隔增长（5 次训练） | 恒 0 | **1→2→3→4→6** | 两种题库均断言 |
| 主观题 30 次训练后 status | 恒 `new` | **`learning`，永不 `mastered`** | 两种题库均断言 |
| 示例题库下 `size` 超过客观题池 | 静默截断 | **= min(size, pool) + subQuota**，且无重复题 | 示例题库专属 |

**重叠率指标的适用性**：重叠率受「候选池规模」与「到期配额占比」双重影响。示例题库仅 14 道客观题，两次各抽 10 题时**必然高度重叠**（鸽巢原理），此时 < 50% 是不可能达到的目标，设定它会制造虚假失败。因此该指标仅在候选池充足（≥ 200 题）时作为硬断言；示例题库下只保证「非空 + 无同日内重复题」这一可实现的弱约束。

**到期优先场景单列的理由**：当到期题数量远超当日配额时（如 500 道到期、size=20），`dueQuota` 会占满全部客观题名额，`fresh` 余额为 0——此时必须验证「到期题确实优先进入计划」而非被未练题挤占，这是与「新用户」相对的另一端边界。

### 6.3 浏览器 E2E 补充（`tests/browser.test.mjs`）

- **E2E-1**：全新 context 打开 Plan 页，选「50 题」，断言计划预览题量 ≥ 50（当前 26）。
- **E2E-2**：seed 60 条到期记录后打开 Plan 页，断言「今日到期复习」计数为 60，且计划中到期题数 ≥ 10，页面出现顺延提示。
- **E2E-3**：seed 20 条刚答对的 mastered 记录，进入错题本「所有做过的」，断言点击「开始复刷」后进入非空会话（当前为空）。
- **E2E-4**：seed 1 个全错章节 + 8 个未练章节的记录，打开 Diagnosis，断言薄弱点榜单**包含**该全错章节且排在未练章节之前（验证「不被挤出」）。
- **E2E-5**：对同一道主观题，先作答再多次点击「AI 参考评阅」，断言 IndexedDB 中该题 `attempts` 仅 +1 且 `nextReviewAt` 不因评阅而推进（验证幂等 + 间隔不被重复推进）。

---

## 7. 预计修改文件、潜在风险和工作量

### 7.1 修改文件

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/lib/scheduler.ts` | 状态机（A1/A2/A3）、权重表（E1/E3/E4）、新增 `applySubjectiveAttempt`、ease 下限统一、同日去重辅助、清理死代码与重复 JSDoc | **中**：行为变化影响全部 4 条写入路径 |
| `src/lib/analysis.ts` | C1（subj/total/objectiveTotal）、薄弱点二分类与独立公式（C2）、C3（删死字段） | **中**：UI 字段语义变化 |
| `src/lib/plan.ts` | **新增**：承载 `buildPlan` 纯函数与配额公式 | 低 |
| `src/pages/Plan.tsx` | 改用纯函数、配额重构、顺延提示、题量口径统一、主观题确定性 | **中**：E2E 有 3 个 plan 相关用例 |
| `src/lib/session.ts` | 3 处主观题写入改用 `applySubjectiveAttempt`；3 个函数补 `reviewIntervalBase` 可选参数 | **中**：触碰阶段 1 幂等逻辑，须逐条对照测试 |
| `src/store/StoreContext.tsx` | 向 `session.ts` 三个函数传入 `settings.reviewIntervalBase` | **中**：触碰统一写入入口 |
| `src/pages/Diagnosis.tsx` | `c.total` 语义同步、薄弱点类别标签、detail 文本 | 低 |
| `src/pages/Practice.tsx` | `chapterStat.total` 展示 | 低 |
| `src/lib/trajectory.test.ts` | **新增** T1–T14 | 低 |
| `src/lib/plan.test.ts` | **新增**：配额 / 去重 / 顺延 / 规模差异单测 | 低 |
| `src/lib/scheduler.test.ts` | 更新/新增状态机与权重断言 | 低 |
| `src/lib/analysis.test.ts` | 新增 C1/C2 断言与 R1–R9 薄弱点回归 | 低 |
| `src/db/session.test.ts` | 新增 S1–S8 主观题间隔与幂等断言 | 低 |
| `tests/browser.test.mjs` | 新增 E2E-1/2/3 | 中（依赖 Chrome） |
| `docs/study-strategy.md` | G1–G7 逐条对齐 + 薄弱点分类 + ease 语义 | 低 |
| `CHANGELOG.md` | 记录改动与旧数据过渡期说明 | 低 |

**不改**：`src/db/*`、`src/lib/io.ts`、`src/lib/bank.ts`、`data/*`、`src/lib/scoring.ts`、`src/lib/mock-grading.ts`、`src/components/*`、`server/*`、`tools/*`、`.github/*`、`package.json`。

### 7.2 潜在风险与缓解

| 风险 | 缓解 |
|---|---|
| 状态机变化导致历史 `struggling` 记录在新规则下「应该」恢复但未恢复 | 明确记录为过渡期现象；下次作答即修正；不写批量重算事务 |
| `ChapterStat.total` 语义变化影响 `Diagnosis.tsx` / `Practice.tsx` 展示 | 两处同步小改；T9 断言 `sum(total) === allQuestions.length` |
| `session.ts` / `StoreContext.tsx` 改动波及阶段 1 幂等测试 | `applySubjectiveAttempt` 为纯函数新增；事务边界、`attemptIdFor`/`hasAttempt`、`db.mocks.get(runId)` 一行不动；S1–S8 逐条覆盖；跑全量 `db/*.test.ts` 对照 |
| 薄弱点二分类后 `Diagnosis.tsx` / `Home.tsx` 渲染受影响 | `weakPoints` 字段名、长度上限 6、`score` 字段均不变，仅新增 `kind`；现有 `.map` / `Tag` 阈值无需改；R1–R9 锁定排序与文本 |
| 权重表变化使 `scheduler.test.ts:118` 的 `masteredPicked <= 4` 断言失效 | 该断言的本意（mastered 应稀有）由「未到期 mastered ×0.3」继续保证；测试场景中 mastered 均「未到期」，预期仍通过，若不通过则更新为更精确的表述并说明理由 |
| ease 下限统一后 `reviewIntervalBase > 1` 的老用户间隔曲线改变 | 仅在用户**主动调高**该设置后才出现，且默认值 1 不变；CHANGELOG 说明；S/权重回归测试锁定四条路径一致 |
| 主观题间隔从「固定 +24h」变为「递增」后，短期内题目出现频率变化 | 1.5× 增长 + 30 天封顶比原方案更保守；`Subjective.tsx` 的「已训练/未训练」标签口径不变（仍看 `attempts > 0`） |
| 浏览器 E2E 依赖本机 Chrome | E2E-1/2/3 与现有用例同为可选层；CI 已有 google-chrome-stable |
| 「到期 FIFO」使用 `lastSeenAt` 排序，同秒提交的题目顺序不稳定 | 排序键加 `qid` 作稳定次序，保证确定性 |
| 示例题库下重叠率等指标不可能达标 | §6.2 已为每个指标标注适用题库规模，示例题库只断言可实现的弱约束 |

### 7.3 工作量

| 项 | 量级 |
|---|---|
| P0（4 项） | 小–中 |
| P1（5 项） | 中 |
| P2（7 项，含文档与 ease 统一） | 中 |
| 薄弱点二分类 + R1–R9 | 小–中 |
| 主观题三路径改造 + S1–S8 | 中 |
| `plan.ts` 抽取与配额公式 + T1–T14 | 中（主体工作量） |
| E2E 补充 5 项 | 小–中 |
| **合计** | **中等。不引入新依赖、新架构、新技术栈。** |

---

## 8. 阶段 2 完成标准

1. **合成轨迹验证**：T1–T14 全部通过，T11 的对比指标全部达到目标值（按其标注的适用题库规模），且数值记录在测试输出中（可复现，非口头声称）。
2. **薄弱点分类回归**：R1–R9 全部通过，特别是 R1（1 个全错章节 + 8 个未练章节时全错章节必须在榜且排第 1）与 R8（两组分数不混排）——直接锁定该失败模式及其复发风险。
3. **主观题写入一致性**：S1–S8 全部通过，覆盖 `recordAttempt` / `submitMockRun` / `saveAiReviewWithAttempt` 三条路径；AI 评阅不重复推进间隔；`lastCorrect` 恒 null；`correctCount`/`wrongCount` 恒 0；永不自动 `mastered`。
4. **既有测试不倒退**：现有 141 个单测 + AI 代理契约测试 + 浏览器 E2E 全绿；任何被有意更新的断言须在 CHANGELOG 说明理由。
5. **本地全量检查通过**：`npm run typecheck`、`lint`、`format:check`、`check:public-info`、`test:public-info`、`test`、`test:ai`、`build` 全部通过；浏览器 E2E 通过。
6. **文档与代码逐条对应**：`docs/study-strategy.md` 的权重表、状态机、可调参数、诊断指标四节与实现完全一致，无 G1–G7 类不一致残留；薄弱点二分类公式与 ease 语义须完整写出，不隐去兜底逻辑。
7. **红线未被触碰（逐条核对）**：
   - 题库题干 / 选项 / 正确答案 / 身份绑定零改动；
   - 阶段 1 的事务写入、Session ID 幂等、备份恢复机制未被破坏（`src/db/*`、`io.ts` 零改动）；
   - 无完整题库、原始 PDF、生成文件、个人数据、凭据进入公开内容；
   - 遵守已合并的公开信息治理规范（推送前跑门禁）；
   - 不伪造学习数据、官方分数、考试提分效果或外部验证结论；AI 仍仅为参考评阅；主观题不因训练次数增加而自动标记已掌握；
   - 无 UI/UX 整体重设计（仅文字与数字口径修正）；
   - 不开展真实 Sub2API 网关联调；
   - 不引入大型依赖、云服务或新技术栈。
8. **指标表述合规**：所有验收指标表述为「工程与策略指标」（选题覆盖、到期命中、重复率、统计一致性、异常边界），**不宣称能提高实际考试分数**；每个指标标注适用题库规模，不设定无法达到的全局阈值。

---

## 附：可复现性

- 本文引用的每个数值均由仓库内的测试产生，不含估算或推断。
- 重放方式：`npm test`（单元与合成轨迹）、`npm run test:browser`（浏览器关键流程）、`npm run test:browser:phase2`（阶段 2 复习策略行为）。
- 合成轨迹测试使用固定时钟与固定种子（`mulberry32`），不含 `Math.random` 与墙钟读取，因此结果可重复。
- 两种题库规模均可验证：公开示例题库（`data/sample-bank.json`，17 题）与本地完整题库（`data/bank.json`，需自行安装）。
- 阶段 1 的可靠性基线（事务写入、Session ID 幂等、备份恢复）在本次改动后仍有回归测试覆盖，见 `src/db/roundtrip.test.ts` 中的对应分组。
