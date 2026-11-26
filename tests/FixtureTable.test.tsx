// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { simulatorData } from '../electron/simulator'
import App from '../src/App'
import type { Bridge } from '../src/types'
import { installStorage } from './testStorage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
installStorage()

let container: HTMLDivElement
let root: Root
let data: ReturnType<typeof simulatorData>
let setPersonality: Mock<Bridge['setPersonality']>
let setIdentify: Mock<Bridge['setIdentify']>
let setLabel: Mock<Bridge['setLabel']>

beforeEach(() => {
  window.localStorage.clear()
  data = simulatorData()
  data.fixtures = data.fixtures.slice(0, 4)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setPersonality = vi.fn<Bridge['setPersonality']>(async () => {})
  setIdentify = vi.fn<Bridge['setIdentify']>(async () => {})
  setLabel = vi.fn<Bridge['setLabel']>(async () => {})
  window.rdm = {
    openNodeWeb: vi.fn(),
    pollNow: vi.fn(),
    snapshot: vi.fn(async () => ({ mode: 'simulator' as const, connected: true, interfaceId: '', ...data })),
    interfaces: vi.fn(async () => []), onSnapshot: vi.fn(() => () => {}),
    connect: vi.fn(), discover: vi.fn(), setIdentify, setAddress: vi.fn(),
    setPersonality, setLabel, clearTable: vi.fn(), simulateOnline: vi.fn(), simulateAddress: vi.fn()
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = async () => { await act(async () => root.render(<App />)) }
const rows = () => Array.from(container.querySelectorAll<HTMLTableRowElement>('.table-section tbody tr'))
const selected = () => rows().map(row => row.getAttribute('aria-selected') === 'true')
const click = async (target: Element, options: MouseEventInit = {}) => {
  await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...options })) })
}
const menu = async (row: Element) => {
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 })) })
  return container.querySelector<HTMLElement>('[role="menu"]')!
}

it('shows the requested columns and a read-only mode', async () => {
  await render()
  expect(Array.from(container.querySelectorAll('.table-section thead th')).map(th => th.textContent?.trim())).toEqual([
    'ONLINE STATUS', 'LABEL', 'ADDRESS', 'UNIVERSE', 'DMX MODE', 'MANUFACTURER / MODEL', 'NODE & PORT', 'IDENTIFY'
  ])
  expect(rows()[0].cells[4].textContent).toBe('Basic')
  expect(rows()[0].querySelector('select')).toBeNull()
  expect(container.textContent).toContain('POLLING · 60S')
})

it('keeps the fixture controls and selection count without redundant navigation and status bars', async () => {
  await render()
  expect(container.querySelector('.sidebar, .topbar, .bottom-note')).toBeNull()
  expect(container.textContent).not.toContain('LIVE NETWORK')
  expect(container.textContent).not.toContain('SIMULATED DATA')
  expect(container.querySelector('[aria-label="Network adapter"]')).not.toBeNull()
  await click(rows()[0])
  expect(container.querySelector('.table-footer')?.textContent).toContain('1 selected')
})

it('starts manual polling, disables overlap and reports failures', async () => {
  let finish!: () => void
  window.rdm.pollNow = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  await render()
  const button = () => Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('Poll now') || item.textContent?.includes('Polling…'))!
  await click(button())
  expect(window.rdm.pollNow).toHaveBeenCalledOnce()
  expect(button().textContent).toContain('Polling…')
  expect(button().disabled).toBe(true)
  await act(async () => { finish() })
  expect(button().textContent).toContain('Poll now')
  expect(button().disabled).toBe(false)
  window.rdm.pollNow = vi.fn(async () => { throw new Error('Polling unavailable') })
  await click(button())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Polling unavailable')
  expect(button().disabled).toBe(false)
})

it('shows and disables the button during an automatic polling cycle', async () => {
  let update!: Parameters<Bridge['onSnapshot']>[0]
  window.rdm.onSnapshot = vi.fn(callback => { update = callback; return () => {} })
  await render()
  await act(async () => { update({ mode: 'simulator', connected: true, interfaceId: '', ...data, polling: true }) })
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('Polling…'))!
  expect(button.disabled).toBe(true)
  await act(async () => { update({ mode: 'simulator', connected: true, interfaceId: '', ...data, polling: false }) })
  expect(button.disabled).toBe(false)
  expect(button.textContent).toContain('Poll now')
})

