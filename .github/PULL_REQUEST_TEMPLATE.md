## 修改摘要

<!-- 用 1-3 句话说明这个 PR 做了什么，解决什么问题 -->

Closes #

## 修改类型

- [ ] feat（新功能）
- [ ] fix（缺陷修复）
- [ ] refactor（不改变外部行为）
- [ ] docs（文档）
- [ ] test（测试）
- [ ] chore（构建 / 依赖 / 配置）
- [ ] perf（性能）

## 改动清单

<!-- 列出主要改动的文件与原因 -->

- `src/...` —
- `server/...` —

## 测试结果

<!-- 必须真实执行并贴出结果。不要把没跑过的测试写成 PASS -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run check:public-info`
- [ ] `npm run test:public-info`
- [ ] `npm test`
- [ ] `npm run test:ai`
- [ ] `npm run build`
- [ ] `npm run test:browser`（如涉及 UI）

```
粘贴关键输出（如 Tests  36 passed (36)）
```

## 风险与回滚

<!-- 这个改动可能影响什么？如何回滚？是否涉及数据迁移？ -->

- 影响范围：
- 数据迁移：
- 回滚方式：

## 检查项

- [ ] 未提交任何密钥、`.env`、`server/ai-config.json`
- [ ] 未提交完整课程题库（`data/bank.json`、`data/local-bank.json`、`src/lib/local-bank.generated.ts`）或原始 PDF
- [ ] 未修改已入库题目的题干 / 选项 / 答案绑定
- [ ] 未虚构题库答案、掌握率或预测成绩
- [ ] 新增脚本已在 `package.json` 中登记，CI 可调用
- [ ] 如为破坏性变更，已更新 CHANGELOG

### 公开信息治理（见 [docs/information-governance.md](../docs/information-governance.md)）

- [ ] PR 标题、描述、提交信息与代码注释中不含本地绝对路径、私人文件名或个人身份信息
- [ ] 不含无证据的验收表述；验证结论已写明命令与提交
- [ ] 未引入需要隐藏的内部研发记录
- [ ] `npm run check:public-info` 通过，且已对新增文字完成人工复核

## 截图（如涉及 UI）

<!-- 粘贴前后对比截图 -->
