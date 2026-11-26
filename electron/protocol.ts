import type { NodeInfo, Port } from '../src/types'

const ID = Buffer.from('Art-Net\0', 'ascii')
export const OPCODE = { poll: 0x2000, pollReply: 0x2100, todRequest: 0x8000, todData: 0x8100, todControl: 0x8200, rdm: 0x8300, rdmSub: 0x8400 } as const
export const PID = { deviceInfo: 0x0060, model: 0x0080, manufacturer: 0x0081, label: 0x0082, personality: 0x00e0, personalityDescription: 0x00e1, address: 0x00f0, identify: 0x1000 } as const

function header(opcode: number, length: number): Buffer {
  const packet = Buffer.alloc(length)
  ID.copy(packet)
  packet.writeUInt16LE(opcode, 8)
  packet.writeUInt16BE(14, 10)
  return packet
}

export function opcode(data: Buffer): number | undefined {
  if (data.length < 10 || !data.subarray(0, 8).equals(ID)) return undefined
  return data.readUInt16LE(8)
}

export function artPoll(): Buffer {
  const p = header(OPCODE.poll, 14)
  p[12] = 0x02
  return p
}

export function artTodRequest(net: number, addresses: number[]): Buffer {
  if (net < 0 || net > 127 || addresses.length < 1 || addresses.length > 32 || addresses.some(a => a < 0 || a > 255)) throw new Error('Invalid TOD request')
  const p = header(OPCODE.todRequest, 56)
  p[21] = net
  p[23] = addresses.length
  addresses.forEach((a, i) => { p[24 + i] = a })
  return p
}

export function artTodControl(net: number, address: number): Buffer {
  const p = header(OPCODE.todControl, 24)
  p[21] = net
  p[22] = 1
  p[23] = address
  return p
}

export function artRdm(net: number, address: number, frame: Buffer): Buffer {
  if (frame[0] !== 0xcc) throw new Error('Invalid RDM start code')
  const p = header(OPCODE.rdm, 24 + frame.length - 1)
  p[12] = 1
  p[21] = net
  p[23] = address
  frame.copy(p, 24, 1)
  return p
}

function text(data: Buffer, offset: number, length: number): string {
  return data.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '').trim()
}

export function parsePollReply(data: Buffer, sender: string): NodeInfo | undefined {
  if (opcode(data) !== OPCODE.pollReply || data.length < 207) return
  const net = data[18] & 0x7f
  const subnet = data[19] & 0x0f
  const bindIndex = data.length > 211 && data[211] ? data[211] : 1
  const count = Math.min(data.readUInt16BE(172), 4)
  const ports: Port[] = []
  for (let i = 0; i < count; i++) {
    if ((data[174 + i] & 0x3f) !== 0) continue
    const direction = data[174 + i] & 0x80 ? 'output' : data[174 + i] & 0x40 ? 'input' : 'off'
    ports.push({ index: (bindIndex - 1) * count + i + 1, localIndex: i + 1, bindIndex, net, address: (subnet << 4) | (data[(direction === 'input' ? 186 : 190) + i] & 0x0f), direction, protocol: direction === 'output' ? (data[182 + i] & 1 ? 'sacn' : 'artnet') : 'unknown' })
  }
  const mac = data.subarray(201, 207)
  return { ip: sender, shortName: text(data, 26, 18), longName: text(data, 44, 64), manufacturerCode: data.readUInt16LE(24), oemCode: data.readUInt16BE(20), style: data[200], mac: mac.some(byte => byte !== 0) ? [...mac].map(byte => byte.toString(16).padStart(2, '0')).join(':').toUpperCase() : undefined, bindIndex, ports, lastSeen: Date.now(), isOnline: true }
}

export interface TodData { net: number; address: number; port: number; bindIndex: number; total: number; block: number; uids: string[]; nak: boolean }
export function parseTodData(data: Buffer): TodData | undefined {
  if (opcode(data) !== OPCODE.todData || data.length < 28) return
  const count = data[27]
  if (count > 200 || data.length < 28 + count * 6) return
  const uids = Array.from({ length: count }, (_, i) => formatUid(data.subarray(28 + i * 6, 34 + i * 6)))
  return { port: data[13], bindIndex: data[20] || 1, net: data[21] & 0x7f, nak: data[22] === 0xff, address: data[23], total: data.readUInt16BE(24), block: data[26], uids }
}

export function formatUid(uid: Buffer): string {
  return `${uid.subarray(0, 2).toString('hex')}:${uid.subarray(2, 6).toString('hex')}`.toUpperCase()
}
export function uidBytes(uid: string): Buffer {
  if (!/^[0-9a-f]{4}:[0-9a-f]{8}$/i.test(uid)) throw new Error('Invalid RDM UID')
  return Buffer.from(uid.replace(':', ''), 'hex')
}

export function rdmFrame(destination: string, source: string, transaction: number, command: number, pid: number, data: Buffer = Buffer.alloc(0), subDevice = 0): Buffer {
  if (data.length > 231 || subDevice < 0 || subDevice > 0xffff) throw new Error('Invalid RDM data')
  const length = 24 + data.length
  const p = Buffer.alloc(length + 2)
  p[0] = 0xcc
  p[1] = 1
  p[2] = length
  uidBytes(destination).copy(p, 3)
  uidBytes(source).copy(p, 9)
  p[15] = transaction
  p[16] = 1
  p.writeUInt16BE(subDevice, 18)
  p[20] = command
  p.writeUInt16BE(pid, 21)
  p[23] = data.length
  data.copy(p, 24)
  p.writeUInt16BE(p.subarray(0, length).reduce((a, b) => a + b, 0) & 0xffff, length)
  return p
}

export interface RdmResponse { source: string; destination: string; transaction: number; responseType: number; subDevice: number; command: number; pid: number; data: Buffer; net: number; address: number }
export function parseArtRdm(data: Buffer): RdmResponse | undefined {
  if (opcode(data) !== OPCODE.rdm || data.length < 49 || data[12] !== 1) return
  const frame = Buffer.concat([Buffer.from([0xcc]), data.subarray(24)])
  const length = frame[2]
  if (frame[1] !== 1 || length < 24 || frame.length !== length + 2 || frame[23] !== length - 24) return
  if ((frame.subarray(0, length).reduce((a, b) => a + b, 0) & 0xffff) !== frame.readUInt16BE(length)) return
  return { destination: formatUid(frame.subarray(3, 9)), source: formatUid(frame.subarray(9, 15)), transaction: frame[15], responseType: frame[16], subDevice: frame.readUInt16BE(18), command: frame[20], pid: frame.readUInt16BE(21), data: frame.subarray(24, length), net: data[21] & 0x7f, address: data[23] }
}
