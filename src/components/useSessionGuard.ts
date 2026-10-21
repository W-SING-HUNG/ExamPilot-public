import { useEffect, useState } from 'react'
import { getActiveSession, subscribeActiveSession } from '../store/session-guard'
import { useConfirm } from './ui'

/**
 * Leaves-guard for the running session.
 *
 * The router is a bare hash listener, so there is no navigation hook to cancel
 * mid-flight. The guard therefore covers the two moments that matter:
 *
 *  - `beforeunload`, for reload / tab close (browser-native prompt);
 *  - `confirmLeave()`, which navigation controls call before routing so the app
 *    can show its own dialog instead of a silent discard.
 */
export function useSessionGuard() {
  const { confirm, confirmEl } = useConfirm()

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!getActiveSession()) return
      e.preventDefault()
      // Browsers ignore the custom string; returning a value is what triggers
      // the prompt.
      e.returnValue = '当前答题会话尚未完成，确定离开吗？'
      return e.returnValue
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  /**
   * Ask before discarding a live session. Resolves true when navigation may
   * proceed.
   */
  const confirmLeave = async (): Promise<boolean> => {
    if (!getActiveSession()) return true
    return confirm({
      title: '离开当前答题？',
      body: '已提交的题目已经保存，未提交的选择会丢失。返回后可以重新开始本组。',
      confirmLabel: '离开',
      cancelLabel: '继续答题',
      danger: true,
    })
  }

  return { confirmLeave, confirmEl }
}

/** Reactive mirror of "a session is running", for showing a live indicator. */
export function useActiveSession(): string | null {
  const [mode, setMode] = useState<string | null>(() => getActiveSession())
  useEffect(() => subscribeActiveSession(setMode), [])
  return mode
}
