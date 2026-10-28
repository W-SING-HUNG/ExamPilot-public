import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react'
import { aiAskQuestionStream } from '../lib/ai'
import { TypingDots } from './ui'
import { IS_WEB_EDITION } from '../lib/edition'
import { useSync } from '../sync/CloudStore'
import { prepareImage, storeCopy, MAX_IMAGES, type PickedImage } from '../lib/ai-image'
import { aiSaveImages, aiImageDataUri } from '../lib/ai'
import { AiSavedImages } from './AiSavedImages'
import type { AiChatMsg } from '../sync/protocol'

/** A "generating" message older than this, not streaming on this device, was interrupted. */
const STALE_GENERATING_MS = 5 * 60_000

function newChatId(prefix: string): string {
  const b = new Uint8Array(9)
  crypto.getRandomValues(b)
  return prefix + '-' + Date.now().toString(36) + '-' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** Title for a conversation, from its first user message. */
function convTitle(text: string): string {
  if (text.includes('【题目详情】')) {
    const stem = /题干[:：]\s*([^\n]+)/.exec(text)?.[1] ?? ''
    return ('题目答疑：' + stem).slice(0, 60)
  }
  return text.replace(/\s+/g, ' ').slice(0, 60)
}

export interface FloatingAiMessage {
  role: 'user' | 'assistant'
  content: string
  /** web edition: stored message state (desktop messages never carry one) */
  status?: AiChatMsg['status']
  error?: string
  id?: string
  at?: number
  /** web edition: compressed copies saved with the question */
  images?: AiChatMsg['images']
}

/** 全局事件：用于页面题目卡片直接呼出或发送给悬浮 AI 窗口 */
export const FLOATING_AI_EVENT = 'exampilot:floating-ai-ask'

/** Web edition: open a stored conversation in the floating window. */
export const FLOATING_AI_OPEN_EVENT = 'exampilot:floating-ai-open'
export function openFloatingAiConversation(conv = '') {
  window.dispatchEvent(new CustomEvent(FLOATING_AI_OPEN_EVENT, { detail: { conv } }))
}

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
function renderBold(text: string, keyBase: string): ReactNode[] {
  const normalized = normalizeAiSymbols(text)
  const parts = normalized.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={keyBase + i} style={{ color: 'var(--text-1)', fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}

// 联网回答里的来源链接：[标题](https://…) 和裸 https 链接。链接本身不做符号规范化
// （否则 https: 会被改成全角冒号而失效），只允许 http(s)，新窗口打开且不带 referrer。
const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()（）\]，。]+)/g
const UNRELIABLE_SRC =
  /^https?:\/\/(?:vertexaisearch\.cloud\.google\.com|(?:www\.)?google\.[a-z.]+\/(?:url|search))(?:[/?#]|$)/i
function renderInlineFormatting(text: string): ReactNode {
  const out: ReactNode[] = []
  let lastIdx = 0
  let k = 0
  for (const m of text.matchAll(LINK_RE)) {
    const at = m.index ?? 0
    if (at > lastIdx) out.push(...renderBold(text.slice(lastIdx, at), `t${k++}-`))
    const href = m[2] || m[3]
    // fix4: a Google grounding redirect / search wrapper is not a source (belt and braces;
    // the Worker already resolves or drops them). Keep the title as plain text only.
    if (UNRELIABLE_SRC.test(href)) {
      if (m[1]) out.push(...renderBold(normalizeAiSymbols(m[1]) + '（来源链接未能核实）', `t${k++}-`))
      lastIdx = at + m[0].length
      continue
    }
    const label = m[1]
      ? normalizeAiSymbols(m[1])
      : (() => {
          try {
            return new URL(href).hostname
          } catch {
            return href
          }
        })()
    out.push(
      <a key={`l${k++}`} className="ai-src-link" href={href} target="_blank" rel="noopener noreferrer nofollow">
        {label}
      </a>,
    )
    lastIdx = at + m[0].length
  }
  if (lastIdx < text.length) out.push(...renderBold(text.slice(lastIdx), `t${k}-`))
  return out
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
  // Web edition: the conversation lives in the account (synced), not in sessionStorage.
  const sync = useSync()
  const web = IS_WEB_EDITION && !!sync
  const convKey = sync ? 'exampilot_floating_ai_conv:' + sync.accountId : ''
  const [convId, setConvIdState] = useState<string | null>(() => {
    if (!web) return null
    try {
      return sessionStorage.getItem(convKey)
    } catch {
      return null
    }
  })
  const convIdRef = useRef<string | null>(convId)
  const setConvId = (id: string | null) => {
    convIdRef.current = id
    setConvIdState(id)
    if (!web) return
    try {
      if (id) sessionStorage.setItem(convKey, id)
      else sessionStorage.removeItem(convKey)
    } catch {
      /* ignore */
    }
  }
  const [showList, setShowList] = useState(false)
  /** id of the assistant message streaming on THIS device (web) */
  const [liveMsgId, setLiveMsgId] = useState<string | null>(null)
  const [localMessages, setMessages] = useState<FloatingAiMessage[]>(() => {
    if (IS_WEB_EDITION) return []
    try {
      const saved = sessionStorage.getItem('exampilot_floating_ai_msgs')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const conv = web && convId ? (sync!.aiChats.find((c) => c.id === convId) ?? null) : null
  // A conversation deleted on another device closes here too (only one we have
  // actually seen in the synced list — a brand-new one is still being written).
  const seenConvs = useRef(new Set<string>())
  if (conv) seenConvs.current.add(conv.id)
  useEffect(() => {
    if (web && convId && !conv && seenConvs.current.has(convId)) setConvId(null)
  }, [web, convId, conv])
  /** final state of the live reply, shown until the synced copy catches up */
  const [pendingFinal, setPendingFinal] = useState<Pick<AiChatMsg, 'id' | 'content' | 'status' | 'error'> | null>(null)
  const messages: FloatingAiMessage[] = useMemo(
    () =>
      web
        ? (conv?.messages ?? [])
            .filter((m) => m.id !== liveMsgId)
            .map((m) =>
              pendingFinal && m.id === pendingFinal.id && m.status === 'generating' ? { ...m, ...pendingFinal } : m,
            )
            .map((m) => ({
              role: m.role,
              content: m.content,
              status: m.status,
              error: m.error,
              id: m.id,
              at: m.at,
              images: m.images,
            }))
        : localMessages,
    [web, conv, liveMsgId, localMessages, pendingFinal],
  )
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  /**
   * D-10: a question is only written to the account once the model has produced
   * its first piece of text. Until then it lives here (shown in the window), so a
   * refused/failed/cancelled request leaves no empty conversation behind.
   */
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  /** D-01: a BUSY answer carries how long until a slot frees; count it down */
  const [busyUntil, setBusyUntil] = useState(0)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!busyUntil) return
    const t = setInterval(() => {
      if (Date.now() >= busyUntil) setBusyUntil(0)
      setTick((n) => n + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [busyUntil])
  const busyLeft = busyUntil ? Math.max(0, Math.ceil((busyUntil - Date.now()) / 1000)) : 0
  /** last text that failed before any answer arrived (offered for one-tap resend) */
  const [unsent, setUnsent] = useState<{ text: string; fresh: boolean } | null>(null)

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)
  /**
   * Mirrors `streamingText` so event handlers can read the latest value without
   * depending on a stale render closure, and so side effects never have to live
   * inside a state updater.
   */
  const streamingTextRef = useRef('')

  // 消息持久化（电脑版：sessionStorage；网页版：账号云同步，见 send/stop）
  useEffect(() => {
    if (IS_WEB_EDITION) return
    try {
      sessionStorage.setItem('exampilot_floating_ai_msgs', JSON.stringify(localMessages))
    } catch {
      // ignore
    }
  }, [localMessages])

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
        // （网页版：旧对话保留在「历史对话」里，新题目开一个新对话）
        if (web) {
          if (loading) stop()
          setConvId(null)
          setShowList(false)
        } else setMessages([])
        streamingTextRef.current = ''
        setStreamingText('')
        setErrorMsg(null)
        void send(ce.detail.prompt, { fresh: true })
      }
    }
    const handleOpen = (e: Event) => {
      const conv = (e as CustomEvent<{ conv: string }>).detail?.conv
      if (!web) return
      setIsOpen(true)
      setIsMinimized(false)
      // no conversation id = just open the assistant (Home / 个人中心 shortcuts)
      if (conv) openConv(conv)
    }
    window.addEventListener(FLOATING_AI_EVENT, handleEvent)
    window.addEventListener(FLOATING_AI_OPEN_EVENT, handleOpen)
    return () => {
      window.removeEventListener(FLOATING_AI_EVENT, handleEvent)
      window.removeEventListener(FLOATING_AI_OPEN_EVENT, handleOpen)
    }
  }, [messages, loading])

  /** web: the assistant message being generated on this device */
  const liveRef = useRef<{
    conv: string
    id: string
    at: number
    /** persisted yet? (only after the first text arrives) */
    started: boolean
    /** writes that create the turn; later writes wait for them */
    startP?: Promise<unknown>
    user?: { msg: AiChatMsg; meta?: { title: string; kind: 'question' | 'free' } }
    /** the question as typed (for resend after a stop before any text) */
    userText?: string
    fresh?: boolean
    images?: PickedImage[]
  } | null>(null)

  /** web: first text arrived — now record the question and the "generating" reply. */
  const startLive = () => {
    const live = liveRef.current
    if (!web || !live || live.started) return
    live.started = true
    setLiveMsgId(live.id)
    const u = live.user
    live.startP = (async () => {
      if (u) await sync!.aiChat.putMsg(live.conv, u.msg, u.meta)
      await sync!.aiChat.putMsg(live.conv, {
        id: live.id,
        role: 'assistant',
        content: '',
        status: 'generating',
        at: live.at,
      })
    })()
    if (live.conv !== convIdRef.current) setConvId(live.conv)
    setPendingUser(null)
  }

  /**
   * web: settle the live turn (once). A turn that never produced text is NOT
   * written at all (D-10): the window shows the failure and offers the question
   * back; nothing appears in the history on any device.
   */
  const finishLive = (status: AiChatMsg['status'], content: string, error?: string): boolean => {
    const live = liveRef.current
    if (!web || !live) return false
    liveRef.current = null
    if (!live.started) {
      setPendingUser(null)
      return false
    }
    setPendingFinal({ id: live.id, content, status, ...(error ? { error: error.slice(0, 1000) } : {}) })
    setLiveMsgId(null)
    const write = () =>
      sync!.aiChat.putMsg(live.conv, {
        id: live.id,
        role: 'assistant',
        content,
        status,
        at: live.at,
        ...(error ? { error: error.slice(0, 1000) } : {}),
      })
    void (live.startP ? live.startP.then(write, write) : write())
    return true
  }

  // Closing the window / losing AI access mid-answer: record what we have, so the
  // reply is stored as interrupted instead of hanging in "generating".
  const finishLiveRef = useRef(finishLive)
  finishLiveRef.current = finishLive
  useEffect(
    () => () => {
      // N-01: always cancel this window's request when it goes away. A request
      // left running after its window was gone used to write its answer into a
      // conversation no window was showing ("saved, but not displayed").
      ctrlRef.current?.abort()
      if (liveRef.current) finishLiveRef.current('error', streamingTextRef.current, '页面已关闭或切换账号，回答未完成')
    },
    [],
  )

  // 联网 + 图片（仅网页版）. Images are kept in memory for this conversation only:
  // they are sent to the model (and re-sent on follow-ups so it can still refer to
  // them) but never written to the synced history.
  const [searchOn, setSearchOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ep.ai.search') === '1'
    } catch {
      return false
    }
  })
  const toggleSearch = () =>
    setSearchOn((v) => {
      try {
        localStorage.setItem('ep.ai.search', v ? '0' : '1')
      } catch {
        /* private mode */
      }
      return !v
    })
  const [picked, setPicked] = useState<PickedImage[]>([])
  const [imgErr, setImgErr] = useState<string | null>(null)
  const convImagesRef = useRef<{ conv: string | null; urls: string[] }>({ conv: null, urls: [] })
  const fileRef = useRef<HTMLInputElement>(null)
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    setImgErr(null)
    const list = Array.from(files)
    for (const f of list) {
      if (picked.length + 1 > MAX_IMAGES) {
        setImgErr(`一次最多 ${MAX_IMAGES} 张图片`)
        break
      }
      const r = await prepareImage(f)
      if (!r.ok) {
        setImgErr(r.reason)
        continue
      }
      setPicked((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, r.image]))
    }
  }

  const send = async (text: string, opts: { fresh?: boolean; retry?: boolean } = {}) => {
    if ((!text.trim() && !(web && picked.length)) || loading) return
    const sendPicked = web ? picked : []
    const sendImages = sendPicked.map((p) => p.url)
    const userText = text.trim() || (sendImages.length ? '请看图片并解答。' : '')
    setPicked([])
    setImgErr(null)
    setInput('')
    setErrorMsg(null)
    setLoading(true)
    streamingTextRef.current = ''
    setStreamingText('')

    // History the model sees. Web: from the synced conversation (finished or
    // stopped replies only — a failed reply is not context).
    const prior: FloatingAiMessage[] = opts.fresh ? [] : messages
    const history = web
      ? prior.filter(
          (m) => m.role === 'user' || ((m.status === 'done' || m.status === 'cancelled') && m.content.trim()),
        )
      : prior
    const nextMessages: FloatingAiMessage[] = opts.retry
      ? [...history]
      : [...history, { role: 'user', content: userText }]
    setUnsent(null)
    if (!web) setMessages(nextMessages)
    else {
      const conv = (!opts.fresh && convIdRef.current) || newChatId('conv')
      const now = Date.now()
      // Pictures are saved (compressed copy) BEFORE the question goes out, so a stored question
      // never points at a picture that failed to save. A failure keeps everything in the box.
      let saved: AiChatMsg['images'] | undefined
      let notSavedNote = false
      if (sendImages.length && !opts.retry) {
        const copies: string[] = []
        for (const u of sendImages) {
          const c = await storeCopy(u)
          if (!c.ok) {
            setPicked(sendPicked)
            setInput(text)
            setLoading(false)
            setImgErr(c.reason)
            return
          }
          copies.push(c.url)
        }
        const r = await aiSaveImages(conv, copies)
        if (r.ok) saved = r.images
        else if (r.unavailable) notSavedNote = true
        else {
          setPicked(sendPicked)
          setInput(text)
          setLoading(false)
          setImgErr(`${r.reason}（问题没有发送）`)
          return
        }
      }
      liveRef.current = {
        conv,
        id: newChatId('m'),
        at: now + 1,
        started: false,
        userText,
        fresh: !!opts.fresh,
        images: sendPicked,
        user: opts.retry
          ? undefined
          : {
              msg: {
                id: newChatId('m'),
                role: 'user',
                content: notSavedNote
                  ? `${userText}\n（附图 ${sendImages.length} 张，图片只用于本次对话，不保存）`
                  : userText,
                ...(saved?.length ? { images: saved } : {}),
                status: 'done',
                at: now,
              },
              meta:
                prior.length === 0
                  ? { title: convTitle(userText), kind: userText.includes('【题目详情】') ? 'question' : 'free' }
                  : undefined,
            },
      }
      if (!opts.retry) setPendingUser(sendImages.length ? `${userText}（附图 ${sendImages.length} 张）` : userText)
      // images of this conversation stay available for follow-up questions
      if (convImagesRef.current.conv !== conv) {
        convImagesRef.current = { conv, urls: [] }
        // continuing a conversation opened from history (maybe started on another device):
        // give the model its saved pictures again (the latest 3)
        if (!sendImages.length) {
          const refs = prior.flatMap((m) => m.images ?? []).slice(-3)
          if (refs.length) {
            const urls = (await Promise.all(refs.map((r) => aiImageDataUri(r.id)))).filter((x): x is string => !!x)
            if (convImagesRef.current.conv === conv) convImagesRef.current.urls = urls
          }
        }
      }
      if (sendImages.length) convImagesRef.current.urls = sendImages
    }

    const ctrl = new AbortController()
    ctrlRef.current = ctrl

    // 判断是否包含完整题目详情，如果是首次发送题目，注入更明确的上下文引导
    const isFirstQuestionContext = userText.includes('【题目详情】')
    let payloadMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = nextMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

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
          ...(web && searchOn ? { search: true } : {}),
          ...(web && convImagesRef.current.urls.length ? { images: convImagesRef.current.urls } : {}),
        },
        (_chunk, fullText) => {
          if (!ctrl.signal.aborted) {
            if (web) startLive()
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
        if (web) finishLive('done', res.answer)
        else setMessages((prev) => [...prev, { role: 'assistant', content: res.answer! }])
        streamingTextRef.current = ''
        setStreamingText('')
      } else {
        // Keep whatever streamed in so a mid-stream failure does not blank the
        // window; show the reason underneath.
        if (web) {
          const stored = finishLive('error', streamingTextRef.current, res.reason || '生成失败')
          if (!stored && !opts.retry) setUnsent({ text: userText, fresh: !!opts.fresh })
          streamingTextRef.current = ''
          setStreamingText('')
        }
        if (res.code === 'BUSY') setBusyUntil(Date.now() + Math.max(1, res.retryAfter ?? 5) * 1000)
        setErrorMsg(res.reason || '生成失败')
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setLoading(false)
        if (web && !finishLive('error', streamingTextRef.current, (e as Error).message || '网络错误') && !opts.retry)
          setUnsent({ text: userText, fresh: !!opts.fresh })
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
    if (web) {
      // Stopped before any text: nothing is stored. Offer the question back as a
      // one-tap resend instead of pasting it into the input box — typing the next
      // question there silently merged both into one long prompt (N-01).
      const live = liveRef.current
      const unsentQ =
        live && !live.started && live.user
          ? { text: live.userText ?? live.user.msg.content, fresh: !!live.fresh }
          : null
      if (!finishLive('cancelled', partial) && unsentQ) {
        setUnsent(unsentQ)
        if (live?.images?.length) setPicked(live.images)
        setErrorMsg('已停止，这个问题没有发送')
      }
    } else if (partial.trim()) {
      setMessages((prev) => [...prev, { role: 'assistant', content: partial }])
    }
    setStreamingText('')
    streamingTextRef.current = ''
  }

  const clearHistory = () => {
    if (loading) stop()
    if (web) {
      // Deleting the conversation is synced: it disappears on every device.
      if (convIdRef.current && conv) void sync!.aiChat.deleteConv(convIdRef.current)
      setConvId(null)
    } else setMessages([])
    streamingTextRef.current = ''
    setStreamingText('')
    setErrorMsg(null)
  }

  /** web: regenerate the answer to the last question (no duplicate question is stored). */
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const canRetry =
    web &&
    !loading &&
    !!lastUser &&
    messages[messages.length - 1]?.role === 'assistant' &&
    messages[messages.length - 1]?.status === 'error'
  const retry = () => {
    if (!lastUser) return
    void send(lastUser.content, { retry: true })
  }

  const openConv = (id: string | null) => {
    if (loading) stop()
    setConvId(id)
    setShowList(false)
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
              <strong>
                <span className="ai-title-long">ExamPilot AI 学习助手</span>
                <span className="ai-title-short">AI 学习助手</span>
              </strong>
            </div>
            <div className="floating-ai-actions">
              <button
                className="ai-win-btn"
                onClick={() => setIsMinimized((m) => !m)}
                title={isMinimized ? '还原窗口' : '最小化'}
              >
                {isMinimized ? '▢' : '—'}
              </button>
              {web && (
                <>
                  <button
                    className="ai-win-btn"
                    onClick={() => setShowList((v) => !v)}
                    title="历史对话"
                    aria-pressed={showList}
                  >
                    历史
                  </button>
                  <button className="ai-win-btn" onClick={() => openConv(null)} title="新对话">
                    ＋
                  </button>
                </>
              )}
              <button
                className="ai-win-btn"
                onClick={clearHistory}
                title={web ? '删除本对话（所有设备同步删除）' : '清空对话记录'}
              >
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
                {web && showList && (
                  <div className="floating-ai-history" role="list" aria-label="历史对话">
                    {sync!.aiChats.length === 0 && <div className="muted-2">还没有历史对话。</div>}
                    {sync!.aiChats.map((c) => (
                      <div
                        key={c.id}
                        role="listitem"
                        className={`floating-ai-hist-row ${c.id === convId ? 'active' : ''}`}
                      >
                        <button className="floating-ai-hist-open" onClick={() => openConv(c.id)}>
                          <span className="floating-ai-hist-title">{c.title}</span>
                          <span className="muted-2">
                            {new Date(c.updatedAt).toLocaleString('zh-CN', { hour12: false })} · {c.messages.length} 条
                          </span>
                        </button>
                        <button
                          className="ai-win-btn"
                          title="删除这个对话"
                          onClick={() => {
                            if (c.id === convId) openConv(null)
                            void sync!.aiChat.deleteConv(c.id)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {!(web && showList) && messages.length === 0 && !loading && !errorMsg && (
                  <div className="floating-ai-empty">
                    <div style={{ fontSize: 24, marginBottom: 8 }}>💬</div>
                    <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>随时随地，向 AI 助手提问</div>
                    <div className="muted-2" style={{ fontSize: 12, marginTop: 4 }}>
                      做题遇到困惑？在此输入或点击题卡上的“在悬浮窗中讨论”，不中断刷题流。
                    </div>
                  </div>
                )}

                {!(web && showList) &&
                  messages.map((m, idx) => (
                    <div key={m.id ?? idx} className={`floating-msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
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
                            {web && <AiSavedImages images={m.images} compact />}
                          </div>
                        ) : (
                          <>
                            {m.content.trim() ? renderAiFormattedText(m.content) : null}
                            {m.status && m.status !== 'done' && <AiMsgState m={m} />}
                          </>
                        )}
                      </div>
                    </div>
                  ))}

                {web && pendingUser && !showList && (
                  <div className="floating-msg user">
                    <div className="msg-avatar">我</div>
                    <div className="msg-bubble">
                      <div className="user-text">
                        {pendingUser.includes('【题目详情】') ? '📋 已发送题目详情' : pendingUser}
                      </div>
                    </div>
                  </div>
                )}

                {/* 流式打字输出 */}
                {loading && streamingText && !(web && showList) && (
                  <div className="floating-msg assistant">
                    <div className="msg-avatar">AI</div>
                    <div className="msg-bubble">{renderAiFormattedText(streamingText)}</div>
                  </div>
                )}

                {loading && !streamingText && !(web && showList) && (
                  <div className="floating-msg assistant">
                    <div className="msg-avatar">AI</div>
                    <div className="msg-bubble">
                      <TypingDots label="正在思考…" />
                    </div>
                  </div>
                )}

                {errorMsg && !(web && showList) && (
                  <div className="floating-error" role="alert">
                    <span>⚠️ {errorMsg}</span>
                    {busyLeft > 0 && <span className="muted-2"> （约 {busyLeft} 秒后可再试）</span>}
                    {unsent && (
                      <button
                        className="btn btn-sm"
                        style={{ marginLeft: 8 }}
                        disabled={busyLeft > 0}
                        onClick={() => void send(unsent.text, { fresh: unsent.fresh })}
                      >
                        {busyLeft > 0 ? `${busyLeft} 秒后重发` : '重新发送'}
                      </button>
                    )}
                    {canRetry && (
                      <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={retry} disabled={busyLeft > 0}>
                        重试
                      </button>
                    )}
                  </div>
                )}
                {!errorMsg && canRetry && !(web && showList) && (
                  <div>
                    <button className="btn btn-sm" onClick={retry}>
                      重新生成回答
                    </button>
                  </div>
                )}
                {web && !showList && messages.length > 0 && (
                  <div className="muted-2" style={{ fontSize: 11.5 }}>
                    AI 回答仅供学习参考；对话保存在你的账号中，并同步到你登录的其他设备。
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              {/* 窗口底部输入栏 */}
              <div
                className="floating-ai-footer"
                onDragOver={web ? (e) => e.preventDefault() : undefined}
                onDrop={
                  web
                    ? (e) => {
                        e.preventDefault()
                        void addFiles(e.dataTransfer.files)
                      }
                    : undefined
                }
              >
                {web && (picked.length > 0 || imgErr) && (
                  <div className="ai-attach-row" aria-live="polite">
                    {picked.map((p, i) => (
                      <div className="ai-attach-thumb" key={p.id}>
                        <img src={p.url} alt={`待发送图片 ${i + 1}`} />
                        <button
                          type="button"
                          className="ai-attach-del"
                          aria-label={`移除图片 ${i + 1}`}
                          onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {imgErr && <span className="ai-attach-err">{imgErr}</span>}
                  </div>
                )}
                {web && (
                  <div className="ai-tools-row">
                    <button
                      type="button"
                      className={`ai-tool-btn${searchOn ? ' on' : ''}`}
                      aria-pressed={searchOn}
                      onClick={toggleSearch}
                      title="开启后 AI 会先联网搜索，并在回答中给出来源链接"
                    >
                      <span aria-hidden>🌐</span> 联网{searchOn ? '：开' : ''}
                    </button>
                    <button
                      type="button"
                      className="ai-tool-btn"
                      onClick={() => fileRef.current?.click()}
                      disabled={loading || picked.length >= MAX_IMAGES}
                      title="上传 JPEG / PNG 图片（可拍照、相册、拖拽或粘贴）"
                    >
                      <span aria-hidden>🖼</span> 图片
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      multiple
                      hidden
                      onChange={(e) => {
                        void addFiles(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </div>
                )}
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
                    onPaste={
                      web
                        ? (e) => {
                            const files = Array.from(e.clipboardData.files || []).filter((f) =>
                              f.type.startsWith('image/'),
                            )
                            if (files.length) {
                              e.preventDefault()
                              void addFiles(files)
                            }
                          }
                        : undefined
                    }
                    disabled={loading}
                  />
                  {loading ? (
                    <button type="button" className="btn btn-sm btn-warn" onClick={stop}>
                      停止
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={!input.trim() && !(web && picked.length)}
                    >
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

/** Web edition: the stored state of an assistant message that is not a finished reply. */
function AiMsgState({ m }: { m: FloatingAiMessage }) {
  if (m.status === 'cancelled') return <div className="muted-2 ai-msg-state">已停止生成（以上为停止前的内容）</div>
  if (m.status === 'error')
    return (
      <div className="ai-msg-state" style={{ color: 'var(--bad)' }}>
        生成未完成{m.error ? `：${m.error}` : ''}
      </div>
    )
  if (m.status === 'generating') {
    const stale = !m.at || Date.now() - m.at > STALE_GENERATING_MS
    return (
      <div className="muted-2 ai-msg-state">
        {stale ? '生成中断（回答没有完成，可重新提问）' : '正在另一台设备上生成…'}
      </div>
    )
  }
  return null
}
