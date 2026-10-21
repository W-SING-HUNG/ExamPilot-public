#!/usr/bin/env node
/**
 * Public-information gate.
 *
 * Implements the automated portion of docs/information-governance.md.
 *
 * SCOPE — what each mode actually inspects (see docs §4):
 *
 *   (default)      index ("staged") file CONTENT  +  commit metadata
 *   --commit <rev> that commit's tree file CONTENT + commit metadata
 *   --worktree     working-tree file CONTENT      +  commit metadata
 *   --all-refs     every reachable blob CONTENT   +  all commit metadata
 *
 * Content scanning and metadata scanning are separate and are reported
 * separately. This tool does NOT scan the full content of every historical
 * commit unless `--all-refs` is given.
 *
 * OUTPUT POLICY (see docs §2 and §5): findings never print the matched text.
 * Only the rule id, a path (or commit sha) and a rule description are emitted,
 * so a detected credential, private path or personal datum is not re-disclosed
 * into CI logs. A path that itself looks sensitive is redacted.
 *
 * LIMITS: only known patterns are detected. This does not replace human review,
 * and a clean run is not proof that the repository holds nothing sensitive.
 *
 * Exit code 1 when a blocking (SECRET / INTERNAL) finding or a forbidden path
 * is present; 0 otherwise. REVIEW-severity notes never fail the build.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Flagged vocabulary (assembled from fragments so this file's own pattern table
// does not match itself).
//
// AI tool names are NOT secrets — see `PROCESS_CONTEXT` below.
// ---------------------------------------------------------------------------
const FRAG = {
  // Kept for identifying a tool name inside a private-collaboration phrase. A
  // bare tool name is public; only the surrounding process language is not.
  assistantTools: ['Clau' + 'de', 'Chat' + 'GPT', 'Co' + 'pilot', 'Gem' + 'ini'],
  codingAgents: ['De' + 'vin', 'Code' + 'x'],
  processWords: ['提' + '示词', 'AI' + ' Agent', 'sub' + 'agent', 'agent ' + '分工', '聊天' + '记录', '对话' + '记录'],
  privateLabels: ['内部' + '工作流', '内部' + '协作记录', '私人' + '偏好', '我的' + '提示词', '我们' + '的对话'],
  validationClaims: ['独立' + '验收', '独立' + '审查', 'independently ' + 'validated', 'independent ' + 'review'],
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (arr, flags = '') => new RegExp(`(${arr.map(esc).join('|')})`, flags)

/**
 * Everything that identifies an AI helper by name. Used to build the
 * "private collaboration" rules below, NOT as a rule on its own.
 */
const AI_TOOL_NAME = [...FRAG.assistantTools, ...FRAG.codingAgents, 'Cursor']

/**
 * THE RULE THIS REPLACED, AND WHY.
 *
 * An earlier version flagged any occurrence of a tool name as INTERNAL. That was
 * wrong twice over:
 *
 *   1. It treated a public product name as a secret, so `assisted by Claude` —
 *      an honest statement of how the work was done — was blocked, while the
 *      policy explicitly forbids hiding AI involvement.
 *   2. It punished disclosure and rewarded silence, which is the opposite of an
 *      information-governance control.
 *
 * What actually needs protecting is the PRIVATE RECORD: transcripts, internal
 * instructions, task assignments, someone's personal prompts. A tool name is
 * sensitive only when it appears inside that kind of content. So the name is no
 * longer matched on its own; the surrounding process vocabulary is.
 */
const AI_TOOL_ALT = alt(AI_TOOL_NAME, 'i')

/**
 * Phrases that turn "a tool name" into "a private collaboration record".
 * Deliberately narrow: these describe a private artefact (a log, a transcript,
 * an instruction file), not merely the fact that a tool was used.
 */
const PRIVATE_COLLAB_CONTEXT = [
  // "Claude conversation", "Codex chat log", "transcript of our session"
  `${AI_TOOL_ALT.source}\\s*(?:${'聊天' + '记录'}|${'对话' + '记录'}|conversation|chat\\s*log|transcript|session\\s*log)`,
  // "prompts I gave Claude", "my prompt for Codex"
  `(?:my|our|${'我的'}?|${'我们' + '的'})?\\s*(${'提' + '示词'}|prompt)s?\\s+(?:for|to|given\\s+to)\\s+${AI_TOOL_ALT.source}`,
  // "internal instructions for Claude", "private rules given to Codex"
  `(${'内部' + '工作流'}|${'内部' + '协作记录'}|${'私人' + '偏好'}|internal\\s+instructions?|private\\s+instructions?)\\s*(?:for|to|given\\s+to)?\\s*${AI_TOOL_ALT.source}`,
]

