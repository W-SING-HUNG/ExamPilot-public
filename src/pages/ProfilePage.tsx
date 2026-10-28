import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { useSync } from '../sync/CloudStore'
import { useAiAccess, tierOf } from '../lib/ai-access'
import { objectiveQuestions, subjectiveQuestions, allQuestions } from '../lib/bank'
import { computeDiagnosis } from '../lib/analysis'
import { CardPad, PageHead, Tag, useToast } from '../components/ui'
import { LogoMark, ProBadge } from '../components/Brand'
import { ThemePicker } from '../components/ThemePicker'
import { openFloatingAiConversation } from '../components/FloatingAiAssistant'
import { fmtDate, fmtLeft, TabPanel, Tabs } from '../web/kit'
import { ReferralPanel, CloseAccountPanel } from '../web/AccountPanels'
import type { RouteName } from '../store/router'

/**
 * 个人中心 (web edition).
 *
 * Identity comes only from the server (tier 'pro' = /api/ai/status allowed:true).
 * Nothing here invents membership facts: no price, no expiry, no quota, no balance,
 * because none exist. Admin is shown as its own, independent mark.
 */
export function ProfilePage({ nav }: { nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void> }) {
  const access = useAiAccess()
  const tier = tierOf(access)
  const sync = useSync()
  const { records, history, mocks } = useStore()
  const { toast, el } = useToast()
  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const email = sync?.email ?? ''
  const pro = tier === 'pro'
  const graded = mocks.filter((m) => (m as { graded?: boolean }).graded).length
  const aiChats = sync?.aiChats.length ?? 0
  const [tab, setTab] = useState(() => (location.hash.includes('tab=referral') ? 'referral' : 'overview'))

  return (
    <>
      <PageHead title="个人中心" desc="你的账号、身份与学习数据。学习记录随账号同步到你登录的所有设备。" />

      <section className={`id-card ${pro ? 'id-pro' : 'id-std'}`} aria-label="账号身份">
        <div className="id-card-top">
          <LogoMark size={36} />
          <div className="id-brand">
            <span className="id-brand-name">ExamPilot</span>
            <span className="id-tier">{pro ? 'Pro 账号' : 'Standard 账号'}</span>
          </div>
          {pro && <ProBadge size="md" />}
        </div>
        <div className="id-card-mid">
          <div className="id-label">账号</div>
          <div className="id-email" title={email}>
            {email || '—'}
          </div>
        </div>
        <div className="id-card-foot">
          <span className="id-chip">{pro ? 'AI 能力已开通' : '完整学习功能'}</span>
          {(access.role === 'super' || access.role === 'reviewer' || access.admin) && (
            <span className="id-chip id-chip-admin">{access.role === 'reviewer' ? '审核管理员' : '管理员'}</span>
          )}
          <span className="id-chip">{sync?.status.synced ? '已同步' : '同步中'}</span>
        </div>
      </section>

      <ProStatus />
      <Tabs
        label="个人中心分类"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: '概览' },
          { id: 'referral', label: '我的推荐' },
          { id: 'look', label: '外观' },
          { id: 'account', label: '账号与数据' },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'overview' && (
          <>
            <div className="grid grid-2 profile-grid">
              <CardPad>
                <div className="card-title">学习数据</div>
                <dl className="kv-grid">
                  <div>
                    <dt>已练客观题</dt>
                    <dd>
                      {diag.overall.attempted}
                      <small> / {objectiveQuestions.length}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>客观题正确率</dt>
                    <dd>{diag.overall.correctRate ? `${Math.round(diag.overall.correctRate * 100)}%` : '—'}</dd>
                  </div>
                  <div>
                    <dt>已掌握</dt>
                    <dd>{diag.overall.ourMastered}</dd>
                  </div>
                  <div>
                    <dt>主观题训练</dt>
                    <dd>
                      {diag.overall.subjectiveAttempted}
                      <small> / {subjectiveQuestions.length}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>作答记录</dt>
                    <dd>{history.length}</dd>
                  </div>
                  <div>
                    <dt>模拟考试</dt>
                    <dd>{graded}</dd>
                  </div>
                </dl>
                <div className="btn-row" style={{ marginTop: 14 }}>
                  <button className="btn btn-sm" onClick={() => void nav('home', { view: 'detail' })}>
                    详细诊断
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void nav('history')}>
                    练习历史
                  </button>
                </div>
              </CardPad>

              {pro ? (
                <CardPad>
                  <div className="card-title">已开启的 AI 能力</div>
                  <ul className="cap-list">
                    <li>
                      <Tag tone="accent">答疑</Tag> 题目 AI 答疑，可多轮追问
                    </li>
                    <li>
                      <Tag tone="accent">评阅</Tag> 主观题 AI 参考评阅（参考分，非官方分数）
                    </li>
                    <li>
                      <Tag tone="accent">助手</Tag> 右下角 AI 助手，随时提问
                    </li>
                    <li>
                      <Tag tone="accent">同步</Tag> AI 对话与评阅记录随账号同步
                    </li>
                  </ul>
                  <div className="btn-row" style={{ marginTop: 14 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => void nav('ai')}>
                      AI 记录（{aiChats}）
                    </button>
                    <button className="btn btn-sm" onClick={() => openFloatingAiConversation()}>
                      打开 AI 助手
                    </button>
                  </div>
                </CardPad>
              ) : (
                <CardPad>
                  <div className="card-title">AI 历史</div>
                  <p className="muted" style={{ margin: 0 }}>
                    {aiChats || sync?.aiChats.length
                      ? `你有 ${aiChats} 个 AI 对话和评阅记录，可以只读查看。`
                      : '你当前是 Standard 账号。'}
                    开通 Pro 后可以使用 AI 答疑、评阅、联网搜索和图片理解。
                  </p>
                  {aiChats > 0 && (
                    <div className="btn-row" style={{ marginTop: 14 }}>
                      <button className="btn btn-sm" onClick={() => void nav('ai')}>
                        查看 AI 记录（只读）
                      </button>
                    </div>
                  )}
                </CardPad>
              )}
            </div>
            {(access.role === 'super' || access.role === 'reviewer') && (
              <CardPad style={{ marginTop: 14 }}>
                <div className="card-title">管理</div>
                <button className="btn btn-sm btn-primary" onClick={() => void nav('admin')}>
                  打开管理中心
                </button>
              </CardPad>
            )}
          </>
        )}
        {tab === 'referral' && <ReferralPanel />}
        {tab === 'look' && (
          <CardPad>
            <div className="card-title">外观</div>
            <ThemePicker onError={toast} />
            <div className="muted-2" style={{ marginTop: 8 }}>
              选择后立即生效，并随账号同步到你的其他设备。
            </div>
          </CardPad>
        )}
        {tab === 'account' && (
          <>
            <CardPad>
              <div className="card-title">数据与隐私</div>
              <DataPrivacy nav={nav} />
            </CardPad>
            <CloseAccountPanel email={email} />
          </>
        )}
      </TabPanel>
      <BuildInfo />
      {el}
    </>
  )
}

