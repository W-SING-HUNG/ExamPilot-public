import { useEffect, useState } from 'react'
import { bank } from '../lib/bank'
import { bankFingerprint, type BankFingerprint } from '../lib/bank-fingerprint'
import { CardPad } from './ui'

/**
 * Web edition only: shows the fingerprint of the bank the RUNNING bundle actually
 * loaded, so it can be compared with `npm run web:verify` output on the
 * maintainer's machine. Computed in the browser; nothing is sent anywhere.
 */
export function BankFingerprintCard() {
  const [fp, setFp] = useState<BankFingerprint | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    bankFingerprint(bank).then(setFp, (e: Error) => setErr(e.message))
  }, [])
  return (
    <CardPad style={{ marginTop: 14 }}>
      <div className="card-title">题库指纹（网页版校验用）</div>
      {err && <div className="muted">无法计算：{err}</div>}
      {!fp && !err && <div className="muted">计算中…</div>}
      {fp && (
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, wordBreak: 'break-all' }}>
          <div data-testid="bank-total">题目总数：{fp.total}</div>
          <div>
            各题型：
            {Object.entries(fp.byType)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ')}
          </div>
          <div data-testid="bank-fp-full">完整指纹：{fp.hashes.full}</div>
          <div>章节顺序：{fp.hashes.chapterOrder.slice(0, 16)}</div>
          <div>题目 ID：{fp.hashes.ids.slice(0, 16)}</div>
          <div>题干与选项：{fp.hashes.stemsOptions.slice(0, 16)}</div>
          <div>答案：{fp.hashes.answers.slice(0, 16)}</div>
        </div>
      )}
    </CardPad>
  )
}
