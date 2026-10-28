/* eslint-disable @typescript-eslint/no-explicit-any -- admin/account API JSON is rendered as-is; the Worker is the source of truth */
/**
 * ExamPilot 管理中心 (web edition). Tabs, each with charts + table + drawer.
 * Every action is authorised by the Worker again; hiding a tab here is cosmetic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../../lib/bank'
import {
  api,
  ApiError,
  BarChart,
  DataTable,
  Drawer,
  Empty,
  fmtDate,
  fmtLeft,
  LineChart,
  Loading,
  Notice,
  SearchBox,
  Segmented,
  Select,
  shortDay,
  TabPanel,
  Tabs,
  Toolbar,
  lastDays,
  useAsync,
  useConfirm,
  type Col,
} from '../kit'

type Role = 'super' | 'reviewer'
interface WhoAmI {
  email: string
  role: Role
  owner: boolean
  unread: number
  mailConfigured: boolean
  accessConfigured: boolean
}
const DAY = 86_400_000

const APP_STATUS: Record<string, [string, string]> = {
  pending: ['待审核', 'warn'],
  approved: ['已通过', 'ok'],
  rejected: ['未通过', 'bad'],
}
const INV_STATUS: Record<string, [string, string]> = {
  pending: ['待接受', 'warn'],
  accepted: ['已接受', 'ok'],
  expired: ['已过期', ''],
  revoked: ['已作废', ''],
}
const MEM_STATUS: Record<string, [string, string]> = {
  active: ['正常', 'ok'],
  revoked: ['已停用', 'bad'],
  closing: ['注销冷静期', 'warn'],
}
const ACCESS_STATE: Record<string, [string, string]> = {
  ok: ['已授权', 'ok'],
  pending: ['待完成', 'warn'],
  failed: ['开通失败待重试', 'bad'],
}
const ROLE: Record<string, string> = { user: '普通用户', reviewer: '审核管理员', super: '超级管理员' }
const REF_STATUS: Record<string, [string, string]> = {
  applied: ['已申请', ''],
  approved: ['已通过待激活', 'acc'],
  rejected: ['未通过', 'bad'],
  rewarded: ['已发奖', 'ok'],
  held: ['奖励冻结', 'warn'],
  void: ['无效', 'bad'],
}
const pill = (m: Record<string, [string, string]>, k: string) => {
  const [t, c] = m[k] ?? [k, '']
  return <span className={`wk-pill ${c}`}>{t}</span>
}

function useErr() {
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn()
      if (ok) setMsg({ tone: 'ok', text: ok })
      return r
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? e.message : String(e) })
      return null
    }
  }, [])
  const node = msg ? (
    <Notice
      tone={msg.tone}
      action={
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMsg(null)}>
          知道了
        </button>
      }
    >
      {msg.text}
    </Notice>
  ) : null
  return { node, run, setMsg }
}

/* ============================================================= root */
export default function AdminCenter() {
  const who = useAsync(() => api<WhoAmI>('GET', '/api/admin/whoami'), [])
  const [tab, setTab] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'overview')
  const [memberEmail, setMemberEmail] = useState<string | null>(null)
  useEffect(() => {
    const base = location.hash.split('?')[0] || '#/admin'
    history.replaceState(null, '', `${base}?tab=${tab}`)
  }, [tab])
  if (who.loading && !who.data) return <Loading />
  if (who.error || !who.data) return <Notice tone="bad">{who.error || '无法打开管理中心'}</Notice>
  const w = who.data
  const sup = w.role === 'super'
  const tabs = [
    { id: 'overview', label: '总览' },
    { id: 'apps', label: '申请审核' },
    { id: 'invites', label: '邀请管理' },
    ...(sup
      ? [
          { id: 'members', label: '成员管理' },
          { id: 'pro', label: 'Pro 权益' },
          { id: 'referrals', label: '推荐与奖励' },
          { id: 'review', label: '异常与申诉' },
          { id: 'stats', label: '学习统计' },
        ]
      : []),
    { id: 'notices', label: '站内通知', badge: w.unread },
    ...(sup
      ? [
          { id: 'settings', label: '公告与申请设置' },
          { id: 'audit', label: '审计日志' },
        ]
      : []),
  ]
  const active = tabs.some((t) => t.id === tab) ? tab : 'overview'
  return (
    <div className="admin-center">
      <div className="page-head row-between">
        <div>
          <h1 className="page-title">管理中心</h1>
          <p className="page-desc">
            {w.email} · {ROLE[w.role]}
            {w.owner ? '（最高管理员）' : ''}
          </p>
        </div>
      </div>
      {(!w.mailConfigured || !w.accessConfigured) && sup && (
        <Notice tone="warn">
          {!w.mailConfigured && '真实发信尚未接通：邮件会排队保存，不会发出。'}
          {!w.accessConfigured && ' Access 自动授权未配置：新成员显示“待完成”。'}
        </Notice>
      )}
      <Tabs tabs={tabs} value={active} onChange={setTab} label="管理中心分类" />
      <TabPanel id={active}>
        {active === 'overview' && <Overview role={w.role} go={setTab} />}
        {active === 'apps' && <Applications role={w.role} />}
        {active === 'invites' && <Invites me={w.email} sup={sup} />}
        {active === 'members' && <Members onOpen={setMemberEmail} />}
        {active === 'pro' && <ProTab onOpen={setMemberEmail} />}
        {active === 'referrals' && <Referrals onOpen={setMemberEmail} />}
        {active === 'review' && <ReviewTab />}
        {active === 'stats' && <Stats onOpen={setMemberEmail} />}
        {active === 'notices' && <Notices role={w.role} onChanged={who.reload} go={setTab} />}
        {active === 'settings' && <Settings />}
        {active === 'audit' && <Audit />}
      </TabPanel>
      {sup && <MemberDrawer email={memberEmail} me={w.email} onClose={() => setMemberEmail(null)} />}
    </div>
  )
}

/* ============================================================= overview */
function Overview({ role, go }: { role: Role; go: (t: string) => void }) {
  const [days, setDays] = useState(30)
  const d = useAsync(() => api<any>('GET', `/api/admin/overview?days=${days}`), [days])
  if (!d.data) return d.error ? <Notice tone="bad">{d.error}</Notice> : <Loading />
  const o = d.data
  const series = (rows: { d: string; n: number }[]) => {
    const m = new Map(rows.map((r) => [r.d, r.n]))
    return lastDays(days).map((k) => ({ label: shortDay(k), key: k, value: Number(m.get(k) || 0) }))
  }
  return (
    <>
      <div className="wk-kpis">
        <button type="button" className="wk-kpi" onClick={() => go('apps')}>
          <b>{o.applications.pending ?? 0}</b>
          <span>待审核申请</span>
        </button>
        <button type="button" className="wk-kpi" onClick={() => go('invites')}>
          <b>{o.invites.pending ?? 0}</b>
          <span>待接受邀请</span>
        </button>
        {role === 'super' && (
          <>
            <button type="button" className="wk-kpi" onClick={() => go('members')}>
              <b>{o.members?.active ?? 0}</b>
              <span>正常成员</span>
            </button>
            <button type="button" className="wk-kpi" onClick={() => go('pro')}>
              <b>{o.pro?.pro ?? 0}</b>
              <span>Pro（永久 {o.pro?.permanent ?? 0}）</span>
            </button>
            <div className="wk-kpi">
              <b>{(o.access?.pending ?? 0) + (o.access?.failed ?? 0)}</b>
              <span>Access 待完成 / 失败</span>
            </div>
            <div className="wk-kpi">
              <b>{(o.mail?.held ?? 0) + (o.mail?.failed ?? 0)}</b>
              <span>未发出的邮件</span>
            </div>
          </>
        )}
      </div>
      <div className="wk-box-h">
        <h3>趋势</h3>
        <Segmented
          label="时间范围"
          value={days}
          onChange={setDays}
          options={[
            { v: 7, label: '7 天' },
            { v: 30, label: '30 天' },
            { v: 90, label: '90 天' },
          ]}
        />
      </div>
      <div className="wk-grid">
        <div className="wk-box">
          <h3>每日申请</h3>
          <BarChart label="每日申请数" data={series(o.applicationTrend)} onSelect={() => go('apps')} />
        </div>
        {role === 'super' && (
          <>
            <div className="wk-box">
              <h3>最后登录分布</h3>
              <BarChart label="最后登录日期分布" data={series(o.lastLoginTrend)} />
            </div>
            <div className="wk-box">
              <h3>Pro 发放（含推荐奖励）</h3>
              <BarChart label="每日 Pro 发放笔数" data={series(o.grantTrend)} onSelect={() => go('referrals')} />
            </div>
            <div className="wk-box">
              <h3>AI 调用次数</h3>
              <LineChart label="每日 AI 调用次数" data={series(o.aiTrend)} />
            </div>
          </>
        )}
      </div>
    </>
  )
}

