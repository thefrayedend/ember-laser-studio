import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ember', {
  invoke: (name: string, args?: unknown) => ipcRenderer.invoke('ember:invoke', name, args),
  onEvent: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('ember:event', h)
    return () => ipcRenderer.removeListener('ember:event', h)
  },
})