// ---------------------------------------------------------------------------
// De-obfuscation
//
// A text matcher that reads raw source is trivially defeated by writing the
// value in a form the matcher cannot see: `\uXXXX` escapes, character-code
// concatenation, or `'a' + 'b'` splitting. That is not a hypothetical — a real
// private document name was once committed to this repository inside a test
// fixture precisely because splitting the literal kept the gate quiet.
//
// Every line is therefore scanned twice: as written, and in a normalised form
// with escapes decoded and adjacent string literals joined. Rules see both.
// A third pass reports the obfuscation itself (see `obfuscated-literal`), so a
// value can be hidden from the matcher but not from the maintainer.
// ---------------------------------------------------------------------------

/** Decode `\uXXXX`, `\u{...}` and `\xXX` escapes so encoded values are visible. */
export function decodeEscapes(text) {
  if (typeof text !== 'string' || !text.includes('\\')) return text
  return text
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (m, h) => {
      const cp = Number.parseInt(h, 16)
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(Number.parseInt(h, 16)))
}

const STRING_PART = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g

/**
 * Join adjacent string literals (`'a' + 'b'` -> `'ab'`) so a value split across
 * concatenation is visible as one token. Repeated until stable, so chained
 * splits collapse fully. Non-literal operands (`PDF_EXT`, `String.fromCharCode`)
 * are left in place; the point is to defeat splitting, not to evaluate code.
 */
