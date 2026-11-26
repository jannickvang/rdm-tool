import { describe, expect, it } from 'vitest'
import { artPoll, artRdm, artTodControl, artTodRequest, opcode, OPCODE, parseArtRdm, parsePollReply, parseTodData, rdmFrame } from '../electron/protocol'

describe('Art-Net packets', () => {
  it('encodes Poll, TOD request, and flush with fixed fields and lengths', () => {
    expect(artPoll().toString('hex')).toBe('4172742d4e6574000020000e0200')
    const request = artTodRequest(3, [0x12, 0x23])
    expect(request.length).toBe(56)
    expect(request.subarray(8, 12).toString('hex')).toBe('0080000e')
    expect(request.subarray(21, 26).toString('hex')).toBe('0300021223')
    expect(request.subarray(26).every(byte => byte === 0)).toBe(true)
    const flush = artTodControl(3, 0x12)
    expect(flush.length).toBe(24)
    expect(flush.subarray(21).toString('hex')).toBe('030112')
    expect(() => artTodRequest(0, Array(33).fill(0))).toThrow()
  })

  it('parses bound output ports and rejects malformed packets', () => {
    const packet = Buffer.alloc(239)
    Buffer.from('Art-Net\0').copy(packet)
    packet.writeUInt16LE(OPCODE.pollReply, 8)
    packet[18] = 2
    packet[19] = 3
    packet.writeUInt16LE(0x1234, 24)
    packet.write('Stage', 26, 'ascii')
    packet.writeUInt16BE(4, 172)
    packet[174] = 0x80
    packet[176] = 0x80
    packet[190] = 1
    packet[192] = 4
    packet.writeUInt16BE(0x5678, 20)
    packet[200] = 2
    Buffer.from('001122334455', 'hex').copy(packet, 201)
    packet[211] = 2
    const node = parsePollReply(packet, '10.0.0.5')!
    expect(node.manufacturerCode).toBe(0x1234)
    expect(node.shortName).toBe('Stage')
    expect(node).toMatchObject({ oemCode: 0x5678, style: 2, mac: '00:11:22:33:44:55' })
    expect(node.ports).toMatchObject([
      { index: 5, localIndex: 1, bindIndex: 2, net: 2, address: 0x31, direction: 'output', protocol: 'artnet' },
      { index: 6, direction: 'off' },
      { index: 7, localIndex: 3, bindIndex: 2, net: 2, address: 0x34, direction: 'output', protocol: 'artnet' },
      { index: 8, direction: 'off' }
    ])
    expect(parsePollReply(packet.subarray(0, 100), '10.0.0.5')).toBeUndefined()
    expect(opcode(Buffer.from('not artnet'))).toBeUndefined()
  })

  it('parses TOD entries and validates lengths', () => {
    const data = Buffer.alloc(40)
    Buffer.from('Art-Net\0').copy(data)
    data.writeUInt16LE(OPCODE.todData, 8)
    data[13] = 2
    data[20] = 1
    data[21] = 3
    data[23] = 0x21
    data.writeUInt16BE(2, 24)
    data[27] = 2
    Buffer.from('123401020304abcd11223344', 'hex').copy(data, 28)
    expect(parseTodData(data)).toEqual({ port: 2, bindIndex: 1, net: 3, address: 0x21, total: 2, block: 0, uids: ['1234:01020304', 'ABCD:11223344'], nak: false })
    expect(parseTodData(data.subarray(0, 39))).toBeUndefined()
  })
})

describe('RDM frames', () => {
  it('encodes the full frame and excludes only the start code in ArtRdm', () => {
    const frame = rdmFrame('0102:03040506', '7FF0:01020304', 5, 0x20, 0x60)
    expect(frame.toString('hex')).toBe('cc01180102030405067ff00102030405010000002000600002f9')
    const packet = artRdm(3, 0x21, frame)
    expect(packet.length).toBe(49)
    expect(packet[12]).toBe(1)
    expect(packet.subarray(21, 24).toString('hex')).toBe('030021')
    expect(packet.subarray(24)).toEqual(frame.subarray(1))
  })

  it('validates response length, checksum, and sub-device', () => {
    const frame = rdmFrame('7FF0:01020304', '0102:03040506', 5, 0x21, 0xf0, Buffer.from([0, 42]), 7)
    frame[16] = 0
    frame.writeUInt16BE(frame.subarray(0, frame[2]).reduce((a, b) => a + b, 0) & 0xffff, frame[2])
    const packet = artRdm(3, 0x21, frame)
    expect(parseArtRdm(packet)).toMatchObject({ destination: '7FF0:01020304', source: '0102:03040506', transaction: 5, subDevice: 7, pid: 0xf0, data: Buffer.from([0, 42]) })
    packet[30] ^= 1
    expect(parseArtRdm(packet)).toBeUndefined()
    expect(parseArtRdm(packet.subarray(0, 30))).toBeUndefined()
  })
})