/* ============================================================= applications */
function Applications({ role }: { role: Role }) {
  const [status, setStatus] = useState('pending')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [sort, setSort] = useState<'new' | 'old'>('old')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<any>(null)
  const { node, run } = useErr()
  const [dlg, confirm] = useConfirm()
  const d = useAsync(
    () =>
      api<any>(
        'GET',
        `/api/admin/applications?status=${status}&q=${encodeURIComponent(q)}&page=${page}&size=${size}&sort=${sort}`,
      ),
    [status, q, page, size, sort],
  )
  useEffect(() => setPage(1), [status, q, size])
  useEffect(() => setSel(new Set()), [status, q, page])
  const rows: any[] = d.data?.rows ?? []
  const decide = async (items: any[], decision: 'approve' | 'reject') => {
    const c = await confirm(
      decision === 'approve'
        ? {
            title: `批准 ${items.length} 份申请？`,
            body: '批准后自动开通 Standard，并排队加入登录授权范围、生成通过邮件。邮件服务未接通时邮件只保存不发出。',
            confirmLabel: '批准',
          }
        : {
            title: `拒绝 ${items.length} 份申请？`,
            body: '用户只收到简洁的拒绝通知；内部原因不会发给用户。7 天后才能再次申请。',
            confirmLabel: '拒绝',
            danger: true,
            reason: 'required',
            reasonLabel: '内部原因',
          },
    )
    if (!c.ok) return
    let publicNote: string | undefined
    if (decision === 'reject') {
      const p = await confirm({
        title: '对外说明（可选）',
        body: '会写进拒绝邮件。留空则只发送简洁通知。',
        reason: 'optional',
        reasonLabel: '对外说明',
        confirmLabel: '发送',
      })
      if (!p.ok) return
      publicNote = p.reason
    }
    const r = await run(() =>
      api<any>('POST', '/api/admin/applications/decide', {
        items: items.map((x) => ({ id: x.id, version: x.version })),
        decision,
        internal: c.reason,
        publicNote,
      }),
    )
    if (r) {
      const bad = r.results.filter((x: any) => !x.ok)
      run(
        async () => null,
        bad.length
          ? `完成 ${r.results.length - bad.length} 份；${bad.length} 份已被其他管理员处理或状态已变化`
          : `已处理 ${r.results.length} 份`,
      )
      setOpen(null)
      d.reload()
    }
  }
  const cols: Col<any>[] = [
    { key: 'email', label: '邮箱', render: (r) => <span className="wk-mono">{r.email}</span> },
    { key: 'status', label: '状态', render: (r) => pill(APP_STATUS, r.status) },
    { key: 'created_at', label: '申请时间', render: (r) => fmtDate(r.created_at) },
    {
      key: 'ref',
      label: '推荐',
      render: (r) => (r.referred ? <span className="wk-pill acc">推荐{r.refFlags ? ' · 有异常信号' : ''}</span> : '—'),
      minor: true,
    },
    {
      key: 'note',
      label: '说明',
      render: (r) => <span className="wk-muted">{(r.note || '').slice(0, 40) || '—'}</span>,
      minor: true,
    },
  ]
  const selected = rows.filter((r) => sel.has(r.id) && r.status === 'pending')
  return (
    <>
      {!open && node}
      {dlg}
      <Toolbar>
        <Segmented
          label="状态"
          value={status}
          onChange={setStatus}
          options={[
            { v: 'pending', label: '待审核' },
            { v: 'approved', label: '已通过' },
            { v: 'rejected', label: '未通过' },
            { v: '', label: '全部' },
          ]}
        />
        <SearchBox label="搜索邮箱" value={q} onChange={setQ} />
        <Select
          label="排序"
          value={sort}
          onChange={(v) => setSort(v as 'new' | 'old')}
          options={[
            { v: 'old', label: '最早在前' },
            { v: 'new', label: '最新在前' },
          ]}
        />
      </Toolbar>
      {selected.length > 0 && (
        <div className="wk-actions" style={{ marginBottom: 10 }}>
          <span className="wk-muted">已选 {selected.length} 份</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(selected, 'approve')}>
            批量批准
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => decide(selected, 'reject')}>
            批量拒绝
          </button>
        </div>
      )}
      <DataTable
        caption="申请列表"
        rows={rows}
        cols={cols}
        rowKey={(r) => r.id}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        selectable={status === 'pending'}
        selected={sel}
        onSelect={setSel}
        onRow={setOpen}
      />
      <Drawer
        open={!!open}
        title="申请详情"
        onClose={() => setOpen(null)}
        footer={
          open?.status === 'pending' && (
            <>
              <button type="button" className="btn btn-danger" onClick={() => decide([open], 'reject')}>
                拒绝
              </button>
              <button type="button" className="btn btn-primary" onClick={() => decide([open], 'approve')}>
                批准
              </button>
            </>
          )
        }
      >
        {/* result / error of a decision taken from this drawer shows here, not behind it */}
        {open && node}
        {open && (
          <dl className="wk-dl">
            <dt>邮箱</dt>
            <dd className="wk-mono">{open.email}</dd>
            <dt>状态</dt>
            <dd>{pill(APP_STATUS, open.status)}</dd>
            <dt>申请时间</dt>
            <dd>{fmtDate(open.created_at)}</dd>
            <dt>申请说明</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{open.note || '（未填写）'}</dd>
            <dt>推荐</dt>
            <dd>{open.referred ? `通过推荐链接${open.refFlags ? `（异常信号：${open.refFlags}）` : ''}` : '无'}</dd>
            {open.decided_at && (
              <>
                <dt>审核</dt>
                <dd>
                  {fmtDate(open.decided_at)} · {open.decided_by}
                </dd>
              </>
            )}
            {open.reject_public && (
              <>
                <dt>对外说明</dt>
                <dd>{open.reject_public}</dd>
              </>
            )}
            {role === 'super' && open.reject_internal && (
              <>
                <dt>内部原因</dt>
                <dd>{open.reject_internal}</dd>
              </>
            )}
          </dl>
        )}
      </Drawer>
    </>
  )
}

