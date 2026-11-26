import type { Fixture, NodeInfo, Port } from '../src/types'

export function simulatorData(): { nodes: NodeInfo[]; fixtures: Fixture[] } {
  const lastSeen = Date.now()
  const ports: Port[] = [
    { index: 1, localIndex: 1, bindIndex: 1, net: 0, address: 1 },
    { index: 2, localIndex: 2, bindIndex: 1, net: 0, address: 2 },
    { index: 1, localIndex: 1, bindIndex: 1, net: 0, address: 3 }
  ]
  const nodes: NodeInfo[] = [
    { ip: '10.0.0.21', shortName: 'LumiNode-FOH', longName: 'Luminex LumiNode 4', manufacturerCode: 0x4c55, bindIndex: 1, ports: ports.slice(0, 2), lastSeen, isOnline: true },
    { ip: '10.0.0.42', shortName: 'ELC-Stage', longName: 'ELC dmXLAN node', manufacturerCode: 0x454c, bindIndex: 1, ports: ports.slice(2), lastSeen, isOnline: true }
  ]
  const definitions = [
    ['4C55:00001001', 0, 0, 'Martin', 'MAC Aura', 'Front wash L', 1, 0],
    ['4C55:00001002', 0, 0, 'Martin', 'MAC Aura', 'Front wash R', 26, 0],
    ['4C55:00001003', 0, 1, 'Robe', 'LEDBeam 150', 'Stage left', 101, 1],
    ['4C55:00001004', 0, 1, 'Robe', 'LEDBeam 150', 'Stage right', 125, 1],
    ['454C:00002001', 1, 2, 'ETC', 'ColorSource PAR', 'Backlight 1', 1, 2],
    ['454C:00002002', 1, 2, 'ETC', 'ColorSource PAR', 'Backlight 2', 13, 2],
    ['454C:00002003', 1, 2, 'Chauvet', 'Rogue R2', 'Upstage spot', 101, 3],
    ['454C:00002004', 1, 2, 'Chauvet', 'Rogue R2', 'Downstage spot', 128, 3]
  ] as const
  const modes = [
    [{ number: 1, name: 'Basic', footprint: 25 }, { number: 2, name: 'Extended', footprint: 33 }],
    [{ number: 1, name: 'Mode 1', footprint: 24 }, { number: 2, name: 'Mode 2', footprint: 35 }],
    [{ number: 1, name: 'Direct', footprint: 12 }, { number: 2, name: 'Studio', footprint: 8 }],
    [{ number: 1, name: 'Standard', footprint: 27 }, { number: 2, name: 'Advanced', footprint: 34 }]
  ]
  return {
    nodes,
    fixtures: definitions.map(([uid, nodeIndex, portIndex, manufacturer, model, label, address, modeIndex]) => ({
      id: `${nodes[nodeIndex].ip}/${ports[portIndex].net}/${ports[portIndex].address}/${uid}`,
      uid, nodeIp: nodes[nodeIndex].ip, nodeName: nodes[nodeIndex].shortName,
      port: ports[portIndex], manufacturer, model, label, address,
      footprint: modes[modeIndex][0].footprint, personality: 1,
      personalities: modes[modeIndex], sensorCount: 0, identify: false,
      lastSeen, isOnline: true, patchStatus: 'initial' as const, simulatedOnline: true
    }))
  }
}
