import { expect, it, vi } from 'vitest'
import { Controller } from '../electron/controller'
import { artRdm, formatUid, PID, rdmFrame } from '../electron/protocol'

type Reply = { data: number[]; type?: number; delay?: number } | undefined

function networkController(respond: (command: number, attempt: number, packet: Buffer) => Reply) {
  const controller = new Controller(() => {})
  controller['state'].mode = 'network'
  controller['state'].nodes = []
  const fixture = controller['state'].fixtures[0]
  fixture.port = { ...fixture.port, net: 0, address: 12, protocol: 'sacn', sacnUniverse: 1002 }
  const packets: { packet: Buffer; ip: string; time: number }[] = []
  controller['send'] = async (packet, ip) => {
    packets.push({ packet, ip, time: Date.now() })
    const command = packet[43]
    const reply = respond(command, packets.filter(item => item.packet[43] === command).length, packet)
    if (!reply) return
    const frame = rdmFrame(formatUid(packet.subarray(32, 38)), formatUid(packet.subarray(26, 32)), packet[38], command + 1, PID.address, Buffer.from(reply.data))
    frame[16] = reply.type ?? 0
    frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((sum, byte) => sum + byte, 0) & 0xffff, frame[2])
    const deliver = () => controller['receive'](artRdm(packet[21], packet[23], frame), ip)
    if (reply.delay) setTimeout(deliver, reply.delay)
    else queueMicrotask(deliver)
  }
  return { controller, fixture, packets }
}

it('verifies a timed-out SET on the RDM port-address, not the displayed sACN universe', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController(command => command === 0x20 ? { data: [0, 157] } : undefined)
    const action = controller.setAddress(fixture.id, 157)
    await vi.advanceTimersByTimeAsync(2520)
    await action
    expect(packets.map(item => item.packet[43])).toEqual([0x30, 0x20])
    expect(packets.every(item => item.ip === fixture.nodeIp && item.packet[21] === 0 && item.packet[23] === 12 && item.packet.readUInt16BE(41) === 0)).toBe(true)
    expect(packets[0].packet.subarray(47, 49)).toEqual(Buffer.from([0, 157]))
    expect(packets[1].time - packets[0].time).toBeGreaterThanOrEqual(20)
    expect(controller.snapshot().fixtures[0]).toMatchObject({ address: 157, patchStatus: 'local' })
  } finally { vi.useRealTimers() }
})

it('allows a slow SET acknowledgement up to the extended timeout', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController(command => command === 0x30 ? { data: [], delay: 2000 } : { data: [0, 157] })
    const action = controller.setAddress(fixture.id, 157)
    await vi.advanceTimersByTimeAsync(2020)
    await action
    expect(packets.map(item => item.packet[43])).toEqual([0x30, 0x20])
    expect(controller.snapshot().fixtures[0].address).toBe(157)
  } finally { vi.useRealTimers() }
})

it('retries the SET once only after GET proves the address did not change', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController((command, attempt) => {
      if (command === 0x30) return attempt === 1 ? undefined : { data: [] }
      return { data: attempt === 1 ? [0, 1] : [0, 157] }
    })
    const action = controller.setAddress(fixture.id, 157)
    await vi.advanceTimersByTimeAsync(2560)
    await action
    expect(packets.map(item => item.packet[43])).toEqual([0x30, 0x20, 0x30, 0x20])
    expect(packets.slice(1).every((item, index) => item.time - packets[index].time >= 20)).toBe(true)
    expect(controller.snapshot().fixtures[0]).toMatchObject({ address: 157, patchStatus: 'local' })
  } finally { vi.useRealTimers() }
})

it('does not retry a write when verification also times out', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController(() => undefined)
    const initialAddress = fixture.address
    const result = expect(controller.setAddress(fixture.id, 157)).rejects.toThrow(/may have been applied.*UDP datagrams from target=0.*verification/s)
    await vi.advanceTimersByTimeAsync(5540)
    await result
    expect(packets.map(item => item.packet[43])).toEqual([0x30, 0x20, 0x20])
    expect(controller.snapshot().fixtures[0].address).toBe(initialAddress)
  } finally { vi.useRealTimers() }
})

it('does not retry SET on a NACK', async () => {
  const { controller, fixture, packets } = networkController(() => ({ data: [0, 1], type: 2 }))
  await expect(controller.setAddress(fixture.id, 157)).rejects.toThrow('RDM NACK')
  expect(packets.map(item => item.packet[43])).toEqual([0x30])
})

it('does not send verification to a different route if discovery changes the port', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController(command => {
      if (command === 0x30) {
        fixture.port = { ...fixture.port, address: 13 }
        return { data: [] }
      }
      return { data: [0, 157] }
    })
    const result = expect(controller.setAddress(fixture.id, 157)).rejects.toThrow('fixture RDM route changed')
    await vi.advanceTimersByTimeAsync(20)
    await result
    expect(packets.map(item => item.packet[43])).toEqual([0x30])
  } finally { vi.useRealTimers() }
})

it('does not retry an acknowledged SET when read-back disagrees', async () => {
  const { controller, fixture, packets } = networkController(command => command === 0x30 ? { data: [] } : { data: [0, 42] })
  await expect(controller.setAddress(fixture.id, 157)).rejects.toThrow('reports address 42 instead of 157')
  expect(packets.map(item => item.packet[43])).toEqual([0x30, 0x20])
  expect(controller.snapshot().fixtures[0].address).toBe(42)
})

it('reports malformed and mismatched responses separately from absent UDP traffic', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, packets } = networkController(() => undefined)
    const action = controller['request'](fixture.id, 0x30, PID.address, Buffer.from([0, 157]))
    const result = expect(action).rejects.toThrow(/UDP datagrams from target=3, malformed ArtRdm=1, unmatched ArtRdm=1, last mismatch: transaction/)
    const pending = controller['pending']!
    const malformed = Buffer.alloc(24)
    Buffer.from('Art-Net\0').copy(malformed)
    malformed.writeUInt16LE(0x8300, 8)
    controller['receive'](Buffer.from('other'), fixture.nodeIp)
    controller['receive'](malformed, fixture.nodeIp)
    const frame = rdmFrame(formatUid(packets[0].packet.subarray(32, 38)), fixture.uid, (pending.transaction + 1) & 255, 0x31, PID.address)
    frame[16] = 0
    frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((sum, byte) => sum + byte, 0) & 0xffff, frame[2])
    controller['receive'](artRdm(fixture.port.net, fixture.port.address, frame), fixture.nodeIp)
    await vi.advanceTimersByTimeAsync(2500)
    await result
  } finally { vi.useRealTimers() }
})