/* ============================================================= invites */
function Invites({ me, sup }: { me: string; sup: boolean }) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [text, setText] = useState('')
  const [result, setResult] = useState<any[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const { node, run } = useErr()
  const [dlg, confirm] = useConfirm()
  const d = useAsync(
    () => api<any>('GET', `/api/admin/invites?status=${status}&q=${encodeURIComponent(q)}&page=${page}&size=${size}`),
    [status, q, page, size],
  )
  useEffect(() => setSel(new Set()), [status, q, page, size])
  const rows: any[] = d.data?.rows ?? []
  const cap = sup ? 200 : 50
  const REASON: Record<string, string> = {
    already_member: '已是成员',
    pending_exists: '已有待接受的邀请',
    bad_email: '邮箱格式不正确',
    reserved_email: '测试保留域名，不能邀请',
    revoked: '账号已被停用',
    closing: '账号在注销冷静期',
  }
  const isExpired = (r: any) => r.status === 'expired' || (r.status === 'pending' && r.expires_at < Date.now())
  const mine = (r: any) => sup || r.created_by === me
  const canRevoke = (r: any) => r.status === 'pending' && !isExpired(r) && mine(r)
  const send = async () => {
    const emails = text.split(/[\s,;，；]+/).filter(Boolean)
    if (!emails.length) return
    if (emails.length > cap) {
      await confirm({
        title: `一次最多 ${cap} 个邮箱`,
        body: `本次粘贴了 ${emails.length} 个，请分批发送。没有发出任何邀请。`,
        confirmLabel: '知道了',
      })
      return
    }
    const many = emails.length > 20
    const c = await confirm({
      title: `发送 ${emails.length} 封邀请？`,
      body: `每封邀请 7 天内有效；收件人验证邮箱并接受后才开通 Standard。${sup ? '' : '审核管理员每天最多发 200 封。'}`,
      confirmLabel: '发送',
      ...(many ? { typeToConfirm: String(emails.length) } : {}),
    })
    if (!c.ok) return
    const r = await run(() =>
      api<any>('POST', '/api/admin/invites', { emails, ...(many ? { confirmCount: emails.length } : {}) }),
    )
    if (r) {
      setResult(r.results)
      setText('')
      d.reload()
    }
  }
  const resend = async (r: any) => {
    const label = r.status === 'revoked' ? '重新邀请' : isExpired(r) ? '重新发送' : '重发新链接'
    const c = await confirm({
      title: `${label} ${r.email}？`,
      body:
        r.status === 'revoked'
          ? '原邀请保持作废，会生成一封新的 7 天邀请。'
          : '会生成新链接（7 天有效），旧链接立即失效。',
      confirmLabel: label,
    })
    if (!c.ok) return
    if (await run(() => api('POST', '/api/admin/invites/resend', { id: r.id }), `${label}成功（新链接，7 天有效）`))
      d.reload()
  }
  const revokeBatch = async () => {
    const items = rows.filter((r) => sel.has(r.id) && canRevoke(r)).map((r) => ({ id: r.id, version: r.version }))
    if (!items.length) return
    const c = await confirm({
      title: `作废 ${items.length} 个邀请？`,
      body: '作废后链接立即失效，不能恢复。',
      confirmLabel: '作废',
      danger: true,
      typeToConfirm: String(items.length),
    })
    if (!c.ok) return
    const r = await run(() =>
      api<any>('POST', '/api/admin/invites/revoke-batch', { items, confirmCount: items.length }),
    )
    if (r) {
      const failed = (r.results as any[]).filter((x) => !x.ok).length
      await confirm({
        title: `已作废 ${r.revoked} 个`,
        body: failed ? `${failed} 个未作废（状态已变化或无权限），请刷新后查看。` : '全部完成。',
        confirmLabel: '好的',
      })
      setSel(new Set())
      d.reload()
    }
  }
  const cols: Col<any>[] = [
    { key: 'email', label: '邮箱', render: (r) => <span className="wk-mono">{r.email}</span> },
    { key: 'status', label: '状态', render: (r) => pill(INV_STATUS, isExpired(r) ? 'expired' : r.status) },
    { key: 'expires_at', label: '有效期至', render: (r) => fmtDate(r.expires_at) },
    { key: 'by', label: '发出人', render: (r) => r.created_by, minor: true },
    {
      key: 'act',
      label: '操作',
      render: (r) => {
        const showResend = r.status !== 'accepted' && (r.status === 'revoked' ? sup : mine(r))
        if (!showResend && !canRevoke(r)) return null
        return (
          <span className="wk-actions">
            {showResend && (
              <button type="button" className="btn btn-sm" onClick={() => resend(r)}>
                {r.status === 'revoked' ? '重新邀请' : '重新发送'}
              </button>
            )}
            {canRevoke(r) && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  const c = await confirm({
                    title: `作废给 ${r.email} 的邀请？`,
                    body: '作废后链接立即失效。',
                    confirmLabel: '作废',
                    danger: true,
                  })
                  if (
                    c.ok &&
                    (await run(
                      () => api('POST', '/api/admin/invites/revoke', { id: r.id, version: r.version }),
                      '已作废',
                    ))
                  )
                    d.reload()
                }}
              >
                作废
              </button>
            )}
          </span>
        )
      },
    },
  ]
  const selectable = rows.some(canRevoke)
  return (
    <>
      {node}
      {dlg}
      <div className="wk-box" style={{ marginBottom: 16 }}>
        <div className="wk-box-h">
          <h3>发送邀请</h3>
          <span className="wk-muted">
            可一次粘贴多个邮箱（换行、逗号或空格分隔，一次最多 {cap} 个{sup ? '' : '，每天最多 200 个'}）
          </span>
        </div>
        <label className="wk-field">
          <span className="sr-only">邮箱列表</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'student@example.edu\nclassmate@example.edu'}
            rows={3}
          />
        </label>
        <button type="button" className="btn btn-primary" onClick={send} disabled={!text.trim()}>
          发送邀请
        </button>
        {result && (
          <ul className="wk-muted" style={{ marginTop: 10 }}>
            {result.map((r, i) => (
              <li key={i}>
                {r.email}：{r.ok ? '已生成邀请' : REASON[r.reason] || r.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Toolbar>
        <Segmented
          label="状态"
          value={status}
          onChange={(v) => (setStatus(v), setPage(1))}
          options={[
            { v: '', label: '全部' },
            { v: 'pending', label: '待接受' },
            { v: 'accepted', label: '已接受' },
            { v: 'expired', label: '已过期' },
            { v: 'revoked', label: '已作废' },
          ]}
        />
        <SearchBox label="搜索邮箱" value={q} onChange={(v) => (setQ(v), setPage(1))} />
        {sel.size > 0 && (
          <button type="button" className="btn btn-sm btn-danger" onClick={revokeBatch}>
            作废所选 {sel.size} 个
          </button>
        )}
      </Toolbar>
      <DataTable
        caption="邀请列表"
        rows={rows}
        cols={cols}
        rowKey={(r) => r.id}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        selectable={selectable}
        selected={sel}
        onSelect={(s) =>
          setSel(
            new Set(
              [...s].filter((id) => {
                const r = rows.find((x) => x.id === id)
                return r && canRevoke(r)
              }),
            ),
          )
        }
      />
    </>
  )
}

/* ============================================================= members */
function useGroups() {
  return useAsync(() => api<any>('GET', '/api/admin/groups'), [])
}
function Members({ onOpen }: { onOpen: (e: string) => void }) {
  const [f, setF] = useState({ status: '', tier: '', role: '', group: '', access: '', q: '', retain: '' })
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [sort, setSort] = useState('login')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulkGroup, setBulkGroup] = useState('')
  const groups = useGroups()
  const { node, run } = useErr()
  const qs = new URLSearchParams({ ...f, page: String(page), size: String(size), sort }).toString()
  const d = useAsync(() => api<any>('GET', `/api/admin/members?${qs}`), [qs])
  const set = (k: keyof typeof f) => (v: string) => (setF((x) => ({ ...x, [k]: v })), setPage(1))
  const gname = useMemo(
    () => new Map<string, string>((groups.data?.groups ?? []).map((g: any) => [g.id, g.name])),
    [groups.data],
  )
  const cols: Col<any>[] = [
    { key: 'email', label: '邮箱', render: (r) => <span className="wk-mono">{r.email}</span> },
    { key: 'status', label: '状态', render: (r) => pill(MEM_STATUS, r.status) },
    {
      key: 'tier',
      label: '权益',
      render: (r) =>
        r.suspended ? (
          <span className="wk-pill bad">Pro 暂停</span>
        ) : r.tier === 'pro' ? (
          <span className="wk-pill acc">{r.permanent ? '永久 Pro' : `Pro · ${fmtLeft(r.until - Date.now())}`}</span>
        ) : (
          'Standard'
        ),
    },
    { key: 'role', label: '身份', render: (r) => ROLE[r.role] + (r.owner ? '（最高）' : ''), minor: true },
    { key: 'access', label: '登录授权', render: (r) => pill(ACCESS_STATE, r.access_state), minor: true },
    { key: 'login', label: '最后登录', render: (r) => fmtDate(r.last_login_at), minor: true },
    {
      key: 'labels',
      label: '分组/标签',
      render: (r) =>
        [
          ...String(r.groups || '')
            .split(',')
            .filter(Boolean)
            .map((g: string) => gname.get(g) || g),
          ...String(r.tags || '')
            .split(',')
            .filter(Boolean),
        ].join('、') || '—',
      minor: true,
    },
  ]
  return (
    <>
      {node}
      <Toolbar>
        <SearchBox label="搜索邮箱" value={f.q} onChange={set('q')} />
        <Select
          label="状态"
          value={f.status}
          onChange={set('status')}
          options={[
            { v: '', label: '全部' },
            { v: 'active', label: '正常' },
            { v: 'revoked', label: '已停用' },
            { v: 'closing', label: '注销冷静期' },
          ]}
        />
        <Select
          label="权益"
          value={f.tier}
          onChange={set('tier')}
          options={[
            { v: '', label: '全部' },
            { v: 'pro', label: 'Pro' },
            { v: 'standard', label: 'Standard' },
            { v: 'suspended', label: 'Pro 暂停' },
          ]}
        />
        <Select
          label="身份"
          value={f.role}
          onChange={set('role')}
          options={[
            { v: '', label: '全部' },
            { v: 'user', label: '普通用户' },
            { v: 'reviewer', label: '审核管理员' },
            { v: 'super', label: '超级管理员' },
          ]}
        />
        <Select
          label="分组"
          value={f.group}
          onChange={set('group')}
          options={[
            { v: '', label: '全部' },
            ...(groups.data?.groups ?? []).map((g: any) => ({ v: g.id, label: `${g.name}（${g.n}）` })),
          ]}
        />
        <Select
          label="登录授权"
          value={f.access}
          onChange={set('access')}
          options={[
            { v: '', label: '全部' },
            { v: 'ok', label: '已授权' },
            { v: 'pending', label: '待完成' },
            { v: 'failed', label: '失败待重试' },
          ]}
        />
        <Select
          label="排序"
          value={sort}
          onChange={setSort}
          options={[
            { v: 'login', label: '最近登录' },
            { v: 'created', label: '加入时间' },
            { v: 'email', label: '邮箱' },
          ]}
        />
      </Toolbar>
      {sel.size > 0 && (
        <div className="wk-actions" style={{ marginBottom: 10, alignItems: 'flex-end' }}>
          <span className="wk-muted">已选 {sel.size} 人</span>
          <Select
            label="移动到分组"
            value={bulkGroup}
            onChange={setBulkGroup}
            options={[
              { v: '', label: '选择分组' },
              ...(groups.data?.groups ?? []).map((g: any) => ({ v: g.id, label: g.name })),
            ]}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!bulkGroup}
            onClick={async () =>
              (await run(
                () => api('POST', '/api/admin/members/bulk', { emails: [...sel], group: bulkGroup, op: 'add' }),
                '已加入分组',
              )) && (setSel(new Set()), d.reload(), groups.reload())
            }
          >
            加入分组
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!bulkGroup}
            onClick={async () =>
              (await run(
                () => api('POST', '/api/admin/members/bulk', { emails: [...sel], group: bulkGroup, op: 'remove' }),
                '已移出分组',
              )) && (setSel(new Set()), d.reload(), groups.reload())
            }
          >
            移出分组
          </button>
        </div>
      )}
      <DataTable
        caption="成员列表"
        rows={d.data?.rows ?? []}
        cols={cols}
        rowKey={(r) => r.email}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        selectable
        selected={sel}
        onSelect={setSel}
        onRow={(r) => onOpen(r.email)}
      />
      <GroupsBox groups={groups} />
      <AccessBox />
    </>
  )
}

function GroupsBox({ groups }: { groups: ReturnType<typeof useGroups> }) {
  const [name, setName] = useState('')
  const { node, run } = useErr()
  return (
    <details className="wk-box" style={{ marginTop: 16 }}>
      <summary>
        <b>分组管理</b> <span className="wk-muted">分组和标签只用于筛选，不会改变任何权限</span>
      </summary>
      {node}
      <div className="wk-actions" style={{ margin: '10px 0' }}>
        <input
          className="wk-field"
          style={{ margin: 0 }}
          aria-label="新分组名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新分组名称"
          maxLength={40}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!name.trim()}
          onClick={async () =>
            (await run(() => api('POST', '/api/admin/groups', { op: 'create', name }))) &&
            (setName(''), groups.reload())
          }
        >
          新建分组
        </button>
      </div>
      <ul>
        {(groups.data?.groups ?? []).map((g: any) => (
          <li key={g.id}>
            {g.name}（{g.n} 人）{' '}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={async () =>
                (await run(() => api('POST', '/api/admin/groups', { op: 'delete', id: g.id }))) && groups.reload()
              }
            >
              删除分组
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

function AccessBox() {
  const { node, run } = useErr()
  const [res, setRes] = useState<any>(null)
  return (
    <details className="wk-box" style={{ marginTop: 12 }}>
      <summary>
        <b>Cloudflare Access 授权同步</b>{' '}
        <span className="wk-muted">读取 → 差异更新 → 复核；只改本站策略里的邮箱规则</span>
      </summary>
      {node}
      <div className="wk-actions" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => setRes(await run(() => api('POST', '/api/admin/access/sync', {})))}
        >
          重试待完成项
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={async () => setRes(await run(() => api('POST', '/api/admin/access/sync', { full: true })))}
        >
          全量核对
        </button>
      </div>
      {res && (
        <p className="wk-muted">
          {res.ran ? `新增 ${res.added.length}，移除 ${res.removed.length}` : '没有需要同步的成员'}
          {res.error ? `；错误：${res.error}` : ''}
        </p>
      )}
    </details>
  )
}

/* ============================================================= member drawer (super) */
function MemberDrawer({ email, me, onClose }: { email: string | null; me: string; onClose: () => void }) {
  const [tick, setTick] = useState(0)
  const d = useAsync(
    () => (email ? api<any>('GET', `/api/admin/member?email=${encodeURIComponent(email)}`) : Promise.resolve(null)),
    [email, tick],
  )
  const [sub, setSub] = useState('info')
  const { node, run } = useErr()
  const [dlg, confirm] = useConfirm()
  const groups = useGroups()
  useEffect(() => setSub('info'), [email])
  const reload = () => setTick((t) => t + 1)
  const m = d.data?.member
  const act = async (
    action: string,
    extra: Record<string, unknown>,
    c: Parameters<typeof confirm>[0] | null,
    ok: string,
  ) => {
    let reason: string | undefined
    if (c) {
      const r = await confirm(c)
      if (!r.ok) return
      reason = r.reason
    }
    if (
      await run(
        () =>
          api('POST', '/api/admin/member/action', {
            email,
            action,
            confirm: true,
            reason,
            version: m?.version,
            ...extra,
          }),
        ok,
      )
    )
      reload()
  }
  // one idempotency key per Pro request; a retry of the same request after a lost response
  // (network error, timeout) reuses it, so the server applies it at most once
  const pendingIdem = useRef<{ sig: string; key: string } | null>(null)
  const pro = async (body: Record<string, unknown>, c: Parameters<typeof confirm>[0], ok: string) => {
    const r = await confirm(c)
    if (!r.ok) return
    const req = { email, confirm: true, reason: r.reason, ...body }
    const sig = JSON.stringify(req)
    const key = pendingIdem.current?.sig === sig ? pendingIdem.current.key : crypto.randomUUID().replace(/-/g, '')
    pendingIdem.current = { sig, key }
    let lost = false
    const done = await run(async () => {
      try {
        return await api('POST', '/api/admin/pro', { ...req, idem: key })
      } catch (e) {
        // lost response: offline (status 0) or a gateway/5xx without our JSON body
        lost = !(e instanceof ApiError) || e.status === 0 || e.code === 'server'
        throw e
      }
    }, ok)
    if (!lost) pendingIdem.current = null
    if (done) reload()
  }
  return (
    <Drawer open={!!email} title={email || ''} onClose={onClose}>
      {dlg}
      {node}
      {!d.data ? (
        d.error ? (
          <Notice tone="bad">{d.error}</Notice>
        ) : (
          <Loading />
        )
      ) : (
        <>
          <Tabs
            compact
            label="成员详情"
            value={sub}
            onChange={setSub}
            tabs={[
              { id: 'info', label: '资料' },
              { id: 'pro', label: 'Pro 权益' },
              { id: 'stats', label: '学习统计' },
              { id: 'ref', label: '推荐' },
            ]}
          />
          {sub === 'info' && (
            <>
              <dl className="wk-dl">
                <dt>状态</dt>
                <dd>
                  {pill(MEM_STATUS, m.status)}
                  {m.delete_after && (
                    <span className="wk-muted">
                      {' '}
                      · {fmtDate(m.delete_after)} 后删除（{m.delete_reason}）
                    </span>
                  )}
                </dd>
                <dt>身份</dt>
                <dd>
                  {ROLE[m.role]}
                  {m.owner ? '（最高管理员，受保护）' : ''}
                </dd>
                <dt>登录授权</dt>
                <dd>
                  {pill(ACCESS_STATE, m.access_state)}{' '}
                  {m.access_error && <span className="wk-muted">{m.access_error}</span>}
                </dd>
                <dt>来源</dt>
                <dd>{m.source}</dd>
                <dt>加入</dt>
                <dd>{fmtDate(m.created_at)}</dd>
                <dt>首次激活</dt>
                <dd>{fmtDate(m.activated_at)}</dd>
                <dt>最后登录</dt>
                <dd>{fmtDate(m.last_login_at)}</dd>
                <dt>长期保留</dt>
                <dd>{m.long_retain ? '已开启（不受 6 个月不活跃清理）' : '未开启'}</dd>
              </dl>
              <LabelsEditor
                email={email!}
                groups={groups.data?.groups ?? []}
                current={d.data.groups}
                tags={d.data.tags}
                note={m.note}
                onSaved={reload}
              />
              {!m.owner && m.email !== me && (
                <div className="wk-box" style={{ marginTop: 12 }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>身份与访问</h3>
                  <div className="wk-actions">
                    {m.status === 'active' && m.role !== 'reviewer' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          act(
                            'role',
                            { role: 'reviewer' },
                            {
                              title: '任命为审核管理员？',
                              body: '审核管理员只能处理申请和邀请。',
                              confirmLabel: '任命',
                            },
                            '已任命',
                          )
                        }
                      >
                        设为审核管理员
                      </button>
                    )}
                    {m.status === 'active' && m.role !== 'super' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          act(
                            'role',
                            { role: 'super' },
                            {
                              title: '任命为超级管理员？',
                              body: '超级管理员拥有全部管理权限。',
                              confirmLabel: '任命',
                              typeToConfirm: '任命',
                            },
                            '已任命',
                          )
                        }
                      >
                        设为超级管理员
                      </button>
                    )}
                    {m.role !== 'user' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          act(
                            'role',
                            { role: 'user' },
                            { title: '撤销管理员身份？', confirmLabel: '撤销' },
                            '已撤销管理员身份',
                          )
                        }
                      >
                        撤销管理员
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        act(
                          'retain',
                          { on: !m.long_retain },
                          {
                            title: m.long_retain ? '关闭长期保留？' : '开启长期保留？',
                            body: m.long_retain
                              ? '关闭后重新走正常提醒流程（先提醒 30 天），不会立即停用。'
                              : '开启后不受 6 个月不活跃自动清理。不影响用户主动注销或管理员停用。',
                            reason: 'optional',
                          },
                          '已更新',
                        )
                      }
                    >
                      {m.long_retain ? '关闭长期保留' : '开启长期保留'}
                    </button>
                  </div>
                  <div className="wk-danger-zone" style={{ marginTop: 12 }}>
                    <h3>危险操作</h3>
                    {m.status === 'active' ? (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          act(
                            'revoke',
                            {},
                            {
                              title: '停用该账号的访问资格？',
                              body: '立即停用（已有登录会话也无法再调用 API），学习数据保留 7 天，7 天内恢复可取消删除；到期自动删除个人数据。',
                              danger: true,
                              confirmLabel: '停用',
                              typeToConfirm: '停用',
                              reason: 'optional',
                            },
                            '已停用，7 天后自动删除',
                          )
                        }
                      >
                        停用访问资格
                      </button>
                    ) : m.status === 'revoked' ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          act(
                            'restore',
                            {},
                            { title: '恢复访问资格？', body: '取消删除计划，恢复原有学习数据和合法权限。' },
                            '已恢复',
                          )
                        }
                      >
                        恢复访问资格
                      </button>
                    ) : (
                      <p className="wk-muted">用户主动注销中，只有用户本人可以撤销。</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {sub === 'pro' && <ProPanel data={d.data} pro={pro} />}
          {sub === 'stats' && <MemberStats email={email!} />}
          {sub === 'ref' && (
            <DataTable
              caption="推荐记录"
              rows={d.data.referrals}
              rowKey={(r: any) => r.id}
              cols={[
                { key: 'who', label: '被推荐人', render: (r: any) => r.referee_email },
                { key: 'st', label: '状态', render: (r: any) => pill(REF_STATUS, r.status) },
                { key: 'at', label: '时间', render: (r: any) => fmtDate(r.created_at, false) },
                {
                  key: 'act',
                  label: '',
                  render: (r: any) =>
                    (r.status === 'approved' && r.activated_at) || r.status === 'approved' ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          pro(
                            { action: 'adjust', source: 'referral_manual', referralId: r.id, days: 7 },
                            {
                              title: '补发这笔推荐奖励？',
                              reason: 'required',
                              body: '记为“推荐补发”，与管理员直接赠送区分。',
                            },
                            '已补发',
                          )
                        }
                      >
                        补发奖励
                      </button>
                    ) : null,
                },
              ]}
              empty={<Empty title="没有推荐记录" />}
            />
          )}
        </>
      )}
    </Drawer>
  )
}

function LabelsEditor({
  email,
  groups,
  current,
  tags,
  note,
  onSaved,
}: {
  email: string
  groups: any[]
  current: string[]
  tags: string[]
  note: string | null
  onSaved: () => void
}) {
  const [g, setG] = useState<string[]>(current)
  const [t, setT] = useState(tags.join('，'))
  const [n, setN] = useState(note || '')
  const { node, run } = useErr()
  return (
    <details className="wk-box" style={{ marginTop: 12 }}>
      <summary>
        <b>分组、标签与内部备注</b>
      </summary>
      {node}
      <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
        <legend className="wk-muted">分组</legend>
        {groups.map((x) => (
          <label key={x.id} style={{ marginRight: 12 }}>
            <input
              type="checkbox"
              checked={g.includes(x.id)}
              onChange={() => setG((v) => (v.includes(x.id) ? v.filter((y) => y !== x.id) : [...v, x.id]))}
            />{' '}
            {x.name}
          </label>
        ))}
        {!groups.length && <span className="wk-muted">还没有分组（在成员列表下方新建）</span>}
      </fieldset>
      <label className="wk-field">
        标签（逗号分隔）
        <input value={t} onChange={(e) => setT(e.target.value)} />
      </label>
      <label className="wk-field">
        内部备注（用户看不到）
        <textarea value={n} onChange={(e) => setN(e.target.value)} maxLength={1000} />
      </label>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={async () => {
          const ok1 = await run(() =>
            api('POST', '/api/admin/member/action', {
              email,
              action: 'labels',
              groups: g,
              tags: t.split(/[,，\s]+/).filter(Boolean),
            }),
          )
          const ok2 =
            ok1 &&
            (await run(() => api('POST', '/api/admin/member/action', { email, action: 'note', note: n }), '已保存'))
          if (ok2) onSaved()
        }}
      >
        保存
      </button>
    </details>
  )
}

const SRC: Record<string, string> = {
  legacy: '迁移（原 AI 权限）',
  admin: '管理员赠送',
  referral: '推荐奖励',
  referral_manual: '推荐补发',
}
function ProPanel({
  data,
  pro,
}: {
  data: any
  pro: (body: Record<string, unknown>, c: any, ok: string) => Promise<void>
}) {
  const p = data.pro
  const [custom, setCustom] = useState('')
  const open = data.suspensions.find((s: any) => !s.ended_at)
  return (
    <>
      <dl className="wk-dl">
        <dt>当前</dt>
        <dd>
          {p.tier === 'pro'
            ? p.permanent
              ? '永久 Pro'
              : p.paused
                ? `Pro（冻结中，剩 ${fmtLeft(p.remainingMs)}）`
                : `Pro，${fmtDate(p.until)} 到期（剩 ${fmtLeft(p.until - Date.now())}）`
            : 'Standard'}
          {p.suspended && <span className="wk-pill bad"> 已强制暂停</span>}
        </dd>
      </dl>
      <div className="wk-box" style={{ marginTop: 12 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>授予 / 续期</h3>
        <div className="wk-actions">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              type="button"
              className="btn btn-sm"
              onClick={() =>
                pro(
                  { action: 'grant', kind: 'days', days: n },
                  { title: `授予 ${n} 天 Pro？`, body: '叠加到当前有效期之后。', reason: 'optional' },
                  `已授予 ${n} 天`,
                )
              }
            >
              +{n} 天
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() =>
              pro(
                { action: 'grant', kind: 'permanent' },
                { title: '授予永久 Pro？', reason: 'optional', typeToConfirm: '永久' },
                '已授予永久 Pro',
              )
            }
          >
            永久 Pro
          </button>
        </div>
        <div className="wk-actions" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <label className="wk-field" style={{ margin: 0 }}>
            自定义到期时间
            <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!custom}
            onClick={() =>
              pro(
                { action: 'grant', kind: 'days', until: new Date(custom).getTime() },
                { title: `把到期时间延长到 ${custom.replace('T', ' ')}？`, reason: 'optional' },
                '已更新',
              )
            }
          >
            设定
          </button>
        </div>
        <div className="wk-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              pro(
                { action: 'adjust', source: 'admin', days: 7 },
                { title: '手工增加 7 天（管理员赠送）', reason: 'required' },
                '已增加',
              )
            }
          >
            手工增加天数
          </button>
        </div>
      </div>
      <div className="wk-danger-zone" style={{ marginTop: 12 }}>
        <h3>撤销与暂停</h3>
        <div className="wk-actions">
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() =>
              pro(
                { action: 'revoke_admin' },
                {
                  title: '普通撤销？',
                  body: '只撤销管理员授予的 Pro（含迁移来的原 AI 权限），推荐奖励保留。',
                  danger: true,
                  reason: 'optional',
                  confirmLabel: '撤销',
                },
                '已撤销管理员授予的 Pro',
              )
            }
          >
            普通撤销
          </button>
          {open ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                pro(
                  { action: 'lift' },
                  {
                    title: '解除强制暂停？',
                    body:
                      open.mode === 'freeze'
                        ? '冻结的剩余天数会从现在起继续计算；暂停期间的推荐奖励同时生效。'
                        : '暂停期间天数照常消耗。',
                    reason: 'optional',
                  },
                  '已解除暂停',
                )
              }
            >
              解除暂停（{open.mode === 'freeze' ? '冻结中' : '继续计时'}）
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() =>
                  pro(
                    { action: 'suspend', mode: 'freeze' },
                    {
                      title: '强制暂停全部 Pro（冻结剩余天数）？',
                      body: '立即阻止 Pro AI；剩余天数冻结，解除后恢复。暂停期间的新推荐奖励暂缓生效。',
                      danger: true,
                      reason: 'optional',
                      confirmLabel: '暂停',
                    },
                    '已暂停（冻结）',
                  )
                }
              >
                强制暂停（冻结天数）
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() =>
                  pro(
                    { action: 'suspend', mode: 'continue' },
                    {
                      title: '强制暂停全部 Pro（继续消耗天数）？',
                      danger: true,
                      reason: 'optional',
                      confirmLabel: '暂停',
                    },
                    '已暂停（继续计时）',
                  )
                }
              >
                强制暂停（继续计时）
              </button>
            </>
          )}
        </div>
      </div>
      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>权益流水</h3>
      <DataTable
        caption="权益流水"
        rows={[...data.ledger].reverse()}
        rowKey={(r: any) => r.id}
        cols={[
          { key: 'src', label: '来源', render: (r: any) => SRC[r.source] || r.source },
          {
            key: 'kind',
            label: '内容',
            render: (r: any) => (r.kind === 'permanent' ? '永久' : `${Math.round((r.duration_ms / DAY) * 10) / 10} 天`),
          },
          {
            key: 'st',
            label: '状态',
            render: (r: any) =>
              r.state === 'revoked' ? (
                <span className="wk-pill bad">
                  已撤销
                  {r.revoked_unused_ms ? `（收回未用 ${Math.round((r.revoked_unused_ms / DAY) * 10) / 10} 天）` : ''}
                </span>
              ) : r.state === 'held' ? (
                <span className="wk-pill warn">冻结待复核</span>
              ) : (
                <span className="wk-pill ok">有效</span>
              ),
          },
          {
            key: 'use',
            label: '已用/剩余',
            render: (r: any) =>
              r.usage ? `${(r.usage.used / DAY).toFixed(1)} / ${(r.usage.remaining / DAY).toFixed(1)} 天` : '—',
            minor: true,
          },
          { key: 'at', label: '时间', render: (r: any) => fmtDate(r.created_at), minor: true },
          {
            key: 'act',
            label: '',
            render: (r: any) =>
              r.state !== 'revoked' && r.kind === 'days' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() =>
                    pro(
                      { action: 'correct', grantId: r.id },
                      {
                        title: '纠正这笔授权？',
                        body: '只收回尚未使用的部分；原记录保留并标记为已撤销。',
                        reason: 'required',
                        danger: true,
                      },
                      '已纠正',
                    )
                  }
                >
                  纠错
                </button>
              ) : null,
          },
        ]}
      />
    </>
  )
}

