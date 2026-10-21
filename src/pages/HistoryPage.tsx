import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { questionById, TYPE_LABEL } from '../lib/bank'
import { db } from '../db/database'
import {
  CardPad,
  PageHead,
  Tag,
  Empty,
  useToast,
  useConfirm,
  useInfiniteList,
  InfiniteSentinel,
  ListFoot,
  SkTable,
  useDeferred,
  type Page as ListPage,
} from '../components/ui'
import type { HistoryEntry } from '../lib/types'

const MODE_LABEL: Record<string, string> = {
  practice: '分章练习',
  special: '专项训练',
  subjective: '主观题训练',
  review: '错题复刷',
  mock: '全真模拟',
  plan: '复习计划',
}

const PAGE_SIZE = 60

/**
 * Read one page of history straight from IndexedDB.
 *
 * Filtering happens in the query rather than over an in-memory copy, so the list
 * can grow without bound: only the requested window is ever materialised. The
 * `submittedAt` index gives a stable newest-first order without a schema change.
 */
async function loadHistoryPage(
  filters: { mode: string; result: string; q: string },
  offset: number,
  limit: number,
): Promise<ListPage<HistoryEntry>> {
  const { mode, result, q } = filters
  const keyword = q.trim()

  // Resolve the keyword to a question-id set first; history rows store only qid.
  let qidFilter: Set<string> | null = null
  if (keyword) {
    const ids = new Set<string>()
    for (const [id, question] of questionById) {
      if (question.stem.includes(keyword) || question.chapter.includes(keyword)) ids.add(id)
    }
    qidFilter = ids
    // A keyword that matches nothing must yield no rows, not all rows.
    if (qidFilter.size === 0) return { items: [], hasMore: false }
  }

  const collected: HistoryEntry[] = []
  let skipped = 0

  // Walk the index newest-first, applying filters, until the requested window
  // is filled. Dexie cannot combine an index order with arbitrary predicates, so
  // the cursor does the filtering and the offset is applied here.
  await db.history
    .orderBy('submittedAt')
    .reverse()
    .until(() => collected.length >= limit)
    .each((h) => {
      if (mode && h.mode !== mode) return
      if (result === 'ok' && h.isCorrect !== true) return
      if (result === 'bad' && h.isCorrect !== false) return
      if (result === 'unscored' && h.isCorrect !== null) return
      if (qidFilter && !qidFilter.has(h.qid)) return
      if (skipped < offset) {
        skipped++
        return
      }
      collected.push(h)
    })

  // A full window means there is probably another page behind it.
  return { items: collected, hasMore: collected.length === limit }
}

