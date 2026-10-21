import { Practice } from './Practice'
import type { RouteName } from '../store/router'

/**
 * `#/special` compatibility route (专项训练).
 *
 * 专项训练 was merged into 自由刷题 as its 按题型 mode. Old links and the
 * router-level alias both land on that mode, so the capability is intact but
 * there is only one practice implementation to maintain.
 */
export function Special({
  nav,
  params,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}) {
  return <Practice nav={nav} params={{ ...params, mode: 'type' }} />
}