/* ============================================================= learning stats helpers */
const qMeta = new Map(allQuestions.map((q) => [q.id, q]))
function digest(s: any) {
  const byCh = new Map<string, { n: number; c: number; w: number; seen: number; total: number }>()
  for (const ch of chapterOrder) byCh.set(ch, { n: 0, c: 0, w: 0, seen: 0, total: 0 })
  for (const q of allQuestions) {
    const x = byCh.get(q.chapter)
    if (x) x.total++
  }
  const byType = new Map<string, { n: number; c: number; w: number }>()
  for (const [qid, n, c, w] of s.qids as [string, number, number, number][]) {
    const q = qMeta.get(qid)
    if (!q) continue
    const ch = byCh.get(q.chapter)
    if (ch) {
      ch.n += n
      ch.c += c
      ch.w += w
      ch.seen++
    }
    const t = byType.get(q.type) || { n: 0, c: 0, w: 0 }
    t.n += n
    t.c += c
    t.w += w
    byType.set(q.type, t)
  }
  return { byCh, byType }
}
function StatsView({ s, days }: { s: any; days: number }) {
  const { byCh, byType } = useMemo(() => digest(s), [s])
  const [chSel, setChSel] = useState<string | null>(null)
  const m = new Map((s.daily as any[]).map((x) => [x.d, x.n]))
  const a = new Map((s.ai as any[]).map((x) => [x.d, x.n]))
  const mocks = (s.mocks as any[])
    .filter((x) => x.at && x.max)
    .sort((x, y) => x.at - y.at)
    .slice(-20)
  const rate = s.graded ? Math.round((s.correct / s.graded) * 100) : 0
  return (
    <>
      <div className="wk-kpis">
        <div className="wk-kpi">
          <b>{s.attempts}</b>
          <span>作答次数</span>
        </div>
        <div className="wk-kpi">
          <b>{s.qids.length}</b>
          <span>练过的题</span>
        </div>
        <div className="wk-kpi">
          <b>{s.graded ? rate + '%' : '—'}</b>
          <span>客观题正确率</span>
        </div>
        <div className="wk-kpi">
          <b>{(s.qids as any[]).filter((x) => x[3] > 0).length}</b>
          <span>做错过的题</span>
        </div>
        <div className="wk-kpi">
          <b>{s.mocks.length}</b>
          <span>模考场次</span>
        </div>
      </div>
      <div className="wk-grid">
        <div className="wk-box">
          <h3>练习趋势</h3>
          <BarChart
            label="每日作答数"
            data={lastDays(days).map((k) => ({ label: shortDay(k), key: k, value: Number(m.get(k) || 0) }))}
          />
        </div>
        <div className="wk-box">
          <h3>AI 使用次数</h3>
          <BarChart
            label="每日 AI 调用"
            data={lastDays(days).map((k) => ({ label: shortDay(k), key: k, value: Number(a.get(k) || 0) }))}
          />
        </div>
        <div className="wk-box">
          <h3>模考成绩（百分制）</h3>
          <LineChart
            label="模考成绩趋势"
            max={100}
            data={mocks.map((x, i) => ({
              label: `${i + 1}`,
              key: String(i),
              value: Math.round((x.score / x.max) * 100),
            }))}
          />
        </div>
        <div className="wk-box">
          <h3>题型正确率</h3>
          <BarChart
            horizontal
            label="题型正确率"
            unit="%"
            data={[...byType].map(([t, x]) => ({
              label: TYPE_LABEL[t as keyof typeof TYPE_LABEL] || t,
              key: t,
              value: x.c + x.w ? Math.round((x.c / (x.c + x.w)) * 100) : 0,
            }))}
          />
        </div>
      </div>
      <div className="wk-box" style={{ marginTop: 12 }}>
        <h3>章节覆盖率（点选查看明细）</h3>
        <BarChart
          horizontal
          label="章节覆盖率"
          unit="%"
          selected={chSel}
          onSelect={setChSel}
          data={[...byCh].map(([ch, x]) => ({
            label: ch,
            key: ch,
            value: x.total ? Math.round((x.seen / x.total) * 100) : 0,
          }))}
        />
        {chSel &&
          (() => {
            const x = byCh.get(chSel)!
            return (
              <p className="wk-muted">
                {chSel}：练过 {x.seen}/{x.total} 题，作答 {x.n} 次，正确 {x.c}，错误 {x.w}
              </p>
            )
          })()}
      </div>
    </>
  )
}
function MemberStats({ email }: { email: string }) {
  const d = useAsync(() => api<any>('GET', `/api/admin/member/stats?email=${encodeURIComponent(email)}`), [email])
  if (!d.data) return d.error ? <Notice tone="bad">{d.error}</Notice> : <Loading />
  if (d.data.empty) return <Empty title="还没有学习记录">这个成员还没有登录过学习站。</Empty>
  return (
    <>
      <p className="wk-muted">只显示统计数字；看不到作答内容、主观题答案或 AI 对话。</p>
      <StatsView s={d.data} days={30} />
    </>
  )
}

