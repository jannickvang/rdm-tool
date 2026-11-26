import { expect, it, vi } from 'vitest'
import os from 'node:os'
import { Controller } from '../electron/controller'
import { artRdm, formatUid, opcode, OPCODE, PID, rdmFrame } from '../electron/protocol'

it('invalidates cached online status when the selected network adapter disappears', async () => {
  const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  const publish = vi.fn()
  const controller = new Controller(publish)
  try {
    const state = controller['state']
    state.mode = 'network'
    state.interfaceId = 'missing|2.0.0.1'
    const lastSeen = state.fixtures[0].lastSeen
    await expect(controller['poll']()).rejects.toThrow('Selected network adapter missing|2.0.0.1 is unavailable')
    const snapshot = controller.snapshot()
    expect(snapshot.connected).toBe(false)
    expect(snapshot.pollError).toContain('adapter missing|2.0.0.1 is unavailable')
    expect(snapshot.nodes.every(node => !node.isOnline)).toBe(true)
    expect(snapshot.fixtures.every(fixture => !fixture.isOnline)).toBe(true)
    expect(snapshot.fixtures[0]).toMatchObject({ lastSeen, reachabilityError: snapshot.pollError })
    expect(publish).toHaveBeenLastCalledWith(snapshot)
    await expect(controller.setIdentify(snapshot.fixtures[0].id, true)).rejects.toThrow('Fixture is offline')
    await expect(controller.connect('network', state.interfaceId)).rejects.toThrow('unavailable')
    expect(controller.snapshot().fixtures).toHaveLength(snapshot.fixtures.length)
  } finally { controller['close'](); interfaces.mockRestore() }
})

it('does not retain simulator fixtures when a saved network adapter is unavailable', async () => {
  const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  const controller = new Controller(() => {})
  try {
    await expect(controller.connect('network', 'missing|2.0.0.1')).rejects.toThrow('unavailable')
    expect(controller.snapshot()).toMatchObject({ mode: 'network', connected: false, interfaceId: 'missing|2.0.0.1', nodes: [], fixtures: [] })
  } finally { controller['close'](); interfaces.mockRestore() }
})

it('detects an unavailable adapter on the ArtPoll heartbeat', async () => {
  vi.useFakeTimers()
  const interfaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({})
  const controller = new Controller(() => {})
  try {
    controller['state'].mode = 'network'
    controller['state'].interfaceId = 'missing|2.0.0.1'
    controller['startPolling']()
    await vi.advanceTimersByTimeAsync(3000)
    expect(controller.snapshot().connected).toBe(false)
    expect(controller.snapshot().fixtures.every(fixture => !fixture.isOnline)).toBe(true)
  } finally { controller['close'](); interfaces.mockRestore(); vi.useRealTimers() }
})

it('retains fixtures missing from consecutive TODs and recovers on an RDM response', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const fixture = state.fixtures[0]
  fixture.id = `${fixture.nodeIp}/${fixture.port.bindIndex}/${fixture.port.index}/${fixture.port.net}/${fixture.port.address}/${fixture.uid}`
  state.fixtures = [fixture]
  state.nodes = [state.nodes[0]]
  controller['initialized'].add(fixture.id)
  controller['poll'] = async () => {}
  controller['send'] = async () => {}
  controller['request'] = vi.fn(async () => Buffer.from([0, 77]))
  const tod = (include: boolean) => {
    const packet = Buffer.alloc(include ? 34 : 28)
    Buffer.from('Art-Net\0').copy(packet)
    packet.writeUInt16LE(OPCODE.todData, 8)
    packet[13] = fixture.port.localIndex
    packet[20] = fixture.port.bindIndex
    packet[21] = fixture.port.net
    packet[23] = fixture.port.address
    packet.writeUInt16BE(include ? 1 : 0, 24)
    packet[27] = include ? 1 : 0
    if (include) Buffer.from(fixture.uid.replace(':', ''), 'hex').copy(packet, 28)
    return packet
  }
  controller['cycle']++
  controller['receive'](tod(false), fixture.nodeIp)
  expect(fixture.isOnline).toBe(true)
  controller['receive'](tod(false), fixture.nodeIp)
  expect(fixture.isOnline).toBe(true)
  controller['cycle']++
  controller['receive'](tod(false), fixture.nodeIp)
  expect(state.fixtures).toHaveLength(1)
  expect(fixture.isOnline).toBe(false)
  controller['receive'](tod(true), fixture.nodeIp)
  await controller['pollCycle']()
  expect(fixture).toMatchObject({ isOnline: true, address: 77, patchStatus: 'external' })
})

