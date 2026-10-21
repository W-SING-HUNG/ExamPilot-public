import { PageHead } from '../components/ui'
import { BankLookup } from './BankLookup'

/**
 * Standalone `#/bank` route.
 *
 * The bank browser is normally reached through 自由刷题 → 查阅题库, but the hash
 * route is kept so an existing bookmark or deep link still lands on the same
 * read-only screen instead of 404-ing.
 */
export function BankPage({ params: _params }: { params: Record<string, string> }) {
  return (
    <>
      <PageHead
        title="题库查阅"
        desc="完整题库检索，含 PDF 页码追溯与数据校验标记。原题干、原选项、原答案均保持题库原样。"
      />
      <BankLookup />
    </>
  )
}
