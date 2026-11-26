export interface NetworkInterface {
  id: string
  name: string
  address: string
  broadcast: string
}

export interface Port {
  index: number
  localIndex: number
  bindIndex: number
  net: number
  address: number
  direction?: 'output' | 'input' | 'off' | 'unknown'
  protocol?: 'artnet' | 'sacn' | 'unknown'
  sacnUniverse?: number
  artnetUniverse?: number
}

export interface LuminexPort {
  index: number
  direction: 'output' | 'input' | 'off' | 'unknown'
  protocol: 'artnet' | 'sacn' | 'unknown'
  universe?: number
  rdmUniverse?: number
  rdm: boolean
  uids?: string[]
}

export interface NodeInfo {
  ip: string
  shortName: string
  longName: string
  manufacturerCode: number
  oemCode?: number
  style?: number
  mac?: string
  bindIndex: number
  ports: Port[]
  lastSeen: number
  isOnline: boolean
  luminexError?: string
}

export interface Personality {
  number: number
  name: string
  footprint: number
}

export interface Fixture {
  id: string
  uid: string
  nodeIp: string
  nodeName: string
  port: Port
  manufacturer: string
  model: string
  label: string
  address: number
  footprint: number
  personality: number
  personalities: Personality[]
  modesComplete?: boolean
  sensorCount: number
  identify: boolean
  identifyUncertain?: boolean
  lastSeen: number
  isOnline: boolean
  patchStatus: 'initial' | 'local' | 'external'
  simulatedOnline?: boolean
  error?: string
  reachabilityError?: string
  rdmAvailable?: boolean
}

export interface Snapshot {
  mode: 'simulator' | 'network'
  connected: boolean
  interfaceId: string
  nodes: NodeInfo[]
  fixtures: Fixture[]
  luminex?: Record<string, { ports: LuminexPort[]; errors: string[] }>
  pollError?: string
  polling?: boolean
}

export interface Bridge {
  interfaces(): Promise<NetworkInterface[]>
  snapshot(): Promise<Snapshot>
  openNodeWeb(ip: string): Promise<void>
  connect(mode: 'simulator' | 'network', interfaceId: string): Promise<void>
  discover(force: boolean): Promise<void>
  pollNow(): Promise<void>
  setIdentify(id: string, value: boolean): Promise<void>
  setAddress(id: string, address: number): Promise<void>
  setPersonality(id: string, personality: number): Promise<void>
  setLabel(id: string, label: string): Promise<void>
  clearTable(): Promise<void>
  simulateOnline(id: string, online: boolean): Promise<void>
  simulateAddress(id: string, address: number): Promise<void>
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void
}

declare global {
  interface Window { rdm: Bridge }
}
