import { contextBridge, ipcRenderer } from 'electron'
import type { Snapshot } from '../src/types'

contextBridge.exposeInMainWorld('rdm', {
  interfaces: () => ipcRenderer.invoke('rdm:interfaces'),
  snapshot: () => ipcRenderer.invoke('rdm:snapshot'),
  openNodeWeb: (ip: string) => ipcRenderer.invoke('rdm:open-node-web', ip),
  connect: (mode: string, id: string) => ipcRenderer.invoke('rdm:connect', mode, id),
  discover: (force: boolean) => ipcRenderer.invoke('rdm:discover', force),
  pollNow: () => ipcRenderer.invoke('rdm:poll-now'),
  setIdentify: (id: string, value: boolean) => ipcRenderer.invoke('rdm:identify', id, value),
  setAddress: (id: string, value: number) => ipcRenderer.invoke('rdm:address', id, value),
  setPersonality: (id: string, value: number) => ipcRenderer.invoke('rdm:personality', id, value),
  setLabel: (id: string, value: string) => ipcRenderer.invoke('rdm:label', id, value),
  clearTable: () => ipcRenderer.invoke('rdm:clear'),
  simulateOnline: (id: string, online: boolean) => ipcRenderer.invoke('rdm:simulate-online', id, online),
  simulateAddress: (id: string, address: number) => ipcRenderer.invoke('rdm:simulate-address', id, address),
  onSnapshot: (callback: (snapshot: Snapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('rdm:snapshot', listener)
    return () => ipcRenderer.removeListener('rdm:snapshot', listener)
  }
})