export function HistoryPage({ params: _params }: { params: Record<string, string> }) {
  const { records, history, ready, clearHistory } = useStore()
  const { toast, el } = useToast()
  const { confirm, confirmEl } = useConfirm()
  const [mode, setMode] = useState('')
  const [result, setResult] = useState<'' | 'ok' | 'bad' | 'unscored'>('')
  const [q, setQ] = useState('')
  const [clearing, setClearing] = useState(false)

  // The query key drives a full reset of the paged list whenever it changes.
  const queryKey = `${mode}|${result}|${q.trim()}`
  const load = useCallback(
    (offset: number, limit: number) => loadHistoryPage({ mode, result, q }, offset, limit),
    [mode, result, q],
  )
  const list = useInfiniteList<HistoryEntry>(queryKey, load, PAGE_SIZE)
  const showSkeleton = useDeferred(list.loading && list.items.length === 0)

  const modes = useMemo(() => Array.from(new Set(history.map((h) => h.mode))), [history])

  const exportCsv = () => {
    const head = 'time,mode,chapter,type,bankNo,answer,result\n'
    // Export always covers the FULL filtered set, never just the loaded pages, so
    // pagination can never truncate an export.
    const rows = history
      .filter((h) => {
        if (mode && h.mode !== mode) return false
        if (result === 'ok' && h.isCorrect !== true) return false
        if (result === 'bad' && h.isCorrect !== false) return false
        if (result === 'unscored' && h.isCorrect !== null) return false
        if (q.trim()) {
          const qq = questionById.get(h.qid)
          return !!qq && (qq.stem.includes(q.trim()) || qq.chapter.includes(q.trim()))
        }
        return true
      })
      .map((h) => {
        const qq = questionById.get(h.qid)
        const t = new Date(h.submittedAt).toLocaleString('zh-CN', { hour12: false })
        const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
        return [
          esc(t),
          esc(MODE_LABEL[h.mode] ?? h.mode),
          esc(qq?.chapter ?? ''),
          esc(qq ? TYPE_LABEL[qq.type] : ''),
          qq?.bankNo ?? '',
          esc(h.answer ?? ''),
          h.isCorrect === true ? 'correct' : h.isCorrect === false ? 'wrong' : 'unscored',
        ].join(',')
      })
      .join('\n')
    const blob = new Blob(['\ufeff' + head + rows], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `exampilot-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出 CSV')
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="练习历史"
        desc="每一次真实作答的完整记录，可按模式、结果与关键词筛选复盘。滚动可继续加载更早的记录。"
        extra={
          <div className="btn-row">
            <button className="btn" onClick={exportCsv} disabled={history.length === 0}>
              导出 CSV
            </button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                const ok = await confirm({
                  title: '清空全部练习历史？',
                  body: `将删除 ${history.length} 条作答记录。题目练习进度与错题本不受影响，但历史记录无法恢复。`,
                  confirmLabel: '清空历史',
                  danger: true,
                })
                if (!ok) return
                setClearing(true)
                try {
                  // Await the real database write before reporting anything: a
                  // fire-and-forget call would announce success even when the
                  // clear threw.
                  await clearHistory()
                  // The list reads straight from IndexedDB, so it must be
                  // invalidated explicitly — clearing the Store does not touch
                  // the paged copy already on screen.
                  list.reset()
                  toast('历史已清除')
                } catch (e) {
                  toast(`清空失败：${(e as Error).message}。未删除任何记录。`)
                } finally {
                  setClearing(false)
                }
              }}
              disabled={history.length === 0 || clearing}
            >
              {clearing ? '正在清空…' : '清空历史'}
            </button>
          </div>
        }
      />

      <CardPad>
        <div className="row wrap" style={{ gap: 10 }}>
          <label className="sr-only" htmlFor="hist-q">
            搜索题干或章节
          </label>
          <input
            id="hist-q"
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="搜索题干 / 章节关键词"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="sr-only" htmlFor="hist-mode">
            按模式筛选
          </label>
          <select
            id="hist-mode"
            className="select"
            style={{ maxWidth: 160 }}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="">全部模式</option>
            {modes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m] ?? m}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="hist-result">
            按结果筛选
          </label>
          <select
            id="hist-result"
            className="select"
            style={{ maxWidth: 160 }}
            value={result}
            onChange={(e) => setResult(e.target.value as typeof result)}
          >
            <option value="">全部结果</option>
            <option value="ok">仅正确</option>
            <option value="bad">仅错误</option>
            <option value="unscored">仅未评分</option>
          </select>
          <span className="muted-2" style={{ marginLeft: 'auto' }}>
            已载入 {list.items.length} 条 · 总计 {history.length} 条
          </span>
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        {showSkeleton ? (
          <SkTable rows={8} />
        ) : list.error ? (
          <Empty text={`加载失败：${list.error}`}>
            <button className="btn" onClick={() => list.reset()}>
              重试
            </button>
          </Empty>
        ) : list.items.length === 0 ? (
          <Empty text="没有符合条件的记录。" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <caption className="sr-only">练习历史记录，按时间从新到旧</caption>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">模式</th>
                  <th scope="col">章节</th>
                  <th scope="col">题型</th>
                  <th scope="col">题干</th>
                  <th scope="col">你的作答</th>
                  <th scope="col">结果</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((h) => {
                  const qq = questionById.get(h.qid)
                  const r = records.get(h.qid)
                  return (
                    <tr key={h.id} className="list-row">
                      <td className="code" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(h.submittedAt).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                      <td>{MODE_LABEL[h.mode] ?? h.mode}</td>
                      <td>{qq?.chapter ?? '—'}</td>
                      <td>{qq ? TYPE_LABEL[qq.type] : '—'}</td>
                      <td
                        style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={qq?.stem}
                      >
                        {qq ? qq.stem.split('\n')[0] : '（题目已不在题库）'}
                      </td>
                      <td
                        style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={h.answer ?? ''}
                      >
                        {h.answer || '（未作答）'}
                      </td>
                      <td>
                        {h.isCorrect === true ? (
                          <Tag tone="ok">正确</Tag>
                        ) : h.isCorrect === false ? (
                          <Tag tone="bad">错误</Tag>
                        ) : (
                          <Tag tone="warn">未评分</Tag>
                        )}
                        {r && r.attempts > 1 && (
                          <span className="muted-2" style={{ marginLeft: 6 }}>
                            ×{r.attempts}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <InfiniteSentinel onHit={() => void list.loadMore()} disabled={!list.hasMore || list.loading} />
            <ListFoot loading={list.loading && list.items.length > 0} done={!list.hasMore} />
          </div>
        )}
      </CardPad>
      {el}
      {confirmEl}
    </>
  )
}