export function flattenConcatenation(line) {
  if (typeof line !== 'string' || !line.includes('+')) return line
  let out = line
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(
      /(['"])((?:(?!\1)[^\\\n]|\\.)*)\1\s*\+\s*(['"])((?:(?!\3)[^\\\n]|\\.)*)\3/g,
      (m, q1, a, q3, b) => q1 + a + b + q3,
    )
    if (next === out) break
    out = next
  }
  return out
}

/** Count the concatenation operators joining string literals on one line. */
function concatParts(line) {
  const literals = line.match(STRING_PART)
  if (!literals || literals.length < 2) return 0
  const joins = line.match(/['"]\s*\+\s*['"]/g)
  return joins ? joins.length + 1 : 0
}

const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{4,}/

/**
 * Placeholder account / local-part names that may legitimately appear in
 * fixtures and examples. Matched against the CAPTURED segment, never the whole
 * line, so an unrelated comment cannot excuse a real value.
 */
const PLACEHOLDER_ACCOUNT =
  /^(?:synthetic|example|test|dummy|fake|sample|placeholder|your[-_]?|user|username|someuser|foo|bar|<.*>)/i

/** First capture group of `re` in `line`, or '' when there is no match. */
function capturedSegment(re, line) {
  const m = line.match(re)
  return m && m[1] ? m[1] : ''
}

/**
 * A finding rule.
 *   severity: 'SECRET' | 'INTERNAL' | 'REVIEW'  (REVIEW = advisory only)
 *   allow: predicate (file, line) => true to suppress a legitimate match
 */
export const RULES = [
  // ---- SECRET -------------------------------------------------------------
  {
    id: 'credential-literal',
    severity: 'SECRET',
    // Prefixes for the providers this project can plausibly meet, plus the
    // generic shapes that leak most often. Deliberately not exhaustive — a
    // pattern list is never a guarantee, see the LIMITS note at the top.
    re: /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/,
    desc: 'provider credential literal',
  },
  {
    id: 'private-key-block',
    severity: 'SECRET',
    re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/,
    desc: 'private key block',
  },
  {
    // A secret smuggled inside a URL: `postgres://user:password@host/db`.
    id: 'credential-in-uri',
    severity: 'SECRET',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]{6,}@[^\s/'"`]+/i,
    desc: 'credential embedded in a connection URI',
    allow: (_f, line) => /(your-|example|placeholder|dummy|fake|sample|user:pass|:password@|<[^>]+>)/i.test(line),
  },
  {
    id: 'assigned-secret',
    severity: 'SECRET',
    // Two value forms are matched. A quoted literal was the ONLY form covered
    // before, which left the shapes this project actually uses uncovered:
    //
    //   AI_API_KEY=<value>        (.env — the form README tells users to create)
    //   "apiKey": "<value>"       (JSON — the shape of server/ai-config.json)
    //   apiKey: <value>           (YAML)
    //
    // A credential with no known provider prefix (a self-hosted gateway token)
    // was therefore missed entirely by both this rule and `credential-literal`.
    // The unquoted branch closes that gap without weakening the quoted branch.
    //
    // The unquoted pattern is deliberately narrow, because a bare `key = ...`
    // appears throughout ordinary code:
    //   - 20+ characters (a placeholder is short, a real token is not)
    //   - one opaque token: letters, digits, `_`, `-` only — no dots, spaces,
    //     parentheses or slashes, so `process.env.AI_CONFIG_TOKEN`,
    //     `String.fromCharCode(...)` and `key={item}` never match
    //   - or a JWT shape, the one opaque format that legitimately holds dots
    // Identifier matching keeps the `api`-prefixed spellings, so a React
    // `key=` prop is never read as a credential name.
    re: /(api[_-]?key|apikey|secret|password|passwd|token|credential)['"]?\s*[:=]\s*(?:['"]([^'"\s]{12,})['"]|((?:[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_./-])))/i,
    desc: 'assigned secret value',
    // Only the ASSIGNED VALUE may be excused as a placeholder. Excusing the
    // whole line let a real key through whenever a comment nearby said
    // "sample" or "example" — the rule must look at the value it matched.
    allow: (_f, line) => {
      const m = line.match(
        /(?:api[_-]?key|apikey|secret|password|passwd|token|credential)['"]?\s*[:=]\s*(?:['"]([^'"\s]{12,})['"]|((?:[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_./-])))/i,
      )
      if (!m) return false
      // Group 1 = quoted value, group 2 = unquoted value.
      const value = m[1] ?? m[2] ?? ''
      return (
        /^(?:your[-_]|<|\.\.\.|\$\{|xxx|\*{3})/i.test(value) ||
        /^(?:example|placeholder|dummy|fake|sample|shared[-_]?secret|super[-_]?secret|changeme|redacted|none|null|todo)/i.test(
          value,
        ) ||
        /^[x*.-]+$/i.test(value)
      )
    },
  },

  // ---- INTERNAL: local identity and filesystem ---------------------------
  {
    id: 'windows-user-path',
    severity: 'INTERNAL',
    // Forward slashes are just as common as backslashes in Windows paths.
    re: /[A-Za-z]:[\\/]{1,2}(Users|AppData|Documents|Desktop)[\\/]{1,2}([^\\/'"\s]+)/i,
    desc: 'local Windows user path',
    // The profile segment itself must be a published placeholder. Checking the
    // captured segment — not the whole line — is what stops `example` in an
    // unrelated comment from excusing a real account name.
    allow: (_f, line) =>
      PLACEHOLDER_ACCOUNT.test(
        capturedSegment(/[A-Za-z]:[\\/]{1,2}(?:Users|AppData|Documents|Desktop)[\\/]{1,2}([^\\/'"\s]+)/i, line),
      ),
  },
  {
    id: 'posix-home-path',
    severity: 'INTERNAL',
    re: /\/(Users|home)\/([A-Za-z0-9._-]+)\//,
    desc: 'local POSIX home path',
    allow: (_f, line) => PLACEHOLDER_ACCOUNT.test(capturedSegment(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//, line)),
  },
  {
    id: 'personal-email',
    severity: 'INTERNAL',
    // Any consumer mailbox, not only the Chinese and US providers listed before.
    re: /([A-Za-z0-9._%+-]+)@(?:[A-Za-z0-9-]+\.)?(?:gmail|qq|163|126|outlook|hotmail|yahoo|foxmail|proton|protonmail|icloud|aol|gmx|zoho|yandex|mail|tutanota)\.[a-z]{2,}/i,
    desc: 'personal email address',
    // Reserve the published placeholder local-parts and the RFC 2606 test
    // domains; a real mailbox is neither.
    allow: (_f, line) => {
      const m = line.match(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[a-z]{2,})/i)
      if (!m) return false
      return (
        PLACEHOLDER_ACCOUNT.test(m[1]) ||
        /^(?:example|test|invalid|localhost)\.(?:com|org|net|invalid|test)$/i.test(m[2])
      )
    },
  },

  // ---- INTERNAL: private source material ---------------------------------
  {
    id: 'source-doc-name',
    severity: 'INTERNAL',
    // A quoted document path, i.e. something that NAMES a file. A bare
    // extension (`'.pdf'`) is a file-extension constant and a glob (`*.pdf`) is
    // a rule, so both are exempt — what matters is a name in front of `.pdf`.
    re: /["'][^"'\n]*[^\s"'*.]\.pdf["']/i,
    desc: 'hardcoded document filename (may disclose private source material)',
    allow: (f, line) =>
      /\.gitignore$|\.gitattributes$|PULL_REQUEST_TEMPLATE/.test(f) ||
      /^\s*\*?\.pdf\b/.test(line.trim()) ||
      /[,，、]?\*\.pdf/.test(line),
  },

  // ---- INTERNAL: obfuscated content --------------------------------------
  //
  // NOTE ON SCOPE. An earlier version of this rule blocked any literal holding
  // several `\uXXXX` escapes. That was too broad: legitimate i18n tables, tests
  // that assert on escapes, and escaped CJK punctuation all tripped it. Detecting
  // "looks encoded" is the wrong goal — an escape is only a problem when the
  // DECODED text is something that must not be published.
  //
  // The decode pass already runs for every line, so a hidden document name or
  // path is now caught by the ordinary rules once decoded. What remains here is
  // the narrow signal that cannot be expressed any other way: escaped text joined
  // across string concatenation, which is the exact shape the historical leak
  // used. A plain escaped literal is left alone.
  {
    id: 'obfuscated-cjk-literal',
    severity: 'INTERNAL',
    re: /\\u(?:3[0-9a-f]{3}|4[0-9a-f]{3}|5[0-9a-f]{3}|6[0-9a-f]{3}|7[0-9a-f]{3}|8[0-9a-f]{3}|9[0-9a-f]{3}|[a-f][0-9a-f]{3})['"]\s*\+\s*['"](?:\\u|\\x)/i,
    desc: 'escaped text split across literals — decode before committing',
  },

  // ---- INTERNAL: development tooling and process -------------------------
  {
    // A tool NAME is public. This rule fires only when a name is bound to a
    // private artefact — a transcript, personal prompts, internal instructions.
    // See the block comment on `PRIVATE_COLLAB_CONTEXT` for why the previous
    // "any tool name is INTERNAL" rule was removed.
    id: 'private-collaboration-record',
    severity: 'INTERNAL',
    re: new RegExp(`(?:${PRIVATE_COLLAB_CONTEXT.join('|')})`, 'i'),
    desc: 'private collaboration record (transcript / internal instructions)',
  },
  {
    // Kept as a REVIEW-level signal, not a block: naming an AI assistant as a
    // contributor is a normal, honest engineering statement. It is surfaced only
    // so a reviewer can confirm the wording is accurate, never to suppress it.
    id: 'ai-attribution-note',
    severity: 'REVIEW',
    re: new RegExp(
      `(?:assisted|generated|written|built|developed|authored|created)\\s+by\\s+(?:${AI_TOOL_ALT.source})|(?:${AI_TOOL_ALT.source})\\s+(?:assisted|helped)`,
      'i',
    ),
    desc: 'AI attribution — confirm the statement is accurate (not a violation)',
  },
  {
    id: 'process-disclosure',
    severity: 'INTERNAL',
    re: alt([...FRAG.processWords, ...FRAG.privateLabels]),
    desc: 'internal process or private-record disclosure',
  },

  // ---- REVIEW: phrasing that must match real evidence --------------------
  {
    id: 'validation-claim',
    severity: 'REVIEW',
    // Phrasings that assert outside validation. "独立源码审查" was missing and
    // is exactly the form this project published, so the list now covers the
    // compound-word variants rather than only the bare "独立审查".
    re: alt(
      [
        ...FRAG.validationClaims,
        '独立' + '源码审查',
        '独立' + '代码审查',
        '第三方' + '审查',
        '第三方' + '验收',
        '外部' + '审计',
      ],
      'i',
    ),
    desc: 'validation claim — confirm independent evidence exists',
  },
]

/**
 * Paths that must NEVER be committed, independent of their content.
 * `.gitignore` alone is not a guarantee (`git add -f` bypasses it), so the gate
 * checks the candidate path list directly.
 *
 * `sensitiveName: true` marks a rule whose matched path EMBEDS variable, private
 * content (a document title). Such a path is redacted in the report. Rules that
 * match fixed, generic names — repository constants or dotted `.env` variants —
 * are reported verbatim, because naming them discloses nothing and keeps the
 * report actionable.
 */
export const FORBIDDEN_PATHS = [
  { id: 'private-course-bank', match: (p) => p === 'data/bank.json' },
  { id: 'private-course-bank', match: (p) => p === 'data/local-bank.json' },
  { id: 'generated-bank-loader', match: (p) => p === 'src/lib/local-bank.generated.ts' },
  { id: 'extracted-source-text', match: (p) => p === 'tools/pdf_text.txt' || p === 'tools/parse_out.txt' },
  { id: 'ai-gateway-credentials', match: (p) => p === 'server/ai-config.json' },
  {
    id: 'environment-secrets',
    // Any `.env` or dotted variant (`.env.local`, `.env.production.local`,
    // `.env.development.local`, …), case-insensitively and at any depth.
    // Credential-free templates (`.env.example`, `.env.sample`, `.env.template`)
    // stay allowed.
    match: (p) => {
      const base = p.split('/').pop().toLowerCase()
      if (/^\.env\.(example|sample|template)$/.test(base)) return false
      return base === '.env' || base.startsWith('.env.')
    },
  },
  {
    id: 'private-source-pdf',
    // The file NAME is itself the private datum (e.g. a titled course document),
    // so it must never be echoed into a log.
    sensitiveName: true,
    match: (p) => /\.pdf$/i.test(p) && !/^data\/sample-/.test(p),
  },
  { id: 'local-backup-data', match: (p) => /\.exampilot-backup\.json$/i.test(p) },
  // Local-only tooling that must never be published: it is gitignored, but
  // `git add -f` bypasses .gitignore, so the path is blocked directly.
  { id: 'local-only-tooling', match: (p) => /^tools\/(?:\.gh_token|staged\.txt|commit-msg[^/]*\.txt)$/i.test(p) },
  {
    // Local learning data and exports. The full-bank export is named
    // `exampilot-bank.json` and the history export `exampilot-history-*.csv`;
    // both are private user data even though neither is a backup snapshot.
    id: 'local-learning-data',
    match: (p) => /(^|\/)exampilot-(?:bank\.json|history-[^/]*\.csv)$/i.test(p),
  },
  {
    // Scratch directories are working files by definition: build logs, throwaway
    // probes, screenshots. They are gitignored but carry no publication intent.
    id: 'scratch-workspace',
    match: (p) => /^(?:scratch|tools\/\.e2e-uploads)\//i.test(p),
  },
]

/**
 * File-level allowlist: files whose matches are structural — they *define* the
 * policy vocabulary, or are the fixture that proves a rule fires. Never used to
 * silence credentials; a regression test asserts SECRET rules still fire inside
 * allowlisted files.
 */
export const FILE_ALLOW = [
  { file: /^tools\/public-info-check\.mjs$/, rules: ['private-collaboration-record', 'process-disclosure'] },
  { file: /^docs\/information-governance\.md$/, rules: ['process-disclosure', 'validation-claim'] },
]

/**
 * EXACT-LINE exemptions — reviewed false positives, one literal line at a time.
 *
 * Why this exists: the `process-disclosure` vocabulary includes ordinary product
 * words (「提示词」 and 「对话记录」). In this codebase those words legitimately
 * appear in UI copy and code comments — "the system prompt is clean", "clear the
 * conversation history" — which are product behaviour, not an author's private
 * prompt library. A rule cannot tell them apart by keyword alone.
 *
 * DESIGN CONSTRAINTS (these are the point of the mechanism, not decoration):
 *
 *   1. EXACT match on the fully trimmed line. Not a substring test, not a regex,
 *      not a keyword. Changing a single character voids the exemption, so it
 *      cannot silently grow to cover unrelated content later.
 *   2. Scoped to ONE rule id (`process-disclosure`) and ONE file (or one commit).
 *      SECRET rules have no entry here and can never be exempted by it.
 *   3. The vocabulary lists (`FRAG`) are NOT touched. Detection stays as strong
 *      as before everywhere else — a real private prompt record still blocks.
 *   4. Every entry carries its justification, so the next reviewer can audit the
 *      decision without re-deriving it.
 *
 * Adding an entry is a deliberate, reviewable act. It is not a way to make a
 * failing build pass quickly.
 */
export const EXACT_LINE_EXEMPTIONS = [
  {
    rule: 'process-disclosure',
    file: /^src\/components\/FloatingAiAssistant\.tsx$/,
    line: '// 全新题目解析：使用干净规范的系统提示词',
    reason:
      'Code comment describing the assistant system prompt. Describes product behaviour; contains no private prompt, transcript or internal instruction.',
  },
  {
    rule: 'process-disclosure',
    file: /^src\/components\/FloatingAiAssistant\.tsx$/,
    line: '<button className="ai-win-btn" onClick={clearHistory} title="清空对话记录">',
    reason:
      'UI button tooltip「清空对话记录」 = "clear conversation history". End-user affordance, not a stored transcript.',
  },
  {
    rule: 'process-disclosure',
    commit: '909dcab765d9a9c3e77be152a03548e2aa3902b6',
    line: '行为不变：正则匹配结果、AI 提示词、消息裁剪、上下文传递、',
    reason:
      'Commit body enumerating what did NOT change; 「AI 提示词」 refers to the shipped system prompt, not an author prompt library.',
  },
]

/**
 * True when this exact line (and rule) has a reviewed exemption.
 *
 * `fileOrCommit` is a repo-relative path for content, or the full 40-char sha for
 * a commit body. Comparison is on the trimmed line so trailing whitespace or
 * CRLF does not defeat an exemption — but nothing else is normalised.
 */
export function isExactLineExempt(ruleId, fileOrCommit, line) {
  if (!ruleId || !fileOrCommit || typeof line !== 'string') return false
  const trimmed = line.trim()
  if (!trimmed) return false
  return EXACT_LINE_EXEMPTIONS.some((e) => {
    if (e.rule !== ruleId) return false
    if (e.line !== trimmed) return false
    return e.file ? e.file.test(fileOrCommit) : e.commit === fileOrCommit
  })
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|zip|gz)$/i

/**
 * Generated lockfiles are still scanned for SECRET material — a credential
 * written into one is a real leak. Only the vocabulary-style rules are skipped
 * there, because registry URLs, integrity hashes and package names would
 * otherwise produce noise that is not an author disclosure.
 */
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/
// De-duplicated defensively: a repeated id in this list would be a silent
// maintenance trap the next time a rule is renamed.
export const LOCKFILE_SKIPPED_RULES = [...new Set(RULES.filter((r) => r.severity !== 'SECRET').map((r) => r.id))]

export function fileAllows(rule, file) {
  return FILE_ALLOW.some((a) => a.file.test(file) && a.rules.includes(rule.id))
}

/**
 * True when a path's NAME is itself sensitive and must not be printed.
 *
 * Two sources of sensitivity:
 *   1. rules flagged `sensitiveName`, whose matched path embeds private content
 *      (e.g. a titled document — a real git path carries no quotes, so the
 *      content rules alone would miss it);
 *   2. content rules that can match inside a filename (local user paths,
 *      personal email).
 *
 * Fixed, generic names (`data/bank.json`, `.env.production.local`) are NOT
 * redacted: naming them discloses nothing and keeps the report actionable.
 */
export function isSensitivePath(p) {
  if (!p) return false
  if (FORBIDDEN_PATHS.some((rule) => rule.sensitiveName && rule.match(p))) return true
  return RULES.some((r) => r.severity !== 'REVIEW' && r.re.test(p))
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  // Capture stderr too: a failing git command must not spray raw diagnostics
  // into the log, and callers handle the failure explicitly.
  return execFileSync('git', args, {
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  })
}

/**
 * Read many blobs in one `git cat-file --batch` call.
 * Returns Map<sha, Buffer>.
 */
export function batchReadBlobs(shas) {
  const unique = [...new Set(shas)]
  const out = new Map()
  if (!unique.length) return out
  const input = unique.map((s) => s + '\n').join('')
  const buf = git(['cat-file', '--batch'], { input })
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const header = buf.toString('utf8', pos, nl)
    pos = nl + 1
    const parts = header.split(' ')
    if (parts.length < 3) continue // "<sha> missing"
    const [, type, sizeStr] = parts
    const size = Number.parseInt(sizeStr, 10)
    if (!Number.isFinite(size)) continue
    const content = buf.subarray(pos, pos + size)
    pos += size + 1
    if (type === 'blob') out.set(parts[0], Buffer.from(content))
  }
  return out
}

/** Files present in a commit tree: [{ path, sha }]. */
function commitTree(rev) {
  const out = git(['ls-tree', '-r', '-z', '--full-tree', rev], { encoding: 'utf8' })
  const files = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const m = entry.match(/^(\d+) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/)
    if (!m || m[2] !== 'blob') continue
    files.push({ path: m[4], sha: m[3] })
  }
  return files
}

/** Files staged in the index: [{ path, sha }]. */
function indexFiles() {
  const out = git(['ls-files', '-s', '-z'], { encoding: 'utf8' })
  const files = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const m = entry.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/)
    if (!m) continue
    // On an unmerged path the same file appears for stages 1..3; only stage 0 is
    // the resolved content.
    if (m[3] !== '0') continue
    files.push({ path: m[4], sha: m[2] })
  }
  return files
}

/** Every blob reachable from all refs: [{ path, sha }] (paths may be null). */
function allRefBlobs() {
  const out = git(['rev-list', '--objects', '--all'], { encoding: 'utf8' })
  const files = []
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})(?:\s([\s\S]+))?$/)
    if (!m) continue
    files.push({ path: m[2] || '(unknown path)', sha: m[1] })
  }
  return files
}

/** Commit metadata entries: [{ sha, message }] for the requested revs. */
function commitMessages(revs) {
  const out = git(['log', revs, '--format=%H%x1f%B%x1e'], { encoding: 'utf8' })
  const commits = []
  for (const entry of out.split('\x1e')) {
    const t = entry.trim()
    if (!t) continue
    const [sha, ...rest] = t.split('\x1f')
    commits.push({ sha, message: rest.join('\x1f') })
  }
  return commits
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Scan one text blob. Returns findings with NO matched text captured.
 * `where` is "path:line" for content or "commit <sha>" for metadata.
 *
 * Each line is matched in three forms so a value cannot be hidden by the way it
 * is written in source:
 *   - raw              what the file literally contains;
 *   - decoded          `\uXXXX` / `\xXX` escapes resolved;
 *   - flattened        adjacent string literals joined (`'a' + 'b'` -> `'ab'`).
 * The decoded and flattened forms exist because a real private document name
 * was previously committed in exactly that shape.
 */
export function scanText(text, where, fileForAllow = '', opts = {}) {
  const findings = []
  if (typeof text !== 'string' || text.includes('\0')) return findings
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    const decoded = decodeEscapes(line)
    const flattened = flattenConcatenation(decoded)
    const forms = decoded === line && flattened === decoded ? [line] : [...new Set([line, decoded, flattened])]
    const seen = new Set()
    for (const rule of RULES) {
      if (opts.skipRules && opts.skipRules.includes(rule.id)) continue
      if (seen.has(rule.id)) continue
      const matched = forms.filter((form) => rule.re.test(form))
      if (!matched.length) continue
      if (fileForAllow && fileAllows(rule, fileForAllow)) continue
      // Reviewed, exact-line exemptions (see EXACT_LINE_EXEMPTIONS). Checked on the
      // raw line only: an exemption names one literal source line, so it must not
      // be satisfied by a decoded or concatenation-flattened rendering of it.
      if (isExactLineExempt(rule.id, fileForAllow, line)) continue
      // Excuse only the forms that actually matched. Asking every form — including
      // the raw, un-decoded one — would suppress the finding whenever the joined
      // form is a placeholder but the source form does not parse as one at all.
      if (rule.allow && matched.every((form) => rule.allow(fileForAllow, form, i))) continue
      seen.add(rule.id)
      findings.push({ severity: rule.severity, rule: rule.id, desc: rule.desc, where: `${where}:${i + 1}` })
    }
  }
  return findings
}

/** Scan commit messages. Never captures the message text. */
export function scanCommitMetadata(commits) {
  const findings = []
  for (const { sha, message } of commits) {
    const where = `commit ${sha.slice(0, 10)}`
    // A commit message is a single logical unit: report the rule but never the
    // text, and do not emit one finding per matching line.
    const seen = new Set()
    for (const rawLine of message.split('\n')) {
      const decoded = decodeEscapes(rawLine)
      const flattened = flattenConcatenation(decoded)
      const forms =
        decoded === rawLine && flattened === decoded ? [rawLine] : [...new Set([rawLine, decoded, flattened])]
      for (const rule of RULES) {
        if (seen.has(rule.id)) continue
        // `source-doc-name` used to be skipped here on the theory that a commit
        // message is prose rather than a filename literal. That assumed a title
        // could not appear in a message, which is precisely what a message like
        // `feat: parse <document>.pdf` does — so it is scanned like any other.
        const matched = forms.filter((form) => rule.re.test(form))
        if (!matched.length) continue
        // Reviewed, exact-line exemptions. Scoped by full commit sha + exact line,
        // so an exemption granted to one historical commit body cannot excuse the
        // same wording arriving in a future commit message.
        if (isExactLineExempt(rule.id, sha, rawLine)) continue
        if (rule.allow && matched.every((form) => rule.allow('<commit>', form))) continue
        seen.add(rule.id)
        findings.push({ severity: rule.severity, rule: rule.id, desc: rule.desc, where })
      }
    }
  }
  return findings
}

/** Path-level hard block. Independent of content and of .gitignore. */
export function checkForbiddenPaths(paths) {
  const hits = []
  for (const p of paths) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.match(p)) hits.push({ rule: rule.id, path: p })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// collection per mode
// ---------------------------------------------------------------------------

export function collectTargets(mode, rev) {
  if (mode === 'worktree') {
    const files = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    return files.map((p) => ({ path: p, text: existsSync(p) ? readFileSync(p, 'utf8') : '' }))
  }
  if (mode === 'index') {
    const files = indexFiles()
    const blobs = batchReadBlobs(files.map((f) => f.sha))
    return files.map((f) => ({ path: f.path, text: blobs.get(f.sha)?.toString('utf8') ?? '' }))
  }
  if (mode === 'commit') {
    const files = commitTree(rev)
    const blobs = batchReadBlobs(files.map((f) => f.sha))
    return files.map((f) => ({ path: f.path, text: blobs.get(f.sha)?.toString('utf8') ?? '' }))
  }
  // all-refs: dedupe by blob sha, remember the first path seen for reporting
  const blobs = allRefBlobs()
  const bySha = new Map()
  for (const b of blobs) if (!bySha.has(b.sha)) bySha.set(b.sha, b.path)
  const contents = batchReadBlobs([...bySha.keys()])
  return [...contents.entries()].map(([sha, buf]) => ({
    path: bySha.get(sha) || '(unknown)',
    text: buf.toString('utf8'),
  }))
}

// ---------------------------------------------------------------------------
// rendering (redacted)
// ---------------------------------------------------------------------------

function safePath(path) {
  if (!path || path === '(unknown)') return '(unknown path)'
  return isSensitivePath(path) ? '(redacted path — its name matches a sensitive pattern)' : path
}

export function render({
  mode,
  rev,
  contentScanned,
  metadataScanned,
  metadataScope,
  contentLabel,
  findings,
  forbidden,
}) {
  const lines = []
  lines.push('public-information gate')
  lines.push(`  mode            : ${mode}${rev ? ` (${rev})` : ''}`)
  lines.push(`  ${contentLabel}`)
  lines.push(
    `  commit metadata : ${metadataScanned} commit message(s)${
      metadataScanned ? ` — scope: ${metadataScope || 'HEAD'}` : ''
    }`,
  )
  lines.push('')
  lines.push('  Note: findings below never include matched text, so detected credentials')
  lines.push('  or personal data are not re-disclosed into this log.')
  lines.push('')

  if (forbidden.length) {
    lines.push(`FORBIDDEN PATH — ${forbidden.length} file(s) must never be committed`)
    for (const f of forbidden) lines.push(`  [${f.rule}] ${safePath(f.path)}`)
    lines.push('')
  }

  const ORDER = { SECRET: 0, INTERNAL: 1, REVIEW: 2 }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule))
  const bySev = { SECRET: [], INTERNAL: [], REVIEW: [] }
  for (const f of findings) bySev[f.severity].push(f)

  for (const sev of ['SECRET', 'INTERNAL', 'REVIEW']) {
    const list = bySev[sev]
    if (!list.length) continue
    lines.push(`${sev} — ${list.length} finding(s)`)
    for (const f of list) {
      const where = f.where.startsWith('commit ')
        ? f.where
        : safePath(f.where.replace(/:\d+$/, '')) + (f.where.match(/:\d+$/) || [''])[0]
      lines.push(`  [${f.rule}] ${where}`)
      lines.push(`      ${f.desc}`)
    }
    lines.push('')
  }

  const blocking = bySev.SECRET.length + bySev.INTERNAL.length + forbidden.length
  if (blocking) {
    lines.push(`FAIL: ${blocking} blocking finding(s). See docs/information-governance.md.`)
  } else if (bySev.REVIEW.length) {
    lines.push(`PASS with ${bySev.REVIEW.length} advisory note(s) to confirm manually.`)
  } else {
    lines.push('PASS: no known-pattern violation found.')
  }
  lines.push('Note: this only covers the modes listed above and only known patterns.')
  lines.push('A clean run is not proof that the repository holds nothing sensitive.')
  void contentScanned
  return { text: lines.join('\n'), blocking }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const has = (f) => argv.includes(f)
  const valueOf = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  let mode = 'index'
  let rev = null
  if (has('--worktree')) mode = 'worktree'
  if (has('--all-refs')) mode = 'all-refs'
  if (has('--commit')) {
    mode = 'commit'
    rev = valueOf('--commit') || 'HEAD'
  }
  if (has('--index') || has('--staged')) mode = 'index'
  return { mode, rev, metadata: !has('--no-metadata') }
}

export function run(argv = process.argv.slice(2)) {
  const { mode, rev, metadata } = parseArgs(argv)

  let targets
  try {
    targets = collectTargets(mode, rev)
  } catch (e) {
    // An unusable revision must fail loudly but readably, never as a stack trace.
    process.stdout.write(
      [
        'public-information gate',
        `  mode            : ${mode}${rev ? ` (${rev})` : ''}`,
        '',
        `FAIL: cannot read the requested revision/tree (${rev ?? mode}).`,
        'Refusing to report PASS because the content could not be inspected.',
        '',
      ].join('\n'),
    )
    void e
    return 1
  }
  let findings = []
  let contentScanned = 0
  let lockfilesScanned = 0
  for (const t of targets) {
    if (BINARY_EXT.test(t.path)) continue
    contentScanned++
    if (LOCKFILE.test(t.path)) {
      // Lockfiles: SECRET rules still run; only vocabulary rules are skipped.
      lockfilesScanned++
      findings = findings.concat(scanText(t.text, t.path, t.path, { skipRules: LOCKFILE_SKIPPED_RULES }))
      continue
    }
    findings = findings.concat(scanText(t.text, t.path, t.path))
  }

  // Path-level block over exactly the candidate path list for this mode.
  const forbidden = checkForbiddenPaths(targets.map((t) => t.path))

  let metadataScanned = 0
  let metadataScope = ''
  if (metadata) {
    // The metadata scope must follow the SELECTED revision:
    //   all-refs -> every ref;  --commit <rev> -> that revision's ancestry;
    //   worktree/index -> HEAD (there is no other revision in play).
    const revs = mode === 'all-refs' ? '--all' : mode === 'commit' && rev ? rev : 'HEAD'
    const commits = commitMessages(revs)
    metadataScanned = commits.length
    metadataScope = mode === 'all-refs' ? 'all refs' : revs === 'HEAD' ? 'HEAD' : `ancestry of ${revs}`
    findings = findings.concat(scanCommitMetadata(commits))
  }

  const contentLabel =
    mode === 'worktree'
      ? `worktree content  : ${contentScanned} file(s) from the working tree${lockfilesScanned ? ` (incl. ${lockfilesScanned} lockfile, SECRET rules only)` : ''}`
      : mode === 'commit'
        ? `commit content  : ${contentScanned} file(s) in ${rev}${lockfilesScanned ? ` (incl. ${lockfilesScanned} lockfile, SECRET rules only)` : ''}`
        : mode === 'all-refs'
          ? `all-refs content: ${contentScanned} unique blob(s) across every ref${lockfilesScanned ? ` (incl. ${lockfilesScanned} lockfile, SECRET rules only)` : ''}`
          : `staged content  : ${contentScanned} file(s) from the index (what a commit would publish)${lockfilesScanned ? ` (incl. ${lockfilesScanned} lockfile, SECRET rules only)` : ''}`

  const { text, blocking } = render({
    mode,
    rev,
    contentScanned,
    metadataScanned,
    metadataScope,
    contentLabel,
    findings,
    forbidden,
  })
  process.stdout.write(text + '\n')
  return blocking ? 1 : 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(run())
