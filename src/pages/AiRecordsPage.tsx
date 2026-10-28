import { useMemo, useState } from 'react'
import { CardPad, Empty, PageHead, Tag, useConfirm } from '../components/ui'
import { useStore } from '../store/StoreContext'
import { useSync } from '../sync/CloudStore'
import { questionById } from '../lib/bank'
import { openFloatingAiConversation } from '../components/FloatingAiAssistant'
import { useAiAccess } from '../lib/ai-access'

/**
 * Web edition, AI-permitted accounts only: this account's AI conversations and
 * AI reference reviews. Everything shown here is synced across the account's
 * devices and never visible to other accounts.
 */
export function AiRecordsPage() {
  const sync = useSync()
  const { aiReviews } = useStore()
  const access = useAiAccess()
  const { confirm, confirmEl } = useConfirm()
  const [openReview, setOpenReview] = useState<string | null>(null)
  const chats = sync?.aiChats ?? []
  const reviews = useMemo(() => aiReviews.slice(0, 200), [aiReviews])

  return (
    <>
      <PageHead
        title="AI 记录"
        desc="你的 AI 对话与主观题参考评阅，保存在你的账号中，在你登录的设备之间同步；其他账号看不到。"
      />

      {!access.configured && (
        <div className="result-banner warn" style={{ marginBottom: 12 }}>
          AI 服务暂时不可用（管理员尚未完成网关配置）。历史记录仍可查看。
        </div>
      )}

      <CardPad>
        <div className="card-title">AI 对话（{chats.length}）</div>
        {chats.length === 0 ? (
          <Empty text="还没有 AI 对话。做题时点题卡上的 AI 答疑，或打开右下角的 AI 助手提问。" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {chats.map((c) => {
              const last = c.messages[c.messages.length - 1]
              const unfinished = c.messages.some((m) => m.status !== 'done' && m.role === 'assistant')
              return (
                <div key={c.id} className="list-row ai-record-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="ai-record-title">
                      {c.kind === 'question' && <Tag tone="accent">题目答疑</Tag>} {c.title}
                    </div>
                    <div className="muted-2">
                      {new Date(c.updatedAt).toLocaleString('zh-CN', { hour12: false })} · {c.messages.length} 条消息
                      {unfinished ? ' · 含未完成的回答' : ''}
                    </div>
                    {last && (
                      <div className="muted ai-record-snippet">
                        {last.role === 'user' ? '我：' : 'AI：'}
                        {recordSnippet(last)}
                      </div>
                    )}
                  </div>
                  <div className="btn-row" style={{ flexShrink: 0 }}>
                    <button className="btn btn-sm btn-primary" onClick={() => openFloatingAiConversation(c.id)}>
                      打开
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        const ok = await confirm({
                          title: '删除这个 AI 对话？',
                          body: '删除后会从你所有登录的设备上移除，无法恢复。',
                          confirmLabel: '删除',
                          danger: true,
                        })
                        if (ok) await sync?.aiChat.deleteConv(c.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardPad>

      <CardPad>
        <div className="card-title">主观题 AI 参考评阅（{aiReviews.length}）</div>
        {reviews.length === 0 ? (
          <Empty text="还没有 AI 评阅记录。主观题提交后，可点「提交 AI 评阅」获得参考评阅。" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {reviews.map((r) => {
              const q = questionById.get(r.qid)
              const open = openReview === r.id
              return (
                <div key={r.id} className="list-row" style={{ display: 'block' }}>
                  <button
                    className="ai-record-head"
                    aria-expanded={open}
                    onClick={() => setOpenReview(open ? null : r.id)}
                  >
                    <span className="ai-record-title">
                      {q ? q.stem.split('\n')[0].slice(0, 60) : '（题目已不在题库）'}
                    </span>
                    <span>
                      <b>{r.result.score}</b>/{r.result.maxScore} <span className="muted-2">参考分</span>
                    </span>
                  </button>
                  <div className="muted-2">
                    {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    {r.model ? ` · 模型 ${r.model}` : ''}
                  </div>
                  {open && (
                    <div className="col" style={{ gap: 8, marginTop: 8 }}>
                      <div className="explain">
                        <b>你的作答：</b>
                        {r.userAnswer || '（空）'}
                      </div>
                      <ReviewList title="命中的采分点" items={r.result.hitPoints} tone="ok" />
                      <ReviewList title="遗漏内容" items={r.result.missedPoints} tone="bad" />
                      <ReviewList title="扣分依据" items={r.result.deductions} tone="warn" />
                      <ReviewList title="修改建议" items={r.result.suggestions} tone="accent" />
                      {r.result.structureNote && <div className="explain">结构点评：{r.result.structureNote}</div>}
                      <div className="muted-2">{r.result.disclaimer || 'AI 评阅仅为参考评阅，非官方标准分数。'}</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="muted-2" style={{ marginTop: 8 }}>
          AI 评阅均为参考评阅，非官方标准答案或考试分数。
        </div>
      </CardPad>

      <div className="muted-2" style={{ marginTop: 12 }}>
        数据说明：提问时只把当前对话内容（以及你主动发送的题目信息）发给 AI
        服务，不包含你的邮箱、其他学习记录或其他人的数据。
      </div>
      {confirmEl}
    </>
  )
}

function ReviewList({
  title,
  items,
  tone,
}: {
  title: string
  items: string[]
  tone: 'ok' | 'bad' | 'warn' | 'accent'
}) {
  if (!items.length) return null
  return (
    <div>
      <Tag tone={tone}>{title}</Tag>
      <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One-line preview of a conversation's last message. An assistant reply that is
 * still being written (or was stopped before any text arrived) has empty content;
 * say what is happening instead of "无内容", which read as data loss.
 */
function recordSnippet(m: { role: string; content: string; status?: string }): string {
  const text = m.content.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (m.role !== 'assistant') return text || '（空消息）'
  if (m.status === 'generating') return text ? text + '…（正在生成）' : '正在生成回答…'
  if (m.status === 'cancelled') return text ? text + '…（已停止）' : '回答已停止，未生成内容'
  if (m.status === 'error') return text ? text + '…（未完成）' : '回答未完成（出错），可打开后重试'
  return text || '（空回答）'
}
