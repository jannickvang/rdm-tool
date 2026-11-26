import type { Fixture, NodeInfo, Port } from './types'
export const universe = (p: Port) => `${p.net}:${p.address >> 4}:${p.address & 15}`
export const universeValue = (p: Port) => p.protocol === 'sacn' ? (p.sacnUniverse === undefined ? 'Unknown' : `U${p.sacnUniverse}`) : p.protocol === 'unknown' ? 'Unknown' : p.artnetUniverse === undefined ? universe(p) : `${p.artnetUniverse >> 8}:${p.artnetUniverse >> 4 & 15}:${p.artnetUniverse & 15}`
export const universeProtocol = (p: Port) => p.protocol === 'sacn' ? 'sACN' : p.protocol === 'unknown' ? 'Unknown' : 'Art-Net'
export const universeNumber = (p: Port) => p.protocol === 'sacn' ? p.sacnUniverse ?? Number.POSITIVE_INFINITY : p.protocol === 'unknown' ? Number.POSITIVE_INFINITY : p.artnetUniverse ?? p.net * 256 + p.address
export const portLabel = (p: Port) => `Port ${p.index <= 26 ? String.fromCharCode(64 + p.index) : p.index}`
export function groupNodes(nodes: NodeInfo[]): NodeInfo[][] {
  const groups: NodeInfo[][] = []
  for (const node of [...nodes].sort((a, b) => a.bindIndex - b.bindIndex)) {
    const group = groups.find(items => items.some(item => node.mac && item.mac ? node.mac === item.mac : node.ip === item.ip) && !items.some(item => item.ip === node.ip && item.mac && node.mac && item.mac !== node.mac))
    if (group) group.push(node)
    else groups.push([node])
  }
  return groups
}
export function conflicts(fixtures: Fixture[]): Set<string> {
  const result = new Set<string>()
  for (let i = 0; i < fixtures.length; i++) for (let j = i + 1; j < fixtures.length; j++) {
    const a = fixtures[i], b = fixtures[j]
    const aUniverse = universeNumber(a.port), bUniverse = universeNumber(b.port)
    if (universeProtocol(a.port) !== universeProtocol(b.port) || !Number.isFinite(aUniverse) || aUniverse !== bUniverse || !a.address || !b.address || !a.footprint || !b.footprint) continue
    if (a.address <= b.address + b.footprint - 1 && b.address <= a.address + a.footprint - 1) { result.add(a.id); result.add(b.id) }
  }
  return result
}
