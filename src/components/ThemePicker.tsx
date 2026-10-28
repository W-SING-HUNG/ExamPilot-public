import { useState } from 'react'
import { useStore } from '../store/StoreContext'
import type { AppSettings } from '../lib/types'

const OPTIONS: { v: AppSettings['theme']; label: string; hint: string }[] = [
  { v: 'light', label: '浅色', hint: '明亮清晰' },
  { v: 'dark', label: '深色', hint: '夜间护眼' },
  { v: 'auto', label: '跟随系统', hint: '随设备切换' },
]

/**
 * Appearance picker: a radio group of three swatch tiles. The swatches are drawn
 * from the CURRENT identity's tokens (Standard blue or Pro champagne), so the
 * preview always matches what the user will get. Saving uses the existing synced
 * `settings.theme` (auto / light / dark), unchanged in shape.
 */
export function ThemePicker({ onError }: { onError?: (msg: string) => void }) {
  const { settings, updateSettings } = useStore()
  const [saving, setSaving] = useState(false)
  const choose = async (theme: AppSettings['theme']) => {
    if (saving || settings.theme === theme) return
    setSaving(true)
    try {
      await updateSettings({ theme })
    } catch {
      onError?.('外观保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="theme-picker" role="radiogroup" aria-label="外观">
      {OPTIONS.map((o) => {
        const on = settings.theme === o.v
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            className={`theme-opt ${on ? 'on' : ''}`}
            disabled={saving}
            onClick={() => void choose(o.v)}
          >
            <span className={`theme-swatch sw-${o.v}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="theme-opt-text">
              <span className="theme-opt-label">{o.label}</span>
              <span className="theme-opt-hint">{o.hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
