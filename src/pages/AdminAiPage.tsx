import { useCallback, useEffect, useState } from 'react'
import { CardPad, Empty, PageHead, Spinner, Tag, useConfirm, useToast } from '../components/ui'
import { refreshAiAccess } from '../lib/ai-access'

interface AdminUser {
  accountId: string
  emails: string[]
  createdAt: number
  lastSeenAt: number | null
  aiEnabled: boolean
  aiUpdatedAt: number | null
  isAdmin: boolean
}

const H = { 'X-ExamPilot-Client': '1' }

interface LogRow {
  id: number
  accountId: string
  enabled: boolean
  at: number
  target: string
  actor: string
}

type Filter = 'all' | 'pro' | 'standard' | 'admin'
const fmt = (t: number | null) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

/**
 * Web edition, admins only (the server checks; this page is also hidden from the
 * navigation for everyone else). Turns AI on/off per account. It manages
 * permissions only — the AI gateway key is never shown or editable here.
 */
export function AdminAiPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [log, setLog] = useState<LogRow[] | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const { toast, el } = useToast()
  const { confirm, confirmEl } = useConfirm()

  const get = async (url: string) => {
    const res = await fetch(url, { headers: H, cache: 'no-store', credentials: 'same-origin', redirect: 'manual' })
    const j = await res.json().catch(() => null)
    return { res, j }
  }

  const load = useCallback(async () => {
    setError(null)
    setLogError(null)
    try {
      const [u, l] = await Promise.all([get('/api/admin/ai-users'), get('/api/admin/ai-log').catch(() => null)])
      if (!u.res.ok || !u.j?.ok) setError(u.j?.reason || `无法读取账号列表（HTTP ${u.res.status}）`)
      else setUsers(u.j.users)
      if (l && l.res.ok && l.j?.ok) setLog(l.j.log)
      else setLogError(l?.j?.reason || '授权记录暂时无法读取')
    } catch (e) {
      setError(`网络错误：${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setAi = async (u: AdminUser, enabled: boolean) => {
    const who = u.emails[0] ?? u.accountId
    if (!enabled) {
      const ok = await confirm({
        title: `撤销 ${who} 的 Pro？`,
        body: '对方会立即回到 Standard：AI 入口隐藏、AI 接口由服务器拒绝。学习记录和已有的 AI 记录都不会删除，之后可以随时重新开通。',
        confirmLabel: '撤销 Pro',
        danger: true,
      })
      if (!ok) return
    }
    setBusy(u.accountId)
    try {
      const res = await fetch('/api/admin/ai-users', {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        redirect: 'manual',
        body: JSON.stringify({ accountId: u.accountId, enabled }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.ok) {
        toast(`修改失败：${j?.reason || 'HTTP ' + res.status}`)
        return
      }
      // Show what the SERVER now holds, not what we asked for.
      setUsers(
        (list) =>
          list?.map((x) =>
            x.accountId === u.accountId ? { ...x, aiEnabled: j.aiEnabled, aiUpdatedAt: j.aiUpdatedAt } : x,
          ) ?? null,
      )
      toast(
        j.aiEnabled === enabled
          ? `已${enabled ? '开通' : '撤销'} ${who} 的 Pro（服务器已确认）`
          : '服务器状态与请求不一致，请刷新确认',
      )
      void refreshAiAccess(true) // in case the admin changed their own account
      void get('/api/admin/ai-log')
        .then((l) => l.res.ok && l.j?.ok && setLog(l.j.log))
        .catch(() => {})
    } catch (e) {
      toast(`网络错误：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const all = users ?? []
  const counts = {
    all: all.length,
    pro: all.filter((u) => u.aiEnabled).length,
    standard: all.filter((u) => !u.aiEnabled).length,
    admin: all.filter((u) => u.isAdmin).length,
  }
  const q = query.trim().toLowerCase()
  const shown = all.filter(
    (u) =>
      (filter === 'all' ||
        (filter === 'pro' && u.aiEnabled) ||
        (filter === 'standard' && !u.aiEnabled) ||
        (filter === 'admin' && u.isAdmin)) &&
      (!q || u.emails.some((e) => e.toLowerCase().includes(q))),
  )

  return (
    <>
      <PageHead
        title="账号与 Pro 管理"
        desc="开通 Pro = 为该账号开启 AI（服务器授权，立即生效，无需重新部署）；默认所有账号都是 Standard。管理员身份与 Pro 互相独立。这里只管理权限，不显示也不修改 AI 网关密钥。"
      />

      {users && (
        <div className="admin-summary" role="group" aria-label="账号筛选">
          {(
            [
              ['all', '全部账号'],
              ['pro', 'Pro'],
              ['standard', 'Standard'],
              ['admin', '管理员'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`admin-sum ${filter === k ? 'on' : ''}`}
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
            >
              <span className="admin-sum-n">{counts[k]}</span>
              <span className="admin-sum-l">{label}</span>
            </button>
          ))}
        </div>
      )}

      <CardPad>
        <div className="row-between" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 300 }}
            type="search"
            placeholder="按邮箱搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="按邮箱搜索"
          />
          <button className="btn btn-sm" onClick={() => void load()}>
            刷新
          </button>
        </div>
        {error && (
          <div className="result-banner bad" role="alert">
            {error}
          </div>
        )}
        {!users && !error && <Spinner label="正在读取账号…" />}
        {users && shown.length === 0 && (
          <Empty
            text={all.length === 0 ? '还没有账号。同学需要先登录网站一次，才会出现在这里。' : '没有符合条件的账号。'}
          />
        )}
        {users && shown.length > 0 && (
          <ul className="admin-list">
            {shown.map((u) => (
              <li key={u.accountId} className={`admin-user ${u.aiEnabled ? 'is-pro' : ''}`}>
                <div className="admin-user-main">
                  <div className="admin-user-email">{u.emails.join('，') || u.accountId}</div>
                  <div className="admin-user-tags">
                    <span className={`tier-tag ${u.aiEnabled ? 'tier-pro' : 'tier-std'}`}>
                      {u.aiEnabled ? 'Pro · AI 已开启' : 'Standard · 无 AI'}
                    </span>
                    {u.isAdmin && <Tag>管理员</Tag>}
                  </div>
                  <div className="muted-2">
                    最近登录 {fmt(u.lastSeenAt)}
                    {u.aiUpdatedAt ? ` · 权限更新于 ${fmt(u.aiUpdatedAt)}` : ''}
                  </div>
                </div>
                <button
                  className={`btn btn-sm admin-user-act ${u.aiEnabled ? 'btn-danger' : 'btn-primary'}`}
                  disabled={busy === u.accountId}
                  aria-label={`${u.aiEnabled ? '撤销' : '开通'} ${u.emails[0] ?? u.accountId} 的 Pro`}
                  onClick={() => void setAi(u, !u.aiEnabled)}
                >
                  {busy === u.accountId ? '处理中…' : u.aiEnabled ? '撤销 Pro' : '开通 Pro'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">授权操作记录</div>
        {logError && <div className="muted">{logError}</div>}
        {!log && !logError && <Spinner label="正在读取记录…" />}
        {log && log.length === 0 && <Empty text="还没有授权操作。" />}
        {log && log.length > 0 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">账号</th>
                  <th scope="col">操作</th>
                  <th scope="col">操作人</th>
                </tr>
              </thead>
              <tbody>
                {log.map((r) => (
                  <tr key={r.id}>
                    <td className="num-left">{fmt(r.at)}</td>
                    <td className="cell-wrap">{r.target || r.accountId}</td>
                    <td>
                      <span className={`tier-tag ${r.enabled ? 'tier-pro' : 'tier-std'}`}>
                        {r.enabled ? '开通 Pro' : '撤销 Pro'}
                      </span>
                    </td>
                    <td className="cell-wrap">{r.actor || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardPad>
      {el}
      {confirmEl}
    </>
  )
}
