// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simulatorData } from '../electron/simulator'
import PatchModal from '../src/PatchModal'
import type { Bridge } from '../src/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('patch modal keyboard behavior', () => {
  let container: HTMLDivElement
  let root: Root
  let bridge: Bridge
  const fixtures = simulatorData().fixtures.slice(0, 3)
  const ids = fixtures.map(f => f.id)
  const close = vi.fn()
  const report = vi.fn()
  const runBackground = (_description: string, action: () => Promise<void>, complete?: (success: boolean) => void) => {
    void Promise.resolve().then(action).then(() => complete?.(true), error => { report(error); complete?.(false) })
  }

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    bridge = {
      openNodeWeb: vi.fn(),
      pollNow: vi.fn(),
      interfaces: vi.fn(), snapshot: vi.fn(), connect: vi.fn(), discover: vi.fn(),
      setIdentify: vi.fn(async () => {}), setAddress: vi.fn(async () => {}),
      setPersonality: vi.fn(async () => {}), setLabel: vi.fn(), clearTable: vi.fn(),
      simulateOnline: vi.fn(), simulateAddress: vi.fn(), onSnapshot: vi.fn()
    }
    window.rdm = bridge
    close.mockClear()
    report.mockClear()
    await act(async () => {
      root.render(<PatchModal ids={ids} fixtures={fixtures} close={close} report={report} runBackground={runBackground} backgroundErrors={[]} />)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const key = (target: Element, value: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))

  it('focuses initially, preserves navigation focus, and patches with Enter on an arrow', async () => {
    const input = container.querySelector<HTMLInputElement>('.target-input')!
    const next = container.querySelector<HTMLButtonElement>('[aria-label="Next fixture"]')!
    expect(document.activeElement).toBe(input)
    next.focus()
    await act(async () => { next.click() })
    expect(document.activeElement).toBe(next)
    expect(container.textContent).toContain('Fixture 2 of 3')
    await act(async () => { key(next, 'ArrowRight') })
    expect(container.textContent).toContain('Fixture 3 of 3')
    expect(document.activeElement).toBe(next)
    await act(async () => { key(next, 'Enter') })
    expect(bridge.setAddress).toHaveBeenCalledOnce()
    expect(bridge.setAddress).toHaveBeenCalledWith(ids[2], fixtures[0].address)
    expect(container.textContent).toContain('Fixture 1 of 3')
    expect(document.activeElement).toBe(next)
  })

  it('does not patch on Enter while the select is open, but patches when it is closed', async () => {
    const select = container.querySelector<HTMLSelectElement>('select')!
    select.focus()
    await act(async () => {
      select.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      key(select, 'Enter')
    })
    expect(bridge.setAddress).not.toHaveBeenCalled()
    await act(async () => { key(select, 'Escape') })
    expect(close).not.toHaveBeenCalled()
    await act(async () => { key(select, 'Enter') })
    expect(bridge.setAddress).toHaveBeenCalledWith(ids[0], fixtures[0].address)
  })

  it('patches with Enter when the modal container has focus', async () => {
    const modal = container.querySelector<HTMLElement>('[role="dialog"]')!
    modal.focus()
    await act(async () => { key(modal, 'Enter') })
    expect(bridge.setAddress).toHaveBeenCalledWith(ids[0], fixtures[0].address)
  })

  it('advances immediately while patch and identify confirmation are pending', async () => {
    let finishPatch!: () => void
    let finishIdentify!: () => void
    vi.mocked(bridge.setAddress).mockImplementationOnce(() => new Promise(resolve => { finishPatch = resolve }))
    vi.mocked(bridge.setIdentify).mockImplementationOnce(() => new Promise(resolve => { finishIdentify = resolve }))
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('Patch & advance'))!
    await act(async () => { button.click() })
    expect(container.textContent).toContain('Fixture 2 of 3')
    expect(container.querySelector('[title="Fixture 1 · pending"]')).not.toBeNull()
    expect(bridge.setIdentify).toHaveBeenCalledWith(ids[0], false)
    expect(bridge.setIdentify).toHaveBeenCalledWith(ids[1], true)
    const identifyCalls = vi.mocked(bridge.setIdentify).mock.invocationCallOrder
    const patchCall = vi.mocked(bridge.setAddress).mock.invocationCallOrder[0]
    expect(identifyCalls[0]).toBeLessThan(patchCall)
    expect(patchCall).toBeLessThan(identifyCalls[1])
    expect(identifyCalls[1]).toBeLessThan(identifyCalls[2])
    await act(async () => { finishPatch() })
    expect(container.querySelector('[title="Fixture 1 · done"]')).not.toBeNull()
    await act(async () => { finishIdentify() })
  })

  it('keeps a failed background patch retryable without marking it done', async () => {
    let rejectPatch!: (error: Error) => void
    vi.mocked(bridge.setAddress).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPatch = reject }))
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('Patch & advance'))!
    await act(async () => { button.click() })
    await act(async () => { rejectPatch(new Error('RDM timeout')) })
    expect(container.querySelector('[title="Fixture 1 · failed"]')).not.toBeNull()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'RDM timeout' }))
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="Fixture 1 · failed"]')!.click() })
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false)
  })
})
