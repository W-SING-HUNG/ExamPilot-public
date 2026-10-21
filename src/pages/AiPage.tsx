import { PageHead } from '../components/ui'
import { AiSettingsSection } from './AiSettingsSection'

/**
 * Standalone `#/ai` route.
 *
 * AI configuration now lives in 设置 → AI 网关. This route is kept only so an old
 * bookmark still lands somewhere useful; it renders the exact same section, so
 * the capability is never duplicated or lost.
 */
export function AiPage({ params: _params }: { params: Record<string, string> }) {
  return (
    <>
      <PageHead
        title="AI 助手设置"
        desc="接入你自己的 Sub2API 网关：密钥仅保存在服务端配置文件中，前端不接触密钥。AI 不可用时，刷题、评分与本地记录照常工作。"
      />
      <AiSettingsSection />
    </>
  )
}
