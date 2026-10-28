import { useState, type CSSProperties, type ReactNode } from 'react'
import { IS_WEB_EDITION } from '../lib/edition'

/**
 * Container for a row of chapter buttons.
 *
 * Desktop edition: unchanged horizontal pill strip.
 * Web edition: every chapter is laid out in a wrapping grid so all of them are
 * visible at once on a phone (a horizontal strip showed ~3 chapters and looked
 * like the whole list). A header states how many chapters exist and what is
 * selected, and the grid can be collapsed. Only layout changes: the buttons and
 * their click handlers are passed in untouched.
 */
export function ChapterPicker({
  children,
  total,
  summary,
  legacyClassName = 'pill-scroll has-fade',
  style,
}: {
  children: ReactNode
  total: number
  summary: string
  legacyClassName?: string
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(true)
  if (!IS_WEB_EDITION) {
    return (
      <div className={legacyClassName} style={style}>
        {children}
      </div>
    )
  }
  return (
    <div className="chapter-picker" style={style}>
      <div className="chapter-picker-head">
        <span className="muted-2">
          共 {total} 章 · {summary}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '收起章节' : `展开全部 ${total} 章`}
        </button>
      </div>
      {open && (
        <div className="chapter-grid" role="group" aria-label="章节选择">
          {children}
        </div>
      )}
    </div>
  )
}
