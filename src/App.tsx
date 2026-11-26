import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowDown, ArrowDownUp, ArrowUp, Cable, Check, ChevronDown, CircleDot, Crosshair, Lightbulb, LightbulbOff, Network, Plus, RefreshCw, Search, Settings2, Sparkles, Trash2 } from 'lucide-react'
import PatchModal from './PatchModal'
import type { Fixture, NetworkInterface, Personality, Snapshot } from './types'
import { conflicts, groupNodes, portLabel, universe, universeNumber, universeProtocol, universeValue } from './utils'

const initial: Snapshot = { mode: 'simulator', connected: false, interfaceId: '', nodes: [], fixtures: [] }
const lastInterfaceKey = 'rdm.lastInterface'

function sharedModes(fixtures: Fixture[]): Personality[] {
  const first = fixtures[0]
  if (!first?.manufacturer.trim() || !first.model.trim() || !first.personalities.length || fixtures.some(f => !f.isOnline || f.modesComplete === false || f.manufacturer !== first.manufacturer || f.model !== first.model)) return []
  const signature = (modes: Personality[]) => JSON.stringify([...modes].sort((a, b) => a.number - b.number).map(mode => [mode.number, mode.name, mode.footprint]))
  const expected = signature(first.personalities)
  return fixtures.every(f => signature(f.personalities) === expected) ? [...first.personalities].sort((a, b) => a.number - b.number) : []
}

function fixtureWarning(fixture: Fixture, connected: boolean): string {
  const messages: string[] = []
  if (fixture.reachabilityError) {
    if (!connected) messages.push('The network connection is unavailable, so the fixture status cannot be checked.')
    else if (fixture.rdmAvailable === false) messages.push('RDM is unavailable for this fixture. Check the node port and RDM configuration.')
    else if (!fixture.isOnline) messages.push('The fixture is offline or not responding. Check its power, DMX cabling and RDM settings.')
    else messages.push('The latest RDM check failed. The fixture status or DMX address may be out of date.')
  }
  if (fixture.error) {
    messages.push('Some fixture details could not be read and may be incomplete or out of date.')
    if (fixture.modesComplete === false) messages.push('The DMX mode list is incomplete; the right-click mode menu is unavailable.')
  }
  return messages.join('\n')
}

