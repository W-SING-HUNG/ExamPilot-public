/* eslint-disable @typescript-eslint/no-explicit-any -- admin/account API JSON is rendered as-is; the Worker is the source of truth */
/** 个人中心 panels backed by /api/me/*: my referral link + self-close. */
import { useState } from 'react'
import { api, DataTable, Empty, fmtDate, Loading, Notice, useAsync, useConfirm } from './kit'

const ST: Record<string, [string, string]> = {
  applied: ['已申请', ''],
  approved: ['已通过，待首次登录', 'acc'],
  rejected: ['未通过', 'bad'],
  rewarded: ['已发奖', 'ok'],
  held: ['奖励复核中', 'warn'],
  void: ['奖励无效', 'bad'],
}

export function ReferralPanel() {
  const d = useAsync(() => api<any>('GET', '/api/me/referral'), [])
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [dlg, confirm] = useConfirm()
  if (!d.data) return d.error ? <Notice tone="bad">{d.error}</Notice> : <Loading />
  const r = d.data
  const link = r.link
  const act = async (action: string, ok: string) => {
    try {
      await api('POST', '/api/me/referral', { action })
      setMsg({ tone: 'ok', text: ok })
      d.reload()
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message })
    }
  }
  return (
    <>
      {dlg}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="wk-kpis">
        <div className="wk-kpi">
          <b>{r.total}</b>
          <span>推荐总数</span>
        </div>
        <div className="wk-kpi">
          <b>{r.success}</b>
          <span>成功推荐</span>
        </div>
        <div className="wk-kpi">
          <b>{r.rewardDays}</b>
          <span>获得的 Pro 天数</span>
        </div>
      </div>
      <div className="wk-box" style={{ marginBottom: 12 }}>
        <div className="wk-box-h">
          <h3>我的推荐链接</h3>
          <span className={`wk-pill ${link?.status === 'active' ? 'ok' : 'warn'}`}>
            {link?.status === 'active' ? '可用' : '已暂停'}
          </span>
        </div>
        <p className="wk-muted">
          每成功推荐 1 位同学（通过审核并首次登录），你获得 7 天 Pro，没有上限。链接不含你的邮箱或账号信息。
        </p>
        <div className="wk-actions" style={{ alignItems: 'center' }}>
          <input
            readOnly
            value={link?.url || ''}
            aria-label="推荐链接"
            className="wk-mono"
            style={{
              flex: '1 1 260px',
              minHeight: 40,
              padding: '8px 10px',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              background: 'var(--surface-2)',
              color: 'var(--text)',
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={link?.status !== 'active'}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link.url)
                setMsg({ tone: 'ok', text: '已复制推荐链接' })
              } catch {
                setMsg({ tone: 'bad', text: '复制失败，请长按链接手动复制' })
              }
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              act(
                link?.status === 'active' ? 'pause' : 'resume',
                link?.status === 'active' ? '链接已暂停' : '链接已恢复',
              )
            }
          >
            {link?.status === 'active' ? '暂停链接' : '恢复链接'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              const c = await confirm({
                title: '重新生成推荐链接？',
                body: '旧链接立即失效；已经提交的申请和已发放的奖励不受影响。',
                confirmLabel: '重新生成',
              })
              if (c.ok) act('regenerate', '已生成新链接，旧链接已失效')
            }}
          >
            重新生成
          </button>
        </div>
      </div>
      <DataTable
        caption="推荐记录"
        rows={r.list}
        rowKey={(x: any) => x.id}
        empty={<Empty title="还没有人通过你的链接申请" />}
        cols={[
          { key: 'who', label: '同学（已脱敏）', render: (x: any) => <span className="wk-mono">{x.who}</span> },
          {
            key: 'at',
            label: '申请日期',
            render: (x: any) => fmtDate(x.appliedAt, false),
            sort: (x: any) => x.appliedAt,
          },
          { key: 'review', label: '审核', render: (x: any) => x.review },
          {
            key: 'st',
            label: '奖励',
            render: (x: any) => (
              <span className={`wk-pill ${ST[x.status]?.[1] ?? ''}`}>
                {x.reward?.days ? `+${x.reward.days} 天 Pro` : (ST[x.status]?.[0] ?? x.status)}
              </span>
            ),
          },
          {
            key: 'appeal',
            label: '',
            render: (x: any) =>
              x.canAppeal ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    const c = await confirm({
                      title: '对这笔奖励的处理提出申诉',
                      body: '每条记录只能申诉一次。',
                      reason: 'required',
                      reasonLabel: '申诉理由',
                      confirmLabel: '提交申诉',
                    })
                    if (!c.ok) return
                    try {
                      await api('POST', '/api/me/appeal', { referralId: x.id, text: c.reason })
                      setMsg({ tone: 'ok', text: '申诉已提交，管理员处理后结果会显示在这里' })
                      d.reload()
                    } catch (e) {
                      setMsg({ tone: 'bad', text: (e as Error).message })
                    }
                  }}
                >
                  申诉
                </button>
              ) : x.appeal ? (
                <span className="wk-muted">
                  申诉{x.appeal === 'open' ? '处理中' : x.appeal === 'upheld' ? '已成立' : '已驳回'}
                </span>
              ) : null,
          },
        ]}
      />
      <p className="wk-muted" style={{ marginTop: 8 }}>
        你只能看到同学的脱敏邮箱、申请日期和审核结果，看不到申请理由或审核备注。
      </p>
    </>
  )
}

export function CloseAccountPanel({ email }: { email: string }) {
  const [step, setStep] = useState<'idle' | 'code' | 'done'>('idle')
  const [code, setCode] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null)
  const [done, setDone] = useState<any>(null)
  return (
    <div className="wk-danger-zone" style={{ marginTop: 14 }}>
      <h3>注销账号</h3>
      <p style={{ margin: '0 0 8px' }}>
        注销后账号立即停用，进入 7 天冷静期。冷静期内可以在欢迎页验证邮箱撤销注销；期满后学习记录、错题、复习、模考和 AI
        历史会被删除。
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {step === 'idle' && (
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api('POST', '/api/me/close/start', {})
              setStep('code')
              setMsg({ tone: 'info', text: `验证码已发送到 ${email}（10 分钟内有效）` })
            } catch (e) {
              setMsg({ tone: 'bad', text: (e as Error).message })
            } finally {
              setBusy(false)
            }
          }}
        >
          开始注销（验证邮箱）
        </button>
      )}
      {step === 'code' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              const r = await api<any>('POST', '/api/me/close/confirm', { code, confirm: typed.trim() })
              setDone(r)
              setStep('done')
              setMsg(null)
            } catch (err) {
              setMsg({ tone: 'bad', text: (err as Error).message })
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="wk-field">
            邮箱验证码
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="wk-field">
            输入「注销」确认
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          <div className="wk-actions">
            <button type="button" className="btn btn-sm" onClick={() => (setStep('idle'), setMsg(null))}>
              取消
            </button>
            <button
              type="submit"
              className="btn btn-danger btn-sm"
              disabled={busy || !/^\d{6}$/.test(code.trim()) || typed.trim() !== '注销'}
            >
              确认注销
            </button>
          </div>
        </form>
      )}
      {step === 'done' && done && (
        <Notice tone="warn">
          账号已停用，{fmtDate(done.deleteAfter)} 后删除数据。改变主意的话，在此之前打开 {done.restoreUrl}{' '}
          验证邮箱即可撤销。
        </Notice>
      )}
    </div>
  )
}
