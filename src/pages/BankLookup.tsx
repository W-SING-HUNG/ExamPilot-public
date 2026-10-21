import { useCallback, useMemo, useState } from 'react'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import {
  CardPad,
  Tag,
  Empty,
  InfiniteSentinel,
  ListFoot,
  SkList,
  useDeferred,
  useInfiniteList,
  type Page as ListPage,
} from '../components/ui'
import { answerText } from '../lib/scoring'
import type { Question, QuestionType } from '../lib/types'

const PAGE_SIZE = 40

/**
 * 题库查阅 — read-only bank browser.
 *
 * Deliberately has NO store access and no submit path: browsing can never write
 * an attempt, touch history, or move the scheduling state. It is embedded in
 * 自由刷题 under the 查阅题库 view rather than being its own sidebar entry.
 */
export function BankLookup() {
  const [chapter, setChapter] = useState('')
  const [type, setType] = useState<QuestionType | ''>('')
  const [kw, setKw] = useState('')
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let list = allQuestions
    if (chapter) list = list.filter((q) => q.chapter === chapter)
    if (type) list = list.filter((q) => q.type === type)
    if (onlyFlagged) list = list.filter((q) => q.isFlagged)
    if (kw.trim()) {
      const k = kw.trim()
      list = list.filter((q) => q.stem.includes(k) || q.options.some((o) => o.includes(k)) || q.answer?.includes(k))
    }
    return list
  }, [chapter, type, kw, onlyFlagged])

  // Pagination pages over the filtered array rather than hiding rows: only the
  // visible window is mounted, so a 1000-question bank stays responsive on a
  // phone. The query key resets the list whenever a filter changes.
  const queryKey = `${chapter}|${type}|${kw.trim()}|${onlyFlagged}`
  const load = useCallback(
    (offset: number, limit: number): Promise<ListPage<Question>> => {
      const slice = filtered.slice(offset, offset + limit)
      return Promise.resolve({ items: slice, hasMore: offset + limit < filtered.length })
    },
    [filtered],
  )
  const list = useInfiniteList<Question>(queryKey, load, PAGE_SIZE)
  const showSkeleton = useDeferred(list.loading && list.items.length === 0)

  return (
    <>
      <div className="callout" style={{ marginBottom: 14 }}>
        只读查阅：这里的浏览不会产生作答记录，也不会改变覆盖率、正确率或复习进度。完整题库含 PDF
        页码追溯，原题干、原选项、原答案均保持题库原样。
      </div>

      <CardPad>
        <div className="card-title">检索条件</div>
        <div className="row wrap" style={{ gap: 10 }}>
          <label className="sr-only" htmlFor="bank-kw">
            搜索题干、选项或答案
          </label>
          <input
            id="bank-kw"
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="搜索题干 / 选项 / 答案"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
          />
          <label className="sr-only" htmlFor="bank-chapter">
            按章节筛选
          </label>
          <select
            id="bank-chapter"
            className="select"
            style={{ maxWidth: 180 }}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
          >
            <option value="">全部章节</option>
            {chapterOrder.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="bank-type">
            按题型筛选
          </label>
          <select
            id="bank-type"
            className="select"
            style={{ maxWidth: 160 }}
            value={type}
            onChange={(e) => setType(e.target.value as QuestionType | '')}
          >
            <option value="">全部题型</option>
            <option value="single">单选题</option>
            <option value="multi">多选题</option>
            <option value="judge">判断题</option>
            <option value="short">简答题</option>
            <option value="material">材料分析题</option>
          </select>
          <label className="row" style={{ gap: 8, fontSize: 13, minHeight: 36 }}>
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            仅看待校验标记
          </label>
          <span className="muted-2" style={{ marginLeft: 'auto' }}>
            共 {filtered.length} 题
          </span>
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        {showSkeleton ? (
          <SkList rows={6} h={64} />
        ) : list.error ? (
          <Empty text={`加载失败：${list.error}`}>
            <button className="btn" onClick={() => list.reset()}>
              重试
            </button>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty text="没有符合条件的题目。" />
        ) : (
          <div className="infinite-list">
            {list.items.map((q) => (
              <BankRow
                key={q.id}
                q={q}
                open={expanded === q.id}
                onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
              />
            ))}
            <InfiniteSentinel onHit={() => void list.loadMore()} disabled={!list.hasMore || list.loading} />
            <ListFoot loading={list.loading && list.items.length > 0} done={!list.hasMore} />
          </div>
        )}
      </CardPad>
    </>
  )
}

function BankRow({ q, open, onToggle }: { q: Question; open: boolean; onToggle: () => void }) {
  return (
    <div className="card card-pad list-row" style={{ boxShadow: 'none' }}>
      <button
        type="button"
        className="row-between"
        style={{
          background: 'none',
          border: 'none',
          width: '100%',
          textAlign: 'left',
          padding: 0,
          minHeight: 32,
          cursor: 'pointer',
        }}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Tag tone="accent">{TYPE_LABEL[q.type]}</Tag>
          <Tag>{q.chapter}</Tag>
          <span className="code">{q.bankNo}</span>
          {q.pageStart && <span className="muted-2">P{q.pageStart}</span>}
          {q.isFlagged && <Tag tone="warn">待校验</Tag>}
        </span>
        <span className="muted-2">{open ? '收起' : '展开'}</span>
      </button>
      <div className="q-stem" style={{ fontSize: 14.5, marginTop: 6 }}>
        {q.stem.split('\n')[0]}
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {q.options.length > 0 && (
            <ol style={{ margin: '0 0 10px', paddingLeft: 22, fontSize: 14, lineHeight: 1.9 }}>
              {q.options.map((o, i) => (
                <li
                  key={i}
                  style={{
                    fontWeight: q.answerNorm && String(q.answerNorm).includes(String.fromCharCode(65 + i)) ? 700 : 400,
                  }}
                >
                  {o}
                </li>
              ))}
            </ol>
          )}
          <div className="explain">
            <div>
              <b>答案：</b>
              {q.hasOfficialAnswer ? answerText(q) : '（题库未提供标准答案）'}
            </div>
            {q.flagReason && <div className="muted-2">校验说明：{q.flagReason}</div>}
            <div className="muted-2">
              ID: {q.id} · 来源 PDF 第 {q.pageStart ?? '?'}
              {q.pageEnd && q.pageEnd !== q.pageStart ? `–${q.pageEnd}` : ''} 页
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
