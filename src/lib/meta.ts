import { IS_WEB_EDITION } from './edition'

export const APP_VERSION = '0.2.0'

/**
 * Product branding. The desktop edition keeps its original strings unchanged;
 * the web edition uses the unified ExamPilot brand (independent study platform).
 */
export const BRAND = {
  en: 'ExamPilot',
  zh: '习概复习系统',
  positioning: '独立学习辅助平台',
  tagline: '系统化复习 · 精准诊断 · 高效备考',
  maintainer: '翁成航',
  copyright: '© 2026 翁成航 (Chenghang Weng)',
  github: 'W-SING-HUNG',
  repoUrl: 'https://github.com/W-SING-HUNG/ExamPilot-public',
  contentRights:
    '题库内容整理自课程学习资料，题目与答案的相关权利归原权利人所有；本软件署名不代表对题目内容主张原创版权。',
} as const

export const APP_NAME = IS_WEB_EDITION ? `${BRAND.en} ${BRAND.zh}` : 'ExamPilot 习概'
export const APP_DESC = IS_WEB_EDITION ? BRAND.tagline : '《习近平新时代中国特色社会主义思想概论》期末智能复习'
