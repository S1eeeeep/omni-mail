export const OFFICIAL_MAIL_SOURCE_IDS = [
  'omnimail', 'icloud', 'linuxdo', 'gmail', 'microsoft', 'qq', 'naver', 'yandex',
] as const

export type OfficialMailSourceId = typeof OFFICIAL_MAIL_SOURCE_IDS[number]

export const MAIL_SOURCE_WEB_PATHS = {
  omnimail: '/mail/inbox',
  icloud: '/icloud',
  linuxdo: '/linux-do-mail',
  gmail: '/gmail',
  microsoft: '/microsoft',
  qq: '/qq-mail',
  naver: '/naver-mail',
  yandex: '/yandex-mail',
} as const satisfies Record<OfficialMailSourceId, string>
