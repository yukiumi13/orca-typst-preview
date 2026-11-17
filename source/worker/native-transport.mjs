/** Acknowledged JSON frames over an Orca-owned terminal, using existing host routing. */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'

export const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startTerminalTransport(adapter, settings, receive, failed) {
  const nonce = randomBytes(12).toString('hex')
  const prefix = `TPREV_${nonce}:`
  // Raw mode removes terminal echo/canonical line limits. No source file is installed
  // remotely: the bootstrap imports the bundled backend from its transmitted bytes.
  const bootstrap = `process.stdin.setRawMode(true);process.env.TYPST_PREVIEW_WIRE=${JSON.stringify(nonce)};const r=require('node:readline').createInterface({input:process.stdin});let s='';r.on('line',async l=>{const m=JSON.parse(l);if(!m.init)return;s+=m.init;if(m.end){process.stdin.pause();r.close();await import('data:text/javascript;base64,'+require('node:zlib').gunzipSync(Buffer.from(s,'base64')).toString('base64'))}});console.log(${JSON.stringify(prefix + 'BOOT')})`
  const command = `exec ${shellQuote(settings.backendNode || 'node')} -e ${shellQuote(bootstrap)}`
  const terminalId = await adapter.create(command)
  let closed = false; let last = 0; let incoming = ''; let booted = false; let ready = false
  let sendChain = Promise.resolve()
  let writeChain = Promise.resolve()
  const send = (text) => {
    const operation = sendChain.then(() => adapter.send(terminalId, text))
    sendChain = operation.catch(() => {})
    return operation
  }
  let lastReceived = Date.now()
  const polling = (async () => {
    try {
      while (!closed) {
        const lines = await adapter.read(terminalId)
        let acknowledged = 0
        for (const line of lines) {
          if (line === prefix + 'BOOT') { booted = true; continue }
          if (!line.startsWith(prefix)) continue
          const fields = line.slice(prefix.length).match(/^(\d+):([01]):([A-Za-z0-9+/=]*):END$/)
          if (!fields) continue
          const seq = Number(fields[1])
          if (seq <= last) continue
          if (seq !== last + 1) throw new Error(`Orca dropped preview transport output (expected ${last + 1}, received ${seq}). Reopen Preview to reconnect.`)
          last = seq; acknowledged = seq; lastReceived = Date.now(); incoming += fields[3]
          if (fields[2] === '1') {
            const packet = JSON.parse(gunzipSync(Buffer.from(incoming, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'))
            incoming = ''
            if (packet.event === 'ready') ready = true
            else receive(packet)
          }
        }
        if (acknowledged) await send(JSON.stringify({ ack: acknowledged }))
        if (Date.now() - lastReceived > 45000) throw new Error('The compilation host stopped responding.')
        await delay(acknowledged ? 60 : 200)
      }
    } catch (error) {
      if (!closed) { closed = true; failed(error); await adapter.close(terminalId).catch(() => {}) }
    }
  })()
  async function waitFor(check, description) {
    const deadline = Date.now() + 25000
    while (!check()) {
      if (closed || Date.now() > deadline) throw new Error(`Cannot start Typst Preview: ${description}. Node.js 22+ must be available on the workspace host.`)
      await delay(50)
    }
  }
  try {
    await waitFor(() => booted, 'background terminal did not start')
    const source = gzipSync(await readFile(new URL('./backend.mjs', import.meta.url)), { level: 1 }).toString('base64')
    for (let offset = 0; offset < source.length; offset += adapter.inputLimit) {
      await send(JSON.stringify({ init: source.slice(offset, offset + adapter.inputLimit), end: offset + adapter.inputLimit >= source.length }))
    }
    await waitFor(() => ready, 'compiler bridge did not initialize')
  } catch (error) { closed = true; await adapter.close(terminalId).catch(() => {}); throw error }
  return {
    terminalId,
    write(message) {
      const operation = writeChain.then(async () => {
        if (closed) throw new Error('Compilation host disconnected.')
        const bytes = gzipSync(Buffer.from(JSON.stringify(message)), { level: 1 }).toString('base64')
        // Keep RPC chunks together while allowing output acknowledgements between them.
        for (let offset = 0; offset < bytes.length; offset += adapter.inputLimit) {
          await send(JSON.stringify({ wire: bytes.slice(offset, offset + adapter.inputLimit), end: offset + adapter.inputLimit >= bytes.length }))
        }
      })
      writeChain = operation.catch(() => {})
      return operation
    },
    async close() {
      if (closed) return
      try { await send(JSON.stringify({ shutdown: true })) } catch {}
      closed = true
      await adapter.close(terminalId).catch(() => {})
      await polling
    }
  }
}