it('explains address overlap and fixture communication warnings on their icons', async () => {
  data.fixtures[1].address = data.fixtures[0].address + 1
  data.fixtures[0].error = 'Personality 2: RDM GET timeout, PID 0xe1, transaction=253'
  data.fixtures[0].modesComplete = false
  data.fixtures[0].reachabilityError = 'RDM GET timeout, PID 0xf0, transaction=52'
  await render()
  const communication = rows()[0].cells[0].querySelector<HTMLButtonElement>('.fixture-warning')!
  const overlap = rows()[0].cells[2].querySelector<HTMLButtonElement>('.fixture-warning')!
  expect(rows()[0].cells[5].querySelector('.fixture-warning')).toBeNull()
  await act(async () => { communication.focus() })
  const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(tooltip.textContent).toContain('latest RDM check failed')
  expect(tooltip.textContent).toContain('fixture details could not be read')
  expect(tooltip.textContent).toContain('DMX mode list is incomplete')
  expect(tooltip.textContent).not.toContain('PID')
  expect(tooltip.textContent).not.toContain('transaction')
  expect(communication.getAttribute('aria-describedby')).toBe(tooltip.id)
  await act(async () => { overlap.focus() })
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('shares channels with another fixture in the same universe')
  await act(async () => { overlap.blur(); overlap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('DMX address overlap')
})

it('explains unavailable RDM ports and offline fixtures without raw diagnostic errors', async () => {
  data.fixtures[0].isOnline = false
  data.fixtures[0].rdmAvailable = false
  data.fixtures[0].reachabilityError = 'Luminex port has no valid RDM universe'
  data.fixtures[1].isOnline = false
  data.fixtures[1].reachabilityError = 'RDM GET timeout PID 0xf0'
  await render()
  await act(async () => { rows()[0].cells[0].querySelector<HTMLButtonElement>('.fixture-warning')!.focus() })
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Check the node port and RDM configuration')
  await act(async () => { rows()[1].cells[0].querySelector<HTMLButtonElement>('.fixture-warning')!.focus() })
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('Check its power, DMX cabling and RDM settings')
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).not.toContain('PID')
})

it('does not display cached fixtures as online or allow commands while disconnected', async () => {
  window.rdm.snapshot = vi.fn(async () => ({ mode: 'network' as const, connected: false, interfaceId: '', ...data }))
  await render()
  const status = rows()[0].querySelector<HTMLElement>('.status-dot')!
  expect(status.classList.contains('online')).toBe(false)
  expect(status.getAttribute('aria-label')).toBe('Connection unavailable')
  expect(status.title).toContain('fixture status cannot be verified')
  expect(rows()[0].querySelector<HTMLButtonElement>('.identify-icon')?.disabled).toBe(true)
  await click(rows()[0])
  const popup = await menu(rows()[0])
  expect(popup.textContent).not.toContain('Set DMX Mode')
  expect(Array.from(popup.querySelectorAll('button')).find(button => button.textContent === 'Edit label')?.disabled).toBe(true)
})

it('supports row, modifier, range and checkbox selection without selecting when identifying', async () => {
  await render()
  await click(rows()[0])
  await click(rows()[2], { metaKey: true })
  expect(selected()).toEqual([true, false, true, false])
  await click(rows()[3], { shiftKey: true })
  expect(selected()).toEqual([false, false, true, true])
  await click(rows()[0], { ctrlKey: true, shiftKey: true })
  expect(selected()).toEqual([true, true, true, true])
  await click(rows()[1], { ctrlKey: true })
  expect(selected()).toEqual([true, false, true, true])
  expect(rows()[0].cells[1].querySelector('input')).toBeNull()
  expect(rows()[0].cells[2].querySelector('input')).toBeNull()
  await click(rows()[0].querySelector('button[aria-label^="Identify"]')!)
  expect(selected()).toEqual([true, false, true, true])
  expect(setIdentify).toHaveBeenCalledWith(data.fixtures[0].id, true)
  await click(rows()[0].querySelector('input[type="checkbox"]')!)
  expect(selected()).toEqual([false, false, true, true])
  await click(rows()[2].querySelector('input[type="checkbox"]')!, { shiftKey: true })
  expect(selected()).toEqual([true, true, true, false])
})

it('prevents native Shift-mousedown selection on fixture cells without blocking controls', async () => {
  await render()
  const normal = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  const shift = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true })
  const checkbox = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true })
  await act(async () => {
    rows()[0].cells[1].dispatchEvent(normal)
    rows()[0].cells[1].dispatchEvent(shift)
    rows()[0].querySelector('input[type="checkbox"]')!.dispatchEvent(checkbox)
  })
  expect(normal.defaultPrevented).toBe(false)
  expect(shift.defaultPrevented).toBe(true)
  expect(checkbox.defaultPrevented).toBe(false)
  await click(rows()[0])
  await click(rows()[2], { shiftKey: true })
  expect(selected()).toEqual([true, true, true, false])
})

it('preserves selected rows on right click, opens Patch, and replaces selection for another row', async () => {
  await render()
  await click(rows()[0])
  await click(rows()[1], { ctrlKey: true })
  let popup = await menu(rows()[1])
  expect(selected()).toEqual([true, true, false, false])
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(container.querySelector('[role="menu"]')).toBeNull()
  popup = await menu(rows()[2])
  expect(selected()).toEqual([false, false, true, false])
  await click(Array.from(popup.querySelectorAll('button')).find(button => button.textContent === 'Patch')!)
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Step-by-step patch')
  expect(setIdentify).toHaveBeenCalledWith(data.fixtures[2].id, true)
})

