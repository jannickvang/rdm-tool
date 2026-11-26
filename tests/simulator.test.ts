import { describe, expect, it, vi } from 'vitest'
import { Controller } from '../electron/controller'
import { conflicts } from '../src/utils'

describe('simulated fixtures', () => {
  it('patches, identifies, changes personality and checks the footprint', async () => {
    const controller = new Controller(() => {})
    const initial = controller.snapshot().fixtures[0]
    await controller.setIdentify(initial.id, true)
    await controller.setPersonality(initial.id, 2)
    await controller.setAddress(initial.id, 100)
    await controller.setLabel(initial.id, 'Updated')
    const fixture = controller.snapshot().fixtures[0]
    expect(fixture).toMatchObject({ identify: true, personality: 2, footprint: 33, address: 100, label: 'Updated' })
    await expect(controller.setAddress(initial.id, 500)).rejects.toThrow('beyond address 512')
    await expect(controller.setPersonality(initial.id, 99)).rejects.toThrow('Unknown personality')
    await controller.setIdentify(initial.id, false)
    expect(controller.snapshot().fixtures[0].identify).toBe(false)
  })
  it('only reports overlapping fixtures in the same Art-Net universe', async () => {
    const controller = new Controller(() => {})
    const [a, b] = controller.snapshot().fixtures
    expect(conflicts(controller.snapshot().fixtures).size).toBe(0)
    await controller.setAddress(b.id, a.address + a.footprint - 1)
    expect(conflicts(controller.snapshot().fixtures)).toEqual(new Set([a.id, b.id]))
  })
  it('distinguishes local patches from external changes on the next poll', async () => {
    const controller = new Controller(() => {})
    const fixture = controller.snapshot().fixtures[0]
    expect(fixture.patchStatus).toBe('initial')
    await controller.setAddress(fixture.id, 100)
    expect(controller.snapshot().fixtures[0].patchStatus).toBe('local')
    await controller.discover(false)
    expect(controller.snapshot().fixtures[0].patchStatus).toBe('local')
    controller.simulateAddress(fixture.id, 150)
    expect(controller.snapshot().fixtures[0].address).toBe(100)
    await controller.discover(false)
    expect(controller.snapshot().fixtures[0]).toMatchObject({ address: 150, patchStatus: 'external' })
    await controller.setPersonality(fixture.id, 2)
    expect(controller.snapshot().fixtures[0].patchStatus).toBe('local')
  })
  it('retains offline fixtures after two missed cycles and recovers them', async () => {
    const controller = new Controller(() => {})
    const fixture = controller.snapshot().fixtures[0]
    controller.simulateOnline(fixture.id, false)
    await controller.discover(false)
    expect(controller.snapshot().fixtures[0].isOnline).toBe(true)
    await controller.discover(false)
    expect(controller.snapshot().fixtures[0]).toMatchObject({ isOnline: false, lastSeen: fixture.lastSeen })
    await expect(controller.setIdentify(fixture.id, true)).rejects.toThrow('offline')
    controller.simulateOnline(fixture.id, true)
    await controller.discover(false)
    expect(controller.snapshot().fixtures[0].isOnline).toBe(true)
  })
  it('clears cached fixtures and rediscovers only simulated online devices', async () => {
    const controller = new Controller(() => {})
    const fixture = controller.snapshot().fixtures[0]
    controller.simulateOnline(fixture.id, false)
    controller.clearTable()
    expect(controller.snapshot().fixtures).toHaveLength(0)
    await controller.discover(false)
    expect(controller.snapshot().fixtures).toHaveLength(7)
    expect(controller.snapshot().fixtures.some(f => f.id === fixture.id)).toBe(false)
    controller.simulateOnline(fixture.id, true)
    await controller.discover(false)
    expect(controller.snapshot().fixtures).toHaveLength(8)
  })
  it('polls automatically at sixty seconds', async () => {
    vi.useFakeTimers()
    try {
      const controller = new Controller(() => {})
      const fixture = controller.snapshot().fixtures[0]
      controller.simulateAddress(fixture.id, 99)
      await vi.advanceTimersByTimeAsync(59999)
      expect(controller.snapshot().fixtures[0].address).toBe(fixture.address)
      await vi.advanceTimersByTimeAsync(1)
      expect(controller.snapshot().fixtures[0]).toMatchObject({ address: 99, patchStatus: 'external' })
    } finally { vi.useRealTimers() }
  })
  it('updates simulated fixtures immediately when polling is requested', async () => {
    const controller = new Controller(() => {})
    try {
      const fixture = controller.snapshot().fixtures[0]
      controller.simulateAddress(fixture.id, 99)
      controller.simulateOnline(fixture.id, false)
      await controller.pollNow()
      expect(controller.snapshot().fixtures[0].isOnline).toBe(true)
      await controller.pollNow()
      expect(controller.snapshot().fixtures[0].isOnline).toBe(false)
      controller.simulateOnline(fixture.id, true)
      await controller.pollNow()
      expect(controller.snapshot().fixtures[0]).toMatchObject({ isOnline: true, address: 99 })
    } finally { controller['close']() }
  })
  it('prioritizes operator work over queued background reads', async () => {
    const controller = new Controller(() => {})
    const order: string[] = []
    let release!: () => void
    const first = controller['enqueue'](0, async () => { order.push('active read'); await new Promise<void>(resolve => { release = resolve }) })
    const background = controller['enqueue'](0, async () => { order.push('next read') })
    const user = controller['enqueue'](1, async () => { order.push('user command') })
    release()
    await Promise.all([first, background, user])
    expect(order).toEqual(['active read', 'user command', 'next read'])
  })
})