it('marks a fixture offline after consecutive RDM failures and restores it on reply', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const fixture = state.fixtures[0]
  state.fixtures = [fixture]
  state.nodes = [state.nodes[0]]
  controller['initialized'].add(fixture.id)
  controller['poll'] = async () => {}
  controller['send'] = async () => {}
  let responding = false
  controller['request'] = vi.fn(async () => {
    if (!responding) throw new Error('RDM timeout')
    return Buffer.from([0, 1])
  })
  await controller['pollCycle']()
  expect(fixture.isOnline).toBe(true)
  await controller['pollCycle']()
  expect(fixture.isOnline).toBe(false)
  responding = true
  await controller['pollCycle']()
  expect(fixture.isOnline).toBe(true)
  expect(fixture.reachabilityError).toBeUndefined()
})

it('continues reachability checks when a missing TOD is followed by a silent node', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const fixture = state.fixtures[0]
  state.fixtures = [fixture]
  state.nodes = []
  controller['initialized'].add(fixture.id)
  controller['todMisses'].set(fixture.id, { count: 1, cycle: 1 })
  controller['poll'] = async () => {}
  controller['request'] = vi.fn(async () => { throw new Error('RDM timeout') })
  await controller['pollCycle']()
  expect(fixture.isOnline).toBe(true)
  await controller['pollCycle']()
  expect(controller['request']).toHaveBeenCalledTimes(2)
  expect(fixture.isOnline).toBe(false)
  controller['close']()
})

it('runs a full manual polling cycle without overlapping cycles or blocking queued operator work', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  state.fixtures = state.fixtures.slice(0, 2)
  state.nodes = [state.nodes[0]]
  for (const fixture of state.fixtures) controller['initialized'].add(fixture.id)
  controller['poll'] = async () => {}
  controller['startLuminex'] = vi.fn()
  const sent: number[] = []
  controller['send'] = async packet => { sent.push(opcode(packet)!) }
  const order: string[] = []
  let release!: () => void
  controller['request'] = vi.fn(async id => {
    order.push(id)
    if (id === state.fixtures[0].id) await new Promise<void>(resolve => { release = resolve })
    return Buffer.from([0, 77])
  })
  try {
    const cycle = controller.pollNow()
    await vi.waitFor(() => expect(controller['request']).toHaveBeenCalledTimes(1))
    expect(controller.snapshot().polling).toBe(true)
    await expect(controller.pollNow()).rejects.toThrow('already running')
    const operator = controller['enqueue'](1, async () => { order.push('operator') })
    release()
    await Promise.all([cycle, operator])
    expect(order).toEqual([state.fixtures[0].id, 'operator', state.fixtures[1].id])
    expect(state.fixtures.map(fixture => fixture.address)).toEqual([77, 77])
    expect(sent).toEqual(state.nodes[0].ports.map(() => OPCODE.todRequest))
    expect(controller.snapshot().polling).toBe(false)
    state.connected = false
    await expect(controller.pollNow()).rejects.toThrow('Connect before polling')
  } finally { controller['close']() }
})

it('marks mode lists incomplete when any personality description fails', async () => {
  const controller = new Controller(() => {})
  const fixture = controller['state'].fixtures[0]
  let fail = true
  controller['get'] = vi.fn(async (_id, pid, data) => {
    if (pid === PID.deviceInfo) {
      const info = Buffer.alloc(19)
      info[12] = 1
      info[13] = 2
      info[15] = 1
      return info
    }
    if (pid === PID.address) return Buffer.from([0, 1])
    if (pid === PID.personality) return Buffer.from([1, 2])
    if (pid === PID.personalityDescription) {
      if (data![0] === 2 && fail) throw new Error('RDM timeout')
      return Buffer.from([data![0], 0, 25])
    }
    if (pid === PID.identify) return Buffer.from([0])
    return Buffer.from('Fixture')
  })
  await controller['refreshFixture'](fixture.id)
  expect(fixture.modesComplete).toBe(false)
  expect(fixture.personalities).toHaveLength(1)
  fail = false
  await controller['refreshFixture'](fixture.id)
  expect(fixture.modesComplete).toBe(true)
  expect(fixture.personalities).toHaveLength(2)
})