it('applies compatible modes in table order and reports a partial failure', async () => {
  setPersonality.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('RDM timeout'))
  await render()
  await click(rows()[1])
  await click(rows()[0], { ctrlKey: true })
  const popup = await menu(rows()[1])
  expect(popup.textContent).toContain('Set DMX Mode')
  expect(popup.textContent).not.toContain('Extended')
  await click(popup.querySelector('[aria-haspopup="menu"]')!)
  await click(Array.from(popup.querySelectorAll('button')).find(button => button.textContent?.includes('Extended'))!)
  expect(setPersonality.mock.calls).toEqual([[data.fixtures[0].id, 2], [data.fixtures[1].id, 2]])
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('after 1 of 2 fixtures: RDM timeout')
})

it('applies a compatible mode to every selected fixture', async () => {
  await render()
  await click(rows()[0])
  await click(rows()[1], { ctrlKey: true })
  const popup = await menu(rows()[0])
  await click(popup.querySelector('[aria-haspopup="menu"]')!)
  await click(Array.from(popup.querySelectorAll('button')).find(button => button.textContent?.includes('Extended'))!)
  expect(setPersonality.mock.calls).toEqual([[data.fixtures[0].id, 2], [data.fixtures[1].id, 2]])
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('hides mode changes for mixed types, mismatched or incomplete modes, and offline selections', async () => {
  data.fixtures[1].personalities = [{ number: 1, name: 'Basic', footprint: 25 }]
  data.fixtures[3].isOnline = false
  await render()
  await click(rows()[0])
  await click(rows()[1], { ctrlKey: true })
  expect((await menu(rows()[0])).textContent).not.toContain('Set DMX Mode')
  await click(rows()[2], { ctrlKey: true })
  expect((await menu(rows()[2])).textContent).not.toContain('Set DMX Mode')
  await click(rows()[3], { ctrlKey: true })
  const popup = await menu(rows()[3])
  expect(popup.textContent).not.toContain('Set DMX Mode')
  expect(popup.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
})

it('does not offer partially loaded modes even when both fixtures match', async () => {
  data.fixtures[0].modesComplete = false
  data.fixtures[1].modesComplete = false
  await render()
  await click(rows()[0])
  await click(rows()[1], { ctrlKey: true })
  expect((await menu(rows()[0])).textContent).not.toContain('Set DMX Mode')
})

it('edits only the right-clicked fixture label through a popup and reports save failures', async () => {
  setLabel.mockRejectedValueOnce(new Error('Label rejected')).mockResolvedValueOnce(undefined)
  await render()
  await click(rows()[0])
  await click(rows()[1], { ctrlKey: true })
  const popup = await menu(rows()[1])
  await click(Array.from(popup.querySelectorAll('button')).find(button => button.textContent === 'Edit label')!)
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain(data.fixtures[1].uid)
  const input = dialog.querySelector<HTMLInputElement>('input')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(input, 'New label'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Save label')!)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Label rejected')
  await click(Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Save label')!)
  expect(setLabel.mock.calls).toEqual([[data.fixtures[1].id, 'New label'], [data.fixtures[1].id, 'New label']])
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

it('turns identify off for all fixtures despite filtering, and continues after errors', async () => {
  data.fixtures[3].isOnline = false
  setIdentify.mockImplementation(async id => { if (id === data.fixtures[1].id || id === data.fixtures[3].id) throw new Error('Unavailable') })
  await render()
  const search = container.querySelector<HTMLInputElement>('[aria-label="Filter by universe or protocol"]')!
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(search, 'no match'); search.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Identify off for all'))!)
  expect(setIdentify.mock.calls).toEqual(data.fixtures.map(fixture => [fixture.id, false]))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('failed for 2 of 4 fixtures')
})

it('marks unverified identify state and allows attempting to turn it off', async () => {
  data.fixtures[0].identifyUncertain = true
  await render()
  const button = rows()[0].querySelector<HTMLButtonElement>('button[aria-label^="Stop identifying"]')!
  expect(button.title).toContain('unverified')
  await click(button)
  expect(setIdentify).toHaveBeenCalledWith(data.fixtures[0].id, false)
})

it('opens and closes the mode submenu with the keyboard', async () => {
  await render()
  const popup = await menu(rows()[0])
  const trigger = popup.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
  trigger.focus()
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(popup.textContent).toContain('Extended')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(popup.textContent).not.toContain('Extended')
  expect(container.querySelector('[role="menu"]')).not.toBeNull()
})

it('reports a failed background patch after the wizard has closed', async () => {
  let rejectPatch!: (error: Error) => void
  window.rdm.setAddress = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPatch = reject }))
  await render()
  await click(rows()[0])
  await click(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Patch selected'))!)
  const dialog = container.querySelector('[role="dialog"]')!
  await click(Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.includes('Patch & advance'))!)
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('background RDM')
  await act(async () => { rejectPatch(new Error('RDM timeout')) })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(`Patch ${data.fixtures[0].label}`)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('RDM timeout')
})
