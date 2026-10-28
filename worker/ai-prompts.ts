/**
 * Prompts and grade validation, ported VERBATIM from the local proxy
 * (server/index.mjs: buildQaPrompt, buildGradePrompt, extractJson, validateGrade).
 *
 * tests/web-ai/contract.test.ts runs the local proxy and this module against the
 * same mock gateway and asserts the upstream request bodies are identical, so a
 * drift between the two is caught.
 */

export const DISCLAIMER = '本评阅由 AI 生成，仅作参考评阅，非官方标准答案或分数；请以题库原答案和课堂讲授为准。'

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }

export interface QaBody {
  question?: { type?: string; stem?: string; options?: string[]; answer?: string | null }
  userAnswer?: string
  questionContext?: { chapter?: string; bankNo?: number }
  messages?: ChatMessage[]
  stream?: boolean
  /** web edition: let the model search the web (Gemini grounding via /responses) */
  search?: boolean
  /** web edition: images (data:image/png|jpeg;base64,…) attached to the LAST user message */
  images?: string[]
}

export interface GradeBody {
  qid?: string
  stem?: string
  userAnswer?: string
  chapter?: string
  kind?: 'short' | 'material'
}

export function buildQaPrompt(body: QaBody): ChatMessage[] {
  // 如果前端直接传递了多轮 messages 历史，则优先支持多轮自由追问对话
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const sysMsg: ChatMessage = {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》专业课程 AI。请基于思政教材与题库知识，用自然、直接、专业的中文回答学生的追问。' +
        '要求：1) 针对学生的具体疑问直接作答，不要重复套用固定模板，不要每次都重复全套题目解析；2) 问什么答什么，直截了当；3) 严禁使用 LaTeX 公式语法（禁止 \\rightarrow 等，如需推导直接用文字或箭头“→”）；4) 重点概念加粗。',
    }
    return [sysMsg, ...body.messages]
  }

  const q = body.question || {}
  const ctx = body.questionContext || {}
  const opts = Array.isArray(q.options)
    ? q.options.map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o}`).join('\n')
    : ''
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》专业课程 AI。请基于题库与教材知识，用规范、专业、易读的简体中文回答学生。' +
        '首次完整解析题目时的结构要求：\n' +
        '1. 严禁使用 LaTeX 数学公式语法（禁止出现 \\rightarrow, \\Rightarrow, $...$ 等），因果推导请直接使用中文箭头“→”或直白汉字表述。\n' +
        '2. 严禁输出空行堆叠或多余的分割线（不要输出 --- 或 *** 分割线）。\n' +
        '3. 首次解析请分三个板块：\n' +
        '   - 1. 正确答案及依据\n' +
        '   - 2. 各选项逐项解析\n' +
        '   - 3. 学生答错原因分析\n' +
        '4. 选项分析分点罗列，核心概念词加粗，语言简洁干练，重点突出。',
    },
    {
      role: 'user',
      content:
        `章节：${ctx.chapter || '未知'}，题号：${ctx.bankNo ?? '未知'}，题型：${q.type || '未知'}\n` +
        `题干：${q.stem || ''}\n` +
        (opts ? `选项：\n${opts}\n` : '') +
        (q.answer ? `题库答案：${q.answer}\n` : '') +
        `学生的作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

