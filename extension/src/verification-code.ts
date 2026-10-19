const CONTEXT_PATTERN = /(?:验证码|校验码|动态码|安全码|登录码|一次性密码|verification\s+code|security\s+code|authentication\s+code|login\s+code|one[- ]time\s+(?:code|password|passcode)|passcode|\botp\b|\bpin\b)/gi
const CODE_PATTERN = /(?<!\d)\d{4,8}(?!\d)/g
const MAX_CONTEXT_DISTANCE = 64

interface Candidate {
  code: string
  distance: number
  index: number
}

export function extractVerificationCode(...parts: Array<string | null | undefined>): string {
  const text = parts.filter(Boolean).join('\n')
  if (!text) return ''
  const contexts = [...text.matchAll(CONTEXT_PATTERN)]
  if (!contexts.length) return ''
  const candidates: Candidate[] = [...text.matchAll(CODE_PATTERN)].flatMap((match) => {
    const index = match.index ?? 0
    const distance = Math.min(...contexts.map((context) => {
      const contextIndex = context.index ?? 0
      const contextEnd = contextIndex + context[0].length
      if (index >= contextIndex && index <= contextEnd) return 0
      return Math.min(Math.abs(index - contextEnd), Math.abs(contextIndex - (index + match[0].length)))
    }))
    return distance <= MAX_CONTEXT_DISTANCE ? [{ code: match[0], distance, index }] : []
  })
  candidates.sort((left, right) => left.distance - right.distance || left.index - right.index)
  return candidates[0]?.code || ''
}
