/**
 * Sync status + notices for the web edition. Plain language only: no op logs,
 * cursors or versions are shown to the user.
 */
import { useAiAccess, refreshAiAccess } from '../lib/ai-access'
import { useEffect, useState } from 'react'
import { useSync } from './CloudStore'
import type { SyncStatus } from './engine'
import {
  hasMigratableData,
  isPostponed,
  migrateLegacy,
  postpone,
  readClaim,
  scanLegacy,
  downloadText,
  backupLegacy,
  type LegacySnapshot,
} from './legacy'
import type { ExamDocBody } from './protocol'

export function statusText(s: SyncStatus): { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad'; detail?: string } {
  switch (s.phase) {
    case 'auth_expired':
      return { label: '登录已过期', tone: 'bad', detail: '请重新验证邮箱，未同步的内容会保留在本设备。' }
    case 'account_switched':
      return { label: '账号已切换', tone: 'bad', detail: '这个页面属于之前登录的账号，请刷新页面。' }
    case 'update_required':
      return { label: '需要更新', tone: 'bad', detail: '网站已更新，请刷新页面后继续同步。' }
    case 'quota':
      return { label: '同步暂停', tone: 'warn', detail: '今日云端额度已用完，记录保存在本设备，稍后自动继续。' }
    case 'offline':
      return {
        label: s.pending ? `等待网络 · ${s.pending} 项待同步` : '等待网络连接',
        tone: 'warn',
        detail: '断网期间的作答会保存在本设备，联网后自动上传。',
      }
    case 'retrying':
      return {
        label: s.pending ? `同步失败，自动重试 · ${s.pending} 项` : '同步失败，自动重试',
        tone: 'warn',
        detail: '服务器暂时没有响应，稍后会自动重试。',
      }
    case 'syncing':
      return { label: '正在同步', tone: 'busy' }
    default:
      if (s.conflicts > 0) return { label: '有需要处理的数据', tone: 'warn' }
      if (s.pending > 0) return { label: `${s.pending} 项待同步`, tone: 'busy' }
      if (s.synced) return { label: '已同步', tone: 'ok' }
      return { label: '正在同步', tone: 'busy' }
  }
}