export function buildGradePrompt(body: GradeBody): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》阅卷助教，请对学生的简答题/材料分析题作答进行参考性评阅。' +
        '请严格输出 JSON，不要输出任何多余文字，JSON 结构如下：\n' +
        '{"score": 0-100 的整数, "hitPoints": ["命中的采分点"], "missedPoints": ["遗漏的内容"], "deductions": ["扣分依据"], "suggestions": ["修改建议"], "structureNote": "答题结构点评"}\n' +
        '评分必须基于题干要求、核心概念、采分点与材料联系；不得凭空给出标准答案之外的内容。',
    },
    {
      role: 'user',
      content:
        `章节：${body.chapter || '未知'}，题型：${body.kind === 'short' ? '简答题' : '材料分析论述题'}\n` +
        `题干：${body.stem || ''}\n` +
        `学生作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

/** Extract JSON from a possibly prose-wrapped model response. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export interface GradeResult {
  score: number
  maxScore: number
  hitPoints: string[]
  missedPoints: string[]
  deductions: string[]
  suggestions: string[]
  structureNote: string
  disclaimer: string
}

/**
 * Validate a grade result strictly. A missing or malformed field is a FAILURE,
 * not a zero — we must never report `ok:true` with a fabricated score.
 */
export function validateGrade(raw: unknown): { ok: true; result: GradeResult } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'AI 返回的评阅结果不是 JSON 对象' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
    return { ok: false, reason: 'AI 评阅结果缺少有效的 score 字段（数字）' }
  }
  if (r.score < 0 || r.score > 100) {
    return { ok: false, reason: `AI 评阅 score 超出 0-100 范围：${r.score}` }
  }
  for (const field of ['hitPoints', 'missedPoints', 'deductions', 'suggestions']) {
    if (!Array.isArray(r[field])) {
      return { ok: false, reason: `AI 评阅结果缺少 ${field} 数组字段` }
    }
    if ((r[field] as unknown[]).some((x) => typeof x !== 'string')) {
      return { ok: false, reason: `AI 评阅结果 ${field} 含非字符串元素` }
    }
  }
  if (typeof r.structureNote !== 'string') {
    return { ok: false, reason: 'AI 评阅结果缺少 structureNote 字符串字段' }
  }
  const list = (k: string) => (r[k] as string[]).filter((s) => s.trim())
  return {
    ok: true,
    result: {
      score: Math.round(r.score),
      maxScore: 100,
      hitPoints: list('hitPoints'),
      missedPoints: list('missedPoints'),
      deductions: list('deductions'),
      suggestions: list('suggestions'),
      structureNote: r.structureNote,
      disclaimer: DISCLAIMER,
    },
  }
}

/**
 * Web-only accuracy guard (added in v4).
 *
 * The real model mixed up the three closely related lists about 中国式现代化
 * (e.g. counted "坚持中国共产党领导" — a 本质要求 / 重大原则 — among the five
 * 中国特色). This is general course knowledge from the 二十大报告, NOT a per-
 * question reference answer: the 67 subjective questions keep no reference answer.
 * It is inserted as a second system message by the Worker only, so the desktop
 * proxy's prompts (and the contract test's equality on everything else) are untouched.
 */
export const WEB_ACCURACY_GUARD =
  '准确性要求（务必遵守）：\n' +
  '1. 只依据题干、材料、学生作答和教材通行表述作判断；不确定的表述要说明“建议以教材原文为准”，不得编造引文、会议、数字或年份。\n' +
  '2. 严格区分下列三组概念，不得混用、互相替代或把其中一组的条目算作另一组的采分点：\n' +
  '   - 中国式现代化的中国特色（五个方面）：人口规模巨大的现代化；全体人民共同富裕的现代化；物质文明和精神文明相协调的现代化；人与自然和谐共生的现代化；走和平发展道路的现代化。\n' +
  '   - 中国式现代化的本质要求（九个方面）：坚持中国共产党领导，坚持中国特色社会主义，实现高质量发展，发展全过程人民民主，丰富人民精神世界，实现全体人民共同富裕，促进人与自然和谐共生，推动构建人类命运共同体，创造人类文明新形态。\n' +
  '   - 推进中国式现代化必须牢牢把握的重大原则（五个）：坚持和加强党的全面领导，坚持中国特色社会主义道路，坚持以人民为中心的发展思想，坚持深化改革开放，坚持发扬斗争精神。\n' +
  '3. 其他易混概念同样不得混用：\n' +
  '   - 新发展理念：创新、协调、绿色、开放、共享；新发展格局：以国内大循环为主体、国内国际双循环相互促进。\n' +
  '   - 总体国家安全观的“五大要素”：以人民安全为宗旨，以政治安全为根本，以经济安全为基础，以军事、科技、文化、社会安全为保障，以促进国际安全为依托；它与总体国家安全观核心要义的“十个坚持”是两组不同表述。\n' +
  '   - 全面依法治国总目标：建设中国特色社会主义法治体系、建设社会主义法治国家；法治体系的内容（完备的法律规范体系、高效的法治实施体系、严密的法治监督体系、有力的法治保障体系、完善的党内法规体系）不是总目标本身。\n' +
  '4. 题目问哪一组就按哪一组评；评阅或回答前先在心里确认“本题问的是哪一组、共几条”，再逐条比对；学生写全了该组条目就不要再以其他组的条目作为“遗漏内容”扣分。'

/** Insert the guard right after the leading system message (or first, when there is none). */
export function withAccuracyGuard(messages: ChatMessage[]): ChatMessage[] {
  const guard: ChatMessage = { role: 'system', content: WEB_ACCURACY_GUARD }
  const i = messages.length > 0 && messages[0].role === 'system' ? 1 : 0
  return [...messages.slice(0, i), guard, ...messages.slice(i)]
}
