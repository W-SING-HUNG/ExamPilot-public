import { useState, useRef, useEffect, type ReactNode } from 'react'
import { aiAskQuestionStream } from '../lib/ai'
import { TypingDots } from './ui'

export interface FloatingAiMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 全局事件：用于页面题目卡片直接呼出或发送给悬浮 AI 窗口 */
export const FLOATING_AI_EVENT = 'exampilot:floating-ai-ask'

export function triggerFloatingAi(prompt: string, contextTitle?: string) {
  window.dispatchEvent(
    new CustomEvent(FLOATING_AI_EVENT, {
      detail: { prompt, contextTitle },
    }),
  )
}

/** 规范化符号：将 LaTeX 箭头或数学符号替换为易读直观的 Unicode 标点符号 */
function normalizeAiSymbols(raw: string): string {
  return raw
    .replace(/\\rightarrow|\\to|\$?\\rightarrow\$?|\$?\\to\$?/gi, ' → ')
    .replace(/\\leftarrow|\$?\\leftarrow\$?/gi, ' ← ')
    .replace(/\\Rightarrow|\$?\\Rightarrow\$?/gi, ' ⇒ ')
    .replace(/\\Leftarrow|\$?\\Leftarrow\$?/gi, ' ⇐ ')
    .replace(/\\leftrightarrow|\$?\\leftrightarrow\$?/gi, ' ↔ ')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\s*([:：])\s*/g, '：')
}

