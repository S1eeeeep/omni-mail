import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }))

import { LinuxDoMailImapClient, linuxDoMailSearchCommand } from './linux-do-mail-imap'
import { connect } from 'cloudflare:sockets'

function scriptedSocket(replies: string, keepOpen = false) {
  const writes: Uint8Array[] = []
  return {
    socket: {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(replies))
          if (!keepOpen) controller.close()
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(value) { writes.push(value.slice()) },
      }),
      opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
      close: vi.fn(async () => undefined),
    } as unknown as Socket,
    commands: () => new TextDecoder().decode(Uint8Array.from(
      writes.flatMap((value) => [...value]),
    )),
  }
}

const messageSource = [
  'From: sender@example.com', 'To: member@linux.do', 'Subject: Test mail',
  'Content-Type: text/plain; charset=utf-8', '', 'Test message body',
].join('\r\n')

function messageReplies(isRead: boolean, storeReply = 'A0005 OK STORE') {
  return [
    '* OK Linux DO Mail ready', 'A0001 OK CAPABILITY', 'A0002 OK LOGIN',
    'A0003 OK [READ-WRITE] SELECT',
    `* 1 FETCH (UID 42 FLAGS (${isRead ? '\\Seen' : ''}) BODY[]<0> {${
      new TextEncoder().encode(messageSource).byteLength
    }}`, messageSource, ')', 'A0004 OK FETCH',
    ...(isRead ? [] : [storeReply]),
    `A000${isRead ? 5 : 6} OK LOGOUT`, '',
  ].join('\r\n')
}

beforeEach(() => vi.mocked(connect).mockReset())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Linux DO Mail IMAP search', () => {
  it('lists all messages when the query is blank', () => {
    expect(linuxDoMailSearchCommand('  ')).toBe('UID SEARCH ALL')
  })

  it('quotes ASCII text searches', () => {
    expect(linuxDoMailSearchCommand('release "notes"')).toBe(
      'UID SEARCH TEXT "release \\"notes\\""',
    )
  })

  it('uses the UTF-8 charset for non-ASCII searches', () => {
    expect(linuxDoMailSearchCommand('求职')).toBe(
      'UID SEARCH CHARSET UTF-8 TEXT "求职"',
    )
  })
})

describe('Linux DO Mail read state synchronization', () => {
  it('marks an unread message Seen after fetching its body over the fixed TLS endpoint', async () => {
    const fixture = scriptedSocket(messageReplies(false))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await expect(client.getMessage('42')).resolves.toMatchObject({
      id: '42', body: 'Test message body', isRead: true,
    })
    await client.close()

    expect(connect).toHaveBeenCalledWith(
      { hostname: 'mail.linux.do', port: 993 },
      { secureTransport: 'on', allowHalfOpen: false },
    )
    const commands = fixture.commands()
    expect(commands).toContain('A0003 SELECT INBOX\r\n')
    expect(commands).toContain('A0004 UID FETCH 42 (UID FLAGS BODY.PEEK[]<0.524288>)\r\n')
    expect(commands).toContain('A0005 UID STORE 42 +FLAGS.SILENT (\\Seen)\r\n')
    expect(commands).not.toMatch(/\b(?:MOVE|COPY|EXPUNGE|APPEND|CLOSE)\b/)
  })

  it('does not write flags for an already-read message', async () => {
    const fixture = scriptedSocket(messageReplies(true))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await expect(client.getMessage('42')).resolves.toMatchObject({ isRead: true })
    await client.close()

    expect(fixture.commands()).not.toContain('UID STORE')
  })

  it.each(['NO', 'BAD'])('keeps the body unread when the server rejects STORE with %s', async (status) => {
    const fixture = scriptedSocket(messageReplies(false, `A0005 ${status} test-token`))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await expect(client.getMessage('42')).resolves.toMatchObject({
      body: 'Test message body', isRead: false,
    })
    await client.close()

    expect(log).toHaveBeenCalledWith('Linux DO 邮件已读状态同步失败', {
      type: 'Error', status: 502,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-token')
    expect(fixture.socket.close).toHaveBeenCalledOnce()
  })

  it('returns the body when the connection closes during the Seen update', async () => {
    const replies = messageReplies(false).split('A0005 OK STORE')[0]
    const fixture = scriptedSocket(replies)
    vi.mocked(connect).mockReturnValue(fixture.socket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await expect(client.getMessage('42')).resolves.toMatchObject({
      body: 'Test message body', isRead: false,
    })
    await client.close()

    expect(fixture.socket.close).toHaveBeenCalledOnce()
  })

  it('bounds a stalled Seen update without discarding the fetched body', async () => {
    vi.useFakeTimers()
    const fixture = scriptedSocket(messageReplies(false).split('A0005 OK STORE')[0], true)
    vi.mocked(connect).mockReturnValue(fixture.socket)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')
    await client.open()

    const message = client.getMessage('42')
    const assertion = expect(message).resolves.toMatchObject({
      body: 'Test message body', isRead: false,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    await client.close()

    expect(fixture.commands()).toContain('UID STORE 42 +FLAGS.SILENT (\\Seen)')
    expect(fixture.socket.close).toHaveBeenCalledOnce()
  })

  it('does not mark a message when its UID is missing from the FETCH result', async () => {
    const fixture = scriptedSocket([
      '* OK Linux DO Mail ready', 'A0001 OK CAPABILITY', 'A0002 OK LOGIN',
      'A0003 OK SELECT', 'A0004 OK FETCH', 'A0005 OK LOGOUT', '',
    ].join('\r\n'))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await expect(client.getMessage('42')).rejects.toMatchObject({ status: 404 })
    await client.close()

    expect(fixture.commands()).not.toContain('UID STORE')
  })

  it('keeps inbox listing and credential verification read-only', async () => {
    const fixture = scriptedSocket([
      '* OK Linux DO Mail ready', 'A0001 OK CAPABILITY', 'A0002 OK LOGIN',
      'A0003 OK EXAMINE', 'A0004 OK EXAMINE', '* SEARCH 42', 'A0005 OK SEARCH',
      `* 1 FETCH (UID 42 FLAGS () BODY[]<0> {${new TextEncoder().encode(messageSource).byteLength}}`,
      messageSource, ')', 'A0006 OK FETCH', 'A0007 OK LOGOUT', '',
    ].join('\r\n'))
    vi.mocked(connect).mockReturnValue(fixture.socket)
    const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')

    await client.open()
    await client.test()
    await expect(client.listInbox()).resolves.toMatchObject([{ id: '42', isRead: false }])
    await client.close()

    expect(fixture.commands()).not.toMatch(/\bSELECT\b|\bSTORE\b/)
  })

  it.each(['0', '-1', '042', '42\n', '42\r\nA0001 LOGOUT', '42,43', '1:*',
    '4294967296', '9007199254740993', '1'.repeat(100)])(
    'rejects invalid UID %j before issuing commands', async (uid) => {
      const client = new LinuxDoMailImapClient('member@linux.do', 'test-token')
      await expect(client.getMessage(uid)).rejects.toMatchObject({ status: 400 })
      expect(connect).not.toHaveBeenCalled()
    },
  )
})