it('does not repopulate cleared nodes from a heartbeat before a discovery cycle', async () => {
  const controller = new Controller(() => {})
  controller['state'].mode = 'network'
  controller['poll'] = async () => {}
  controller['send'] = async () => {}
  const packet = Buffer.alloc(239)
  Buffer.from('Art-Net\0').copy(packet)
  packet.writeUInt16LE(OPCODE.pollReply, 8)
  packet[211] = 1
  controller.clearTable()
  controller['receive'](packet, '10.0.0.5')
  expect(controller.snapshot().nodes).toHaveLength(0)
  await controller['pollCycle']()
  controller['receive'](packet, '10.0.0.5')
  expect(controller.snapshot().nodes).toHaveLength(1)
})

it('continues discovery and fixture polling when an individual node send fails', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const fixture = state.fixtures[0]
  state.fixtures = [fixture]
  controller['initialized'].add(fixture.id)
  controller['poll'] = async () => {}
  const sent: string[] = []
  controller['send'] = async (_data, ip) => {
    sent.push(ip)
    if (ip === state.nodes[0].ip) throw new Error('unreachable')
  }
  controller['request'] = vi.fn(async () => Buffer.from([0, 77]))
  await controller['pollCycle']()
  expect(sent).toContain(state.nodes[1].ip)
  expect(fixture.address).toBe(77)
  expect(controller.snapshot().pollError).toContain('unreachable')
})

it('preserves the ArtPoll heartbeat alongside the minute discovery cycle', async () => {
  vi.useFakeTimers()
  try {
    const controller = new Controller(() => {})
    controller['state'].mode = 'network'
    controller['state'].nodes = []
    controller['state'].fixtures = []
    controller['poll'] = vi.fn(async () => {})
    controller['startPolling']()
    await vi.advanceTimersByTimeAsync(3000)
    expect(controller['poll']).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(57050)
    expect(controller['poll']).toHaveBeenCalledTimes(21)
  } finally { vi.useRealTimers() }
})

it('flushes and requests TOD from nodes discovered while the poll replies arrive', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const node = state.nodes[0]
  state.nodes = []
  controller['poll'] = async () => { setTimeout(() => state.nodes.push(node), 50) }
  const sent: { op: number | undefined; ip: string; net: number; address: number }[] = []
  controller['send'] = async (data, ip) => { sent.push({ op: opcode(data), ip, net: data[21], address: data[opcode(data) === OPCODE.todRequest ? 24 : 23] }) }
  await controller.discover(true)
  expect(sent).toEqual(node.ports.flatMap(port => [
    { op: OPCODE.todControl, ip: node.ip, net: port.net, address: port.address },
    { op: OPCODE.todRequest, ip: node.ip, net: port.net, address: port.address }
  ]))
})

it('assembles out-of-order TOD blocks and links UIDs to the advertised port', () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  const node = state.nodes[0], port = node.ports[0]
  state.fixtures = []
  controller['startRefresh'] = vi.fn()
  const packet = (block: number, start: number, count: number) => {
    const data = Buffer.alloc(28 + count * 6)
    Buffer.from('Art-Net\0').copy(data)
    data.writeUInt16LE(OPCODE.todData, 8)
    data[13] = port.localIndex
    data[20] = port.bindIndex
    data[21] = port.net
    data[23] = port.address
    data.writeUInt16BE(201, 24)
    data[26] = block
    data[27] = count
    for (let i = 0; i < count; i++) data.writeUIntBE(start + i, 28 + i * 6, 6)
    return data
  }
  controller['receive'](packet(1, 200, 1), node.ip)
  expect(state.fixtures).toHaveLength(0)
  controller['receive'](packet(0, 0, 200), node.ip)
  expect(state.fixtures).toHaveLength(201)
  expect(state.fixtures[200]).toMatchObject({ uid: '0000:000000C8', nodeIp: node.ip, port })
  expect(controller['startRefresh']).toHaveBeenCalledTimes(201)
})