function Stats({ onOpen }: { onOpen: (e: string) => void }) {
  const groups = useGroups()
  const [group, setGroup] = useState('')
  const [days, setDays] = useState(30)
  const d = useAsync(() => api<any>('GET', `/api/admin/stats?group=${group}`), [group])
  const [q, setQ] = useState('')
  return (
    <>
      <Toolbar>
        <Select
          label="分组"
          value={group}
          onChange={setGroup}
          options={[
            { v: '', label: '全部正常成员' },
            ...(groups.data?.groups ?? []).map((g: any) => ({ v: g.id, label: g.name })),
          ]}
        />
        <Segmented
          label="时间范围"
          value={days}
          onChange={setDays}
          options={[
            { v: 7, label: '7 天' },
            { v: 30, label: '30 天' },
            { v: 90, label: '90 天' },
          ]}
        />
        <form
          className="wk-actions"
          onSubmit={(e) => {
            e.preventDefault()
            if (q.trim()) onOpen(q.trim().toLowerCase())
          }}
        >
          <SearchBox label="查看某个成员（输入邮箱）" value={q} onChange={setQ} />
          <button className="btn btn-sm" type="submit">
            查看
          </button>
        </form>
      </Toolbar>
      {!d.data ? (
        d.error ? (
          <Notice tone="bad">{d.error}</Notice>
        ) : (
          <Loading />
        )
      ) : (
        <>
          <p className="wk-muted">{d.data.members} 名成员的汇总。统计只含次数与正确率，不含任何作答内容。</p>
          <StatsView s={d.data} days={days} />
        </>
      )}
    </>
  )
}