function FixtureWarning({ message, size }: { message: string; size: number }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<number>()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const open = hovered || focused
  const enter = () => { window.clearTimeout(leaveTimer.current); setHovered(true) }
  const leave = () => { leaveTimer.current = window.setTimeout(() => setHovered(false), 100) }
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      if (!trigger.current || !tooltip.current) return
      const target = trigger.current.getBoundingClientRect()
      const box = tooltip.current.getBoundingClientRect()
      tooltip.current.style.left = `${Math.max(8, Math.min(target.left, window.innerWidth - box.width - 8))}px`
      tooltip.current.style.top = `${Math.max(8, Math.min(target.bottom + 8, window.innerHeight - box.height - 8))}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, message])
  return <>
    <button ref={trigger} type="button" className="fixture-warning" aria-label={`Fixture warning: ${message}`} aria-describedby={open ? id : undefined} onMouseEnter={enter} onMouseLeave={leave} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={event => { if (event.key === 'Escape') { setHovered(false); setFocused(false) } }}><AlertTriangle className="warning" size={size} aria-hidden="true" /></button>
    {open && createPortal(<div ref={tooltip} id={id} className="fixture-tooltip" role="tooltip" onMouseEnter={enter} onMouseLeave={leave}>{message}</div>, document.body)}
  </>
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(initial)
  const [adapters, setAdapters] = useState<NetworkInterface[]>([])
  const [adapter, setAdapter] = useState('')
  const [search, setSearch] = useState('')
  const [universeFilter, setUniverseFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; fixtureId: string } | null>(null)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [batchChanging, setBatchChanging] = useState(false)
  const [identifyAllRunning, setIdentifyAllRunning] = useState(false)
  const [manualPolling, setManualPolling] = useState(false)
  const [identifyPending, setIdentifyPending] = useState<string[]>([])
  const [labelEdit, setLabelEdit] = useState<{ id: string; draft: string } | null>(null)
  const [labelSaving, setLabelSaving] = useState(false)
  const [labelError, setLabelError] = useState('')
  const [backgroundCount, setBackgroundCount] = useState(0)
  const [backgroundErrors, setBackgroundErrors] = useState<string[]>([])
  const [wizard, setWizard] = useState<string[] | null>(null)
  const [nodesOpen, setNodesOpen] = useState(false)
  const [nodesError, setNodesError] = useState('')
  const [nodeSort, setNodeSort] = useState<{ key: 'name' | 'ip'; descending: boolean }>({ key: 'name', descending: false })
  const [nodeFilter, setNodeFilter] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [sort, setSort] = useState<{ key: string; descending: boolean }>({ key: 'label', descending: false })
  const report = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), [])
  useEffect(() => {
    let active = true
    const unsubscribe = window.rdm.onSnapshot(setSnapshot)
    setBusy(true)
    void (async () => {
      try {
        const state = await window.rdm.snapshot()
        if (!active) return
        setSnapshot(state)
        const items = await window.rdm.interfaces()
        if (!active) return
        setAdapters(items)
        let saved: string | null
        try { saved = window.localStorage.getItem(lastInterfaceKey) }
        catch (err) { throw new Error(`Could not read adapter preference: ${String(err)}`) }
        setAdapter(saved && saved !== 'simulator' ? saved : state.interfaceId || items[0]?.id || '')
        if (saved && saved !== 'simulator' && !items.some(item => item.id === saved)) {
          await window.rdm.connect('network', saved)
          throw new Error(`Saved network adapter ${saved} is unavailable; select an adapter to reconnect`)
        }
        if (saved === 'simulator' && (state.mode !== 'simulator' || !state.connected)) await window.rdm.connect('simulator', '')
        else if (saved && saved !== 'simulator' && (state.mode !== 'network' || state.interfaceId !== saved || !state.connected)) await window.rdm.connect('network', saved)
      } catch (err) { if (active) report(err) }
      finally { if (active) setBusy(false) }
    })()
    return () => { active = false; unsubscribe() }
  }, [report])
  useEffect(() => {
    const timer = window.setInterval(() => { void window.rdm.interfaces().then(setAdapters).catch(report) }, 3000)
    return () => window.clearInterval(timer)
  }, [report])
  useEffect(() => {
    setSelected(current => {
      const available = current.filter(id => snapshot.fixtures.some(f => f.id === id))
      return available.length === current.length ? current : available
    })
  }, [snapshot.fixtures])
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!contextMenu || !menu) return
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(contextMenu.x, window.innerWidth - rect.width))}px`
    menu.style.top = `${Math.max(0, Math.min(contextMenu.y, window.innerHeight - rect.height))}px`
    const first = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (first) first.focus()
    else menu.focus()
  }, [contextMenu, modeMenuOpen])
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); if (modeMenuOpen) setModeMenuOpen(false); else setContextMenu(null) } }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) setContextMenu(null) }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true) }
  }, [contextMenu, modeMenuOpen])
  const run = async (action: () => Promise<void>) => {
    try { setError(''); await action() } catch (err) { report(err); throw err }
  }
  const perform = (action: () => Promise<void>) => { void run(action).catch(() => {}) }
  const pollNow = () => {
    setManualPolling(true)
    void run(() => window.rdm.pollNow()).catch(() => {}).finally(() => setManualPolling(false))
  }
  const changeConnection = useCallback((mode: 'network' | 'simulator', id: string) => {
    setBusy(true)
    setError('')
    try { window.localStorage.setItem(lastInterfaceKey, mode === 'simulator' ? 'simulator' : id) }
    catch (err) { report(new Error(`Could not save adapter preference: ${String(err)}`)) }
    void window.rdm.connect(mode, id).then(() => setSelected([])).catch(report).finally(() => setBusy(false))
  }, [report])
  const nextReconnect = useRef(0)
  useEffect(() => {
    if (snapshot.mode !== 'network' || snapshot.connected || !adapter || adapter !== snapshot.interfaceId || !adapters.some(item => item.id === adapter) || busy || batchChanging || backgroundCount > 0 || identifyPending.length > 0 || wizard || labelEdit) return
    const timer = window.setTimeout(() => {
      nextReconnect.current = Date.now() + 10_000
      changeConnection('network', adapter)
    }, Math.max(0, nextReconnect.current - Date.now()))
    return () => window.clearTimeout(timer)
  }, [snapshot.mode, snapshot.connected, snapshot.interfaceId, adapter, adapters, busy, batchChanging, backgroundCount, identifyPending.length, wizard, labelEdit, changeConnection])
  const runBackground = useCallback((description: string, action: () => Promise<void>, complete?: (success: boolean) => void) => {
    setBackgroundCount(count => count + 1)
    void Promise.resolve().then(action).then(() => complete?.(true), err => {
      setBackgroundErrors(errors => [...errors, `${description}: ${err instanceof Error ? err.message : String(err)}`])
      complete?.(false)
    }).finally(() => setBackgroundCount(count => count - 1))
  }, [])
  const overlap = useMemo(() => conflicts(snapshot.fixtures), [snapshot.fixtures])
  const nodes = useMemo(() => groupNodes(snapshot.nodes), [snapshot.nodes])
  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => {
    const value = (group: typeof a) => nodeSort.key === 'name' ? group[0].shortName || group[0].longName || group[0].ip : group[0].ip
    return value(a).localeCompare(value(b), undefined, { numeric: true, sensitivity: 'base' }) * (nodeSort.descending ? -1 : 1)
  }), [nodes, nodeSort])
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    const uq = universeFilter.toLowerCase().trim()
    const list = snapshot.fixtures.filter(f => (!nodeFilter || nodeFilter.includes(f.nodeIp)) && [f.manufacturer, f.model, f.label, f.uid, f.nodeName, f.nodeIp, universeProtocol(f.port), universeValue(f.port), Number.isFinite(universeNumber(f.port)) ? String(universeNumber(f.port)) : '', f.address.toString()].some(value => value.toLowerCase().includes(q)) && `${universeProtocol(f.port)} ${universeValue(f.port)} ${Number.isFinite(universeNumber(f.port)) ? universeNumber(f.port) : ''}`.toLowerCase().includes(uq))
    const get = (f: Fixture): string | number => {
      switch (sort.key) {
        case 'universe': return universeNumber(f.port)
        case 'address': return f.address
        case 'mode': return f.personalities.find(p => p.number === f.personality)?.name ?? ''
        case 'model': return `${f.manufacturer} ${f.model}`
        case 'label': return f.label
        default: return `${f.nodeName} ${String(f.port.index).padStart(3, '0')}`
      }
    }
    return list.sort((a, b) => {
      const x = get(a), y = get(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * (sort.descending ? -1 : 1)
    })
  }, [snapshot.fixtures, search, universeFilter, sort, nodeFilter])
  const toggleSort = (key: string) => setSort(current => ({ key, descending: current.key === key ? !current.descending : false }))
  const selectable = filtered
  const allSelected = selectable.length > 0 && selectable.every(f => selected.includes(f.id))
  const toggleAll = () => { anchor.current = null; setSelected(current => allSelected ? current.filter(id => !selectable.some(f => f.id === id)) : [...new Set([...current, ...selectable.map(f => f.id)])]) }
  const selectedIds = selected.filter(id => snapshot.fixtures.some(f => f.id === id))
  const selectedFixtures = selectedIds.flatMap(id => snapshot.fixtures.filter(f => f.id === id))
  const canPatch = snapshot.connected && !busy && selectedFixtures.length > 0 && selectedFixtures.every(f => f.isOnline) && !batchChanging && identifyPending.length === 0 && backgroundCount === 0
  const modes = backgroundCount || !snapshot.connected ? [] : sharedModes(selectedFixtures)
  const menuFixture = snapshot.fixtures.find(f => f.id === contextMenu?.fixtureId)
  const labelFixture = snapshot.fixtures.find(f => f.id === labelEdit?.id)
  const orderedSelection = () => filtered.filter(f => selectedIds.includes(f.id)).map(f => f.id).concat(selectedIds.filter(id => !filtered.some(f => f.id === id)))
  const selectRow = (id: string, range: boolean, toggle: boolean) => {
    if (busy || batchChanging) return
    setContextMenu(null)
    const start = filtered.findIndex(f => f.id === anchor.current)
    const end = filtered.findIndex(f => f.id === id)
    if (range && start >= 0 && end >= 0) {
      const ids = filtered.slice(Math.min(start, end), Math.max(start, end) + 1).map(f => f.id)
      setSelected(current => toggle ? [...new Set([...current, ...ids])] : ids)
    } else {
      setSelected(current => toggle ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id])
      anchor.current = id
    }
  }
  const changeModes = (mode: number) => {
    const targets = orderedSelection()
    setContextMenu(null)
    setBatchChanging(true)
    void run(async () => {
      let completed = 0
      for (const id of targets) {
        const fixture = snapshot.fixtures.find(f => f.id === id)
        try { await window.rdm.setPersonality(id, mode); completed++ }
        catch (err) { throw new Error(`Mode change stopped at ${fixture?.label || fixture?.uid || id} after ${completed} of ${targets.length} fixtures: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }).catch(() => {}).finally(() => setBatchChanging(false))
  }
  const identifyFixture = (fixture: Fixture) => {
    setIdentifyPending(current => [...current, fixture.id])
    void run(() => window.rdm.setIdentify(fixture.id, fixture.identifyUncertain ? false : !fixture.identify))
      .catch(() => {}).finally(() => setIdentifyPending(current => current.filter(id => id !== fixture.id)))
  }
  const identifyOffAll = () => {
    const targets = snapshot.fixtures
    setBatchChanging(true)
    setIdentifyAllRunning(true)
    void run(async () => {
      const failures: string[] = []
      for (const fixture of targets) {
        try { await window.rdm.setIdentify(fixture.id, false) }
        catch (err) { failures.push(`${fixture.label || fixture.uid} (${fixture.uid}): ${err instanceof Error ? err.message : String(err)}`) }
      }
      if (failures.length) throw new Error(`Identify off failed for ${failures.length} of ${targets.length} fixtures: ${failures.join('; ')}`)
    }).catch(() => {}).finally(() => { setBatchChanging(false); setIdentifyAllRunning(false) })
  }
  const saveLabel = () => {
    if (!labelEdit || !labelFixture?.isOnline || labelSaving) return
    setLabelSaving(true)
    setLabelError('')
    void window.rdm.setLabel(labelEdit.id, labelEdit.draft).then(() => setLabelEdit(null))
      .catch(err => setLabelError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLabelSaving(false))
  }
  const header = (label: string, key: string) => <button className="sort" onClick={() => toggleSort(key)}>{label} <ArrowDownUp size={12} className={sort.key === key ? 'sort-active' : ''} /></button>
  const nodeHeader = (label: string, key: 'name' | 'ip') => <button className="sort" onClick={() => setNodeSort(current => ({ key, descending: current.key === key ? !current.descending : false }))}>{label} {nodeSort.key !== key ? <ArrowDownUp size={12} /> : nodeSort.descending ? <ArrowDown size={12} className="sort-active" /> : <ArrowUp size={12} className="sort-active" />}</button>
  return (
    <div className="app-shell">
      <main className="main">
        <div className="content">
          <div className="page-heading"><div><div className="eyebrow">LIGHTING CONTROL / RDM</div><h1>Fixture manager<span>.</span></h1><p>Discover, identify, and patch fixtures across your network.</p></div><button className="button primary" disabled={!canPatch} onClick={() => setWizard(orderedSelection())}><Plus size={16} /> Patch selected <span className="button-count">{selectedIds.length}</span></button></div>
          <div className="stats">
            <div className="stat"><div className="stat-icon blue"><Network size={17} /></div><div><span>NODES ONLINE</span><strong>{String(nodes.filter(group => group.some(node => node.isOnline)).length).padStart(2, '0')}</strong></div></div>
            <div className="stat"><div className="stat-icon purple"><Lightbulb size={17} /></div><div><span>FIXTURES FOUND</span><strong>{String(snapshot.fixtures.length).padStart(2, '0')}</strong></div></div>
            <div className="stat"><div className="stat-icon green"><CircleDot size={17} /></div><div><span>UNIVERSES</span><strong>{String(new Set(snapshot.fixtures.filter(f => Number.isFinite(universeNumber(f.port))).map(f => `${universeProtocol(f.port)}/${universeNumber(f.port)}`)).size).padStart(2, '0')}</strong></div></div>
            <div className="stat stat-network"><div className="stat-icon amber"><Cable size={17} /></div><div><span>CONNECTION</span><strong className="stat-connection"><span className={`status-dot ${snapshot.connected ? 'online' : ''}`} /> {snapshot.mode === 'simulator' ? 'Simulator' : snapshot.connected ? 'Connected' : 'Disconnected'}</strong></div></div>
          </div>
          <div className="control-bar">
            <div className="adapter-control"><Network size={16} /><div><span>NETWORK ADAPTER</span><select aria-label="Network adapter" value={snapshot.mode === 'simulator' ? 'simulator' : adapter} disabled={busy || batchChanging || backgroundCount > 0 || identifyPending.length > 0 || !!wizard || !!labelEdit} onChange={event => { if (event.target.value === 'simulator') changeConnection('simulator', ''); else { setAdapter(event.target.value); changeConnection('network', event.target.value) } }}><option value="simulator">Simulator mode</option>{snapshot.mode === 'network' && adapter && !adapters.some(item => item.id === adapter) && <option value={adapter} disabled>{adapter} · unavailable</option>}{adapters.map(item => <option key={item.id} value={item.id}>{item.name} · {item.address}</option>)}</select></div><ChevronDown size={14} /></div>
            <div className="control-separator" />
            {snapshot.mode === 'network' && !snapshot.connected && <button className="button secondary" disabled={busy || batchChanging || !adapters.some(item => item.id === adapter)} onClick={() => changeConnection('network', adapter)}><RefreshCw size={15} /> Reconnect</button>}
            <button className="button secondary" disabled={busy || batchChanging || !snapshot.connected} onClick={() => perform(() => window.rdm.discover(false))}><RefreshCw size={15} /> Discover / Refresh</button>
            <button className="button secondary" disabled={busy || !snapshot.connected || manualPolling || snapshot.polling} onClick={pollNow}><RefreshCw size={15} /> {manualPolling || snapshot.polling ? 'Polling…' : 'Poll now'}</button>
            <button className="button secondary" disabled={batchChanging} onClick={() => { setNodesError(''); setNodesOpen(true) }}><Network size={15} /> Network Nodes</button>
            <button className="button secondary" disabled={busy || batchChanging || backgroundCount > 0 || identifyPending.length > 0 || !!wizard || !snapshot.connected || !snapshot.fixtures.length} onClick={identifyOffAll}><LightbulbOff size={15} /> {identifyAllRunning ? 'Turning identify off…' : 'Identify off for all'}</button>
            <button className="button ghost" disabled={busy || batchChanging || !snapshot.connected} onClick={() => perform(() => window.rdm.discover(true))}><Sparkles size={15} /> Force full discovery</button>
            <button className="button ghost" disabled={busy || batchChanging || backgroundCount > 0 || identifyPending.length > 0 || !!wizard || !!labelEdit || !snapshot.fixtures.length && !snapshot.nodes.length} onClick={() => perform(async () => { await window.rdm.clearTable(); setSelected([]); anchor.current = null })}><Trash2 size={15} /> Clear list</button>
            <span className="poll-status" title={snapshot.pollError || 'Background discovery and reachability polling every 60 seconds'}><span className={`status-dot ${snapshot.connected && !snapshot.pollError ? 'online' : ''}`} /> {snapshot.pollError ? 'POLL ERROR' : snapshot.connected ? 'POLLING · 60S' : 'POLLING STOPPED'}</span>
          </div>
          {snapshot.pollError && <div className="error-banner" role="alert"><AlertTriangle size={16} /> Background polling: {snapshot.pollError}</div>}
          {error && <div className="error-banner" role="alert"><AlertTriangle size={16} /> {error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {backgroundCount > 0 && <div className="background-status" role="status">{backgroundCount} background RDM {backgroundCount === 1 ? 'operation' : 'operations'} pending</div>}
          {backgroundErrors.length > 0 && <div className="error-banner" role="alert"><AlertTriangle size={16} /><div>{backgroundErrors.map((message, index) => <div key={index}>{message}</div>)}</div><button onClick={() => setBackgroundErrors([])} aria-label="Dismiss background errors">×</button></div>}
          <section className="table-section">
            <div className="table-heading"><div><h2>Fixtures <span>{filtered.length}</span></h2><p>{nodeFilter ? <>Filtered by {nodeFilter.join(', ')} <button className="filter-clear" onClick={() => setNodeFilter(null)}>Clear filter</button></> : 'All discovered RDM devices on your network'}</p></div><div className="table-actions"><div className="search"><Search size={16} /><input placeholder="Search fixtures, nodes, addresses..." value={search} onChange={event => setSearch(event.target.value)} /></div><div className="search"><input aria-label="Filter by universe or protocol" placeholder="Universe / protocol" value={universeFilter} onChange={event => setUniverseFilter(event.target.value)} /></div></div></div>
            <div className="table-scroll"><table className="fixtures-table"><thead><tr><th><div className="status-cell"><input type="checkbox" aria-label="Select all visible fixtures" checked={allSelected} disabled={batchChanging} onChange={toggleAll} /> ONLINE STATUS</div></th><th>{header('LABEL', 'label')}</th><th>{header('ADDRESS', 'address')}</th><th>{header('UNIVERSE', 'universe')}</th><th>{header('DMX MODE', 'mode')}</th><th>{header('MANUFACTURER / MODEL', 'model')}</th><th>{header('NODE & PORT', 'node')}</th><th>IDENTIFY</th></tr></thead>
              <tbody>{filtered.map(f => <tr key={f.id} tabIndex={0} aria-selected={selectedIds.includes(f.id)} className={`${selectedIds.includes(f.id) ? 'selected' : ''} ${!snapshot.connected || !f.isOnline ? 'offline-row' : ''}`}
                onMouseDown={event => { if (event.shiftKey && !(event.target instanceof Element && event.target.closest('input, button, select, textarea, a, [contenteditable="true"]'))) event.preventDefault() }}
                onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('input, button, select, textarea, a')) selectRow(f.id, event.shiftKey, event.metaKey || event.ctrlKey) }}
                onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectRow(f.id, event.shiftKey, event.metaKey || event.ctrlKey) } }}
                onContextMenu={event => {
                  event.preventDefault()
                  if (batchChanging) return
                  if (!selectedIds.includes(f.id)) { setSelected([f.id]); anchor.current = f.id }
                  setModeMenuOpen(false)
                  setContextMenu({ x: event.clientX, y: event.clientY, fixtureId: f.id })
                }}>
                <td><div className="status-cell"><input type="checkbox" aria-label={`Select ${f.uid}`} checked={selectedIds.includes(f.id)} disabled={batchChanging} onClick={event => event.stopPropagation()} onChange={event => { const native = event.nativeEvent; selectRow(f.id, native instanceof MouseEvent && native.shiftKey, native instanceof MouseEvent && native.shiftKey ? native.metaKey || native.ctrlKey : true) }} /><span className={`status-dot ${snapshot.connected && f.isOnline ? 'online' : 'offline'}`} title={!snapshot.connected ? `Connection unavailable; fixture status cannot be verified${f.lastSeen ? ` · last seen ${new Date(f.lastSeen).toLocaleString()}` : ''}` : f.lastSeen ? `Fixture ${f.isOnline ? 'online' : 'offline'} · last seen ${new Date(f.lastSeen).toLocaleString()}` : 'No RDM response yet'} role="img" aria-label={!snapshot.connected ? 'Connection unavailable' : f.isOnline ? 'Online' : 'Offline'} />{(f.error || f.reachabilityError) && <FixtureWarning size={15} message={fixtureWarning(f, snapshot.connected)} />}</div></td>
                <td>{f.label || <span className="muted">No label</span>}</td>
                <td><div className="address-cell"><span className="mono">{f.address || '—'}</span>{overlap.has(f.id) && <FixtureWarning size={15} message="DMX address overlap: this fixture shares channels with another fixture in the same universe." />}{f.patchStatus === 'local' && <span className="patch-badge local" title="Patched locally">Patched ✓</span>}{f.patchStatus === 'external' && <span className="patch-badge external" title="Address changed outside this app">Changed externally</span>}</div></td>
                <td><span className="universe-tag" title={f.port.protocol === 'sacn' ? `RDM Art-Net ${universe(f.port)}` : undefined}>{universeProtocol(f.port)} · {universeValue(f.port)}</span></td>
                <td><span className="mode-badge">{f.personalities.find(p => p.number === f.personality)?.name || (f.personality ? `Mode ${f.personality}` : 'Unavailable')}</span></td>
                <td><div className="model-cell"><strong>{f.manufacturer || 'Unknown'}</strong><small>{f.model || (f.error ? 'RDM error' : 'Loading…')}</small></div></td>
                <td><div className="node-cell"><span className="node-icon"><Network size={14} /></span><div><strong>{f.nodeName || f.nodeIp}</strong><small>{portLabel(f.port)} <span>·</span> {f.nodeIp}</small><small>{snapshot.nodes.some(n => n.ip === f.nodeIp && n.isOnline) ? 'Node online' : 'Node offline'}</small>{snapshot.mode === 'simulator' && <div className="sim-actions"><button disabled={batchChanging} title="Change simulated fixture reachability" onClick={() => perform(() => window.rdm.simulateOnline(f.id, !f.simulatedOnline))}>Sim {f.simulatedOnline ? 'offline' : 'online'}</button><button disabled={batchChanging} title="Simulate an address change by another controller" onClick={() => perform(() => window.rdm.simulateAddress(f.id, f.address >= 512 - Math.max(f.footprint, 1) + 1 ? 1 : f.address + 1))}>External +1</button></div>}</div></div></td>
                <td><button className={`identify-icon ${f.identify ? 'active' : ''} ${f.identifyUncertain ? 'uncertain' : ''}`} disabled={busy || !snapshot.connected || !f.isOnline || batchChanging || backgroundCount > 0 || identifyPending.includes(f.id)} title={!snapshot.connected ? 'Connection unavailable' : !f.isOnline ? 'Fixture offline' : f.identifyUncertain ? 'Identify state unverified; click to turn off' : f.identify ? 'Stop identify' : 'Identify fixture'} aria-label={`${f.identify || f.identifyUncertain ? 'Stop identifying' : 'Identify'} ${f.uid}`} onClick={() => identifyFixture(f)}><Lightbulb size={16} /></button></td>
              </tr>)}</tbody></table>
              {!filtered.length && <div className="empty"><Crosshair size={25} /><strong>No fixtures found</strong><span>Choose an adapter and discover devices, or use simulator mode.</span></div>}
            </div>
            <div className="table-footer"><span>Showing <strong>{filtered.length}</strong> of <strong>{snapshot.fixtures.length}</strong> fixtures</span><span>{selectedIds.length ? <><Check size={13} /> {selectedIds.length} selected</> : <><Settings2 size={13} /> Ready to patch</>}</span></div>
          </section>
        </div>
      </main>
      {contextMenu && <div ref={menuRef} className="fixture-context-menu" role="menu" aria-label={modeMenuOpen ? 'Set DMX Mode' : 'Fixture actions'} tabIndex={-1} style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => {
        if (event.key === 'ArrowLeft' && modeMenuOpen) { event.preventDefault(); setModeMenuOpen(false); return }
        if (event.key === 'ArrowRight' && !modeMenuOpen && modes.length && (event.target as HTMLElement).getAttribute('aria-haspopup') === 'menu') { event.preventDefault(); setModeMenuOpen(true); return }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        if (!buttons.length) return
        const index = buttons.findIndex(button => button === document.activeElement)
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus()
      }}>
        {modeMenuOpen ? <><button role="menuitem" onClick={() => setModeMenuOpen(false)}>‹ Back</button><div className="context-heading">Set DMX Mode</div>{modes.map(mode => <button role="menuitem" key={mode.number} onClick={() => changeModes(mode.number)}>{mode.name || `Mode ${mode.number}`} <span>{mode.footprint} ch</span></button>)}</> : <>
          <button role="menuitem" disabled={!canPatch} title={backgroundCount || identifyPending.length ? 'Wait for background RDM operations to complete' : !canPatch ? 'All selected fixtures must be online' : undefined} onClick={() => { setContextMenu(null); setWizard(orderedSelection()) }}>Patch</button>
          <button role="menuitem" disabled={!snapshot.connected || !menuFixture?.isOnline} onClick={() => { if (menuFixture) { setLabelError(''); setLabelEdit({ id: menuFixture.id, draft: menuFixture.label }); setContextMenu(null) } }}>Edit label</button>
          {modes.length > 0 && <button role="menuitem" aria-haspopup="menu" aria-expanded={false} onClick={() => setModeMenuOpen(true)}>Set DMX Mode <span>›</span></button>}
        </>}
      </div>}
      {labelEdit && <div className="overlay">
        <form className="modal label-modal" role="dialog" aria-modal="true" aria-labelledby="label-title" onSubmit={event => { event.preventDefault(); saveLabel() }} onKeyDown={event => { if (event.key === 'Escape' && !labelSaving) { event.preventDefault(); setLabelEdit(null) } }}>
          <div className="modal-top"><div><div className="eyebrow">FIXTURE SETTINGS</div><h2 id="label-title">Edit label</h2><p>{labelFixture ? `${labelFixture.label || 'No label'} · ${labelFixture.uid}` : 'Fixture no longer available'}</p></div><button type="button" className="icon-button" aria-label="Close label editor" disabled={labelSaving} onClick={() => setLabelEdit(null)}>×</button></div>
          <label className="field-label label-edit-field">DEVICE LABEL<input className="field full" autoFocus value={labelEdit.draft} disabled={labelSaving} onChange={event => setLabelEdit({ ...labelEdit, draft: event.target.value })} /></label>
          <p className="muted">Maximum 32 UTF-8 bytes. Only this fixture will be changed.</p>
          {labelError && <div className="inline-error" role="alert">{labelError}</div>}
          {labelFixture && !labelFixture.isOnline && <div className="inline-error" role="alert">Fixture is offline.</div>}
          <div className="label-modal-actions"><button type="button" className="button secondary" disabled={labelSaving} onClick={() => setLabelEdit(null)}>Cancel</button><button type="submit" className="button primary" disabled={labelSaving || !labelFixture?.isOnline}>Save label</button></div>
        </form>
      </div>}
      {nodesOpen && <div className="overlay" onClick={event => { if (event.target === event.currentTarget) setNodesOpen(false) }}>
        <section className="modal nodes-modal" role="dialog" aria-modal="true" aria-labelledby="nodes-title" onKeyDown={event => { if (event.key === 'Escape') setNodesOpen(false) }}>
          <div className="modal-top"><div><div className="eyebrow">ART-NET DISCOVERY</div><h2 id="nodes-title">Network Nodes</h2><p>Select a node to filter fixtures, or an IP address to open its web interface.</p></div><button className="icon-button" aria-label="Close network nodes" autoFocus onClick={() => setNodesOpen(false)}>×</button></div>
          {nodesError && <div className="inline-error" role="alert">{nodesError}</div>}
          <div className="table-scroll nodes-table"><table><thead><tr><th aria-sort={nodeSort.key === 'name' ? nodeSort.descending ? 'descending' : 'ascending' : 'none'}>{nodeHeader('NAME / TYPE', 'name')}</th><th aria-sort={nodeSort.key === 'ip' ? nodeSort.descending ? 'descending' : 'ascending' : 'none'}>{nodeHeader('IP / MAC', 'ip')}</th><th>PORTS / UNIVERSES</th><th>RDM DEVICES</th><th>STATUS / LAST SEEN</th></tr></thead>
            <tbody>{sortedNodes.map(group => {
              const node = group[0]
              const ips = [...new Set(group.map(item => item.ip))]
              const mac = group.find(item => item.mac)?.mac
              const apiPorts = ips.flatMap(ip => snapshot.luminex?.[ip]?.ports ?? [])
              const ports = apiPorts.length ? apiPorts.map(p => {
                const advertised = group.flatMap(item => item.ports).find(port => port.index === p.index)
                const address = p.protocol === 'artnet' && p.universe !== undefined ? p.universe : p.rdmUniverse
                return { index: p.index, localIndex: advertised?.localIndex ?? 1, bindIndex: advertised?.bindIndex ?? 1, net: address === undefined ? 0 : address >> 8, address: address === undefined ? 0 : address & 255, direction: p.direction, protocol: p.protocol, sacnUniverse: p.protocol === 'sacn' ? p.universe : undefined }
              }) : group.flatMap(item => item.ports)
              const lastSeen = Math.max(...group.map(item => item.lastSeen))
              const online = group.some(item => item.isOnline)
              return <tr key={`${mac || node.ip}/${node.ip}`}>
                <td><button className="node-select" onClick={() => { setNodeFilter(ips); setSelected([]); setNodesOpen(false) }}>{node.shortName || node.longName || node.ip}</button><div className="muted">{node.longName && node.longName !== node.shortName ? node.longName : ''}</div>{group.some(n => n.luminexError) && <div className="warning" title={group.find(n => n.luminexError)?.luminexError}>Luminex API unavailable or incomplete</div>}</td>
                <td>{ips.map((ip, index) => <span key={ip}>{index > 0 && ', '}<button className="node-select" aria-label={`Open web interface for ${ip}`} onClick={() => { setNodesError(''); void window.rdm.openNodeWeb(ip).catch(error => setNodesError(`Could not open ${ip}: ${error instanceof Error ? error.message : String(error)}`)) }}>{ip}</button></span>)}<div className="muted">{mac || 'MAC unavailable'}</div></td>
                <td>{ports.length ? ports.map((port, i) => <div key={`${port.bindIndex}/${port.localIndex}/${i}`}>{portLabel(port)} · {port.direction === 'input' ? 'DMX In' : port.direction === 'off' ? 'Off / Unassigned' : port.direction === 'unknown' ? 'Direction unknown' : `${universeProtocol(port)} Out`}{port.direction !== 'off' && port.protocol !== 'unknown' ? ` · ${universeProtocol(port)} ${universeValue(port)}` : ''}</div>) : 'No DMX ports advertised'}</td>
                <td>{snapshot.fixtures.filter(f => ips.includes(f.nodeIp)).length}</td>
                <td><span className={`status-dot ${online ? 'online' : 'offline'}`} /> {online ? 'Online' : 'Offline'}<div className="muted">{new Date(lastSeen).toLocaleString()}</div></td>
              </tr>
            })}</tbody></table>
            {!snapshot.nodes.length && <div className="empty">No network nodes discovered.</div>}
          </div>
        </section>
      </div>}
      {wizard && <PatchModal ids={wizard} fixtures={snapshot.fixtures} close={() => setWizard(null)} report={report} runBackground={runBackground} backgroundErrors={backgroundErrors} />}
    </div>
  )
}
