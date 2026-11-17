/** WebSocket-compatible adapter for Tinymist through Orca's worker RPC. */
// Orca 1.4.247 reuses PanelCaller.id for different documents of this editor.
// This nonce isolates live frames; it is not a stable host tab identity.
const frame = crypto.randomUUID()
export const request = <T = any>(name: string, input: any): Promise<T> => orca.plugin.request(name, { ...input, frame }, { timeoutMs: 30000 }) as Promise<T>
type Packet = { event: string; socket?: string; part?: string; end?: boolean; binary?: boolean; value?: any; message?: string }
let activeView: string | null = null
let sequence = 0
const sockets = new Map<string, PreviewSocket>()

class PreviewSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  protocol = ''; extensions = ''
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly id = String(++sequence)
  readonly view = activeView
  private parts: string[] = []
  constructor(readonly url: string) {
    super()
    if (url !== 'ws://preview.invalid/' || !this.view) throw new Error('Preview connection is not active.')
    sockets.set(this.id, this)
    void request('preview.send', { view: this.view, method: 'socket.open', socket: this.id }).catch(() => this.finish())
  }
  accept(packet: Packet) {
    if (packet.event === 'socket.open') { this.readyState = 1; const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event) }
    else if (packet.event === 'socket.close') this.finish()
    else if (packet.event === 'socket.data') {
      this.parts.push(packet.part || '')
      if (!packet.end) return
      const content = this.parts.join(''); this.parts = []
      const bytes = packet.binary ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : null
      const data = bytes ? this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]) : content
      const event = new MessageEvent('message', { data })
      this.dispatchEvent(event); this.onmessage?.(event)
    }
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Preview socket is not open.')
    void request('preview.send', { view: this.view, method: 'socket.send', socket: this.id, data }).catch(() => this.finish())
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 2
    void request('preview.send', { view: this.view, method: 'socket.close', socket: this.id }).catch(() => {})
    this.finish()
  }
  finish() {
    if (this.readyState === 3) return
    this.readyState = 3; sockets.delete(this.id)
    const event = new CloseEvent('close', { code: 1000, wasClean: true })
    this.dispatchEvent(event); this.onclose?.(event)
  }
}

window.WebSocket = PreviewSocket as unknown as typeof WebSocket

export async function listen(view: string, control: (value: any) => void, fail: (message: string) => void) {
  activeView = view
  try {
    while (activeView === view) {
      const { events } = await request<{ events: Packet[] }>('preview.poll', { view })
      if (activeView !== view) break
      for (const event of events) {
        if (event.socket) sockets.get(event.socket)?.accept(event)
        else if (event.event === 'control') control(event.value)
        else if (event.event === 'pdf') control(event)
        else if (event.event === 'error') fail(event.message || 'Preview failed.')
      }
    }
  } catch (error) { if (activeView === view) fail(error instanceof Error ? error.stack || error.message : String(error)) }
}

export function stopTransport() {
  activeView = null
  for (const socket of sockets.values()) socket.close()
}

export async function upload(view: string, text: string) {
  const upload = crypto.randomUUID()
  for (let offset = 0, index = 0; offset < text.length || offset === 0; offset += 12000, index++) {
    await request('preview.upload', { view, upload, index, part: text.slice(offset, offset + 12000), end: offset + 12000 >= text.length })
  }
}
