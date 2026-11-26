import { expect, it, vi } from 'vitest'
import { Controller } from '../electron/controller'
import { artRdm, formatUid, PID, rdmFrame } from '../electron/protocol'

function networkController(respond: (command: number, attempt: number) => number[] | undefined, responseType = 0) {
  const snapshots: ReturnType<Controller['snapshot']>[] = []
  const controller = new Controller(state => snapshots.push(state))
  controller['state'].mode = 'network'
  controller['state'].nodes = []
  const fixture = controller['state'].fixtures[0]
  const commands: number[] = []
  controller['send'] = async (data, ip) => {
    const command = data[43]
    commands.push(command)
    const reply = respond(command, commands.filter(value => value === command).length)
    if (!reply) return
    const frame = rdmFrame(formatUid(data.subarray(32, 38)), formatUid(data.subarray(26, 32)), data[38], command + 1, PID.identify, Buffer.from(reply))
    frame[16] = responseType
    frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((sum, byte) => sum + byte, 0) & 0xffff, frame[2])
    queueMicrotask(() => controller['receive'](artRdm(data[21], data[23], frame), ip))
  }
  return { controller, fixture, commands, snapshots }
}

it('confirms identify by GET when the SET response times out', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, commands, snapshots } = networkController(command => command === 0x20 ? [1] : undefined)
    const action = controller.setIdentify(fixture.id, true)
    await vi.advanceTimersByTimeAsync(1520)
    await action
    expect(commands).toEqual([0x30, 0x20])
    expect(snapshots.some(state => state.fixtures[0].identifyUncertain)).toBe(true)
    expect(controller.snapshot().fixtures[0]).toMatchObject({ identify: true, identifyUncertain: false })
  } finally { vi.useRealTimers() }
})

it('retries a timed-out verification GET after a SET acknowledgement', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, commands } = networkController((command, attempt) => command === 0x30 ? [] : attempt === 2 ? [1] : undefined)
    const action = controller.setIdentify(fixture.id, true)
    await vi.advanceTimersByTimeAsync(1540)
    await action
    expect(commands).toEqual([0x30, 0x20, 0x20])
    expect(controller.snapshot().fixtures[0]).toMatchObject({ identify: true, identifyUncertain: false })
  } finally { vi.useRealTimers() }
})

it('reports uncertainty if identify is sent but verification times out', async () => {
  vi.useFakeTimers()
  try {
    const { controller, fixture, commands } = networkController(() => undefined)
    const result = expect(controller.setIdentify(fixture.id, true)).rejects.toThrow('state could not be verified (SET timed out)')
    await vi.advanceTimersByTimeAsync(4540)
    await result
    expect(commands).toEqual([0x30, 0x20, 0x20])
    expect(controller.snapshot().fixtures[0]).toMatchObject({ identify: false, identifyUncertain: true })
  } finally { vi.useRealTimers() }
})

it('retains the reported actual state when verification disagrees', async () => {
  const { controller, fixture } = networkController(command => command === 0x30 ? [] : [0])
  await expect(controller.setIdentify(fixture.id, true)).rejects.toThrow('reports identify off instead of on')
  expect(controller.snapshot().fixtures[0]).toMatchObject({ identify: false, identifyUncertain: false })
})

it('surfaces an RDM NACK without treating it as a timeout or sending a verification GET', async () => {
  const { controller, fixture, commands } = networkController(() => [0, 1], 2)
  await expect(controller.setIdentify(fixture.id, true)).rejects.toThrow('RDM NACK')
  expect(commands).toEqual([0x30])
  expect(controller.snapshot().fixtures[0].identifyUncertain).not.toBe(true)
})
