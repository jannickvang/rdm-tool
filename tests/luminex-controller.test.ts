import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { Controller } from '../electron/controller'
import * as luminex from '../electron/luminex'
import { artRdm, formatUid, OPCODE, PID, rdmFrame } from '../electron/protocol'
import { simulatorData } from '../electron/simulator'

it('marks a fixture absent from the node port offline and verifies it again when it returns', async () => {
  const adapter = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [{ address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '10.0.0.1/24' }]
  })
  const controller = new Controller(() => {})
  const node = simulatorData().nodes[0]
  const [missing, present] = simulatorData().fixtures
  const port = { index: 1, direction: 'output' as const, protocol: 'sacn' as const, universe: 1002, rdmUniverse: 1, rdm: true }
  const read = vi.spyOn(luminex, 'readLuminex').mockResolvedValue({
    ports: [{ ...port, uids: [present.uid] }],
    fixtures: [{ uid: present.uid, port: 1 }],
    errors: []
  })
  try {
    controller['state'].mode = 'network'
    controller['state'].interfaceId = 'test|10.0.0.1'
    controller['state'].nodes = [node]
    controller['state'].fixtures = [missing, present]
    controller['initialized'].add(missing.id)
    controller['initialized'].add(present.id)
    controller['startRefresh'] = vi.fn()
    controller['startLuminex'](node)
    await vi.waitFor(() => expect(controller['luminexLoading'].size).toBe(0))
    expect(missing.isOnline).toBe(false)
    expect(missing.reachabilityError).toContain('no longer present')
    expect(present.isOnline).toBe(true)
    controller['seen'](missing)
    expect(missing.isOnline).toBe(false)
    read.mockResolvedValue({
      ports: [{ ...port, uids: [missing.uid, present.uid] }],
      fixtures: [{ uid: missing.uid, port: 1 }, { uid: present.uid, port: 1 }],
      errors: []
    })
    controller['startLuminex'](node)
    await vi.waitFor(() => expect(controller['luminexLoading'].size).toBe(0))
    expect(controller['startRefresh']).toHaveBeenCalledWith(missing.id)
    expect(missing.isOnline).toBe(false)
    controller['seen'](missing)
    expect(missing.isOnline).toBe(true)
    expect(missing.reachabilityError).toBeUndefined()
  } finally { controller['close'](); adapter.mockRestore(); read.mockRestore() }
})

it('does not interpret an unavailable API port list as an empty list', async () => {
  const adapter = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [{ address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '10.0.0.1/24' }]
  })
  const read = vi.spyOn(luminex, 'readLuminex').mockResolvedValue({
    ports: [{ index: 1, direction: 'output', protocol: 'sacn', rdmUniverse: 1, rdm: true }],
    fixtures: [],
    errors: ['RDM list unavailable']
  })
  const controller = new Controller(() => {})
  try {
    const node = simulatorData().nodes[0]
    const fixture = simulatorData().fixtures[0]
    controller['state'].mode = 'network'
    controller['state'].interfaceId = 'test|10.0.0.1'
    controller['state'].nodes = [node]
    controller['state'].fixtures = [fixture]
    controller['startLuminex'](node)
    await vi.waitFor(() => expect(controller['luminexLoading'].size).toBe(0))
    expect(fixture.isOnline).toBe(true)
    expect(controller['luminexAbsent'].has(fixture.id)).toBe(false)
  } finally { controller['close'](); adapter.mockRestore(); read.mockRestore() }
})

it('merges API UIDs with TOD fixtures and preserves their physical port and RDM address', async () => {
  const adapter = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [{ address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '10.0.0.1/24' }]
  })

  const read = vi.spyOn(luminex, 'readLuminex').mockResolvedValue({
    ports: [{ index: 2, direction: 'output', protocol: 'sacn', universe: 1003, rdmUniverse: 12, rdm: true, uids: ['4C55:00001001'] }],
    fixtures: [{ uid: '4C55:00001001', port: 2 }],
    errors: []
  })
  const controller = new Controller(() => {})
  try {
    const node = simulatorData().nodes[0]
    node.longName = 'LumiNode'
    controller['state'].mode = 'network'
    controller['state'].interfaceId = 'test|10.0.0.1'
    controller['state'].nodes = [node]
    controller['state'].fixtures = [simulatorData().fixtures[0]]
    controller['startRefresh'] = vi.fn()
    controller['startLuminex'](node)
    await vi.waitFor(() => expect(controller['state'].luminex?.[node.ip]).toBeDefined())
    expect(controller.snapshot().fixtures).toHaveLength(1)
    expect(controller.snapshot().fixtures[0].port).toMatchObject({ index: 2, protocol: 'sacn', sacnUniverse: 1003, net: 0, address: 12 })
    expect(controller['startRefresh']).toHaveBeenCalledOnce()

    const tod = Buffer.alloc(34)
    Buffer.from('Art-Net\0').copy(tod)
    tod.writeUInt16LE(OPCODE.todData, 8)
    tod[13] = 1
    tod[20] = 1
    tod[27] = 1
    tod.writeUInt16BE(1, 24)
    Buffer.from('4c5500001001', 'hex').copy(tod, 28)
    controller['receive'](tod, node.ip)
    expect(controller.snapshot().fixtures).toHaveLength(1)
    expect(controller.snapshot().fixtures[0].port.index).toBe(2)
    controller.clearTable()
    expect(controller.snapshot().luminex).toBeUndefined()
  } finally { controller['close'](); adapter.mockRestore(); read.mockRestore() }
})

it('verifies Luminex port ownership before SET and refuses a changed route', async () => {
  const adapter = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [{ address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '10.0.0.1/24' }]
  })
  const verify = vi.spyOn(luminex, 'verifyLuminexTarget').mockResolvedValue()
  const controller = new Controller(() => {})
  try {
    const node = controller['state'].nodes[0]
    node.longName = 'LumiNode'
    const fixture = controller['state'].fixtures[0]
    fixture.port = { ...fixture.port, net: 0, address: 12, protocol: 'sacn', sacnUniverse: 1002 }
    controller['state'].mode = 'network'
    controller['state'].interfaceId = 'test|10.0.0.1'
    controller['state'].luminex = { [node.ip]: { ports: [], errors: [] } }
    const packets: Buffer[] = []
    controller['send'] = async (packet, ip) => {
      packets.push(packet)
      const command = packet[43]
      const frame = rdmFrame(formatUid(packet.subarray(32, 38)), fixture.uid, packet[38], command + 1, PID.address, command === 0x20 ? Buffer.from([0, 157]) : Buffer.alloc(0))
      frame[16] = 0
      frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((sum, byte) => sum + byte, 0) & 0xffff, frame[2])
      queueMicrotask(() => controller['receive'](artRdm(packet[21], packet[23], frame), ip))
    }
    await controller.setAddress(fixture.id, 157)
    expect(verify).toHaveBeenCalledWith(node.ip, '10.0.0.1', fixture.port.index, 12, fixture.uid, 80, expect.any(AbortSignal))
    expect(packets.map(packet => [packet[21], packet[23], packet[43]])).toEqual([[0, 12, 0x30], [0, 12, 0x20]])
    verify.mockImplementation(async () => { fixture.port = { ...fixture.port, address: 13 } })
    await expect(controller.setAddress(fixture.id, 158)).rejects.toThrow('fixture RDM route changed')
    expect(packets).toHaveLength(2)
  } finally { controller['close'](); adapter.mockRestore(); verify.mockRestore() }
})