it('queries discovered fixture metadata on its originating node and port', async () => {
  const controller = new Controller(() => {})
  const fixture = controller['state'].fixtures[0]
  const calls: { ip: string; port: typeof fixture.port; pid: number }[] = []
  controller['get'] = async (id, pid) => {
    const target = controller['fixture'](id)
    calls.push({ ip: target.nodeIp, port: target.port, pid })
    if (pid === PID.deviceInfo) { const info = Buffer.alloc(19); info[13] = 0; return info }
    if (pid === PID.address) return Buffer.from([0, 42])
    if (pid === PID.personality) return Buffer.from([1, 1])
    if (pid === PID.identify) return Buffer.from([0])
    return Buffer.from('Test')
  }
  await controller['refreshFixture'](fixture.id)
  expect(calls.map(call => call.pid)).toEqual([PID.deviceInfo, PID.manufacturer, PID.model, PID.label, PID.address, PID.personality, PID.identify])
  expect(calls.every(call => call.ip === fixture.nodeIp && call.port === fixture.port)).toBe(true)
  expect(fixture).toMatchObject({ address: 42, personality: 1, manufacturer: 'Test' })
})

it('discovers and queries a fixture through PollReply, TOD and ArtRdm packets', async () => {
  const controller = new Controller(() => {})
  const state = controller['state']
  state.mode = 'network'
  state.nodes = []
  state.fixtures = []
  const ip = '10.0.0.5'
  const requests: { ip: string; net: number; address: number; pid: number }[] = []
  controller['send'] = async (data, destination) => {
    if (opcode(data) !== OPCODE.rdm) return
    const pid = data.readUInt16BE(44)
    requests.push({ ip: destination, net: data[21], address: data[23], pid })
    let payload = Buffer.from('Test')
    if (pid === PID.deviceInfo) { payload = Buffer.alloc(19); payload.writeUInt16BE(8, 10); payload[12] = 1; payload.writeUInt16BE(42, 14) }
    if (pid === PID.address) payload = Buffer.from([0, 42])
    if (pid === PID.personality) payload = Buffer.from([1, 1])
    if (pid === PID.identify) payload = Buffer.from([0])
    const frame = rdmFrame(formatUid(data.subarray(32, 38)), formatUid(data.subarray(26, 32)), data[38], 0x21, pid, payload)
    frame[16] = 0
    frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((sum, byte) => sum + byte, 0) & 0xffff, frame[2])
    queueMicrotask(() => controller['receive'](artRdm(data[21], data[23], frame), ip))
  }
  const poll = Buffer.alloc(239)
  Buffer.from('Art-Net\0').copy(poll)
  poll.writeUInt16LE(OPCODE.pollReply, 8)
  poll[18] = 3
  poll[19] = 2
  poll.write('Gateway', 26)
  poll.writeUInt16BE(1, 172)
  poll[174] = 0x80
  poll[190] = 4
  poll[211] = 1
  controller['receive'](poll, ip)
  const tod = Buffer.alloc(34)
  Buffer.from('Art-Net\0').copy(tod)
  tod.writeUInt16LE(OPCODE.todData, 8)
  tod[13] = 1
  tod[20] = 1
  tod[21] = 3
  tod[23] = 0x24
  tod.writeUInt16BE(1, 24)
  tod[27] = 1
  Buffer.from('123401020304', 'hex').copy(tod, 28)
  controller['receive'](tod, ip)
  await vi.waitFor(() => expect(controller['loading'].size).toBe(0))
  expect(state.fixtures[0]).toMatchObject({ uid: '1234:01020304', nodeIp: ip, nodeName: 'Gateway', address: 42, footprint: 8, isOnline: true })
  expect(requests.map(request => request.pid)).toEqual([PID.deviceInfo, PID.manufacturer, PID.model, PID.label, PID.address, PID.personality, PID.identify])
  expect(requests.every(request => request.ip === ip && request.net === 3 && request.address === 0x24)).toBe(true)
})
