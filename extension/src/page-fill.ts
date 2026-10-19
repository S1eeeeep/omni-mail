type FillKind = 'email' | 'verification-code'

function visibleInput(input: HTMLInputElement): boolean {
  const rect = input.getBoundingClientRect()
  return !input.disabled && !input.readOnly && rect.width > 0 && rect.height > 0
}

function inputDescription(input: HTMLInputElement): string {
  return [
    input.name,
    input.id,
    input.placeholder,
    input.autocomplete,
    input.getAttribute('aria-label') || '',
    ...[...(input.labels || [])].map((label) => label.textContent || ''),
  ].join(' ')
}

function looksLikeEmailInput(input: HTMLInputElement): boolean {
  return input.type === 'email'
    || input.autocomplete === 'email'
    || /(?:e-?mail|邮箱)/i.test(inputDescription(input))
}

function looksLikeVerificationInput(input: HTMLInputElement): boolean {
  if (!['text', 'tel', 'number', 'password'].includes(input.type)) return false
  const description = inputDescription(input)
  if (input.autocomplete === 'one-time-code') return true
  if (/(?:验证码|校验码|动态码|安全码|登录码|verification|one[- ]time|passcode|\botp\b|\bpin\b)/i
    .test(description)) return true
  const length = input.maxLength
  return input.inputMode === 'numeric' && length >= 4 && length <= 8
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.focus()
}

export function fillPageValue(
  document: Document,
  lastFocusedInput: HTMLInputElement | null,
  kind: FillKind,
  value: string,
): { ok: true } | { ok: false; error: string } {
  const matches = kind === 'email' ? looksLikeEmailInput : looksLikeVerificationInput
  if (lastFocusedInput && document.contains(lastFocusedInput)
    && visibleInput(lastFocusedInput) && matches(lastFocusedInput)) {
    setInputValue(lastFocusedInput, value)
    return { ok: true }
  }
  const candidates = [...document.querySelectorAll<HTMLInputElement>('input')]
    .filter((input) => visibleInput(input) && matches(input))
  if (kind === 'verification-code' && candidates.length > 1) {
    return { ok: false, error: '检测到多个验证码输入框，请先点击要填入的输入框。' }
  }
  const input = candidates[0]
  if (!input) return { ok: false, error: kind === 'email'
    ? '当前页面没有找到邮箱输入框。'
    : '当前页面没有找到验证码输入框。' }
  setInputValue(input, value)
  return { ok: true }
}