/* ============================================================= Pro tab */
function ProTab({ onOpen }: { onOpen: (e: string) => void }) {
  const [tier, setTier] = useState('pro')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const d = useAsync(
    () => api<any>('GET', `/api/admin/members?tier=${tier}&sort=until&page=${page}&size=${size}`),
    [tier, page, size],
  )
  return (
    <>
      <Toolbar>
        <Segmented
          label="范围"
          value={tier}
          onChange={(v) => (setTier(v), setPage(1))}
          options={[
            { v: 'pro', label: '全部 Pro' },
            { v: 'suspended', label: '已暂停' },
            { v: 'standard', label: 'Standard' },
          ]}
        />
        <a
          className="btn btn-sm"
          href="/api/admin/export?type=members"
          onClick={(e) => (e.preventDefault(), downloadCsv('/api/admin/export?type=members'))}
        >
          导出成员 CSV
        </a>
      </Toolbar>
      <p className="wk-muted">点一行打开成员详情，在“Pro 权益”里授予、续期、撤销、暂停或纠错。</p>
      <DataTable
        caption="Pro 成员"
        rows={d.data?.rows ?? []}
        rowKey={(r: any) => r.email}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        onRow={(r: any) => onOpen(r.email)}
        cols={[
          { key: 'email', label: '邮箱', render: (r: any) => <span className="wk-mono">{r.email}</span> },
          {
            key: 'tier',
            label: '权益',
            render: (r: any) => (r.tier === 'pro' ? (r.permanent ? '永久 Pro' : 'Pro') : 'Standard'),
          },
          {
            key: 'until',
            label: '到期',
            render: (r: any) =>
              r.permanent
                ? '—'
                : r.paused_ms
                  ? `冻结（剩 ${fmtLeft(r.paused_ms)}）`
                  : r.until
                    ? `${fmtDate(r.until)}（剩 ${fmtLeft(r.until - Date.now())}）`
                    : '—',
          },
          {
            key: 'sus',
            label: '暂停',
            render: (r: any) => (r.suspended ? <span className="wk-pill bad">已暂停</span> : '—'),
          },
        ]}
      />
    </>
  )
}

