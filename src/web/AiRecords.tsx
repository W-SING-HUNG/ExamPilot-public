/**
 * AI 记录 (web): search, date range, paged list, detail drawer.
 * Pro: "继续对话" opens the assistant. Standard (Pro ended): read-only history —
 * nothing here can send a new question (and the Worker refuses it anyway).
 */
import { AiSavedImages } from '../components/AiSavedImages'
import { useMemo, useState } from 'react'
import { PageHead, Tag } from '../components/ui'
import { useStore } from '../store/StoreContext'
import { useSync } from '../sync/CloudStore'
import { questionById } from '../lib/bank'
import { openFloatingAiConversation } from '../components/FloatingAiAssistant'
import { useAiAccess } from '../lib/ai-access'
import {
  DataTable,
  Drawer,
  Empty,
  fmtDate,
  Notice,
  SearchBox,
  Segmented,
  TabPanel,
  Tabs,
  Toolbar,
  useConfirm,
} from './kit'

const DAY = 86_400_000

export function AiRecords() {
  const sync = useSync()
  const { aiReviews } = useStore()
  const access = useAiAccess()
  const canUse = access.state === 'granted'
  const [tab, setTab] = useState('chats')
  const [q, setQ] = useState('')
  const [range, setRange] = useState<'7' | '30' | 'all'>('all')
  const [openChat, setOpenChat] = useState<string | null>(null)
  const [openReview, setOpenReview] = useState<string | null>(null)
  const [dlg, confirm] = useConfirm()
  const chats = sync?.aiChats ?? []
  const since = range === 'all' ? 0 : Date.now() - Number(range) * DAY
  const needle = q.trim().toLowerCase()
  const chatRows = useMemo(
    () =>
      chats
        .filter((c) => c.updatedAt >= since)
        .filter(
          (c) =>
            !needle ||
            c.title.toLowerCase().includes(needle) ||
            c.messages.some((m) => m.content.toLowerCase().includes(needle)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [chats, since, needle],
  )
  const reviewRows = useMemo(
    () =>
      aiReviews
        .filter((r) => r.createdAt >= since)
        .filter((r) => {
          if (!needle) return true
          const qq = questionById.get(r.qid)
          return (qq?.stem || '').toLowerCase().includes(needle) || (r.userAnswer || '').toLowerCase().includes(needle)
        })
        .sort((a, b) => b.createdAt - a.createdAt),
    [aiReviews, since, needle],
  )
  const chat = chats.find((c) => c.id === openChat)
  const review = aiReviews.find((r) => r.id === openReview)

  return (
    <>
      {dlg}
      <PageHead
        title="AI 记录"
        desc="你的 AI 对话和主观题参考评阅，保存在你的账号里，在你的设备之间同步；其他账号看不到。"
      />
      {!canUse && (
        <Notice tone="warn">
          {access.pro?.suspended ? 'Pro 已被暂停' : '你当前是 Standard'}
          ：历史记录可以只读查看，不能发送新问题、追问、联网搜索或识别新图片。重新开通 Pro 后恢复全部功能。
        </Notice>
      )}
      <Tabs
        label="记录类别"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'chats', label: `AI 对话（${chats.length}）` },
          { id: 'reviews', label: `参考评阅（${aiReviews.length}）` },
        ]}
      />
      <Toolbar>
        <SearchBox label="搜索标题或内容" value={q} onChange={setQ} />
        <Segmented
          label="时间"
          value={range}
          onChange={setRange}
          options={[
            { v: '7', label: '7 天' },
            { v: '30', label: '30 天' },
            { v: 'all', label: '全部' },
          ]}
        />
      </Toolbar>
      <TabPanel id={tab}>
        {tab === 'chats' ? (
          <DataTable
            caption="AI 对话"
            rows={chatRows}
            rowKey={(c) => c.id}
            onRow={(c) => setOpenChat(c.id)}
            empty={<Empty title={chats.length ? '没有符合条件的对话' : '还没有 AI 对话'} />}
            cols={[
              {
                key: 'title',
                label: '对话',
                render: (c) => (
                  <>
                    {c.kind === 'question' && <Tag tone="accent">题目答疑</Tag>} {c.title || '（无标题）'}
                  </>
                ),
                sort: (c) => c.title,
              },
              {
                key: 'n',
                label: '消息',
                render: (c) => c.messages.length,
                sort: (c) => c.messages.length,
                align: 'right',
              },
              { key: 'at', label: '最近更新', render: (c) => fmtDate(c.updatedAt), sort: (c) => c.updatedAt },
            ]}
          />
        ) : (
          <DataTable
            caption="参考评阅"
            rows={reviewRows}
            rowKey={(r) => r.id}
            onRow={(r) => setOpenReview(r.id)}
            empty={<Empty title={aiReviews.length ? '没有符合条件的评阅' : '还没有 AI 评阅记录'} />}
            cols={[
              {
                key: 'q',
                label: '题目',
                render: (r) => questionById.get(r.qid)?.stem.split('\n')[0].slice(0, 50) ?? '（题目已不在题库）',
              },
              {
                key: 's',
                label: '参考分',
                render: (r) => `${r.result.score}/${r.result.maxScore}`,
                sort: (r) => r.result.score / (r.result.maxScore || 1),
                align: 'right',
              },
              { key: 'at', label: '时间', render: (r) => fmtDate(r.createdAt), sort: (r) => r.createdAt },
            ]}
          />
        )}
      </TabPanel>

      <Drawer
        open={!!chat}
        title={chat?.title || 'AI 对话'}
        onClose={() => setOpenChat(null)}
        footer={
          chat && (
            <>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  const r = await confirm({
                    title: '删除这个 AI 对话？',
                    body: '会从你所有登录的设备上移除，无法恢复。',
                    danger: true,
                    confirmLabel: '删除',
                  })
                  if (r.ok) {
                    await sync?.aiChat.deleteConv(chat.id)
                    setOpenChat(null)
                  }
                }}
              >
                删除
              </button>
              {canUse && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setOpenChat(null)
                    openFloatingAiConversation(chat.id)
                  }}
                >
                  在助手中继续
                </button>
              )}
            </>
          )
        }
      >
        {chat && (
          <div className="ai-readonly-thread">
            <p className="wk-muted">
              {fmtDate(chat.updatedAt)} · {chat.messages.length} 条消息{!canUse ? ' · 只读' : ''}
            </p>
            {chat.messages.map((m, i) => (
              <div
                key={i}
                className={`wk-box`}
                style={{ marginBottom: 8, background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--surface)' }}
              >
                <div className="wk-muted">{m.role === 'user' ? '我' : 'AI'}</div>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {m.content ||
                    (m.status === 'error' ? '（回答未完成）' : m.status === 'cancelled' ? '（已停止）' : '')}
                </div>
                <AiSavedImages images={m.images} />
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer open={!!review} title="参考评阅" onClose={() => setOpenReview(null)}>
        {review && (
          <>
            <p>
              <b>{review.result.score}</b>/{review.result.maxScore} 参考分 ·{' '}
              <span className="wk-muted">{fmtDate(review.createdAt)}</span>
            </p>
            <div className="explain" style={{ whiteSpace: 'pre-wrap' }}>
              <b>题目：</b>
              {questionById.get(review.qid)?.stem ?? '（题目已不在题库）'}
            </div>
            <div className="explain" style={{ whiteSpace: 'pre-wrap' }}>
              <b>你的作答：</b>
              {review.userAnswer || '（空）'}
            </div>
            {(
              [
                ['命中的采分点', review.result.hitPoints, 'ok'],
                ['遗漏内容', review.result.missedPoints, 'bad'],
                ['扣分依据', review.result.deductions, 'warn'],
                ['修改建议', review.result.suggestions, 'accent'],
              ] as const
            ).map(([t, items, tone]) =>
              items.length ? (
                <div key={t} style={{ marginTop: 8 }}>
                  <Tag tone={tone}>{t}</Tag>
                  <ul>
                    {items.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {review.result.structureNote && <div className="explain">结构点评：{review.result.structureNote}</div>}
            <p className="wk-muted">{review.result.disclaimer || 'AI 评阅仅为参考评阅，非官方标准分数。'}</p>
          </>
        )}
      </Drawer>
    </>
  )
}
