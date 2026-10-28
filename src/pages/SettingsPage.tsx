import { useEffect, useState } from 'react'
import { useAiUsable } from '../lib/ai-access'
import { useStore } from '../store/StoreContext'
import { CardPad, PageHead, useConfirm, useToast } from '../components/ui'
import type { AppSettings } from '../lib/types'
import { AiSettingsSection } from './AiSettingsSection'
import { DataIOCard } from './DataIO'
import { AI_ENABLED, IS_WEB_EDITION } from '../lib/edition'
import { Tabs } from '../web/kit'
import { APP_VERSION, BRAND } from '../lib/meta'
import { BankFingerprintCard } from '../components/BankFingerprintCard'
import { AccountSyncCard } from '../sync/SyncUI'
import { ThemePicker } from '../components/ThemePicker'

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
  const aiOn = useAiUsable()
  const { settings, ready, updateSettings, resetAllProgress } = useStore()
  const { toast, el } = useToast()
  const { confirm, confirmEl } = useConfirm()
  const [reviewIntervalBase, setReviewIntervalBase] = useState(settings.reviewIntervalBase)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(location.hash.split('?')[1] || '').get('tab')
    return t && ['learn', 'look', 'data', 'about'].includes(t) ? t : 'learn'
  })
  /** web: one category at a time; desktop: everything as before */
  const show = (t: string) => !IS_WEB_EDITION || tab === t

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
      <PageHead
        title="设置"
        desc={
          AI_ENABLED
            ? '外观、复习参数、AI 网关与数据备份，全部保存在本地。'
            : IS_WEB_EDITION
              ? '账号与同步、外观、复习参数与数据备份。学习数据随账号自动同步到你登录的所有设备。'
              : '外观、复习参数与数据备份，全部保存在本地。'
        }
      />
      {IS_WEB_EDITION && (
        <Tabs
          label="设置分类"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'learn', label: '学习设置' },
            { id: 'look', label: '外观' },
            { id: 'data', label: '账号与数据' },
            { id: 'about', label: '高级与关于' },
          ]}
        />
      )}
      {IS_WEB_EDITION && show('data') && <AccountSyncCard />}

      {show('look') && (
        <CardPad>
          <div className="card-title">外观</div>
          {IS_WEB_EDITION ? (
            <ThemePicker onError={toast} />
          ) : (
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
          )}
          <div className="muted-2" style={{ marginTop: 8 }}>
            {IS_WEB_EDITION
              ? '选择后立即生效，并随账号同步到你的其他设备。'
              : '选择后立即生效并自动保存，无需点击下方保存按钮。'}
          </div>
        </CardPad>
      )}

      {show('learn') && (
        <CardPad style={{ marginTop: IS_WEB_EDITION ? 0 : 14 }}>
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
      )}

      {AI_ENABLED ? <AiSettingsSection /> : show('about') && <BankFingerprintCard />}

      {show('data') && <DataIOCard />}

      {show('data') && (
        <CardPad style={{ marginTop: 14 }} className={IS_WEB_EDITION ? 'wk-danger-zone' : ''}>
          <div className="card-title">危险操作</div>
          <div className="muted" style={{ marginBottom: 10 }}>
            {IS_WEB_EDITION
              ? `重置将删除本账号的全部学习记录、历史与模拟考试${aiOn ? '（含 AI 评阅；AI 对话不受影响）' : ''}，且不可恢复。建议先在上方「数据备份」中导出备份。`
              : '重置将删除全部学习记录、历史、模拟考试与 AI 评阅，且不可恢复。建议先在上方「数据备份」中导出备份。'}
          </div>
          <button
            className="btn btn-danger"
            onClick={async () => {
              const ok = await confirm({
                title: '重置全部学习数据？',
                body: IS_WEB_EDITION
                  ? '将删除本账号的全部题目记录、练习历史、模拟考试和未完成的练习，并同步到你的所有设备（外观与复习参数保留）。此操作不可恢复，建议先导出备份。'
                  : '将删除全部题目记录、练习历史、模拟考试与 AI 评阅。此操作不可恢复，建议先导出备份。',
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
      )}

      {show('about') && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="card-title">关于</div>
          {IS_WEB_EDITION ? (
            <div className="muted about-web">
              <p style={{ margin: '0 0 6px' }}>
                <strong>
                  {BRAND.en} {BRAND.zh}
                </strong>
                ——{BRAND.positioning}
              </p>
              <p style={{ margin: '0 0 6px' }}>{BRAND.tagline}</p>
              <p style={{ margin: '0 0 6px' }}>
                面向《习近平新时代中国特色社会主义思想概论》课程复习：章节与专项练习、模拟考试、错题本与学习诊断。客观题答案以题库为准；简答与材料题提供自评训练。
              </p>
              <p style={{ margin: '0 0 6px' }}>
                使用说明：通过受邀邮箱和一次性验证码登录；学习记录保存在你的账号里，用同一个邮箱在手机、电脑登录会自动同步，换设备可以直接接着学。
              </p>
              <p style={{ margin: '0 0 6px' }}>
                开发与维护：{BRAND.maintainer}
                {'\u3000'}软件版本 v{APP_VERSION}
              </p>
              <p style={{ margin: '0 0 6px' }}>软件署名：{BRAND.copyright}</p>
              <p style={{ margin: '0 0 6px' }}>
                项目主页：GitHub{' '}
                <a href={BRAND.repoUrl} target="_blank" rel="noopener noreferrer">
                  {BRAND.github}/ExamPilot-public
                </a>
              </p>
              <p style={{ margin: 0 }}>内容权利说明：{BRAND.contentRights}本平台为独立学习辅助工具，非学校官方网站。</p>
            </div>
          ) : (
            <div className="muted">
              ExamPilot 习概 — 《习近平新时代中国特色社会主义思想概论》期末智能复习。题库解析自指定 PDF，
              客观题答案以题库为准；
              {AI_ENABLED
                ? 'AI 功能通过本地服务端代理访问你自己的网关，密钥不暴露在前端。'
                : '网页版暂不提供 AI 功能，学习记录只保存在你自己的浏览器里。'}
            </div>
          )}
        </CardPad>
      )}
      {el}
      {confirmEl}
    </>
  )
}