async function downloadCsv(url: string) {
  const res = await fetch(url, { headers: { 'X-ExamPilot-Client': '1' }, credentials: 'same-origin' })
  if (!res.ok) return alert('导出失败')
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'export.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

/* ============================================================= referrals & rewards */
function Referrals({ onOpen }: { onOpen: (e: string) => void }) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [days, setDays] = useState(30)
  const [daySel, setDaySel] = useState<string | null>(null)
  const ov = useAsync(() => api<any>('GET', `/api/admin/overview?days=${days}`), [days])
  const d = useAsync(
    () => api<any>('GET', `/api/admin/referrals?status=${status}&q=${encodeURIComponent(q)}&page=${page}&size=${size}`),
    [status, q, page, size],
  )
  const trend = useMemo(() => {
    const m = new Map<string, any>((ov.data?.grantTrend ?? []).map((r: any) => [r.d, r]))
    return lastDays(days).map((k) => ({
      label: shortDay(k),
      key: k,
      value: Number(m.get(k)?.referral || 0),
      value2: Number(m.get(k)?.held || 0),
    }))
  }, [ov.data, days])
  const from = daySel ? new Date(daySel + 'T00:00:00+08:00').getTime() : 0
  return (
    <>
      <div className="wk-box" style={{ marginBottom: 12 }}>
        <div className="wk-box-h">
          <h3>推荐奖励发放（蓝：发放，红：冻结）</h3>
          <Segmented
            label="时间范围"
            value={days}
            onChange={setDays}
            options={[
              { v: 30, label: '30 天' },
              { v: 90, label: '90 天' },
            ]}
          />
        </div>
        <BarChart label="每日推荐奖励笔数" data={trend} selected={daySel} onSelect={setDaySel} />
        <div className="wk-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              downloadCsv(`/api/admin/export?type=rewards${daySel ? `&from=${from}&to=${from + DAY}` : ''}`)
            }
          >
            导出奖励流水 CSV{daySel ? `（${daySel}）` : '（全部）'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => downloadCsv(`/api/admin/export?type=rewards&source=referral_manual`)}
          >
            导出人工补发
          </button>
        </div>
      </div>
      <Toolbar>
        <Select
          label="状态"
          value={status}
          onChange={(v) => (setStatus(v), setPage(1))}
          options={[{ v: '', label: '全部' }, ...Object.entries(REF_STATUS).map(([v, [label]]) => ({ v, label }))]}
        />
        <SearchBox label="搜索推荐人或被推荐人" value={q} onChange={(v) => (setQ(v), setPage(1))} />
      </Toolbar>
      <DataTable
        caption="推荐关系"
        rows={d.data?.rows ?? []}
        rowKey={(r: any) => r.id}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        onRow={(r: any) => !String(r.referrer_email).startsWith('deleted:') && onOpen(r.referrer_email)}
        cols={[
          { key: 'referrer', label: '推荐人', render: (r: any) => <span className="wk-mono">{r.referrer_email}</span> },
          { key: 'referee', label: '被推荐人', render: (r: any) => <span className="wk-mono">{r.referee_email}</span> },
          { key: 'st', label: '状态', render: (r: any) => pill(REF_STATUS, r.status) },
          {
            key: 'flags',
            label: '异常信号',
            render: (r: any) => (r.flags ? <span className="wk-pill warn">{r.flags}</span> : '—'),
            minor: true,
          },
          { key: 'at', label: '申请时间', render: (r: any) => fmtDate(r.created_at), minor: true },
        ]}
      />
    </>
  )
}

/* ============================================================= anomalies & appeals */
function ReviewTab() {
  const [view, setView] = useState('held')
  const { node, run } = useErr()
  const [dlg, confirm] = useConfirm()
  const held = useAsync(() => api<any>('GET', `/api/admin/referrals?review=pending&size=100`), [])
  const appeals = useAsync(() => api<any>('GET', `/api/admin/appeals?status=open&size=100`), [])
  const review = async (r: any, verdict: 'legit' | 'invalid') => {
    const c = await confirm(
      verdict === 'legit'
        ? {
            title: '确认合法并发奖？',
            body: '冻结的 7 天奖励从现在起生效。',
            reason: 'optional',
            reasonLabel: '复核备注',
          }
        : {
            title: '确认违规？',
            body: '只撤销这笔奖励尚未使用的部分；已用时间不追扣，不影响其他奖励。用户可以申诉一次。',
            danger: true,
            reason: 'required',
            reasonLabel: '复核备注',
          },
    )
    if (!c.ok) return
    if (
      await run(
        () =>
          api('POST', '/api/admin/referrals/review', {
            id: r.id,
            verdict,
            note: c.reason,
            confirm: true,
            version: r.version,
          }),
        '已处理',
      )
    ) {
      held.reload()
      appeals.reload()
    }
  }
  const decide = async (a: any, verdict: 'upheld' | 'denied') => {
    const c = await confirm({
      title: verdict === 'upheld' ? '申诉成立，恢复奖励？' : '驳回申诉？',
      reason: 'optional',
      reasonLabel: '处理说明',
      danger: verdict === 'denied',
    })
    if (!c.ok) return
    if (
      await run(
        () => api('POST', '/api/admin/appeals/decide', { id: a.id, verdict, note: c.reason, confirm: true }),
        '已处理',
      )
    )
      appeals.reload()
  }
  return (
    <>
      {node}
      {dlg}
      <Segmented
        label="类别"
        value={view}
        onChange={setView}
        options={[
          { v: 'held', label: `冻结待复核（${held.data?.total ?? 0}）` },
          { v: 'appeals', label: `申诉（${appeals.data?.total ?? 0}）` },
        ]}
      />
      <p className="wk-muted" style={{ margin: '10px 0' }}>
        异常信号只是提示（如 24 小时内同一链接大量申请），不会自动判定作弊；相同 IP、校园网或共用设备不作为依据。
      </p>
      {view === 'held' ? (
        <DataTable
          caption="冻结待复核的推荐"
          rows={held.data?.rows ?? []}
          rowKey={(r: any) => r.id}
          loading={held.loading}
          empty={<Empty title="没有待复核的推荐" />}
          cols={[
            {
              key: 'referrer',
              label: '推荐人',
              render: (r: any) => <span className="wk-mono">{r.referrer_email}</span>,
            },
            {
              key: 'referee',
              label: '被推荐人',
              render: (r: any) => <span className="wk-mono">{r.referee_email}</span>,
            },
            { key: 'flags', label: '信号', render: (r: any) => r.flags },
            {
              key: 'act',
              label: '处理',
              render: (r: any) => (
                <span className="wk-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => review(r, 'legit')}>
                    合法，发奖
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => review(r, 'invalid')}>
                    违规
                  </button>
                </span>
              ),
            },
          ]}
        />
      ) : (
        <DataTable
          caption="申诉"
          rows={appeals.data?.rows ?? []}
          rowKey={(r: any) => r.id}
          loading={appeals.loading}
          empty={<Empty title="没有待处理的申诉" />}
          cols={[
            { key: 'email', label: '申诉人', render: (r: any) => <span className="wk-mono">{r.email}</span> },
            {
              key: 'text',
              label: '内容',
              render: (r: any) => <span style={{ whiteSpace: 'pre-wrap' }}>{r.text}</span>,
            },
            { key: 'at', label: '时间', render: (r: any) => fmtDate(r.created_at), minor: true },
            {
              key: 'act',
              label: '处理',
              render: (r: any) => (
                <span className="wk-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(r, 'upheld')}>
                    申诉成立
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => decide(r, 'denied')}>
                    驳回
                  </button>
                </span>
              ),
            },
          ]}
        />
      )}
    </>
  )
}

/* ============================================================= notices */
const NOTICE_GO: Record<string, string> = {
  application: 'apps',
  referral_flagged: 'review',
  appeal: 'review',
  delete_soon: 'members',
  access_alert: 'members',
}
function Notices({ role, onChanged, go }: { role: Role; onChanged: () => void; go: (t: string) => void }) {
  const [state, setState] = useState('open')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [open, setOpen] = useState<any>(null)
  const d = useAsync(
    () => api<any>('GET', `/api/admin/notices?state=${state}&page=${page}&size=${size}`),
    [state, page, size],
  )
  const read = async (n: any) => {
    setOpen(n)
    if (!n.read) {
      await api('POST', '/api/admin/notices/read', { ids: [n.id] }).catch(() => {})
      d.reload()
      onChanged()
    }
  }
  return (
    <>
      <Toolbar>
        <Segmented
          label="状态"
          value={state}
          onChange={(v) => (setState(v), setPage(1))}
          options={[
            { v: 'open', label: '待处理' },
            { v: 'handled', label: '已处理' },
            { v: 'all', label: '全部' },
          ]}
        />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={async () => {
            await api('POST', '/api/admin/notices/read', { ids: (d.data?.rows ?? []).map((x: any) => x.id) }).catch(
              () => {},
            )
            d.reload()
            onChanged()
          }}
        >
          本页全部标为已读
        </button>
      </Toolbar>
      <p className="wk-muted">
        {role === 'reviewer' ? '只显示申请与邀请相关的事项。' : '管理员提醒只在站内显示，不发邮件。'}
      </p>
      <DataTable
        caption="站内通知"
        rows={d.data?.rows ?? []}
        rowKey={(r: any) => r.id}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        onRow={read}
        empty={<Empty title="没有通知" />}
        cols={[
          {
            key: 'title',
            label: '事项',
            render: (r: any) => <span style={{ fontWeight: r.read ? 400 : 700 }}>{r.title}</span>,
          },
          { key: 'body', label: '摘要', render: (r: any) => <span className="wk-muted">{r.body}</span>, minor: true },
          { key: 'at', label: '时间', render: (r: any) => fmtDate(r.created_at) },
          {
            key: 'st',
            label: '状态',
            render: (r: any) =>
              r.handled_at ? <span className="wk-pill ok">已处理</span> : <span className="wk-pill warn">待处理</span>,
          },
        ]}
      />
      <Drawer
        open={!!open}
        title={open?.title}
        onClose={() => setOpen(null)}
        footer={
          open && (
            <>
              {NOTICE_GO[open.kind] && (role === 'super' || NOTICE_GO[open.kind] === 'apps') && (
                <button type="button" className="btn" onClick={() => (setOpen(null), go(NOTICE_GO[open.kind]))}>
                  去处理
                </button>
              )}
              {!open.handled_at && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    await api('POST', '/api/admin/notices/handle', { id: open.id }).catch(() => {})
                    setOpen(null)
                    d.reload()
                    onChanged()
                  }}
                >
                  标记已处理
                </button>
              )}
            </>
          )
        }
      >
        {open && (
          <dl className="wk-dl">
            <dt>内容</dt>
            <dd>{open.body || '—'}</dd>
            <dt>时间</dt>
            <dd>{fmtDate(open.created_at)}</dd>
            {open.handled_at && (
              <>
                <dt>处理</dt>
                <dd>
                  {fmtDate(open.handled_at)} · {open.handled_by}
                </dd>
              </>
            )}
          </dl>
        )}
      </Drawer>
    </>
  )
}