/** Read-only build identity (GET /api/version), so testers can tell deployments apart. */
function BuildInfo() {
  const [v, setV] = useState<{ version: string | null; commit: string | null; builtAt: string | null } | null>(null)
  useEffect(() => {
    let live = true
    fetch('/api/version', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && j.ok && setV(j))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!v) return null
  return (
    <p className="muted-2 build-info" data-testid="build-info" style={{ marginTop: 14, fontSize: 12 }}>
      版本 {v.version ? v.version.slice(0, 8) : '—'} · 代码 {v.commit ?? '—'}
      {v.builtAt ? ` · 构建于 ${new Date(v.builtAt).toLocaleString('zh-CN', { hour12: false })}` : ''}
    </p>
  )
}

function DataPrivacy({ nav }: { nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void> }) {
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        学习记录只保存在你的账号下，其他账号看不到。你可以随时导出备份，或在设置里管理同步与数据。
      </p>
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn btn-sm" onClick={() => void nav('settings')}>
          账号与同步
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => void nav('io')}>
          导入 / 导出
        </button>
      </div>
    </>
  )
}

/** Pro status with a live countdown for time-limited Pro (server values only). */
function ProStatus() {
  const access = useAiAccess()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const p = access.pro
  if (!p || p.tier !== 'pro') return null
  let text: string
  if (p.suspended) text = 'Pro 已被管理员暂停，暂时不能使用 AI。'
  else if (p.permanent) text = '永久 Pro'
  else if (p.paused) text = `Pro（冻结中，剩余 ${fmtLeft(p.remainingMs)}）`
  else if (p.until) text = `Pro 将于 ${fmtDate(p.until)} 到期，还剩 ${fmtLeft(p.until - now)}`
  else text = 'Pro'
  return (
    <p
      className={`wk-notice ${p.suspended ? 'wk-bad' : p.until && p.until - now < 3 * 86_400_000 ? 'wk-warn' : 'wk-info'}`}
      data-testid="pro-status"
    >
      {text}
    </p>
  )
}
