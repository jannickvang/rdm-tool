import http from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { readLuminex, verifyLuminexTarget } from '../electron/luminex'

let server: http.Server | undefined
afterEach(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined })

it('reads physical ports, sACN sources, UIDs and optional cached details', async () => {
  const paths: string[] = []
  server = http.createServer((req, res) => {
    paths.push(req.url!)
    const data: Record<string, unknown> = {
      '/api/IO': [
        { io_class: 'dmx', io_type: 'output', port_number: 0, id: 100000, rdm: true, rdm_universe: 1002 },
        { io_class: 'dmx', io_type: 'input', port_number: 1, id: 100001, rdm: false, rdm_universe: 1003 }
      ],
      '/api/IO/100000/artrdm_candidates': [{ io_class: 'sacn', universe: 1002 }],
      '/api/IO/100001/artrdm_candidates': [{ io_class: 'artnet', universe: 101 }],
      '/api/rdm/0/connected_devices': ['12:34:01:02:03:04'],
      '/api/rdm/uid?port=0': { port: 0, uid: '1234:01020304', device_label: 'Front', dmx_start_address: 25 }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(data[req.url!] ?? []))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const result = await readLuminex('127.0.0.1', '127.0.0.1', address.port)
  expect(result.errors).toEqual([])
  expect(result.ports).toMatchObject([
    { index: 1, direction: 'output', protocol: 'sacn', universe: 1002, rdmUniverse: 1002, uids: ['1234:01020304'] },
    { index: 2, direction: 'input', protocol: 'artnet', universe: 101 }
  ])
  expect(result.fixtures).toMatchObject([{ uid: '1234:01020304', port: 1, label: 'Front', address: 25 }])
  expect(paths).not.toContain('/api/rdm/1/connected_devices')
})

it('refuses writes when shared-universe fixture ownership is ambiguous or the port changed', async () => {
  let duplicate = false
  let changed = false
  server = http.createServer((req, res) => {
    const data = req.url === '/api/IO' ? [
      { io_class: 'dmx', io_type: 'output', port_number: 0, rdm: true, rdm_universe: changed ? 12 : 11 },
      { io_class: 'dmx', io_type: 'output', port_number: 1, rdm: true, rdm_universe: 11 }
    ] : req.url === '/api/rdm/0/connected_devices' || duplicate ? ['12:34:01:02:03:04'] : []
    res.end(JSON.stringify(data))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  await expect(verifyLuminexTarget('127.0.0.1', '127.0.0.1', 1, 11, '1234:01020304', address.port)).resolves.toBeUndefined()
  duplicate = true
  await expect(verifyLuminexTarget('127.0.0.1', '127.0.0.1', 1, 11, '1234:01020304', address.port)).rejects.toThrow('cannot be verified')
  changed = true
  await expect(verifyLuminexTarget('127.0.0.1', '127.0.0.1', 1, 11, '1234:01020304', address.port)).rejects.toThrow('port or RDM universe changed')
})
