import { useRef, useState } from 'react'
import { useStore } from '../store/StoreContext'
import {
  parseExport,
  makeExportPayload,
  serialize,
  planImport,
  diffImport,
  describePlan,
  checkBank,
  bankFingerprint,
  type RestoreMode,
  type ExportPayload,
  type ImportDiff,
  type BankCheck,
  type ImportPlan,
} from '../lib/io'
import { CardPad, PageHead, Tag, useToast } from '../components/ui'
import { APP_VERSION } from '../lib/meta'
import { bank } from '../lib/bank'

/**
 * Import is a two-step flow:
 *   1. select a file -> validate -> show a PREVIEW (contents, strategy, diff, risks)
 *   2. the user explicitly confirms -> one transaction writes everything
 *
 * Nothing is written before the user confirms. Every row is filtered against the
 * current bank first, so learning progress that cannot be tied to a current
 * question is never merged into the statistics.
 */
interface Preview {
  fileName: string
  payload: ExportPayload
  diff: ImportDiff
  bankCheck: BankCheck
  plan: ImportPlan
  warnings: string[]
}

export function DataIOCard() {
  const { records, history, mocks, aiReviews, settings, ready, restoreBackup } = useStore()
  const { toast, el } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [overwriteAck, setOverwriteAck] = useState(false)
  const [legacyAck, setLegacyAck] = useState(false)

  const currentData = () => ({
    records: Array.from(records.values()),
    history,
    mocks,
    aiReviews,
    settings,
  })

  const bankIds = () => new Set(bank.questions.map((q) => q.id))

  const exportAll = () => {
    const payload = makeExportPayload({
      settings,
      records: Array.from(records.values()),
      history,
      mocks,
      aiReviews,
      bankFingerprint: bankFingerprint(bank),
      bankCount: bank.questions.length,
    })
    const blob = new Blob([serialize(payload)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `exampilot-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出学习数据')
  }

  const exportBank = () => {
    const blob = new Blob([JSON.stringify(bank, null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'exampilot-bank.json'
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出题库数据')
  }

  const buildPreview = (fileName: string, payload: ExportPayload, warnings: string[], m: RestoreMode): Preview => {
    const existing = currentData()
    const ids = bankIds()
    const bankCheck = checkBank(payload, bankFingerprint(bank), bank.questions.length, ids)
    const plan = planImport(payload, m, existing, ids, bankCheck.status === 'match')
    return {
      fileName,
      payload,
      diff: diffImport(plan, m, existing),
      bankCheck,
      plan,
      warnings,
    }
  }

  /** Step 1: validate and build a preview. Writes NOTHING. */
  const onFile = async (f: File) => {
    setBusy(true)
    setMsg([])
    setPreview(null)
    setOverwriteAck(false)
    setLegacyAck(false)
    try {
      const text = await f.text()
      const res = parseExport(text)
      if (!res.ok || !res.payload) {
        setMsg(['导入失败：备份未通过校验，未写入任何数据。', ...res.errors.slice(0, 8)])
        return
      }
      setPreview(buildPreview(f.name, res.payload, res.warnings, mode))
    } catch (e) {
      setMsg([`导入失败：${(e as Error).message}`, '未写入任何数据。'])
    } finally {
      setBusy(false)
    }
  }

  /** Recompute the preview when the strategy changes. */
  const switchMode = (m: RestoreMode) => {
    setMode(m)
    setOverwriteAck(false)
    if (!preview) return
    setPreview(buildPreview(preview.fileName, preview.payload, preview.warnings, m))
  }

  const cancelPreview = () => {
    setPreview(null)
    setMsg(['已取消导入，数据库未发生任何更改。'])
  }

  /** Step 2: the user confirmed — write everything in one transaction. */
  const confirmImport = async () => {
    if (!preview) return
    if (mode === 'replace' && !overwriteAck) {
      setMsg(['替换模式会清空现有学习数据，请先勾选确认。'])
      return
    }
    if (preview.bankCheck.status === 'unknown' && !legacyAck) {
      setMsg(['旧版备份缺少题库指纹，请先确认你了解风险。'])
      return
    }
    setBusy(true)
    try {
      const { plan } = preview
      const out = await restoreBackup({
        records: plan.records,
        history: plan.history,
        mocks: plan.mocks,
        aiReviews: plan.aiReviews,
        settingsAction: plan.settingsAction,
        settings: plan.settings,
      })
      setMsg([
        '导入完成：学习记录、历史、模拟考试、AI 评阅与偏好设置已按所选策略恢复。',
        ...describePlan(plan, mode),
        `当前偏好设置：主题 ${out.settings.theme} · 每日目标 ${out.settings.dailyGoalQuestions} 题`,
      ])
      setPreview(null)
      toast('导入完成')
    } catch (e) {
      setMsg([`导入失败：${(e as Error).message}`, '数据库未发生任何更改（事务已回滚）。'])
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return null

  const f = preview?.plan.filter
  const excludedTotal = f ? f.excludedRecords + f.excludedHistory + f.excludedMocks + f.excludedAiReviews : 0
  const isFingerprintMatch = preview?.bankCheck.status === 'match'
  const hasVerifiableStudyData = f
    ? f.keptRecords > 0 || f.keptHistory > 0 || f.keptMocks > 0 || f.keptAiReviews > 0
    : true
  const hasRecoverableSettings = preview
    ? preview.plan.settingsAction === 'set' && preview.plan.settings !== null
    : false
  const canImport = isFingerprintMatch
    ? f
      ? !f.nothingVerifiable || hasRecoverableSettings
      : true
    : hasVerifiableStudyData || (mode === 'merge' && hasRecoverableSettings)

  // Replace mode is disallowed if cross-bank progress is unverified,
  // to avoid accidentally clearing existing progress just to apply settings.
  const replaceBlocked = mode === 'replace' && !isFingerprintMatch && !hasVerifiableStudyData
  const needsOverwriteAck = mode === 'replace' && !overwriteAck
  const needsLegacyAck = preview?.bankCheck.status === 'unknown' && !legacyAck
  const confirmBlocked = !canImport || replaceBlocked || needsOverwriteAck || needsLegacyAck

  return (
    <>
      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <CardPad>
          <div className="card-title">导出</div>
          <div className="muted" style={{ marginBottom: 12 }}>
            学习记录 {records.size} 条 · 历史 {history.length} 条 · 模拟考试 {mocks.length} 场 · AI 评阅{' '}
            {aiReviews.length} 条
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={exportAll}>
              导出学习数据（JSON）
            </button>
            <button className="btn" onClick={exportBank}>
              导出题库（JSON）
            </button>
          </div>
          <div className="divider" />
          <div className="card-title">题库版本</div>
          <div className="muted">
            {bank.schema} · {bank.countsByType.single} 单选 / {bank.countsByType.multi} 多选 / {bank.countsByType.judge}{' '}
            判断 / {bank.countsByType.short} 简答 / {bank.countsByType.material} 材料
          </div>
          <div className="muted-2" style={{ marginTop: 4 }}>
            应用版本 v{APP_VERSION}
          </div>
          <div className="muted-2" style={{ marginTop: 4 }}>
            题库指纹 {bankFingerprint(bank).slice(0, 12)}…
          </div>
        </CardPad>

        <CardPad>
          <div className="card-title">导入恢复</div>
          <div className="muted" style={{ marginBottom: 10 }}>
            选择备份文件后，系统会先校验格式并展示内容预览、恢复策略、与现有数据的差异和风险；
            <b>在你点击「确认导入」之前不会写入任何数据</b>。
          </div>
          <div className="field">
            <span className="field-label">恢复策略</span>
            <div className="btn-row">
              <button
                className={`btn btn-sm ${mode === 'merge' ? 'btn-primary' : ''}`}
                onClick={() => switchMode('merge')}
              >
                合并（同 ID 以备份为准）
              </button>
              <button
                className={`btn btn-sm ${mode === 'replace' ? 'btn-primary' : ''}`}
                onClick={() => switchMode('replace')}
              >
                替换（清空后写入）
              </button>
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onFile(file)
              e.target.value = ''
            }}
          />
          {busy && (
            <div className="muted" style={{ marginTop: 8 }}>
              处理中…
            </div>
          )}
          {msg.length > 0 && (
            <div className="explain" style={{ marginTop: 10 }}>
              {msg.map((m, i) => (
                <div key={i}>{m}</div>
              ))}
            </div>
          )}
        </CardPad>
      </div>

      {preview && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <div className="card-title" style={{ margin: 0 }}>
              导入预览 — {preview.fileName}
            </div>
            <Tag tone={preview.bankCheck.status === 'match' ? 'ok' : 'warn'}>
              {preview.bankCheck.status === 'match'
                ? '题库一致'
                : preview.bankCheck.status === 'mismatch'
                  ? '题库不一致'
                  : '题库未知（旧版备份）'}
            </Tag>
          </div>

          <div className="muted" style={{ marginBottom: 10 }}>
            {preview.bankCheck.message}
          </div>

          {!hasVerifiableStudyData && hasRecoverableSettings && mode === 'merge' && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              备份与当前题库不一致或缺乏完整题目绑定证明，未经验证的学习数据已安全排除，以防串题污染统计。由于备份包含有效偏好设置，在合并模式下
              <b>可单独恢复偏好设置</b>（当前学习数据保持不变）。
            </div>
          )}

          {!hasVerifiableStudyData && hasRecoverableSettings && mode === 'replace' && (
            <div className="result-banner bad" style={{ marginBottom: 10 }}>
              备份未包含可安全验证的学习进度。为防止替换模式意外清空您现有的学习数据，<b>已禁止替换导入</b>
              。如需仅恢复设置，请切换至「合并」模式。
            </div>
          )}

          {!hasVerifiableStudyData && !hasRecoverableSettings && (
            <div className="result-banner bad" style={{ marginBottom: 10 }}>
              备份与当前题库不一致或没有任何数据能对应到当前题库，且未包含可恢复的有效学习数据或偏好设置，因此
              <b>没有可导入的内容</b>。请使用与当前题库匹配的备份。
            </div>
          )}

          {preview.bankCheck.status === 'mismatch' && hasVerifiableStudyData && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              备份来自不同题库（指纹不一致）。由于题目选项与答案绑定无法保证一致，未经验证的学习记录与历史已自动排除，以防串题污染统计。
            </div>
          )}
          {preview.bankCheck.status === 'unknown' && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              这是旧版备份（缺少完整题库指纹），缺乏题目—选项—答案绑定证明。为保证当前学习统计真实，无法确认题目是否一致，学习记录与历史已安全隔离。
            </div>
          )}

          {excludedTotal > 0 && hasVerifiableStudyData && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              已安全排除 {excludedTotal} 条未通过题库一致性验证的数据： 学习记录 {f?.excludedRecords}、历史{' '}
              {f?.excludedHistory}、 模拟考试 {f?.excludedMocks}、AI 评阅 {f?.excludedAiReviews}。
            </div>
          )}

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>数据</th>
                  <th>备份中</th>
                  <th>可验证</th>
                  <th>现有</th>
                  <th>新增</th>
                  <th>覆盖</th>
                  <th>恢复后</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['学习记录', preview.diff.records, f?.excludedRecords ?? 0],
                    ['练习历史', preview.diff.history, f?.excludedHistory ?? 0],
                    ['模拟考试', preview.diff.mocks, f?.excludedMocks ?? 0],
                    ['AI 评阅', preview.diff.aiReviews, f?.excludedAiReviews ?? 0],
                  ] as const
                ).map(([label, d, excluded]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{d.incoming + excluded}</td>
                    <td>{d.incoming}</td>
                    <td>{d.existing}</td>
                    <td>{d.added}</td>
                    <td>{d.updated}</td>
                    <td>{mode === 'replace' ? d.incoming : d.existing + d.added}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divider" />
          <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
            {describePlan(preview.plan, mode).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            {preview.diff.settingsChanged && <li>偏好设置：备份中的设置与当前不同，将被应用。</li>}
            {mode === 'replace' && preview.diff.clearedInReplace > 0 && (
              <li style={{ color: 'var(--bad)' }}>
                替换将删除现有 {preview.diff.clearedInReplace} 条数据（学习记录 / 历史 / 模拟 / AI 评阅）。
              </li>
            )}
            {preview.warnings.map((w, i) => (
              <li key={`w${i}`} style={{ color: 'var(--warn)' }}>
                {w}
              </li>
            ))}
          </ul>

          <div className="divider" />
          {mode === 'replace' && (
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={overwriteAck} onChange={(e) => setOverwriteAck(e.target.checked)} />
              <span className="muted">我确认要用备份替换现有全部学习数据（现有数据将被删除，且不可撤销）</span>
            </label>
          )}
          {preview.bankCheck.status === 'unknown' && (
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={legacyAck} onChange={(e) => setLegacyAck(e.target.checked)} />
              <span className="muted">我确认这是缺少指纹的旧版备份，了解无法确认题目是否一致的风险</span>
            </label>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={confirmImport} disabled={busy || confirmBlocked}>
              确认导入
            </button>
            <button className="btn" onClick={cancelPreview} disabled={busy}>
              取消
            </button>
            {mode === 'replace' && !isFingerprintMatch && !hasVerifiableStudyData && hasRecoverableSettings && (
              <span className="muted-2">替换模式已禁止（防止清空现有进度），请切至合并模式</span>
            )}
            {mode === 'replace' && (isFingerprintMatch || hasVerifiableStudyData) && !overwriteAck && (
              <span className="muted-2">请先勾选替换确认</span>
            )}
            {needsLegacyAck && <span className="muted-2">请先勾选旧版备份风险确认</span>}
            {!canImport && <span className="muted-2">没有可导入的数据</span>}
          </div>
        </CardPad>
      )}

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">数据说明</div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
          <li>
            备份包含学习记录、练习历史、模拟考试成绩、AI 评阅与偏好设置，并附带基于全量题干、选项与答案的 SHA-256
            题库指纹。
          </li>
          <li>只有在题库指纹完全一致时，学习进度与练习历史才能安全恢复，以杜绝题目答案变动引发的串题错误。</li>
          <li>题库指纹不同或旧备份缺少指纹时，未通过完整题库一致性证明的学习记录不会混入当前统计。</li>
          <li>
            简答题与材料分析论述题在题库中只有题干、没有标准答案，系统不伪造官方答案；AI
            评阅结果会单独保存并标注为参考评阅。
          </li>
          <li>清除浏览器站点数据会删除本地学习记录，请定期导出备份。</li>
        </ul>
      </CardPad>
      {el}
    </>
  )
}

/**
 * Standalone `#/io` route.
 *
 * Data backup/restore is normally reached from 设置 → 数据备份, but the hash
 * route is kept so existing bookmarks still work. Both entry points render the
 * same DataIOCard — there is no second implementation to drift.
 */
export function DataIO({ params: _params }: { params: Record<string, string> }) {
  return (
    <>
      <PageHead
        title="数据备份与恢复"
        desc="所有学习数据保存在浏览器本地数据库（IndexedDB）。导出为 JSON 备份后可在任意设备恢复。"
      />
      <DataIOCard />
    </>
  )
}