/* ============================================================= settings */
const TEXT_KEYS: [string, string, number][] = [
  ['text.apply_title', '欢迎标题', 1],
  ['text.apply_intro', '申请说明', 3],
  ['text.apply_paused', '暂停提示', 3],
  ['text.apply_success', '申请成功提示', 3],
  ['text.announcement', '公告（留空则不显示）', 3],
]
function Settings() {
  const d = useAsync(() => api<any>('GET', '/api/admin/settings'), [])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState(false)
  const { node, run } = useErr()
  const [dlg, confirm] = useConfirm()
  useEffect(() => {
    if (d.data) setDraft(d.data.settings)
  }, [d.data])
  if (!d.data) return d.error ? <Notice tone="bad">{d.error}</Notice> : <Loading />
  const open = d.data.settings.applications_open === '1'
  const save = async () => {
    const texts: Record<string, string> = {}
    for (const [k] of TEXT_KEYS) texts[k] = draft[k] ?? ''
    if (await run(() => api('POST', '/api/admin/settings', { texts }), '文案已保存')) d.reload()
  }
  return (
    <>
      {node}
      {dlg}
      <div className="wk-box" style={{ marginBottom: 12 }}>
        <div className="wk-box-h">
          <h3>新申请</h3>
          <span className={`wk-pill ${open ? 'ok' : 'warn'}`}>{open ? '开放中' : '已暂停'}</span>
        </div>
        <p className="wk-muted">
          暂停后新访客不能提交；已提交的申请仍可审核，已发出的有效邀请仍可接受，已开通用户不受影响。
        </p>
        <button
          type="button"
          className={`btn ${open ? 'btn-danger' : 'btn-primary'}`}
          onClick={async () => {
            const c = await confirm({
              title: open ? '暂停新申请？' : '开放新申请？',
              confirmLabel: open ? '暂停' : '开放',
              danger: open,
            })
            if (
              c.ok &&
              (await run(
                () => api('POST', '/api/admin/settings', { applications_open: !open }),
                open ? '已暂停新申请' : '已开放新申请',
              ))
            )
              d.reload()
          }}
        >
          {open ? '暂停新申请' : '开放新申请'}
        </button>
      </div>
      <div className="wk-box">
        <div className="wk-box-h">
          <h3>申请页文案</h3>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setPreview((p) => !p)}
            aria-pressed={preview}
          >
            {preview ? '返回编辑' : '预览'}
          </button>
        </div>
        {preview ? (
          <div className="wk-box" style={{ background: 'var(--surface-2)' }}>
            <h2 style={{ margin: '0 0 6px' }}>{draft['text.apply_title']}</h2>
            {draft['text.announcement'] && <p className="wk-notice wk-info">{draft['text.announcement']}</p>}
            <p>{open ? draft['text.apply_intro'] : draft['text.apply_paused']}</p>
            <p className="wk-notice wk-ok">提交成功后：{draft['text.apply_success']}</p>
          </div>
        ) : (
          TEXT_KEYS.map(([k, label, rows]) => (
            <label key={k} className="wk-field">
              <span>
                {label}{' '}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setDraft((x) => ({ ...x, [k]: d.data.defaults[k] }))}
                >
                  恢复默认
                </button>
              </span>
              {rows === 1 ? (
                <input
                  value={draft[k] ?? ''}
                  maxLength={600}
                  onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))}
                />
              ) : (
                <textarea
                  rows={rows}
                  value={draft[k] ?? ''}
                  maxLength={1000}
                  onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))}
                />
              )}
            </label>
          ))
        )}
        <button type="button" className="btn btn-primary" onClick={save}>
          保存文案
        </button>
      </div>
      <MailBox />
    </>
  )
}

function MailBox() {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const d = useAsync(() => api<any>('GET', `/api/admin/mail?status=${status}&page=${page}&size=20`), [status, page])
  const { node, run } = useErr()
  const ST: Record<string, [string, string]> = {
    queued: ['排队', ''],
    sending: ['发送中', 'acc'],
    sent: ['已发送', 'ok'],
    failed: ['失败重试中', 'warn'],
    dead: ['放弃', 'bad'],
    held: ['未接通发信', 'warn'],
  }
  return (
    <details className="wk-box" style={{ marginTop: 12 }}>
      <summary>
        <b>用户邮件队列</b> <span className="wk-muted">{d.data && !d.data.configured ? '真实发信未接通' : ''}</span>
      </summary>
      {node}
      <Toolbar>
        <Select
          label="状态"
          value={status}
          onChange={(v) => (setStatus(v), setPage(1))}
          options={[{ v: '', label: '全部' }, ...Object.entries(ST).map(([v, [label]]) => ({ v, label }))]}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => (await run(() => api('POST', '/api/admin/mail/retry', {}), '已重新排队')) && d.reload()}
        >
          重试未发出的邮件
        </button>
      </Toolbar>
      <DataTable
        caption="邮件队列"
        rows={d.data?.rows ?? []}
        rowKey={(r: any) => r.id}
        total={d.data?.total ?? 0}
        page={page}
        size={20}
        onPage={setPage}
        loading={d.loading}
        cols={[
          { key: 'to', label: '收件人', render: (r: any) => r.to_email },
          { key: 'tpl', label: '类型', render: (r: any) => r.template },
          { key: 'st', label: '状态', render: (r: any) => pill(ST, r.status) },
          { key: 'at', label: '时间', render: (r: any) => fmtDate(r.created_at), minor: true },
          {
            key: 'err',
            label: '错误',
            render: (r: any) => <span className="wk-muted">{r.last_error || ''}</span>,
            minor: true,
          },
        ]}
      />
    </details>
  )
}

/* ============================================================= audit */
const AUDIT_GROUPS: { v: string; label: string }[] = [
  { v: '', label: '全部' },
  { v: 'application.', label: '申请' },
  { v: 'invite.', label: '邀请' },
  { v: 'member.', label: '成员' },
  { v: 'pro.', label: 'Pro' },
  { v: 'referral.', label: '推荐' },
  { v: 'appeal.', label: '申诉' },
  { v: 'settings.', label: '设置' },
  { v: 'export.', label: '导出' },
  { v: 'access.', label: 'Access' },
]
function Audit() {
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const [open, setOpen] = useState<any>(null)
  const d = useAsync(
    () =>
      api<any>(
        'GET',
        `/api/admin/audit?action=${encodeURIComponent(action)}&q=${encodeURIComponent(q)}&page=${page}&size=${size}`,
      ),
    [action, q, page, size],
  )
  return (
    <>
      <Toolbar>
        <Select label="类别" value={action} onChange={(v) => (setAction(v), setPage(1))} options={AUDIT_GROUPS} />
        <SearchBox label="搜索操作人或对象" value={q} onChange={(v) => (setQ(v), setPage(1))} />
      </Toolbar>
      <DataTable
        caption="审计日志"
        rows={d.data?.rows ?? []}
        rowKey={(r: any) => String(r.id)}
        total={d.data?.total ?? 0}
        page={page}
        size={size}
        onPage={setPage}
        onSize={setSize}
        loading={d.loading}
        onRow={setOpen}
        cols={[
          { key: 'action', label: '操作', render: (r: any) => <span className="wk-mono">{r.action}</span> },
          { key: 'actor', label: '操作人', render: (r: any) => r.actor },
          {
            key: 'target',
            label: '对象',
            render: (r: any) => <span className="wk-mono">{r.target || '—'}</span>,
            minor: true,
          },
          { key: 'at', label: '时间', render: (r: any) => fmtDate(r.at) },
        ]}
      />
      <Drawer open={!!open} title="审计记录" onClose={() => setOpen(null)}>
        {open && (
          <pre className="wk-mono" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify({ ...open, detail: open.detail ? JSON.parse(open.detail) : null }, null, 2)}
          </pre>
        )}
      </Drawer>
    </>
  )
}
