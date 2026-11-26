// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { simulatorData } from '../electron/simulator'
import App from '../src/App'
import type { Snapshot } from '../src/types'
import { installStorage } from './testStorage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
installStorage()

const adapter = { id: 'en0|192.0.2.174', name: 'en0', address: '192.0.2.174', broadcast: '192.0.2.255' }

it('saves and restores the selected adapter across app launches', async () => {
  window.localStorage.clear()
  const data = simulatorData()
  const connect = vi.fn(async () => {})
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => [adapter]), onSnapshot: vi.fn(() => () => {}),
    connect, discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Network adapter"]')!
    await act(async () => { select.value = adapter.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(connect).toHaveBeenCalledWith('network', adapter.id)
    await act(async () => { root.unmount() })
    connect.mockClear()
    root = createRoot(container)
    await act(async () => { root.render(<App />) })
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith('network', adapter.id)
  } finally { await act(async () => root.unmount()); container.remove(); window.localStorage.clear() }
})

it('automatically reconnects a missing saved adapter when it returns', async () => {
  vi.useFakeTimers()
  window.localStorage.setItem('rdm.lastInterface', 'missing|2.0.0.1')
  const data = simulatorData()
  const missing = { ...adapter, id: 'missing|2.0.0.1', address: '2.0.0.1' }
  let onSnapshot: (snapshot: Snapshot) => void = () => {}
  let available = false
  const connect = vi.fn(async (mode: 'network' | 'simulator', id: string) => {
    const connected = available && mode === 'network'
    onSnapshot({ mode: 'network', connected, interfaceId: id, nodes: [], fixtures: [] })
    if (!connected) throw new Error(`Selected network adapter ${id} is unavailable`)
  })
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => available ? [missing] : [adapter]), onSnapshot: vi.fn(callback => { onSnapshot = callback; return () => {} }),
    connect, discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith('network', missing.id)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Selected network adapter missing|2.0.0.1 is unavailable')
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Network adapter"]')!
    expect(select.value).toBe(missing.id)
    expect(select.selectedOptions[0].textContent).toContain('unavailable')
    expect(container.querySelector('.fixtures-table tbody')?.textContent).not.toContain('Front wash')
    const reconnect = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Reconnect'))!
    expect(reconnect.disabled).toBe(true)
    expect(window.localStorage.getItem('rdm.lastInterface')).toBe('missing|2.0.0.1')
    available = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith('network', missing.id)
    expect(container.textContent).not.toContain('Reconnect')
  } finally { await act(async () => root.unmount()); container.remove(); window.localStorage.clear(); vi.useRealTimers() }
})

it('refreshes available adapters without reloading or changing the selected mode', async () => {
  vi.useFakeTimers()
  window.localStorage.clear()
  const data = simulatorData()
  let items = [adapter]
  const connect = vi.fn(async () => {})
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => items), onSnapshot: vi.fn(() => () => {}),
    connect, discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Network adapter"]')!
    expect(Array.from(select.options).map(option => option.value)).toContain(adapter.id)
    const added = { ...adapter, id: 'en1|10.0.0.1' }
    items = [added]
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(Array.from(select.options).map(option => option.value)).toEqual(['simulator', added.id])
    expect(select.value).toBe('simulator')
    expect(connect).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() }
})

it('retries a failed automatic connection without repeatedly connecting in parallel', async () => {
  vi.useFakeTimers()
  window.localStorage.clear()
  let onSnapshot: (snapshot: Snapshot) => void = () => {}
  const connect = vi.fn(async () => { throw new Error('Port is busy') })
  const state: Snapshot = { mode: 'network', connected: false, interfaceId: adapter.id, nodes: [], fixtures: [] }
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => state), interfaces: vi.fn(async () => [adapter]),
    onSnapshot: vi.fn(callback => { onSnapshot = callback; return () => {} }),
    connect, discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Port is busy')
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(connect).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(connect).toHaveBeenCalledTimes(2)
    await act(async () => { onSnapshot({ ...state, connected: true }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(connect).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() }
})

it('restores simulator mode when it was the last selection', async () => {
  window.localStorage.setItem('rdm.lastInterface', 'simulator')
  const data = simulatorData()
  const connect = vi.fn(async () => {})
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'network' as const, connected: true, interfaceId: adapter.id, ...data })),
    interfaces: vi.fn(async () => [adapter]), onSnapshot: vi.fn(() => () => {}),
    connect, discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    expect(connect).toHaveBeenCalledWith('simulator', '')
  } finally { await act(async () => root.unmount()); container.remove(); window.localStorage.clear() }
})

it('sorts fixtures by label on initial render', async () => {
  window.localStorage.clear()
  const data = simulatorData()
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => []), onSnapshot: vi.fn(() => () => {}),
    connect: vi.fn(), discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(), setPersonality: vi.fn(),
    setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<App />) })
    const labels = Array.from(container.querySelectorAll<HTMLTableRowElement>('.fixtures-table tbody tr'), row => row.cells[1].textContent)
    expect(labels).toEqual([...data.fixtures].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map(f => f.label))
  } finally { await act(async () => root.unmount()); container.remove(); window.localStorage.clear() }
})
