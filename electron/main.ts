import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'node:path'
import { isIP } from 'node:net'
import { Controller, interfaces } from './controller'

let window: BrowserWindow | null = null
const controller = new Controller(snapshot => window?.webContents.send('rdm:snapshot', snapshot))

function createWindow() {
  window = new BrowserWindow({
    width: 1500, height: 900, minWidth: 1050, minHeight: 650,
    backgroundColor: '#0b0e13',
    title: 'RDM Tool',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env.VITE_DEV_SERVER_URL) void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  else void window.loadFile(path.join(__dirname, '../dist/index.html'))
  window.on('closed', () => { window = null })
}

ipcMain.handle('rdm:interfaces', () => interfaces())
ipcMain.handle('rdm:snapshot', () => controller.snapshot())
ipcMain.handle('rdm:open-node-web', (_, ip: unknown) => {
  if (typeof ip !== 'string' || isIP(ip) !== 4 || !controller.snapshot().nodes.some(node => node.ip === ip)) throw new Error('Invalid or unknown node IP address')
  return shell.openExternal(`http://${ip}/`)
})
ipcMain.handle('rdm:connect', (_, mode: 'simulator' | 'network', id: string) => {
  if ((mode !== 'simulator' && mode !== 'network') || typeof id !== 'string') throw new Error('Invalid connection settings')
  return controller.connect(mode, id)
})
ipcMain.handle('rdm:discover', (_, force: boolean) => {
  if (typeof force !== 'boolean') throw new Error('Invalid discovery command')
  return controller.discover(force)
})
ipcMain.handle('rdm:poll-now', () => controller.pollNow())
ipcMain.handle('rdm:identify', (_, id: string, value: boolean) => {
  if (typeof id !== 'string' || typeof value !== 'boolean') throw new Error('Invalid identify command')
  return controller.setIdentify(id, value)
})
ipcMain.handle('rdm:address', (_, id: string, value: number) => controller.setAddress(id, value))
ipcMain.handle('rdm:personality', (_, id: string, value: number) => controller.setPersonality(id, value))
ipcMain.handle('rdm:label', (_, id: string, value: string) => {
  if (typeof id !== 'string' || typeof value !== 'string') throw new Error('Invalid label')
  return controller.setLabel(id, value)
})
ipcMain.handle('rdm:clear', () => controller.clearTable())
ipcMain.handle('rdm:simulate-online', (_, id: string, online: boolean) => {
  if (typeof id !== 'string' || typeof online !== 'boolean') throw new Error('Invalid simulator command')
  return controller.simulateOnline(id, online)
})
ipcMain.handle('rdm:simulate-address', (_, id: string, address: number) => {
  if (typeof id !== 'string') throw new Error('Invalid simulator command')
  return controller.simulateAddress(id, address)
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
