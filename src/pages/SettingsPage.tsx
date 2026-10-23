import { useEffect, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { CardPad, PageHead, useConfirm, useToast } from '../components/ui'
import type { AppSettings } from '../lib/types'
import { AiSettingsSection } from './AiSettingsSection'
import { DataIOCard } from './DataIO'

/**
 * 设置 — one place for preferences, AI configuration and data management.
 *
 * Consolidates what used to be three sidebar entries (偏好设置 / AI 助手 /
 * 导入导出). Each section keeps its full original capability; they are simply
 * grouped, because all three are visited rarely and none is part of the daily
 * answering loop.
 *
 * `dailyGoalQuestions` and `studyTarget` are gone from the UI: neither was ever
 * read by the planning or scheduling logic, so editing them changed nothing.
 * `reviewIntervalBase` IS read (scheduler ease floor) and therefore stays.
 * The underlying fields remain in the settings type and the backup format so
 * old backups still import cleanly.
 */
export function SettingsPage({ params: _params }: { params: Record<string, string> }) {
  const { settings, ready, updateSettings, resetAllProgress } = useStore()
  const { toast, el } = useToast()
  const { confirm, confirmEl } = useConfirm()
  const [reviewIntervalBase, setReviewIntervalBase] = useState(settings.reviewIntervalBase)
  const [saving, setSaving] = useState(false)

  // Settings load asynchronously from IndexedDB; never overwrite persisted values
  // with the initial defaults when the user later saves a different field.
  useEffect(() => {
    if (ready) setReviewIntervalBase(settings.reviewIntervalBase)
  }, [ready, settings.reviewIntervalBase])

  const chooseTheme = async (theme: AppSettings['theme']) => {
    if (saving || settings.theme === theme) return
    setSaving(true)
    try {
      await updateSettings({ theme })
    } catch {
      toast('外观保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  if (!ready) return null

  return (
    <>
      <PageHead title="设置" desc="外观、复习参数、AI 网关与数据备份，全部保存在本地。" />

      <CardPad>
        <div className="card-title">外观</div>
        <div className="btn-row">
          {(
            [
              ['light', '浅色'],
              ['dark', '深色'],
              ['auto', '跟随系统'],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              aria-pressed={settings.theme === v}
              className={`btn btn-sm ${settings.theme === v ? 'btn-primary' : ''}`}
              disabled={saving}
              onClick={() => void chooseTheme(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="muted-2" style={{ marginTop: 8 }}>
          选择后立即生效并自动保存，无需点击下方保存按钮。
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">复习参数</div>
        <div className="grid grid-3">
          <label className="field">
            <span className="field-label">复习间隔基数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={reviewIntervalBase}
              onChange={(e) => setReviewIntervalBase(Number(e.target.value) || 1)}
            />
          </label>
        </div>
        <div className="muted-2" style={{ marginBottom: 12 }}>
          间隔基数越大，同一道题复习得越稀疏（例如设为 2 时，答对后的间隔按 1→2→4→8 天递增）。
        </div>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              try {
                await updateSettings({ reviewIntervalBase })
                toast('复习参数已保存')
              } catch {
                toast('复习参数保存失败，请重试')
              } finally {
                setSaving(false)
              }
            }}
          >
            保存设置
          </button>
          <button className="btn btn-ghost" onClick={() => setReviewIntervalBase(settings.reviewIntervalBase)}>
            还原
          </button>
        </div>
      </CardPad>

      <AiSettingsSection />

      <DataIOCard />

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">危险操作</div>
        <div className="muted" style={{ marginBottom: 10 }}>
          重置将删除全部学习记录、历史、模拟考试与 AI 评阅，且不可恢复。建议先在上方「数据备份」中导出备份。
        </div>
        <button
          className="btn btn-danger"
          onClick={async () => {
            const ok = await confirm({
              title: '重置全部学习数据？',
              body: '将删除全部题目记录、练习历史、模拟考试与 AI 评阅。此操作不可恢复，建议先导出备份。',
              confirmLabel: '确认重置',
              danger: true,
            })
            if (!ok) return
            void resetAllProgress()
            toast('已重置')
          }}
        >
          重置全部学习数据
        </button>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">关于</div>
        <div className="muted">
          ExamPilot 习概 — 《习近平新时代中国特色社会主义思想概论》期末智能复习。题库解析自指定 PDF，
          客观题答案以题库为准；AI 功能通过本地服务端代理访问你自己的网关，密钥不暴露在前端。
        </div>
      </CardPad>
      {el}
      {confirmEl}
    </>
  )
}