/** 将 AI 返回的行内 Markdown (**加粗**) 渲染为 React 元素 */
function renderInlineFormatting(text: string): ReactNode {
  const normalized = normalizeAiSymbols(text)
  const parts = normalized.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={i} style={{ color: 'var(--text-1)', fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}

/** 结构化渲染 AI 文本 */
function renderAiFormattedText(raw: string): ReactNode {
  const lines = raw.split(/\r?\n/)
  const sections: { title?: string; items: ReactNode[] }[] = []
  let currentSection: { title?: string; items: ReactNode[] } = { items: [] }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim()
    if (!line || line === '---' || line === '***') continue

    if (
      line.startsWith('### ') ||
      line.startsWith('## ') ||
      line.startsWith('# ') ||
      /^【.+】$/.test(line) ||
      /^[一二三四1234]\s*[.、]\s*.+/.test(line)
    ) {
      if (currentSection.items.length > 0 || currentSection.title) {
        sections.push(currentSection)
      }
      const cleanTitle = line.replace(/^#+\s*/, '').replace(/^[【[](.+)[】\]]$/, '$1')
      currentSection = { title: cleanTitle, items: [] }
      continue
    }

    if (line.startsWith('* ') || line.startsWith('- ')) {
      const itemText = line.slice(2).trim()
      const cleanItem = normalizeAiSymbols(itemText)
      const isCorrectOption = /^[A-D][项.、\s]?.*[（(【[]?(正确|符合)[）)】\]]?/i.test(cleanItem)
      const isWrongOption = /^[A-D][项.、\s]?.*[（(【[]?(错误|不符合)[）)】\]]?/i.test(cleanItem)

      let badgeTone = ''
      if (isCorrectOption) badgeTone = 'ok'
      else if (isWrongOption) badgeTone = 'bad'

      currentSection.items.push(
        <div key={currentSection.items.length} className={`ai-list-item ${badgeTone ? `ai-opt-${badgeTone}` : ''}`}>
          <span className={`ai-bullet ${badgeTone ? `ai-bullet-${badgeTone}` : ''}`}>
            {badgeTone === 'ok' ? '✓' : badgeTone === 'bad' ? '✗' : '•'}
          </span>
          <span className="ai-item-body">{renderInlineFormatting(itemText)}</span>
        </div>,
      )
    } else {
      currentSection.items.push(
        <p key={currentSection.items.length} className="ai-paragraph">
          {renderInlineFormatting(line)}
        </p>,
      )
    }
  }

  if (currentSection.items.length > 0 || currentSection.title) {
    sections.push(currentSection)
  }

  // 如果没有标题且只有单段落，直接紧凑渲染
  if (sections.length === 1 && !sections[0].title) {
    return <div className="ai-plain-output">{sections[0].items}</div>
  }

  return (
    <div className="ai-sections-container">
      {sections.map((sec, sIdx) => {
        let secClass = 'ai-section-card'
        let icon = '📌'
        if (sec.title) {
          if (sec.title.includes('正确') || sec.title.includes('判定')) {
            secClass += ' ai-sec-answer'
            icon = '🎯'
          } else if (sec.title.includes('选项') || sec.title.includes('解析')) {
            secClass += ' ai-sec-options'
            icon = '🔍'
          } else if (sec.title.includes('错因') || sec.title.includes('建议') || sec.title.includes('注意')) {
            secClass += ' ai-sec-analysis'
            icon = '💡'
          }
        }

        return (
          <div key={sIdx} className={secClass}>
            {sec.title && (
              <div className="ai-section-title">
                <span className="ai-sec-icon">{icon}</span>
                <span>{renderInlineFormatting(sec.title)}</span>
              </div>
            )}
            <div className="ai-section-content">{sec.items}</div>
          </div>
        )
      })}
    </div>
  )
}

/** 专业常驻悬浮/小窗口 AI 助手 */
export function FloatingAiAssistant() {
  const [isOpen, setIsOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [messages, setMessages] = useState<FloatingAiMessage[]>(() => {
    try {
      const saved = sessionStorage.getItem('exampilot_floating_ai_msgs')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)
  /**
   * Mirrors `streamingText` so event handlers can read the latest value without
   * depending on a stale render closure, and so side effects never have to live
   * inside a state updater.
   */
  const streamingTextRef = useRef('')

  // 消息持久化
  useEffect(() => {
    try {
      sessionStorage.setItem('exampilot_floating_ai_msgs', JSON.stringify(messages))
    } catch {
      // ignore
    }
  }, [messages])

  // 滚动到底部
  useEffect(() => {
    if (isOpen && !isMinimized) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingText, isOpen, isMinimized])

  // 监听外部事件（比如在题目中点击“在常驻悬浮窗中讨论”）
  useEffect(() => {
    const handleEvent = (e: Event) => {
      const ce = e as CustomEvent<{ prompt: string; contextTitle?: string }>
      if (ce.detail?.prompt) {
        setIsOpen(true)
        setIsMinimized(false)
        // 清空之前的旧对话，让新题目拥有全新的独立会话上下文
        setMessages([])
        streamingTextRef.current = ''
        setStreamingText('')
        setErrorMsg(null)
        void send(ce.detail.prompt)
      }
    }
    window.addEventListener(FLOATING_AI_EVENT, handleEvent)
    return () => window.removeEventListener(FLOATING_AI_EVENT, handleEvent)
  }, [messages, loading])

  const send = async (text: string) => {
    if (!text.trim() || loading) return
    const userText = text.trim()
    setInput('')
    setErrorMsg(null)
    setLoading(true)
    streamingTextRef.current = ''
    setStreamingText('')

    const nextMessages: FloatingAiMessage[] = [...messages, { role: 'user', content: userText }]
    setMessages(nextMessages)

    const ctrl = new AbortController()
    ctrlRef.current = ctrl

    // 判断是否包含完整题目详情，如果是首次发送题目，注入更明确的上下文引导
    const isFirstQuestionContext = userText.includes('【题目详情】')
    let payloadMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = nextMessages

    if (isFirstQuestionContext) {
      // 全新题目解析：使用干净规范的系统提示词
      payloadMessages = [
        {
          role: 'system',
          content:
            '你是《习近平新时代中国特色社会主义思想概论》专业课程助教。请仔细阅读用户提供的【题目详情】（包含题干、选项、标准答案和学生作答），为学生做深度解析。' +
            '结构要求：' +
            '1. 正确答案及依据（结合教材原文与二十大报告理论表述）；' +
            '2. 各选项深度辨析（对于选择题逐项剖析各选项正误及对应概念定位；对于判断题分析判定考点与易混陷阱）；' +
            '3. 学生答错原因分析（指出核心概念混淆点与记忆要诀）。' +
            '严禁回复“题目内容为空”，严禁使用 LaTeX 语法（禁止 \\rightarrow 等），重点概念加粗。',
        },
        { role: 'user', content: userText },
      ]
    }

    try {
      const res = await aiAskQuestionStream(
        {
          messages: payloadMessages,
        },
        (_chunk, fullText) => {
          if (!ctrl.signal.aborted) {
            streamingTextRef.current = fullText
            setStreamingText(fullText)
          }
        },
        ctrl.signal,
      )

      // A newer request may have superseded this one: never let a stale response
      // overwrite the current state or clear the spinner for someone else.
      if (ctrlRef.current !== ctrl) return

      if (ctrl.signal.aborted) {
        setLoading(false)
        return
      }
      setLoading(false)
      if (res.ok && res.answer) {
        setMessages((prev) => [...prev, { role: 'assistant', content: res.answer! }])
        streamingTextRef.current = ''
        setStreamingText('')
      } else {
        // Keep whatever streamed in so a mid-stream failure does not blank the
        // window; show the reason underneath.
        setErrorMsg(res.reason || '生成失败')
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setLoading(false)
        setErrorMsg((e as Error).message || '网络错误')
      }
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null
    }
  }

  const stop = () => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
    setLoading(false)
    // A partial answer is still useful: keep the text the user already saw.
    //
    // Read the current partial text from a ref rather than from inside a
    // `setStreamingText` updater: an updater must be a pure function of its
    // argument, and calling `setMessages` inside one made the commit depend on
    // how many times React chose to invoke it (StrictMode invokes updaters
    // twice), which could leave the partial answer out entirely.
    const partial = streamingTextRef.current
    if (partial.trim()) {
      setMessages((prev) => [...prev, { role: 'assistant', content: partial }])
    }
    setStreamingText('')
    streamingTextRef.current = ''
  }

  const clearHistory = () => {
    if (loading) stop()
    setMessages([])
    streamingTextRef.current = ''
    setStreamingText('')
    setErrorMsg(null)
  }

  return (
    <>
      {/* 屏幕右下角常驻唤出图标 */}
      {!isOpen && (
        <button
          className="floating-ai-launcher"
          onClick={() => {
            setIsOpen(true)
            setIsMinimized(false)
          }}
          title="展开常驻 AI 助手"
        >
          <span className="floating-ai-icon">✨</span>
          <span className="floating-ai-label">AI 助手</span>
          {messages.length > 0 && <span className="floating-ai-badge">{messages.length}</span>}
        </button>
      )}

      {/* 常驻悬浮小窗口 */}
      {isOpen && (
        <div className={`floating-ai-window ${isMinimized ? 'minimized' : ''}`}>
          {/* 窗口头部 */}
          <div className="floating-ai-header">
            <div className="floating-ai-title">
              <span className="floating-ai-icon">✨</span>
              <strong>ExamPilot AI 学习助手</strong>
            </div>
            <div className="floating-ai-actions">
              <button
                className="ai-win-btn"
                onClick={() => setIsMinimized((m) => !m)}
                title={isMinimized ? '还原窗口' : '最小化'}
              >
                {isMinimized ? '▢' : '—'}
              </button>
              <button className="ai-win-btn" onClick={clearHistory} title="清空对话记录">
                🗑️
              </button>
              <button className="ai-win-btn" onClick={() => setIsOpen(false)} title="关闭悬浮窗">
                ✕
              </button>
            </div>
          </div>

          {/* 窗口主体内容（最小化时隐藏） */}
          {!isMinimized && (
            <>
              <div className="floating-ai-body">
                {messages.length === 0 && !loading && (
                  <div className="floating-ai-empty">
                    <div style={{ fontSize: 24, marginBottom: 8 }}>💬</div>
                    <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>随时随地，向 AI 助手提问</div>
                    <div className="muted-2" style={{ fontSize: 12, marginTop: 4 }}>
                      做题遇到困惑？在此输入或点击题卡上的“在悬浮窗中讨论”，不中断刷题流。
                    </div>
                  </div>
                )}

                {messages.map((m, idx) => (
                  <div key={idx} className={`floating-msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
                    <div className="msg-avatar">{m.role === 'user' ? '我' : 'AI'}</div>
                    <div className="msg-bubble">
                      {m.role === 'user' ? (
                        <div className="user-text">
                          {m.content.includes('【题目详情】') ? (
                            <div>
                              <div
                                style={{
                                  fontWeight: 600,
                                  marginBottom: 4,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                }}
                              >
                                <span>📋</span>
                                <span>已发送题目详情</span>
                              </div>
                              <div style={{ fontSize: 12, opacity: 0.9 }}>{m.content.slice(0, 70)}...</div>
                            </div>
                          ) : (
                            m.content
                          )}
                        </div>
                      ) : (
                        renderAiFormattedText(m.content)
                      )}
                    </div>
                  </div>
                ))}

                {/* 流式打字输出 */}
                {loading && streamingText && (
                  <div className="floating-msg assistant">
                    <div className="msg-avatar">AI</div>
                    <div className="msg-bubble">{renderAiFormattedText(streamingText)}</div>
                  </div>
                )}

                {loading && !streamingText && (
                  <div className="floating-msg assistant">
                    <div className="msg-avatar">AI</div>
                    <div className="msg-bubble">
                      <TypingDots label="正在思考…" />
                    </div>
                  </div>
                )}

                {errorMsg && (
                  <div className="floating-error">
                    <span>⚠️ {errorMsg}</span>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              {/* 窗口底部输入栏 */}
              <div className="floating-ai-footer">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void send(input)
                  }}
                  className="floating-form"
                >
                  <input
                    type="text"
                    className="input floating-input"
                    placeholder="输入问题、概念或让 AI 解释任何内容…"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    disabled={loading}
                  />
                  {loading ? (
                    <button type="button" className="btn btn-sm btn-warn" onClick={stop}>
                      停止
                    </button>
                  ) : (
                    <button type="submit" className="btn btn-primary btn-sm" disabled={!input.trim()}>
                      发送
                    </button>
                  )}
                </form>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}
