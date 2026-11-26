import http from 'node:http'
import type { LuminexPort } from '../src/types'

type JsonObject = Record<string, unknown>
export interface LuminexFixture {
  uid: string
  port: number
  manufacturer?: string
  model?: string
  label?: string
  address?: number
  footprint?: number
  personality?: number
}
export interface LuminexData { ports: LuminexPort[]; fixtures: LuminexFixture[]; errors: string[] }

const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) ? value : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

function uid(value: unknown): string {
  const raw = text(value)?.replace(/[:-]/g, '').toUpperCase()
  if (!raw || !/^[0-9A-F]{12}$/.test(raw)) throw new Error(`Invalid RDM UID: ${String(value)}`)
  return `${raw.slice(0, 4)}:${raw.slice(4)}`
}

function request(ip: string, localAddress: string, path: string, port: number, signal?: AbortSignal, auth = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: ip, port, path, localAddress, signal, agent: false, headers: { Accept: 'application/json', ...(auth ? { Authorization: `Basic ${Buffer.from('admin:').toString('base64')}` } : {}) } }, response => {
      if ((response.statusCode === 401 || response.statusCode === 403) && !auth) {
        response.resume()
        request(ip, localAddress, path, port, signal, true).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) response.destroy(new Error('Response exceeds 1 MiB'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (path.startsWith('/api/rdm/')) console.info(`[Luminex RX] ${ip} ${path} HTTP ${response.statusCode}: ${body}`)
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${path}: HTTP ${response.statusCode}`))
          return
        }
        try { resolve(JSON.parse(body) as unknown) } catch { reject(new Error(`${path}: invalid JSON`)) }
      })
    })
    req.setTimeout(3000, () => req.destroy(new Error(`${path}: timed out`)))
    req.on('error', reject)
  })
}

export async function readLuminex(ip: string, localAddress: string, httpPort = 80, signal?: AbortSignal): Promise<LuminexData> {
  const raw = await request(ip, localAddress, '/api/IO', httpPort, signal)
  if (!Array.isArray(raw)) throw new Error('/api/IO: expected an array')
  const ios = raw.map(object).filter((entry): entry is JsonObject => !!entry && entry.io_class === 'dmx')
  const errors: string[] = []
  const ports: LuminexPort[] = []
  const fixtures: LuminexFixture[] = []
  for (const io of ios) {
    signal?.throwIfAborted()
    const number = integer(io.port_number), id = integer(io.id)
    if (number === undefined || number < 0 || number > 255 || id === undefined || id < 0) {
      errors.push('Invalid DMX port number or IO id')
      continue
    }
    const direction = io.io_type === 'output' ? 'output' : io.io_type === 'input' ? 'input' : io.io_type === 'idle' ? 'off' : 'unknown'
    const rdmAddress = integer(io.rdm_universe)
    const port: LuminexPort = { index: number + 1, direction, protocol: 'unknown', rdm: io.rdm === true, rdmUniverse: rdmAddress !== undefined && rdmAddress >= 0 && rdmAddress <= 0x7fff ? rdmAddress : undefined }
    ports.push(port)
    try {
      const candidates = await request(ip, localAddress, `/api/IO/${id}/artrdm_candidates`, httpPort, signal)
      if (!Array.isArray(candidates)) throw new Error('expected an array of candidates')
      const sources = candidates.map(object).filter((entry): entry is JsonObject => !!entry && (entry.io_class === 'sacn' || entry.io_class === 'artnet') && integer(entry.universe) !== undefined)
      const distinct = new Map(sources.map(source => [`${source.io_class}/${source.universe}`, source]))
      if (distinct.size === 1) {
        const source = [...distinct.values()][0]
        const universe = integer(source.universe)!
        if (source.io_class === 'sacn' && universe >= 1 && universe <= 63999 || source.io_class === 'artnet' && universe >= 0 && universe <= 0x7fff) {
          port.protocol = source.io_class === 'sacn' ? 'sacn' : 'artnet'
          port.universe = universe
        } else errors.push(`Port ${port.index}: invalid source universe ${universe}`)
      } else if (distinct.size > 1) errors.push(`Port ${port.index}: multiple candidate universes; active source is unknown`)
    } catch (error) { signal?.throwIfAborted(); errors.push(`Port ${port.index} source: ${String(error)}`) }
    if (!port.rdm || direction !== 'output') continue
    try {
      const list = await request(ip, localAddress, `/api/rdm/${number}/connected_devices`, httpPort, signal)
      if (!Array.isArray(list)) throw new Error('expected an array of UIDs')
      port.uids = [...new Set(list.map(item => uid(typeof item === 'string' ? item : object(item)?.uid)))]
      fixtures.push(...port.uids.map(device => ({ uid: device, port: port.index })))
    } catch (error) { signal?.throwIfAborted(); errors.push(`Port ${port.index} RDM list: ${String(error)}`); continue }
    try {
      const result = await request(ip, localAddress, `/api/rdm/uid?port=${number}`, httpPort, signal)
      const entries = Array.isArray(result) ? result : [result]
      for (const value of entries) {
        const entry = object(value)
        if (!entry || entry.port !== undefined && integer(entry.port) !== number) continue
        const device = uid(entry.uid)
        const fixture = fixtures.find(f => f.port === port.index && f.uid === device)
        if (!fixture) continue
        fixture.manufacturer = text(entry.manufacturer_label)
        fixture.model = text(entry.device_model_description)
        fixture.label = text(entry.device_label)
        fixture.address = integer(entry.dmx_start_address)
        fixture.footprint = integer(entry.dmx_footprint)
        fixture.personality = integer(entry.dmx_personality)
      }
    } catch (error) { signal?.throwIfAborted(); errors.push(`Port ${port.index} RDM details: ${String(error)}`) }
  }
  return { ports, fixtures, errors }
}

export async function verifyLuminexTarget(ip: string, localAddress: string, portIndex: number, address: number, device: string, httpPort = 80, signal?: AbortSignal): Promise<void> {
  const raw = await request(ip, localAddress, '/api/IO', httpPort, signal)
  if (!Array.isArray(raw)) throw new Error('Cannot verify port: invalid /api/IO response')
  const ios = raw.map(object).filter((entry): entry is JsonObject => !!entry && entry.io_class === 'dmx')
  const target = ios.find(io => integer(io.port_number) === portIndex - 1)
  if (!target || target.io_type !== 'output' || target.rdm !== true || integer(target.rdm_universe) !== address) throw new Error('Nothing sent: Luminex port or RDM universe changed')
  const sharing = ios.filter(io => io.io_type === 'output' && io.rdm === true && integer(io.rdm_universe) === address)
  for (const io of sharing) {
    const number = integer(io.port_number)
    if (number === undefined || number < 0 || number > 255) throw new Error('Nothing sent: invalid Luminex port number')
    const list = await request(ip, localAddress, `/api/rdm/${number}/connected_devices`, httpPort, signal)
    if (!Array.isArray(list)) throw new Error('Nothing sent: invalid Luminex RDM list')
    const has = list.some(item => uid(typeof item === 'string' ? item : object(item)?.uid) === device)
    if (number === portIndex - 1 && !has || number !== portIndex - 1 && has) throw new Error('Nothing sent: fixture port cannot be verified on the shared RDM universe')
  }
}
