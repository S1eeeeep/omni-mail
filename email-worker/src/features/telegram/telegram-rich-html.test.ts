import { describe, expect, it } from 'vitest'
import { renderTelegramRichMessage } from './telegram-rich-html'

describe('Telegram rich HTML conversion', () => {
  it('keeps common formatting while discarding active content and unsafe links', () => {
    const rich = renderTelegramRichMessage('主题：A&B\nhttps://mail.example.com', `
      <style>.secret { color: red }</style><script>alert('x')</script>
      <h2>订单 <b>已完成</b></h2><p>查看 <a href="https://example.com/order?a=1&amp;b=2" onclick="evil()">订单</a></p>
      <p><a href="javascript:alert(1)">危险链接</a><img src="https://tracker.example/pixel" alt="收据"></p>
      <table><tr><th>项目</th><th>金额</th></tr><tr><td>A</td><td>10</td></tr></table>
      <div style="display:none">隐藏预览</div>
    `)
    expect(rich).toContain('<h2>订单 <b>已完成</b></h2>')
    expect(rich).toContain('<a href="https://example.com/order?a=1&amp;b=2">订单</a>')
    expect(rich).toContain('<table><tr><th>项目</th><th>金额</th></tr>')
    expect(rich).toContain('[图片：收据]')
    expect(rich).toContain('主题：A&amp;B')
    expect(rich).toContain('<a href="https://mail.example.com/">https://mail.example.com/</a>')
    expect(rich).not.toMatch(/script|onclick|javascript:|tracker\.example|隐藏预览|color: red/)
  })

  it('falls back for oversized or empty HTML', () => {
    expect(renderTelegramRichMessage('新邮件', '')).toBeNull()
    expect(renderTelegramRichMessage('新邮件', '<style>body{color:red}</style>')).toBeNull()
    expect(renderTelegramRichMessage('新邮件', `<p>${'a'.repeat(100_001)}</p>`)).toBeNull()
  })
})
