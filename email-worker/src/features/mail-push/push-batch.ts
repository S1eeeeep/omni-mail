export interface PendingPush {
  event_id: string
  sequence: number
  payload_json: string
  announced: number
  attempts: number
}

const MAX_BYTES = 3 * 1024 * 1024
const INLINE_BYTES = 256 * 1024
const INLINE_MESSAGE_BYTES = 64 * 1024
const MAX_INLINE = 32
export const BODY_BATCH_SIZE = 32

// Reserve metadata coverage first, then use spare space for ordinary OTP
// bodies. Inline content never displaces another event's route/sequence proof.
export function deliveryBatch(input: PendingPush[], metadata: boolean) {
  const encoder = new TextEncoder()
  const rows: PendingPush[] = []
  const events: Record<string, unknown>[] = []
  const bodies: { text: string; fullBytes: number; metadataBytes: number }[] = []
  let bytes = 4096
  for (const row of input) {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    const event: Record<string, unknown> = { ...payload, id: row.event_id, sequence: row.sequence }
    const fullBytes = encoder.encode(JSON.stringify(event)).byteLength
    const text = typeof event.text === 'string' ? event.text : ''
    if (metadata && event.state === 'ready') { event.text = ''; event.metadata_only = true }
    const metadataBytes = encoder.encode(JSON.stringify(event)).byteLength
    if (bytes + metadataBytes > MAX_BYTES) break
    bytes += metadataBytes
    rows.push(row); events.push(event); bodies.push({ text, fullBytes, metadataBytes })
  }
  let inlineBytes = 0, inline = 0
  if (metadata) for (const [index, event] of events.entries()) {
    if (!event.metadata_only || inline >= MAX_INLINE) continue
    const body = bodies[index]
    const textBytes = encoder.encode(body.text).byteLength
    const delta = Math.max(0, body.fullBytes - body.metadataBytes)
    if (textBytes > INLINE_MESSAGE_BYTES || inlineBytes + textBytes > INLINE_BYTES || bytes + delta > MAX_BYTES) continue
    event.text = body.text
    delete event.metadata_only
    bytes += delta; inlineBytes += textBytes; inline++
  }
  return { rows, events }
}
