import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

const MAX_SOURCE_CHARS = 100_000
const MAX_RICH_CHARS = 24_000
const MAX_RICH_BYTES = 32_000
const MAX_NODES = 1_000
const MAX_BLOCKS = 250
const MAX_DEPTH = 12
const ignoredTags = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
  'svg', 'form', 'input', 'button', 'meta', 'link', 'video', 'audio', 'picture',
  'source', 'canvas', 'textarea',
])
const inlineTags = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code',
  'mark', 'sub', 'sup',
])
const blockTags = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'table', 'tr', 'th', 'td', 'hr',
])

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function attribute(node: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value
}

function safeLink(value: string | undefined): string | null {
  if (!value || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['https:', 'mailto:', 'tel:'].includes(url.protocol)
      || ((url.protocol === 'https:') && (!url.hostname || url.username || url.password))) return null
    return url.toString()
  } catch { return null }
}

export function renderTelegramRichMessage(header: string, emailHtml: string): string | null {
  if (!emailHtml.trim() || emailHtml.length > MAX_SOURCE_CHARS) return null
  let nodes = 0
  let blocks = 0
  try {
    const fragment = parseFragment(emailHtml)
    const visit = (node: DefaultTreeAdapterTypes.Node, depth: number, inCell = false,
      preserveWhitespace = false): string => {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('rich_html_complexity')
      if (node.nodeName === '#text') {
        const value = (node as DefaultTreeAdapterTypes.TextNode).value
        return escapeHtml(preserveWhitespace ? value : value.replace(/\s+/g, ' '))
      }
      if (!('tagName' in node)) {
        return 'childNodes' in node
          ? node.childNodes.map((child) => visit(child, depth + 1, inCell, preserveWhitespace)).join('')
          : ''
      }
      const tag = node.tagName
      if (ignoredTags.has(tag) || attribute(node, 'hidden') !== undefined
        || attribute(node, 'aria-hidden') === 'true'
        || /(?:display\s*:\s*none|visibility\s*:\s*hidden|max-height\s*:\s*0\b)/i
          .test(attribute(node, 'style') ?? '')) return ''
      if (tag === 'img') {
        const alt = (attribute(node, 'alt') ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80)
        return escapeHtml(alt ? `[图片：${alt}]` : '[图片]')
      }
      if (tag === 'br') return inCell ? ' ' : '<br>'
      if (tag === 'hr') return inCell ? ' ' : '<hr/>'
      const children = 'childNodes' in node
        ? node.childNodes.map((child) => visit(child, depth + 1, inCell || tag === 'td' || tag === 'th',
          preserveWhitespace || tag === 'pre')).join('') : ''
      if (!children.trim()) return ''
      if (tag === 'a') {
        const link = safeLink(attribute(node, 'href'))
        return link ? `<a href="${escapeHtml(link)}">${children}</a>` : children
      }
      if (inlineTags.has(tag)) return `<${tag}>${children}</${tag}>`
      if (inCell && blockTags.has(tag)) return `${children} `
      if (blockTags.has(tag)) {
        if (++blocks > MAX_BLOCKS) throw new Error('rich_html_blocks')
        return `<${tag}>${children}</${tag}>`
      }
      // 邮件常用 div/span 布局；不携带其 CSS，仅保留文字与段落边界。
      return tag === 'div' && !inCell ? `${children}<br>` : children
    }
    const content = fragment.childNodes.map((node) => visit(node, 0)).join('')
      .replace(/(?:<br>){3,}/g, '<br><br>').trim()
    if (!content || !content.replace(/<[^>]*>/g, '').trim()) return null
    const headerLines = header.split('\n')
    const siteLink = safeLink(headerLines.pop())
    if (!siteLink) return null
    const headerHtml = headerLines.map(escapeHtml).join('<br>')
    const rich = `<p>${headerHtml}<br><a href="${escapeHtml(siteLink)}">${escapeHtml(siteLink)}</a></p>${content}`
    return rich.length <= MAX_RICH_CHARS && new TextEncoder().encode(rich).byteLength <= MAX_RICH_BYTES
      ? rich : null
  } catch {
    return null
  }
}
