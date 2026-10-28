import { useEffect, useState } from 'react'
import { aiImageUrl } from '../lib/ai'

/** Pictures saved with an AI chat message (compressed copies), loaded with this account's session. */
export function AiSavedImages({
  images,
  compact,
}: {
  images?: { id: string; w: number; h: number }[]
  compact?: boolean
}) {
  if (!images?.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }} aria-label={`附图 ${images.length} 张`}>
      {images.map((im) => (
        <SavedImage key={im.id} id={im.id} w={im.w} h={im.h} compact={compact} />
      ))}
    </div>
  )
}

function SavedImage({ id, w, h, compact }: { id: string; w: number; h: number; compact?: boolean }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  const [big, setBig] = useState(false)
  useEffect(() => {
    let live = true
    void aiImageUrl(id).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [id])
  const box = compact ? 72 : 120
  const ratio = w && h ? Math.min(box / w, box / h, 1) : 1
  const style = {
    width: Math.max(40, Math.round((w || box) * ratio)),
    height: Math.max(40, Math.round((h || box) * ratio)),
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,.35)',
  }
  if (url === undefined)
    return <div style={{ ...style, background: 'rgba(127,127,127,.12)' }} aria-label="图片加载中" />
  if (url === null)
    return (
      <div
        style={{
          ...style,
          display: 'grid',
          placeItems: 'center',
          fontSize: 11,
          opacity: 0.7,
          textAlign: 'center',
          padding: 4,
        }}
        role="img"
        aria-label="图片已删除或无法加载"
      >
        图片不可用
      </div>
    )
  return (
    <>
      <button
        type="button"
        onClick={() => setBig(true)}
        style={{ padding: 0, border: 0, background: 'none', cursor: 'zoom-in' }}
        aria-label="查看大图"
      >
        <img src={url} alt="附图" style={{ ...style, objectFit: 'cover', display: 'block' }} />
      </button>
      {big && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="附图大图"
          tabIndex={-1}
          onClick={() => setBig(false)}
          onKeyDown={(e) => e.key === 'Escape' && setBig(false)}
          ref={(el) => el?.focus()}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10050,
            background: 'rgba(0,0,0,.82)',
            display: 'grid',
            placeItems: 'center',
            padding: 'max(12px, env(safe-area-inset-top)) 12px',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={url}
            alt="附图大图"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: '#fff' }}
          />
        </div>
      )}
    </>
  )
}
