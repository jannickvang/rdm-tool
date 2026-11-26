import dgram from 'node:dgram'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Fixture, NetworkInterface, NodeInfo, Port, Snapshot } from '../src/types'
import { artPoll, artRdm, artTodControl, artTodRequest, opcode, OPCODE, parseArtRdm, parsePollReply, parseTodData, PID, rdmFrame } from './protocol'
import { simulatorData } from './simulator'
import { readLuminex, verifyLuminexTarget } from './luminex'

const PORT = 6454
const POLL_INTERVAL = 60_000
const MISSES_BEFORE_OFFLINE = 2
const RDM_PACING_MS = 20
const sourceUid = `7FF0:${randomBytes(4).toString('hex').toUpperCase()}`
const word = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const string = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '').trim()

export function interfaces(): NetworkInterface[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal)
    .map(entry => {
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      return { id: `${name}|${entry.address}`, name, address: entry.address, broadcast: ip.map((part, i) => (part | (255 ^ mask[i]))).join('.') }
    }))
}

interface Pending {
  id: string; ip: string; uid: string; transaction: number; pid: number; command: number; port: Port
  resolve: (value: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout
  datagrams: number; malformed: number; unmatched: number; lastMismatch?: string
}
interface QueuedTask { priority: number; run: () => Promise<void> }
interface RdmRoute { ip: string; uid: string; index: number; net: number; address: number }
const rdmRoute = (f: Fixture): RdmRoute => ({ ip: f.nodeIp, uid: f.uid, index: f.port.index, net: f.port.net, address: f.port.address })
class RdmResponseError extends Error {}
class RdmTimeoutError extends Error {}

export class Controller {
  private socket?: dgram.Socket
  private bound = false
  private pollTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private heartbeatPending = false
  private simulator = simulatorData()
  private state: Snapshot = { mode: 'simulator', connected: true, interfaceId: '', ...structuredClone(this.simulator) }
  private pending?: Pending
  private transaction = 0
  private lastRdmComplete?: number
  private tasks: QueuedTask[] = []
  private processing = false
  private polling = false
  private cycle = 0
  private discoveryArmed = true
  private rdmMisses = new Map<string, number>()
  private todMisses = new Map<string, { count: number; cycle: number }>()
  private luminexAbsent = new Set<string>()
  private expectedAddresses = new Map<string, number>()
  private generation = 0
  private todBlocks = new Map<string, { total: number; blocks: Map<number, string[]>; started: number; complete: boolean }>()
  private loading = new Set<string>()
  private initialized = new Set<string>()
  private luminexLoading = new Set<string>()
  private luminexAbort = new AbortController()
  constructor(private publish: (state: Snapshot) => void) { this.startPolling() }
  snapshot(): Snapshot { return structuredClone({ ...this.state, polling: this.polling }) }
  private emit() { this.publish(this.snapshot()) }
  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.pollTimer = setInterval(() => {
      const generation = this.generation
      void this.pollCycle().catch(error => {
        if (generation === this.generation) { this.state.pollError = String(error); this.emit() }
      })
    }, POLL_INTERVAL)
    this.pollTimer.unref()
    if (this.state.mode === 'network') {
      this.heartbeatTimer = setInterval(() => {
        if (this.heartbeatPending || !this.state.connected) return
        this.heartbeatPending = true
        const generation = this.generation
        void this.enqueue(0, () => this.poll()).catch(error => {
          if (generation === this.generation) { this.state.pollError = String(error); this.emit() }
        }).finally(() => { this.heartbeatPending = false })
      }, 3000)
      this.heartbeatTimer.unref()
    }
  }
  private enqueue<T>(priority: number, work: () => Promise<T>): Promise<T> {
    const generation = this.generation
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ priority, run: async () => {
        if (generation !== this.generation) { reject(new Error('Connection or table changed')); return }
        try {
          const value = await work()
          if (generation !== this.generation) throw new Error('Connection or table changed')
          resolve(value)
        } catch (error) { reject(error) }
      } })
      void this.processTasks()
    })
  }
  private async processTasks() {
    if (this.processing) return
    this.processing = true
    while (this.tasks.length) {
      const index = this.tasks.findIndex(task => task.priority === 1)
      const [task] = this.tasks.splice(index < 0 ? 0 : index, 1)
      await task.run()
      await delay(20)
    }
    this.processing = false
  }
  private cancelWork() {
    this.generation++
    this.luminexAbort.abort()
    this.luminexAbort = new AbortController()
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(new Error('Connection or table changed'))
      this.pending = undefined
    }
    this.todBlocks.clear()
    this.loading.clear()
    this.initialized.clear()
    this.rdmMisses.clear()
    this.todMisses.clear()
    this.luminexAbsent.clear()
    this.expectedAddresses.clear()
    this.lastRdmComplete = undefined
    this.luminexLoading.clear()
  }
  private close() {
    this.cancelWork()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.pollTimer = undefined
    this.heartbeatTimer = undefined
    if (this.bound) this.socket?.close()
    this.bound = false
    this.socket = undefined
  }
  private disconnect(reason: string) {
    this.close()
    this.state.connected = false
    this.state.pollError = reason
    for (const node of this.state.nodes) node.isOnline = false
    for (const fixture of this.state.fixtures) {
      fixture.isOnline = false
      fixture.reachabilityError = reason
    }
    this.emit()
  }
  async connect(mode: 'simulator' | 'network', interfaceId: string) {
    const adapter = interfaces().find(i => i.id === interfaceId)
    if (mode === 'network' && !adapter) {
      if (this.state.mode !== 'network' || this.state.interfaceId !== interfaceId) {
        this.state = { mode, connected: false, interfaceId, nodes: [], fixtures: [] }
      }
      const reason = `Selected network adapter ${interfaceId} is unavailable`
      this.disconnect(reason)
      throw new Error(reason)
    }
    this.close()
    this.discoveryArmed = true
    this.state = { mode, connected: false, interfaceId, nodes: [], fixtures: [] }
    this.emit()
    if (mode === 'simulator') {
      this.simulator = simulatorData()
      Object.assign(this.state, structuredClone(this.simulator), { connected: true })
      this.startPolling()
      this.emit()
      return
    }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false })
    this.socket = socket
    socket.on('message', (message, remote) => this.receive(message, remote.address))
    socket.on('error', error => {
      console.error('Art-Net socket error:', error)
      if (this.socket === socket) {
        this.disconnect(`Art-Net connection error: ${error.message}`)
      }
    })
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error)
      socket.once('error', fail)
      socket.bind(PORT, adapter!.address, () => { this.bound = true; socket.off('error', fail); resolve() })
    })
    socket.setBroadcast(true)
    console.info(`[Art-Net] Listening on ${adapter!.name} ${adapter!.address}:${PORT}; directed broadcast ${adapter!.broadcast}`)
    this.state.connected = true
    this.emit()
    this.startPolling()
    await this.discover(false)
  }
  private send(data: Buffer, ip: string): Promise<void> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('Not connected to an Art-Net network'))
    const op = opcode(data)
    if (op === OPCODE.todRequest || op === OPCODE.todControl || op === OPCODE.rdm) {
      const addresses = op === OPCODE.todRequest ? [...data.subarray(24, 24 + data[23])].join(',') : String(data[23])
      console.info(`[Art-Net TX] ${op === OPCODE.todRequest ? 'ArtTodRequest' : op === OPCODE.todControl ? 'ArtTodControl flush' : 'ArtRdm'} ip=${ip} net=${data[21]} address=${addresses}${op === OPCODE.rdm ? ` port-address=${(data[21] << 8) | data[23]} subnet=${data[23] >> 4} universe=${data[23] & 15} uid=${data.subarray(26, 32).toString('hex')} transaction=${data[38]} subdevice=${data.readUInt16BE(41)} command=0x${data[43].toString(16)} pid=0x${data.readUInt16BE(44).toString(16)} artnet=${data.toString('hex')} rdm=cc${data.subarray(24).toString('hex')}` : ''}`)
    }
    return new Promise((resolve, reject) => socket.send(data, PORT, ip, error => {
      if (error) { console.error(`[Art-Net TX] ${ip}:`, error); reject(error) } else resolve()
    }))
  }
  private async poll() {
    const adapter = interfaces().find(i => i.id === this.state.interfaceId)
    if (!adapter) {
      const reason = `Selected network adapter ${this.state.interfaceId} is unavailable`
      this.disconnect(reason)
      throw new Error(reason)
    }
    const errors: string[] = []
    let sent = 0
    for (const ip of new Set([adapter.broadcast, '2.255.255.255', '10.255.255.255'])) {
      try { await this.send(artPoll(), ip); sent++ } catch (error) { errors.push(`${ip}: ${String(error)}`) }
    }
    if (!sent) throw new Error(`Could not send ArtPoll: ${errors.join('; ')}`)
    if (errors.length) console.warn('Some ArtPoll destinations were unreachable:', errors.join('; '))
  }
  async discover(force: boolean) {
    if (!this.state.connected) throw new Error('Connect before discovering fixtures')
    if (this.state.mode === 'simulator') {
      if (force) this.simulator.fixtures.forEach(f => { f.identify = false })
      await this.pollCycle()
      return
    }
    this.cycle++
    this.discoveryArmed = true
    const errors = await this.enqueue(1, () => this.discoverNetwork(force))
    if (errors.length) throw new Error(`Discovery failed: ${errors.join('; ')}`)
  }
  async pollNow() {
    if (!this.state.connected) throw new Error('Connect before polling fixtures')
    if (this.polling) throw new Error('A polling cycle is already running')
    await this.pollCycle()
  }
  private async discoverNetwork(force: boolean) {
    const errors: string[] = []
    const generation = this.generation
    try { await this.poll() } catch (error) { errors.push(String(error)) }
    if (force) await delay(1100)
    if (generation !== this.generation) throw new Error('Connection or table changed')
    const sent = new Set<string>()
    for (const node of this.state.nodes) for (const port of node.ports) {
      if (port.direction && port.direction !== 'output') continue
      if (generation !== this.generation) throw new Error('Connection or table changed')
      const key = `${node.ip}/${port.net}/${port.address}`
      if (sent.has(key)) continue
      sent.add(key)
      try {
        if (force) await this.send(artTodControl(port.net, port.address), node.ip)
        if (generation !== this.generation) throw new Error('Connection or table changed')
        await this.send(artTodRequest(port.net, [port.address]), node.ip)
      }
      catch (error) { errors.push(`${node.ip} port ${port.index}: ${String(error)}`) }
    }
    for (const node of this.state.nodes) this.startLuminex(node)
    return errors
  }
  private isLuminex(node: NodeInfo) {
    return node.manufacturerCode === 0x4c4c || /luminex|luminode|lumicore/i.test(`${node.shortName} ${node.longName}`)
  }
  private startLuminex(node: NodeInfo) {
    if (!this.isLuminex(node) || this.luminexLoading.has(node.ip)) return
    const adapter = interfaces().find(item => item.id === this.state.interfaceId)
    if (!adapter) { console.warn(`[Luminex] ${node.ip}: selected network adapter unavailable`); return }
    const generation = this.generation
    this.luminexLoading.add(node.ip)
    void readLuminex(node.ip, adapter.address, 80, this.luminexAbort.signal).then(result => {
      if (generation !== this.generation) return
      this.state.luminex ??= {}
      this.state.luminex[node.ip] = { ports: result.ports, errors: result.errors }
      for (const entry of this.state.nodes.filter(item => item.ip === node.ip)) entry.luminexError = result.errors.length ? result.errors.join('; ') : undefined
      for (const error of result.errors) console.warn(`[Luminex] ${node.ip}: ${error}`)
      const returned = new Set<string>()
      for (const fixture of this.state.fixtures.filter(f => f.nodeIp === node.ip)) {
        const apiPort = result.ports.find(port => port.index === fixture.port.index)
        if (apiPort && (!apiPort.rdm || apiPort.direction !== 'output')) {
          fixture.isOnline = false
          fixture.rdmAvailable = false
          fixture.reachabilityError = 'RDM is disabled or this port is not an output'
          continue
        }
        if (apiPort?.uids) {
          if (apiPort.uids.includes(fixture.uid)) {
            if (this.luminexAbsent.delete(fixture.id)) returned.add(fixture.id)
          } else {
            this.luminexAbsent.add(fixture.id)
            fixture.isOnline = false
            fixture.reachabilityError = "Fixture is no longer present in the node's RDM device list for this port"
          }
        }
      }
      for (const item of result.fixtures) {
        const apiPort = result.ports.find(port => port.index === item.port)!
        const owners = result.ports.filter(port => port.uids?.includes(item.uid))
        if (owners.length !== 1) {
          console.warn(`[Luminex] ${node.ip}: ${item.uid} belongs to multiple ports; skipped`)
          for (const fixture of this.state.fixtures.filter(f => f.nodeIp === node.ip && f.uid === item.uid)) {
            fixture.isOnline = false
            fixture.rdmAvailable = false
            fixture.reachabilityError = 'Luminex reports this UID on multiple ports'
          }
          continue
        }
        const existing = this.state.fixtures.filter(fixture => fixture.nodeIp === node.ip && fixture.uid === item.uid)
        const fixture = existing.find(f => f.port.index === item.port) ?? existing[0]
        for (const duplicate of existing) {
          if (duplicate !== fixture) {
            this.luminexAbsent.delete(duplicate.id)
            this.state.fixtures = this.state.fixtures.filter(f => f !== duplicate)
          }
        }
        const advertised = this.state.nodes.filter(n => n.ip === node.ip).flatMap(n => n.ports).find(port => port.index === item.port)
        const address = apiPort.rdmUniverse
        const port: Port = { index: item.port, localIndex: advertised?.localIndex ?? 1, bindIndex: advertised?.bindIndex ?? 1, net: address === undefined ? 0 : address >> 8, address: address === undefined ? 0 : address & 255, direction: 'output', protocol: apiPort.protocol, sacnUniverse: apiPort.protocol === 'sacn' ? apiPort.universe : undefined, artnetUniverse: apiPort.protocol === 'artnet' ? apiPort.universe : undefined }
        let current = fixture
        if (!current) {
          current = { id: `${node.ip}/luminex/${item.port}/${item.uid}`, uid: item.uid, nodeIp: node.ip, nodeName: node.shortName || node.longName, port, manufacturer: '', model: '', label: '', address: 0, footprint: 0, personality: 0, personalities: [], sensorCount: 0, identify: false, lastSeen: 0, isOnline: false, patchStatus: 'initial' }
          this.state.fixtures.push(current)
        }
        current.port = port
        if (this.luminexAbsent.delete(current.id)) returned.add(current.id)
        current.rdmAvailable = address !== undefined
        if (!current.rdmAvailable) { current.isOnline = false; current.reachabilityError = 'Luminex port has no valid RDM universe' }
        if (!this.initialized.has(current.id)) {
          if (item.manufacturer) current.manufacturer = item.manufacturer
          if (item.model) current.model = item.model
          if (item.label) current.label = item.label
          if (item.address !== undefined && item.address >= 1 && item.address <= 512) current.address = item.address
          if (item.footprint !== undefined && item.footprint >= 0 && item.footprint <= 512) current.footprint = item.footprint
          if (item.personality !== undefined && item.personality >= 1 && item.personality <= 255) current.personality = item.personality
        }
        this.todMisses.delete(current.id)
        if (current.rdmAvailable && (!this.initialized.has(current.id) || returned.has(current.id))) this.startRefresh(current.id)
      }
      this.emit()
    }).catch(error => {
      if (generation !== this.generation) return
      console.warn(`[Luminex] ${node.ip}: ${String(error)}`)
      for (const entry of this.state.nodes.filter(item => item.ip === node.ip)) entry.luminexError = String(error)
      this.emit()
    }).finally(() => { if (generation === this.generation) this.luminexLoading.delete(node.ip) })
  }
  private seen(f: Fixture) {
    if (this.luminexAbsent.has(f.id) || f.rdmAvailable === false) return
    f.lastSeen = Date.now()
    f.isOnline = true
    f.reachabilityError = undefined
    this.rdmMisses.delete(f.id)
  }
  private missed(f: Fixture) {
    const misses = (this.rdmMisses.get(f.id) ?? 0) + 1
    this.rdmMisses.set(f.id, misses)
    if (misses >= MISSES_BEFORE_OFFLINE) f.isOnline = false
  }
  private observedAddress(f: Fixture, address: number) {
    const expected = this.expectedAddresses.get(f.id)
    if (expected !== undefined && address === expected) f.patchStatus = 'local'
    else if (f.address !== 0 && f.address !== address) f.patchStatus = 'external'
    this.expectedAddresses.delete(f.id)
    f.address = address
    this.seen(f)
  }
  private async pollCycle() {
    if (this.polling || !this.state.connected) return
    this.polling = true
    this.emit()
    const generation = this.generation
    this.cycle++
    try {
      if (this.state.mode === 'simulator') {
        await this.enqueue(0, async () => {
          const now = Date.now()
          this.state.nodes = structuredClone(this.simulator.nodes).map(node => ({ ...node, lastSeen: now, isOnline: true }))
          for (const simulated of this.simulator.fixtures) {
            let fixture = this.state.fixtures.find(f => f.id === simulated.id)
            if (!fixture && simulated.simulatedOnline) {
              fixture = structuredClone(simulated)
              fixture.patchStatus = 'initial'
              this.state.fixtures.push(fixture)
            }
            if (!fixture) continue
            fixture.simulatedOnline = simulated.simulatedOnline
            if (simulated.simulatedOnline) {
              this.observedAddress(fixture, simulated.address)
              fixture.identify = simulated.identify
            }
            else this.missed(fixture)
          }
          this.state.pollError = undefined
          this.emit()
        })
        return
      }
      this.discoveryArmed = true
      const errors = await this.enqueue(0, () => this.discoverNetwork(false))
      for (const node of this.state.nodes) {
        if (Date.now() - node.lastSeen >= POLL_INTERVAL * MISSES_BEFORE_OFFLINE) node.isOnline = false
      }
      this.emit()
      const ids = this.state.fixtures.map(f => f.id)
      for (const id of ids) {
        if (generation !== this.generation) return
        if (this.loading.has(id) || this.luminexAbsent.has(id)) continue
        await this.enqueue(0, async () => {
          const fixture = this.fixture(id)
          try {
            const response = await this.request(id, 0x20, PID.address)
            if (response.length !== 2) throw new Error('Invalid DMX_START_ADDRESS response')
            if (this.luminexAbsent.has(id)) return
            this.observedAddress(fixture, response.readUInt16BE(0))
            if (!this.initialized.has(id)) this.startRefresh(id)
          } catch (error) {
            if (generation !== this.generation) throw error
            if (this.luminexAbsent.has(id)) return
            if (!(error instanceof RdmResponseError)) this.missed(fixture)
            fixture.reachabilityError = String(error)
            console.warn(`[RDM] Reachability check for ${fixture.uid}: ${String(error)}`)
          }
          this.emit()
        })
      }
      if (generation === this.generation) { this.state.pollError = errors.length ? errors.join('; ') : undefined; this.emit() }
    } finally {
      this.polling = false
      this.emit()
    }
  }
  clearTable() {
    this.cancelWork()
    this.discoveryArmed = false
    this.state.nodes = []
    this.state.fixtures = []
    this.state.luminex = undefined
    this.state.pollError = undefined
    this.emit()
  }
  simulateOnline(id: string, online: boolean) {
    if (this.state.mode !== 'simulator' || typeof online !== 'boolean') throw new Error('Simulator mode required')
    const fixture = this.simulator.fixtures.find(f => f.id === id)
    if (!fixture) throw new Error('Simulated fixture not found')
    fixture.simulatedOnline = online
    const displayed = this.state.fixtures.find(f => f.id === id)
    if (displayed) displayed.simulatedOnline = online
    this.emit()
  }
  simulateAddress(id: string, address: number) {
    if (this.state.mode !== 'simulator') throw new Error('Simulator mode required')
    if (!Number.isInteger(address) || address < 1 || address > 512) throw new Error('DMX address must be between 1 and 512')
    const fixture = this.simulator.fixtures.find(f => f.id === id)
    if (!fixture) throw new Error('Simulated fixture not found')
    fixture.address = address
  }
  private receive(data: Buffer, ip: string) {
    if (this.pending && ip === this.pending.ip) this.pending.datagrams++
    if (opcode(data) === OPCODE.pollReply) {
      if (!this.discoveryArmed) return
      const node = parsePollReply(data, ip)
      if (!node) { console.warn(`[Art-Net RX] Invalid ArtPollReply ip=${ip} bytes=${data.length}`); return }
      console.info(`[Art-Net RX] ArtPollReply ip=${ip} name=${node.shortName || node.longName || '(unnamed)'} bind=${node.bindIndex} ports=${node.ports.map(p => `${p.localIndex}:${p.net}:${p.address}`).join(',') || 'none'}`)
      const existing = this.state.nodes.findIndex(n => n.ip === ip && n.bindIndex === node.bindIndex)
      const isNew = existing < 0
      node.luminexError = this.state.nodes.find(n => n.ip === ip)?.luminexError
      if (isNew) this.state.nodes.push(node)
      else this.state.nodes[existing] = node
      this.emit()
      if (isNew) this.startLuminex(node)
      if (isNew) for (const port of node.ports) {
        if (port.direction && port.direction !== 'output') continue
        void this.enqueue(0, () => this.send(artTodRequest(port.net, [port.address]), ip)).catch(error => {
          if (this.state.connected) { this.state.pollError = String(error); this.emit() }
        })
      }
    } else if (opcode(data) === OPCODE.todData) {
      const tod = parseTodData(data)
      if (!tod) { console.warn(`[Art-Net RX] Invalid ArtTodData ip=${ip} bytes=${data.length}`); return }
      console.info(`[Art-Net RX] ArtTodData ip=${ip} bind=${tod.bindIndex} port=${tod.port} net=${tod.net} address=${tod.address} block=${tod.block} uids=${tod.uids.length}/${tod.total}${tod.nak ? ' TOD unavailable/discovery incomplete' : ''}`)
      if (tod.nak) return
      if (this.state.luminex?.[ip]) { console.info(`[Art-Net RX] Using Luminex per-port RDM lists for ${ip}`); return }
      const node = this.state.nodes.find(n => n.ip === ip && n.bindIndex === tod.bindIndex)
      const port = node?.ports.find(p => (!p.direction || p.direction === 'output') && p.net === tod.net && p.address === tod.address && p.localIndex === tod.port)
      if (!node || !port) { console.warn(`[Art-Net RX] ArtTodData does not match an advertised output port ip=${ip} bind=${tod.bindIndex} port=${tod.port} net=${tod.net} address=${tod.address}`); return }
      const key = `${ip}/${tod.bindIndex}/${tod.port}/${tod.net}/${tod.address}`
      let blocks = this.todBlocks.get(key)
      if (!blocks || blocks.complete || blocks.total !== tod.total || Date.now() - blocks.started > 10_000) {
        blocks = { total: tod.total, blocks: new Map(), started: Date.now(), complete: false }
        this.todBlocks.set(key, blocks)
      }
      blocks.blocks.set(tod.block, tod.uids)
      const uids = [...blocks.blocks.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, value]) => value)
      if (uids.length !== tod.total || !Array.from({ length: blocks.blocks.size }, (_, i) => blocks!.blocks.has(i)).every(Boolean)) return
      blocks.complete = true
      for (const fixture of this.state.fixtures) {
        if (fixture.nodeIp !== ip || fixture.port.bindIndex !== port.bindIndex || fixture.port.localIndex !== port.localIndex || fixture.port.net !== port.net || fixture.port.address !== port.address) continue
        if (uids.includes(fixture.uid)) this.todMisses.delete(fixture.id)
        else {
          const previous = this.todMisses.get(fixture.id)
          if (previous?.cycle !== this.cycle) {
            const count = (previous?.count ?? 0) + 1
            this.todMisses.set(fixture.id, { count, cycle: this.cycle })
            if (count >= MISSES_BEFORE_OFFLINE) fixture.isOnline = false
          }
        }
      }
      for (const uid of uids) {
        const id = `${ip}/${port.bindIndex}/${port.index}/${port.net}/${port.address}/${uid}`
        const isNew = !this.state.fixtures.some(f => f.id === id)
        if (isNew) {
          this.state.fixtures.push({ id, uid, nodeIp: ip, nodeName: node.shortName || node.longName, port, manufacturer: '', model: '', label: '', address: 0, footprint: 0, personality: 0, personalities: [], sensorCount: 0, identify: false, lastSeen: 0, isOnline: false, patchStatus: 'initial' })
          this.startRefresh(id)
        }
      }
      this.emit()
    } else if (opcode(data) === OPCODE.rdm) {
      const response = parseArtRdm(data)
      if (!response) {
        if (this.pending && ip === this.pending.ip) this.pending.malformed++
        console.warn(`[Art-Net RX] Invalid ArtRdm ip=${ip} bytes=${data.length} packet=${data.toString('hex')}`)
        return
      }
      console.info(`[Art-Net RX] ArtRdm ip=${ip} net=${response.net} address=${response.address} uid=${response.source} transaction=${response.transaction} pid=0x${response.pid.toString(16)} type=${response.responseType} packet=${data.toString('hex')}`)
      const pending = this.pending
      if (!pending || ip !== pending.ip || response.source !== pending.uid || response.destination !== sourceUid || response.transaction !== pending.transaction || response.pid !== pending.pid || response.command !== pending.command + 1 || response.subDevice !== 0 || response.net !== pending.port.net || response.address !== pending.port.address) {
        const differences = pending ? [
          ip !== pending.ip ? `ip ${ip} != ${pending.ip}` : '',
          response.source !== pending.uid ? `source ${response.source} != ${pending.uid}` : '',
          response.destination !== sourceUid ? `destination ${response.destination} != ${sourceUid}` : '',
          response.transaction !== pending.transaction ? `transaction ${response.transaction} != ${pending.transaction}` : '',
          response.pid !== pending.pid ? `pid 0x${response.pid.toString(16)} != 0x${pending.pid.toString(16)}` : '',
          response.command !== pending.command + 1 ? `command 0x${response.command.toString(16)} != 0x${(pending.command + 1).toString(16)}` : '',
          response.subDevice !== 0 ? `subdevice ${response.subDevice} != 0` : '',
          response.net !== pending.port.net || response.address !== pending.port.address ? `port-address ${response.net}:${response.address} != ${pending.port.net}:${pending.port.address}` : ''
        ].filter(Boolean).join(', ') : 'no outstanding request'
        if (pending && ip === pending.ip) { pending.unmatched++; pending.lastMismatch = differences }
        console.warn(`[Art-Net RX] ArtRdm did not match: ${differences}`)
        return
      }
      clearTimeout(pending.timer)
      this.pending = undefined
      const fixture = this.state.fixtures.find(f => f.id === pending.id)
      if (fixture) { this.seen(fixture); this.emit() }
      if (response.responseType === 0) pending.resolve(response.data)
      else if (response.responseType === 2 && response.data.length >= 2) {
        const error = new RdmResponseError(`RDM NACK 0x${response.data.readUInt16BE(0).toString(16).padStart(4, '0')} for ${pending.uid}, PID 0x${response.pid.toString(16)} from ${ip}`)
        console.warn(`[Art-Net RX] ${error.message}`)
        pending.reject(error)
      }
      else pending.reject(new RdmResponseError(`Unsupported RDM response type ${response.responseType} for PID 0x${response.pid.toString(16)}`))
    } else if (opcode(data) === OPCODE.rdmSub) {
      console.warn(`[Art-Net RX] ArtRdmSub ip=${ip} is not supported; root-device queries use ArtRdm (0x8300)`)
    }
  }
  private fixture(id: string) {
    const f = this.state.fixtures.find(fixture => fixture.id === id)
    if (!f) throw new Error('Fixture is no longer available')
    return f
  }
  private async request(id: string, command: number, pid: number, data: Buffer = Buffer.alloc(0), expectedRoute?: RdmRoute): Promise<Buffer> {
    const generation = this.generation
    const wait = this.lastRdmComplete === undefined ? 0 : RDM_PACING_MS - (Date.now() - this.lastRdmComplete)
    if (wait > 0) await delay(wait)
    if (generation !== this.generation) throw new Error('Connection or table changed')
    if (this.pending) throw new Error('An RDM request is already in progress')
    try {
      const f = this.fixture(id)
      if (expectedRoute && (f.nodeIp !== expectedRoute.ip || f.uid !== expectedRoute.uid || f.port.index !== expectedRoute.index || f.port.net !== expectedRoute.net || f.port.address !== expectedRoute.address)) throw new Error('Nothing sent: fixture RDM route changed')
      if (f.rdmAvailable === false) return Promise.reject(new Error('Luminex port has no valid RDM universe'))
      const transaction = this.transaction = (this.transaction + 1) & 255
      const frame = rdmFrame(f.uid, sourceUid, transaction, command, pid, data)
      const port = f.port
      const timeout = command === 0x30 && pid === PID.address ? 2500 : 1500
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this.pending
          if (pending?.timer === timer) this.pending = undefined
          const details = pending?.timer === timer ? `UDP datagrams from target=${pending.datagrams}, malformed ArtRdm=${pending.malformed}, unmatched ArtRdm=${pending.unmatched}${pending.lastMismatch ? `, last mismatch: ${pending.lastMismatch}` : ''}` : 'request no longer pending'
          const error = new RdmTimeoutError(`RDM ${command === 0x30 ? 'SET' : 'GET'} timeout for ${f.uid}, PID 0x${pid.toString(16)}, ip=${f.nodeIp}, port-address=${port.net}:${port.address >> 4}:${port.address & 15}, transaction=${transaction}; ${details}`)
          console.warn(`[Art-Net] ${error.message}`)
          reject(error)
        }, timeout)
        this.pending = { id, ip: f.nodeIp, uid: f.uid, transaction, pid, command, port, resolve, reject, timer, datagrams: 0, malformed: 0, unmatched: 0 }
        void this.send(artRdm(port.net, port.address, frame), f.nodeIp).catch(error => {
          clearTimeout(timer)
          if (this.pending?.timer === timer) this.pending = undefined
          reject(error)
        })
      })
    } finally { if (generation === this.generation) this.lastRdmComplete = Date.now() }
  }
  private get(id: string, pid: number, data?: Buffer, route?: RdmRoute) { return this.request(id, 0x20, pid, data, route) }
  private async set(id: string, pid: number, data: Buffer, route?: RdmRoute) {
    const f = this.fixture(id)
    const target = route ?? rdmRoute(f)
    const generation = this.generation
    const node = this.state.nodes.find(item => item.ip === target.ip && this.isLuminex(item))
    if (node) {
      const adapter = interfaces().find(item => item.id === this.state.interfaceId)
      if (!adapter || !this.state.luminex?.[target.ip]) throw new Error('Nothing sent: Luminex port cannot be verified')
      await verifyLuminexTarget(target.ip, adapter.address, target.index, target.net * 256 + target.address, target.uid, 80, this.luminexAbort.signal)
    }
    if (generation !== this.generation) throw new Error('Connection or table changed')
    return this.request(id, 0x30, pid, data, target)
  }
  private startRefresh(id: string) {
    if (this.loading.has(id)) return
    this.loading.add(id)
    const generation = this.generation
    void this.refreshFixture(id).catch(error => {
      if (generation === this.generation) {
        const fixture = this.state.fixtures.find(f => f.id === id)
        if (fixture) { fixture.error = String(error); console.warn(`[RDM] Fixture information for ${fixture.uid}: ${fixture.error}`); this.emit() }
      }
    }).finally(() => { if (generation === this.generation) this.loading.delete(id) })
  }
  private async refreshFixture(id: string) {
    const generation = this.generation
    const check = () => { if (generation !== this.generation) throw new Error('Connection or table changed') }
    this.fixture(id).modesComplete = false
    const count = await this.enqueue(0, async () => {
      const info = await this.get(id, PID.deviceInfo)
      check()
      if (info.length < 19) throw new Error('Invalid DEVICE_INFO response')
      const f = this.fixture(id)
      f.footprint = info.readUInt16BE(10)
      f.personality = info[12]
      this.observedAddress(f, info.readUInt16BE(14))
      f.sensorCount = info[18]
      this.initialized.add(id)
      this.emit()
      return info[13]
    })
    const f = this.fixture(id)
    const errors: string[] = []
    const readOptional = async (pid: number) => {
      try { return string(await this.enqueue(0, () => this.get(id, pid))) } catch (error) { check(); errors.push(`PID 0x${pid.toString(16)}: ${String(error)}`); return '' }
    }
    f.manufacturer = await readOptional(PID.manufacturer)
    check()
    f.model = await readOptional(PID.model)
    check()
    f.label = await readOptional(PID.label)
    check()
    try {
      const address = await this.enqueue(0, () => this.get(id, PID.address))
      check()
      if (address.length !== 2) throw new Error('Invalid DMX_START_ADDRESS response')
      this.observedAddress(f, address.readUInt16BE(0))
    } catch (error) { check(); errors.push(`DMX start address: ${String(error)}`) }
    try {
      const personality = await this.enqueue(0, () => this.get(id, PID.personality))
      check()
      if (personality.length !== 2) throw new Error('Invalid DMX_PERSONALITY response')
      f.personality = personality[0]
    } catch (error) { check(); errors.push(`DMX personality: ${String(error)}`) }
    f.personalities = []
    for (let i = 1; i <= count; i++) {
      try {
        const description = await this.enqueue(0, () => this.get(id, PID.personalityDescription, Buffer.from([i])))
        check()
        if (description.length < 3 || description[0] !== i) throw new Error('Invalid personality description')
        f.personalities.push({ number: i, footprint: description.readUInt16BE(1), name: string(description.subarray(3)) || `Mode ${i}` })
      } catch (error) { check(); errors.push(`Personality ${i}: ${String(error)}`) }
    }
    f.modesComplete = f.personalities.length === count
    try { const identify = await this.enqueue(0, () => this.get(id, PID.identify)); check(); if (identify.length !== 1 || identify[0] > 1) throw new Error('Invalid identify response'); f.identify = identify[0] === 1; f.identifyUncertain = false } catch (error) { check(); errors.push(`Identify: ${String(error)}`) }
    f.error = errors.length ? errors.join('\n') : undefined
    if (f.error) console.warn(`[RDM] Fixture information for ${f.uid}: ${f.error}`)
    this.emit()
  }
  private available(id: string) {
    const fixture = this.fixture(id)
    if (!fixture.isOnline) throw new Error('Fixture is offline')
    if (!this.state.connected) throw new Error('Connection unavailable')
    if (this.state.mode === 'simulator' && !this.simulator.fixtures.find(f => f.id === id)?.simulatedOnline) throw new Error('Simulated fixture is offline')
    return fixture
  }
  async setIdentify(id: string, value: boolean) {
    return this.enqueue(1, async () => {
      const f = this.available(id)
      if (this.state.mode === 'network') {
        const generation = this.generation
        let setTimedOut = false
        try { await this.set(id, PID.identify, Buffer.from([Number(value)])) }
        catch (error) {
          if (!(error instanceof RdmTimeoutError)) throw error
          setTimedOut = true
        }
        if (generation !== this.generation) throw new Error('Connection or table changed')
        f.identifyUncertain = true
        this.emit()
        let response: Buffer
        try {
          try { response = await this.get(id, PID.identify) }
          catch (error) {
            if (!(error instanceof RdmTimeoutError)) throw error
            console.warn(`[RDM] Retrying identify verification for ${f.uid} after GET timeout`)
            response = await this.get(id, PID.identify)
          }
        } catch (error) {
          if (generation !== this.generation) throw new Error('Connection or table changed')
          throw new Error(`Identify ${value ? 'on' : 'off'} was sent to ${f.uid}, but its state could not be verified${setTimedOut ? ' (SET timed out)' : ''}: ${String(error)}`)
        }
        if (generation !== this.generation) throw new Error('Connection or table changed')
        if (response.length !== 1 || response[0] > 1) throw new Error(`Identify state for ${f.uid} is unverified: invalid GET response`)
        f.identify = response[0] === 1
        f.identifyUncertain = false
        this.seen(f)
        this.emit()
        if (f.identify !== value) throw new Error(`Fixture ${f.uid} reports identify ${f.identify ? 'on' : 'off'} instead of ${value ? 'on' : 'off'}`)
        if (setTimedOut) console.warn(`[RDM] Identify SET for ${f.uid} timed out, but GET confirmed the requested state`)
      } else this.simulator.fixtures.find(item => item.id === id)!.identify = value
      f.identify = value
      f.identifyUncertain = false
      this.seen(f)
      this.emit()
    })
  }
  async setAddress(id: string, address: number) {
    if (!Number.isInteger(address) || address < 1 || address > 512) throw new Error('DMX address must be between 1 and 512')
    return this.enqueue(1, async () => {
      const f = this.available(id)
      if (f.footprint && address + f.footprint - 1 > 512) throw new Error('Fixture footprint extends beyond address 512')
      if (this.state.mode === 'network') {
        const generation = this.generation
        const route = rdmRoute(f)
        for (let attempt = 1; attempt <= 2; attempt++) {
          let setTimeoutError: RdmTimeoutError | undefined
          try { await this.set(id, PID.address, word(address), route) }
          catch (error) {
            if (!(error instanceof RdmTimeoutError)) throw error
            setTimeoutError = error
          }
          if (generation !== this.generation) throw new Error('Connection or table changed')
          this.expectedAddresses.set(id, address)
          let response: Buffer
          try {
            try { response = await this.get(id, PID.address, undefined, route) }
            catch (error) {
              if (!(error instanceof RdmTimeoutError)) throw error
              console.warn(`[RDM] Retrying DMX_START_ADDRESS verification for ${f.uid}: ${error.message}`)
              response = await this.get(id, PID.address, undefined, route)
            }
          } catch (error) {
            if (generation !== this.generation) throw new Error('Connection or table changed')
            throw new Error(`Address SET to ${address} may have been applied to ${f.uid}, but could not be verified${setTimeoutError ? `; ${setTimeoutError.message}` : ''}; verification: ${String(error)}`)
          }
          if (generation !== this.generation) throw new Error('Connection or table changed')
          if (response.length !== 2) throw new Error(`Address SET to ${address} may have been applied to ${f.uid}, but verification returned an invalid response${setTimeoutError ? `; ${setTimeoutError.message}` : ''}`)
          const actual = response.readUInt16BE(0)
          this.observedAddress(f, actual)
          this.emit()
          if (actual === address) {
            if (setTimeoutError) console.warn(`[RDM] Address SET timed out, but GET confirmed ${f.uid} at ${address}: ${setTimeoutError.message}`)
            break
          }
          if (!setTimeoutError || attempt === 2) throw new Error(`Fixture ${f.uid} reports address ${actual} instead of ${address}${setTimeoutError ? `; ${setTimeoutError.message}` : ''}`)
          console.warn(`[RDM] ${setTimeoutError.message}; GET reports ${actual}, retrying address SET to ${address} once`)
        }
      } else this.simulator.fixtures.find(item => item.id === id)!.address = address
      f.address = address
      f.patchStatus = 'local'
      this.seen(f)
      this.emit()
    })
  }
  async setPersonality(id: string, personality: number) {
    return this.enqueue(1, async () => {
      const f = this.available(id)
      if (!f.personalities.some(p => p.number === personality)) throw new Error('Unknown personality')
      if (this.state.mode === 'network') {
        await this.set(id, PID.personality, Buffer.from([personality]))
        const info = await this.get(id, PID.deviceInfo)
        if (info.length < 19 || info[12] !== personality) throw new Error('Fixture did not confirm the requested personality')
        f.footprint = info.readUInt16BE(10)
        f.address = info.readUInt16BE(14)
      } else {
        f.footprint = f.personalities.find(p => p.number === personality)!.footprint
        const simulated = this.simulator.fixtures.find(item => item.id === id)!
        simulated.personality = personality
        simulated.footprint = f.footprint
      }
      f.personality = personality
      f.patchStatus = 'local'
      this.seen(f)
      this.emit()
    })
  }
  async setLabel(id: string, label: string) {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 32) throw new Error('Device label must be at most 32 bytes')
    return this.enqueue(1, async () => {
      const f = this.available(id)
      if (this.state.mode === 'network') {
        await this.set(id, PID.label, bytes)
        const response = await this.get(id, PID.label)
        if (string(response) !== label.trim()) throw new Error('Fixture did not confirm the requested label')
      } else this.simulator.fixtures.find(item => item.id === id)!.label = label.trim()
      f.label = label.trim()
      this.seen(f)
      this.emit()
    })
  }
}
