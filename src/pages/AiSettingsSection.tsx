import { useEffect, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { aiStatus, type AiStatusResponse } from '../lib/ai'
import { CardPad, Tag, useToast } from '../components/ui'

/**
 * AI 网关配置 — the section that used to be the standalone AI 助手 page.
 *
 * Everything the old page could do is preserved here: gateway status check,
 * base URL / model / API key / timeout configuration, capability description,
 * and the AI review history table. Only the page chrome and its sidebar entry
 * are gone, because the daily AI entry points are the floating assistant and the
 * in-question button, not this configuration screen.
 */
export function AiSettingsSection() {
  const { aiReviews, ready } = useStore()
  const { toast, el } = useToast()
  const [status, setStatus] = useState<AiStatusResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [form, setForm] = useState({ baseUrl: '', apiKey: '', model: '', timeoutMs: 60000 })
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const check = async () => {
    setChecking(true)
    const s = await aiStatus()
    setStatus(s)
    if (s && s.configured) {
      setForm((f) => ({
        baseUrl: s.baseUrl || f.baseUrl || '',
        model: s.model || f.model || '',
        timeoutMs: s.timeoutMs || f.timeoutMs || 60000,
        // 如果后端已有 key，前台若用户未手动输入则保持空白，仅显示提示信息
        apiKey: f.apiKey,
      }))
    }
    setChecking(false)
  }

  useEffect(() => {
    void check()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      // The dev proxy answers 503 JSON when the AI server is not running, and the
      // server answers 403 when the origin is not trusted. Both used to surface as
      // a bare "Failed to fetch" or a misleading toast; report what actually
      // happened so the user can act on it.
      const raw = await res.text()
      let data: { ok?: boolean; message?: string } | null = null
      try {
        data = JSON.parse(raw)
      } catch {
        data = null
      }
      if (!data) {
        toast(`保存失败：服务端返回了非 JSON 响应（HTTP ${res.status}）。请确认 AI 服务端已启动：npm run server`)
        return
      }
      if (!res.ok || data.ok === false) {
        // 403 here means this page's Origin is not on the server allowlist. Say so
        // explicitly: the remedy is a server-side opt-in, not "restart the server".
        if (res.status === 403) {
          toast(
            '保存失败：当前页面来源未被 AI 服务端信任。默认只允许 http://localhost:5173；如需使用其他端口，请用 AI_ALLOWED_ORIGINS 显式加入。',
          )
          return
        }
        toast(`保存失败：${data.message ?? `HTTP ${res.status}`}`)
        return
      }
      toast(data.message ?? '已保存')
      await check()
    } catch (e) {
      // Only a genuine transport failure lands here (server down, connection reset).
      const msg = (e as Error).message
      toast(`保存失败：无法连接 AI 服务端（${msg}）。请先运行 npm run server，或直接使用 npm run dev 一并启动。`)
    } finally {
      setSaving(false)
    }
  }

  if (!ready) return null

  return (
    <>
      <CardPad style={{ marginTop: 14 }}>
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div className="card-title" style={{ margin: 0 }}>
            AI 网关
          </div>
          <button className="btn btn-sm" onClick={check} disabled={checking}>
            {checking ? '检测中…' : '重新检测'}
          </button>
        </div>
        {status ? (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <Tag tone={status.configured ? 'ok' : 'warn'}>{status.configured ? '已配置' : '未配置'}</Tag>
              {status.model && <Tag>{status.model}</Tag>}
              {status.baseUrl && <Tag tone="accent">接口地址：{status.baseUrl}</Tag>}
            </div>
            <div className="muted">{status.message}</div>
          </>
        ) : (
          <div className="muted">正在检测…</div>
        )}
        <div className="muted-2" style={{ marginTop: 8 }}>
          AI 不可用时，刷题、评分与本地记录照常工作。密钥仅保存在服务端配置文件中，前端不接触密钥。
        </div>

        <div className="divider" />
        <div className="btn-row">
          <button className="btn btn-sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起网关配置' : '修改网关配置'}
          </button>
          {aiReviews.length > 0 && <span className="muted-2">AI 参考评阅记录 {aiReviews.length} 条</span>}
        </div>

        {expanded && (
          <div style={{ marginTop: 12 }}>
            <div className="grid grid-2">
              <label className="field">
                <span className="field-label">Base URL（OpenAI 兼容）</span>
                <input
                  className="input"
                  placeholder="https://your-sub2api-host/v1"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                />
              </label>
              <label className="field">
                <span className="field-label">模型名称</span>
                <input
                  className="input"
                  placeholder="例如 gpt-4o-mini / deepseek-chat"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                />
              </label>
              <label className="field">
                <span className="field-label">
                  API Key（仅写入服务端配置文件，不进入前端）
                  {status?.hasKey && (
                    <span style={{ color: 'var(--ok)', marginLeft: 8 }}>
                      已配置：{status.maskedKey}（如不修改可留空）
                    </span>
                  )}
                </span>
                <input
                  className="input"
                  type="password"
                  placeholder={status?.hasKey ? `保持原密钥不变 (${status.maskedKey})` : 'sk-...'}
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                />
              </label>
              <label className="field">
                <span className="field-label">超时（毫秒）</span>
                <input
                  className="input"
                  type="number"
                  min={5000}
                  max={300000}
                  value={form.timeoutMs}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Number(e.target.value) || 60000 }))}
                />
              </label>
            </div>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存配置'}
            </button>
            <div className="muted-2" style={{ marginTop: 10 }}>
              服务端代理需单独启动：<span className="code">npm run server</span>（默认 http://127.0.0.1:8787）。
              开发模式下 Vite 已将 <span className="code">/api</span> 代理到该端口，也可通过环境变量
              <span className="code">AI_BASE_URL</span> / <span className="code">AI_API_KEY</span> /{' '}
              <span className="code">AI_MODEL</span> 配置。
            </div>
          </div>
        )}

        {aiReviews.length > 0 && (
          <>
            <div className="divider" />
            <div className="card-title">AI 评阅记录</div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>题目</th>
                    <th>参考分</th>
                    <th>命中</th>
                    <th>遗漏</th>
                  </tr>
                </thead>
                <tbody>
                  {aiReviews.slice(0, 20).map((r) => (
                    <tr key={r.id}>
                      <td className="code" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                      <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.userAnswer.slice(0, 30) || '（空）'}
                      </td>
                      <td>
                        <b>{r.result.score}</b>/{r.result.maxScore}
                      </td>
                      <td>{r.result.hitPoints.length}</td>
                      <td>{r.result.missedPoints.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted-2" style={{ marginTop: 8 }}>
              AI 评阅均为参考评阅，非官方标准分数。
            </div>
          </>
        )}
      </CardPad>
      {el}
    </>
  )
}
