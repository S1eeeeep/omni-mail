import { describe, expect, it } from 'vitest'
import { extractVerificationCode } from './verification-code'

describe('verification code extraction', () => {
  it.each([
    [['Your verification code', 'Code 123456'], '123456'],
    [['登录验证码：2468，请勿告诉他人'], '2468'],
    [['Use OTP 004921 to continue'], '004921'],
    [['Your one-time passcode is 87654321'], '87654321'],
    [['PIN: 73910'], '73910'],
  ])('extracts an explicitly labelled code from %j', (parts, expected) => {
    expect(extractVerificationCode(...parts)).toBe(expected)
  })

  it('chooses the number closest to the verification label', () => {
    expect(extractVerificationCode(
      'Order 778899 was created. Your verification code is 135790.',
    )).toBe('135790')
  })

  it.each([
    ['Your order 246810 has shipped'],
    ['Meeting scheduled for 2026-08-30'],
    ['Call 13800138000 for support'],
    ['Verification complete. Reference 123456789'],
    ['Your code is 123'],
  ])('does not treat unrelated or invalid numbers as codes: %s', (text) => {
    expect(extractVerificationCode(text)).toBe('')
  })
})
