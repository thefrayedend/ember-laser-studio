/**
 * In the desktop app, window.ember comes from the Electron preload. In a normal browser (the page is served by the
 * Ember server running next to the laser) it does not exist, so this builds the same object on a WebSocket.
 */
export const isRemote = () => !!(window as unknown as { __emberRemote?: boolean }).__emberRemote

export function installTransport() {
  if (window.ember) return
  ;(window as unknown as { __emberRemote: boolean }).__emberRemote = true
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
  const pending = new Map<number, Pending>()
  const listeners = new Set<(e: unknown) => void>()
  const queue: string[] = []
  let ws: WebSocket | null = null
  let seq = 0
  let delay = 500

  const open = () => {
    const w = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws = w
    w.onopen = () => {
      delay = 500
      while (queue.length) w.send(queue.shift()!)
      listeners.forEach((l) => l({ type: 'link', up: true }))
    }
    w.onmessage = (m) => {
      const d = JSON.parse(String(m.data))
      if (d.event) return listeners.forEach((l) => l(d.event))
      const p = pending.get(d.id)
      if (!p) return
      pending.delete(d.id)
      if (d.ok) p.resolve(d.result)
      else p.reject(new Error(d.error))
    }
    w.onclose = () => {
      ws = null
      pending.forEach((p) => p.reject(new Error('Lost the connection to the laser box. Reconnecting…')))
      pending.clear()
      listeners.forEach((l) => l({ type: 'link', up: false }))
      setTimeout(open, delay)
      delay = Math.min(delay * 2, 5000)
    }
  }
  open()

  const download = (name: string, data: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([data], { type: 'text/plain' }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    return name
  }

  window.ember = {
    invoke: (name, args) => {
      // Saving a file means downloading it in the browser.
      if (name === 'file.save') {
        const a = args as { defaultName: string; data: string }
        return Promise.resolve(download(a.defaultName, a.data))
      }
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        const msg = JSON.stringify({ id, name, args })
        if (ws && ws.readyState === 1) ws.send(msg)
        else queue.push(msg)
      })
    },
    onEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
