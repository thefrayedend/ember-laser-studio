import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MachineController, type ConnectRequest, type EmberEvent } from './controller'
import { coreHandlers } from './handlers'

let win: BrowserWindow | null = null
const send = (e: EmberEvent) => win?.webContents.send('ember:event', e)
const controller = new MachineController(send)

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#14161a',
    title: 'Ember Laser Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const dev = process.env.VITE_DEV_SERVER_URL
  if (dev) void win.loadURL(dev)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  // Never navigate the app window away, open links in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? 'x:')) e.preventDefault()
  })
  win.on('closed', () => (win = null))
}

const presetFile = () => path.join(app.getPath('userData'), 'presets.json')

const handlers: Record<string, (a: any) => unknown> = {
  ...coreHandlers(controller),
  'file.save': async (a: { defaultName: string; data: string; filters: { name: string; extensions: string[] }[] }) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: a.defaultName, filters: a.filters })
    if (r.canceled || !r.filePath) return null
    await fs.writeFile(r.filePath, a.data, 'utf8')
    return r.filePath
  },
  'presets.load': async () => {
    try {
      return JSON.parse(await fs.readFile(presetFile(), 'utf8'))
    } catch {
      return []
    }
  },
  'presets.save': async (a: unknown) => {
    await fs.writeFile(presetFile(), JSON.stringify(a, null, 1), 'utf8')
  },
  'app.version': () => app.getVersion(),
}

ipcMain.handle('ember:invoke', async (_e, name: string, args: unknown) => {
  const h = handlers[name]
  if (!h) throw new Error(`Unknown command ${name}`)
  try {
    return await h(args)
  } catch (err) {
    // Errors cross IPC as plain messages the UI can show.
    throw new Error((err as Error).message)
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', async (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  // Make sure the laser is off and the port is released before the process exits.
  try {
    controller.emergencyStop()
    await controller.disconnect()
  } catch {
    /* ignore */
  }
  app.exit(0)
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