function ago(t: number | null): string {
  if (!t) return '尚未同步'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/** Compact status pill (sidebar + mobile top bar). */
export function SyncBadge({ compact = false }: { compact?: boolean }) {
  const sync = useSync()
  const [open, setOpen] = useState(false)
  if (!sync) return null
  const t = statusText(sync.status)
  return (
    <div className={`sync-badge ${compact ? 'compact' : ''}`}>
      <button
        type="button"
        className={`sync-pill tone-${t.tone}`}
        aria-expanded={open}
        aria-label={`同步状态：${t.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sync-dot" aria-hidden="true" />
        <span className="sync-label">{t.label}</span>
      </button>
      {open && (
        <div className="sync-pop" role="dialog" aria-label="同步详情">
          <div className="sync-pop-row">
            <b>{t.label}</b>
          </div>
          {t.detail && <div className="muted-2">{t.detail}</div>}
          <div className="muted-2">账号：{sync.email}</div>
          <div className="muted-2">上次完成同步：{ago(sync.status.lastSyncedAt)}</div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {sync.status.phase === 'auth_expired' ||
            sync.status.phase === 'account_switched' ||
            sync.status.phase === 'update_required' ? (
              <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
                {sync.status.phase === 'auth_expired' ? '重新验证' : '刷新页面'}
              </button>
            ) : (
              <button
                className="btn btn-sm"
                onClick={() => void sync.engine.syncNow()}
                disabled={sync.status.phase === 'syncing'}
              >
                立即同步
              </button>
            )}
            <a className="btn btn-sm btn-ghost" href="#/settings" onClick={() => setOpen(false)}>
              账号与同步
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

/** Notices that need the user's decision; shown above page content. */
export function SyncNotices() {
  const sync = useSync()
  const [legacy, setLegacy] = useState<LegacySnapshot | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [later, setLater] = useState(false)
  const ai = useAiAccess()
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (!sync) return
    let alive = true
    const claim = readClaim()
    if (claim || isPostponed(sync.accountId)) return
    scanLegacy()
      .then((s) => {
        if (alive && hasMigratableData(s)) setLegacy(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sync?.accountId])

  if (!sync) return null
  const { status, engine } = sync
  const draftConflicts = engine.allDocs().filter((d) => d.key.startsWith('draft.') && d.conflict)
  const q = engine.quarantine
  const notices: JSX.Element[] = []

  if (status.phase === 'auth_expired') {
    notices.push(
      <div key="auth" className="sync-notice bad" role="alert">
        <span>登录已过期。未同步的内容已保存在本设备，重新验证后会自动上传。</span>
        <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
          重新验证
        </button>
      </div>,
    )
  }
  if (status.phase === 'account_switched') {
    notices.push(
      <div key="sw" className="sync-notice bad" role="alert">
        <span>
          此页面属于之前登录的账号（{sync.email}），浏览器现在登录的是另一个账号。为避免数据串号，本页已停止同步。
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>,
    )
  }
  if (status.phase === 'update_required') {
    notices.push(
      <div key="up" className="sync-notice warn" role="alert">
        <span>网站已更新，请刷新页面后继续同步（本设备的记录不会丢失）。</span>
        <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>,
    )
  }

  // N01-8: the AI permission check could not be answered (5xx / timeout / offline /
  // Access session). Never read as "no Pro": say what happened and offer a retry.
  if (ai.issue && ai.state !== 'denied' && !(ai.issue === 'session' && status.phase === 'auth_expired')) {
    const why =
      ai.issue === 'session'
        ? '登录已过期，AI 暂时用不了。'
        : ai.issue === 'offline'
          ? '网络已断开，暂时无法确认 AI 权限。'
          : ai.issue === 'timeout'
            ? 'AI 服务响应超时，暂时无法确认 AI 权限。'
            : 'AI 服务暂时不可用，暂时无法确认 AI 权限。'
    const tail =
      ai.state === 'granted'
        ? ' 你的 Pro 状态保持不变，AI 入口保留；连上后自动恢复。'
        : ' 这不代表账号没有 Pro，刷题不受影响；稍后会自动重试。'
    notices.push(
      <div key="ai-status" className="sync-notice warn ai-status-notice" role="status" data-ai-issue={ai.issue}>
        <span>
          {why}
          {ai.issue === 'session' ? '' : tail}
        </span>
        {ai.issue === 'session' ? (
          <button className="btn btn-sm btn-primary" onClick={() => window.location.reload()}>
            重新登录
          </button>
        ) : (
          <button
            className="btn btn-sm"
            disabled={retrying}
            onClick={() => {
              setRetrying(true)
              void refreshAiAccess(true).finally(() => setRetrying(false))
            }}
          >
            {retrying ? '正在重试…' : '重试'}
          </button>
        )}
      </div>,
    )
  }

  if (legacy && !later) {
    const n = legacy.records.length
    notices.push(
      <div key="legacy" className="sync-notice info migrate" role="region" aria-label="旧记录归入账号">
        <div>
          <b>本浏览器有升级前的学习记录</b>
          <div className="muted-2" style={{ marginTop: 4 }}>
            {n} 道题的练习进度、{legacy.history.length} 条作答历史、{legacy.mocks.length} 场模拟考试。
            {legacy.demo.records + legacy.demo.history + legacy.demo.mocks > 0 && ' 旧版演示题库的记录不会归入。'}
          </div>
          <div className="muted-2">
            是否归入当前登录的账号 <b>{sync.email}</b>
            ？归入后会同步到你的其他设备。归入前会先在本设备保存一份完整备份，原始记录也不会被删除。
          </div>
          {msg && <div style={{ marginTop: 6 }}>{msg}</div>}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm btn-primary"
            disabled={migrating}
            onClick={async () => {
              setMigrating(true)
              setMsg(null)
              try {
                await migrateLegacy(engine, legacy)
                setLegacy(null)
                void engine.syncNow()
              } catch (e) {
                setMsg('归入失败：' + String((e as Error).message || e) + '。原有记录未受影响，可以再试一次。')
              } finally {
                setMigrating(false)
              }
            }}
          >
            {migrating ? '正在归入…' : '归入此账号'}
          </button>
          <button
            className="btn btn-sm"
            onClick={async () => {
              const b = await backupLegacy(legacy, 'manual-download')
              downloadText(`ExamPilot-升级前备份-${new Date().toISOString().slice(0, 10)}.json`, b.json)
            }}
          >
            先下载备份
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              postpone(sync.accountId)
              setLater(true)
            }}
          >
            这不是我的记录 / 以后再说
          </button>
        </div>
      </div>,
    )
  }

  for (const d of draftConflicts) {
    notices.push(
      <div key={d.key} className="sync-notice warn" role="alert">
        <span>另一台设备上有这组练习更新的进度。要使用哪一份？</span>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-sm btn-primary"
            onClick={async () => {
              await engine.resolveDocUseServer(d.key)
              window.location.reload()
            }}
          >
            使用另一台设备的进度
          </button>
          <button className="btn btn-sm" onClick={() => void engine.resolveDocKeepLocal(d.key)}>
            保留本设备的进度
          </button>
        </div>
      </div>,
    )
  }

  if (q.length > 0) {
    const resetOnes = q.filter((x) => x.reason === 'reset')
    const others = q.filter((x) => x.reason !== 'reset')
    notices.push(
      <div key="q" className="sync-notice warn" role="alert">
        <div>
          {resetOnes.length > 0 && (
            <div>
              有 {resetOnes.length}{' '}
              项记录产生于“重置学习进度”之前、当时还没来得及同步。为避免把已重置的数据带回来，它们被单独保存在本设备，没有计入。
            </div>
          )}
          {others.length > 0 && (
            <div>有 {others.length} 项内容没能同步（例如考试已在另一台设备交卷）。它们保存在本设备，没有计入。</div>
          )}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm"
            onClick={() => downloadText('ExamPilot-未计入的记录.json', JSON.stringify(q, null, 2))}
          >
            下载这些记录
          </button>
          {resetOnes.length > 0 && (
            <button className="btn btn-sm" onClick={() => void engine.restoreQuarantined(resetOnes.map((x) => x.id))}>
              仍然计入
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => void engine.discardQuarantined(q.map((x) => x.id))}>
            不需要，丢弃
          </button>
        </div>
      </div>,
    )
  }

  if (!notices.length) return null
  return <div className="sync-notices">{notices}</div>
}

/** Settings card: account, sync, logout. */
export function AccountSyncCard() {
  const sync = useSync()
  const [usage, setUsage] = useState<string | null>(null)
  if (!sync) return null
  const t = statusText(sync.status)
  const claim = readClaim()
  const pending = sync.status.pending
  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <div className="card-title">账号与云同步</div>
      <div className="kv">
        <div>
          当前账号：<b>{sync.email}</b>
        </div>
        <div>
          同步状态：<b>{t.label}</b>（上次完成：{ago(sync.status.lastSyncedAt)}）
        </div>
        <div className="muted-2" style={{ marginTop: 6 }}>
          用同一个邮箱在手机、电脑、平板登录，看到的是同一份学习数据：练习进度、错题本、作答历史、模拟考试（包括没交卷的考试）、未完成的练习和设置都会自动同步。断网时的作答先保存在本设备，联网后自动上传。
        </div>
        {claim && (
          <div className="muted-2" style={{ marginTop: 6 }}>
            本浏览器升级前的学习记录已于 {new Date(claim.at).toLocaleString('zh-CN', { hour12: false })} 归入
            {claim.accountId === sync.accountId ? '当前账号' : '另一个账号'}，原始记录仍保留在本浏览器。
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-sm"
          onClick={() => void sync.engine.syncNow()}
          disabled={sync.status.phase === 'syncing'}
        >
          立即同步
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            try {
              const r = await fetch('/api/sync/usage', {
                headers: { 'X-ExamPilot-Sync': '1' },
                credentials: 'same-origin',
                redirect: 'manual',
              })
              const j = await r.json()
              const today = j.days?.[0]
              setUsage(
                `云端共保存 ${j.stored?.ops ?? 0} 条记录；今日上传 ${today?.ops ?? 0} 条（${today?.pushes ?? 0} 次）。`,
              )
            } catch {
              setUsage('暂时无法读取用量。')
            }
          }}
        >
          查看云端用量
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (
              pending > 0 &&
              !window.confirm(
                `还有 ${pending} 项没有同步到云端。退出后它们仍保存在本设备，用同一账号再次登录时会继续上传。确定退出？`,
              )
            )
              return
            window.location.href = '/cdn-cgi/access/logout'
          }}
        >
          退出登录
        </button>
      </div>
      {usage && (
        <div className="muted-2" style={{ marginTop: 8 }}>
          {usage}
        </div>
      )}
    </div>
  )
}

/** Running exam (from any device) — used by the mock exam page. */
export function useExamDoc(): { doc: ExamDocBody | null; note: string | null; mine: boolean; dirty: boolean } {
  const sync = useSync()
  if (!sync) return { doc: null, note: null, mine: false, dirty: false }
  const d = sync.exam.current()
  const body = d && !d.deleted ? (d.body as ExamDocBody | null) : null
  return {
    doc: body,
    note: d?.serverNote ?? null,
    mine: !!body && body.holder === sync.engine.clientId,
    dirty: !!d?.dirty,
  }
}
