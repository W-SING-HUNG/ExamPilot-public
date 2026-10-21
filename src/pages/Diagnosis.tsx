import { Home } from './Home'
import type { RouteName } from '../store/router'

/**
 * `#/diagnosis` compatibility route.
 *
 * 学习诊断 was merged into 学习总览 as its 详细诊断 view. This route still renders
 * that same view so old links keep working, but there is only ONE implementation
 * of the diagnosis UI (inside Home) — no duplicated tables to drift apart.
 */
export function Diagnosis({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}) {
  return <Home nav={nav} params={{ view: 'detail' }} />
}
