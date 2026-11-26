// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { simulatorData } from '../electron/simulator'
import App from '../src/App'
import type { LuminexPort } from '../src/types'
import { installStorage } from './testStorage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
installStorage()

it('groups bindings and filters fixtures by the physical node', async () => {
  const data = simulatorData()
  const first = data.nodes[0]
  data.nodes.push({ ...first, bindIndex: 2, ports: [{ ...first.ports[1], bindIndex: 2 }] })
  first.ports = [first.ports[0]]
  for (const fixture of data.fixtures.filter(f => f.nodeIp === first.ip && f.port.index === 2)) fixture.port = { ...fixture.port, bindIndex: 2 }
  const ports: LuminexPort[] = [
    { index: 1, direction: 'output', protocol: 'sacn', universe: 12, rdm: true },
    { index: 2, direction: 'output', protocol: 'artnet', universe: 101, rdm: true },
    { index: 3, direction: 'input', protocol: 'unknown', rdm: false },
    { index: 4, direction: 'off', protocol: 'unknown', rdm: false }
  ]
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data, luminex: { [first.ip]: { ports, errors: [] } } })),
    interfaces: vi.fn(async () => []),
    onSnapshot: vi.fn(() => () => {}),
    connect: vi.fn(), discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(),
    setPersonality: vi.fn(), setLabel: vi.fn(), clearTable: vi.fn(),
    simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  try {
    await act(async () => { root.render(<App />) })
    const buttons = () => Array.from(container.querySelectorAll('button'))
    await act(async () => { buttons().find(button => button.textContent?.includes('Network Nodes'))!.click() })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('10.0.0.21')
    expect(dialog.textContent).toContain('10.0.0.42')
    expect(dialog.textContent).toContain('MAC unavailable')
    expect(dialog.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(dialog.textContent).not.toContain('MANUFACTURER / OEM')
    expect(dialog.textContent).toContain('Port B')
    expect(dialog.textContent).toContain('sACN Out · sACN U12')
    expect(dialog.textContent).toContain('Art-Net Out · Art-Net 0:6:5')
    expect(dialog.textContent).toContain('DMX In')
    expect(dialog.textContent).toContain('Off / Unassigned')
    await act(async () => { Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'LumiNode-FOH')!.click() })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4)
    expect(container.textContent).toContain('Filtered by 10.0.0.21')
    await act(async () => { buttons().find(button => button.textContent === 'Clear filter')!.click() })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(8)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('sorts nodes, opens IP addresses, and closes only when clicking outside', async () => {
  const data = simulatorData()
  const template = data.nodes[0]
  data.nodes = [
    { ...template, shortName: 'Node 10', ip: '192.0.2.12' },
    { ...template, shortName: 'Node 2', ip: '192.0.2.3' },
    { ...template, shortName: 'Node 1', ip: '192.0.2.100' }
  ]
  const openNodeWeb = vi.fn(async (_ip: string) => {})
  openNodeWeb.mockRejectedValueOnce(new Error('Browser unavailable'))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  window.rdm = {
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => []), onSnapshot: vi.fn(() => () => {}), openNodeWeb,
    connect: vi.fn(), discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(),
    setPersonality: vi.fn(), setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  try {
    await act(async () => { root.render(<App />) })
    const open = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Network Nodes'))!
    await act(async () => { open().click() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const names = () => Array.from(dialog.querySelectorAll<HTMLTableRowElement>('tbody tr'), row => row.cells[0].textContent)
    const ips = () => Array.from(dialog.querySelectorAll<HTMLTableRowElement>('tbody tr'), row => row.cells[1].querySelector('button')?.textContent)
    expect(names().map(name => name?.split('Luminex')[0])).toEqual(['Node 1', 'Node 2', 'Node 10'])
    const ipHeader = Array.from(dialog.querySelectorAll<HTMLButtonElement>('th button')).find(button => button.textContent?.includes('IP / MAC'))!
    await act(async () => { ipHeader.click() })
    expect(ips()).toEqual(['192.0.2.3', '192.0.2.12', '192.0.2.100'])
    expect(ipHeader.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    await act(async () => { ipHeader.click() })
    expect(ips()).toEqual(['192.0.2.100', '192.0.2.12', '192.0.2.3'])
    expect(ipHeader.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    const nameHeader = Array.from(dialog.querySelectorAll<HTMLButtonElement>('th button')).find(button => button.textContent?.includes('NAME / TYPE'))!
    await act(async () => { nameHeader.click(); nameHeader.click() })
    expect(names().map(name => name?.split('Luminex')[0])).toEqual(['Node 10', 'Node 2', 'Node 1'])
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[aria-label="Open web interface for 192.0.2.12"]')!.click() })
    expect(openNodeWeb).toHaveBeenCalledWith('192.0.2.12')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Browser unavailable')
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[aria-label="Open web interface for 192.0.2.3"]')!.click() })
    expect(openNodeWeb).toHaveBeenLastCalledWith('192.0.2.3')
    expect(dialog.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { dialog.querySelector('table')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { dialog.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { open().click() })
    await act(async () => { container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows and searches protocol-specific universes and sorts them numerically', async () => {
  const data = simulatorData()
  data.fixtures = data.fixtures.slice(0, 3)
  data.fixtures[0].port = { ...data.fixtures[0].port, protocol: 'sacn', sacnUniverse: 1002 }
  data.fixtures[1].port = { ...data.fixtures[1].port, protocol: 'sacn', sacnUniverse: 12 }
  data.fixtures[2].port = { ...data.fixtures[2].port, protocol: 'artnet', net: 0, address: 0x65 }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => []), onSnapshot: vi.fn(() => () => {}),
    connect: vi.fn(), discover: vi.fn(), setIdentify: vi.fn(), setAddress: vi.fn(),
    setPersonality: vi.fn(), setLabel: vi.fn(), clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
  try {
    await act(async () => { root.render(<App />) })
    expect(container.textContent).toContain('sACN · U1002')
    expect(container.textContent).toContain('Art-Net · 0:6:5')
    expect(container.querySelector('[title="RDM Art-Net 0:0:1"]')).not.toBeNull()
    await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('UNIVERSE'))!.click() })
    expect(Array.from(container.querySelectorAll('tbody input[type=checkbox]')).map(el => el.getAttribute('aria-label'))).toEqual([data.fixtures[1].uid, data.fixtures[2].uid, data.fixtures[0].uid].map(uid => `Select ${uid}`))
    const search = container.querySelector<HTMLInputElement>('[aria-label="Filter by universe or protocol"]')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { set.call(search, 'sACN'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    await act(async () => { set.call(search, '1002'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
  } finally { await act(async () => root.unmount()); container.remove() }
})
