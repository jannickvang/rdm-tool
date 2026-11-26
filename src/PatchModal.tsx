import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Lightbulb, X } from 'lucide-react'
import type { Fixture } from './types'
import { portLabel, universeProtocol, universeValue } from './utils'

interface Props {
  ids: string[]
  fixtures: Fixture[]
  close: () => void
  report: (error: unknown) => void
  runBackground: (description: string, action: () => Promise<void>, complete?: (success: boolean) => void) => void
  backgroundErrors: string[]
}

type PatchStatus = 'pending' | 'done' | 'failed'

export default function PatchModal({ ids, fixtures, close, report, runBackground, backgroundErrors }: Props) {
  const [index, setIndex] = useState(0)
  const [target, setTarget] = useState(() => String(fixtures.find(f => f.id === ids[0])?.address || 1))
  const [increment, setIncrement] = useState(true)
  const [gap, setGap] = useState('0')
  const [statuses, setStatuses] = useState<Record<string, PatchStatus>>({})
  const statusRef = useRef<Record<string, PatchStatus>>({})
  const [identifyPending, setIdentifyPending] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const active = fixtures.find(f => f.id === ids[index])
  const activeId = ids[index]
  const activeRef = useRef(activeId)
  const operation = useRef(false)
  const closing = useRef(false)
  const selectOpen = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    input.current?.focus()
    input.current?.select()
    return () => { mounted.current = false }
  }, [])

  const identify = useCallback((fixture: Fixture | undefined, value: boolean) => {
    if (!fixture?.isOnline) {
      const error = new Error(`Fixture ${fixture?.label || fixture?.uid || 'unknown'} is offline; identify ${value ? 'on' : 'off'} could not be sent`)
      setLocalError(error.message)
      report(error)
      return
    }
    setIdentifyPending(current => ({ ...current, [fixture.id]: (current[fixture.id] ?? 0) + 1 }))
    runBackground(`Identify ${value ? 'on' : 'off'} for ${fixture.label || fixture.uid} (${fixture.uid})`, () => window.rdm.setIdentify(fixture.id, value), () => {
      if (mounted.current) setIdentifyPending(current => ({ ...current, [fixture.id]: Math.max(0, (current[fixture.id] ?? 1) - 1) }))
    })
  }, [report, runBackground])

  useEffect(() => {
    identify(fixtures.find(f => f.id === ids[0]), true)
    // The initial identify belongs to this wizard session, not later snapshot updates.
  }, [])

  const run = useCallback(async (action: () => Promise<void>) => {
    if (operation.current || closing.current) return
    operation.current = true
    setBusy(true)
    setLocalError('')
    try { await action() } catch (error) { setLocalError(String(error)); report(error) }
    finally { operation.current = false; setBusy(false) }
  }, [report])

  const navigate = useCallback((next: number) => {
    if (operation.current || closing.current) return
    if (next < 0 || next >= ids.length || next === index) return
    setLocalError('')
    identify(fixtures.find(f => f.id === activeRef.current), false)
    activeRef.current = ids[next]
    setIndex(next)
    const nextFixture = fixtures.find(f => f.id === ids[next])
    if (nextFixture?.isOnline) identify(nextFixture, true)
    else setLocalError('Fixture is offline; patch and identify are unavailable')
  }, [ids, index, fixtures, identify])

  const finish = useCallback(() => {
    if (operation.current || closing.current) return
    closing.current = true
    identify(fixtures.find(f => f.id === activeRef.current), false)
    close()
  }, [fixtures, close, identify])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selectOpen.current) { selectOpen.current = false; return }
      if (event.key === 'Escape') { event.preventDefault(); void finish(); return }
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement
      const previous = event.key === 'PageUp' || event.key === 'ArrowUp' && !editing || event.key === 'ArrowLeft' && (!editing || event.altKey || event.metaKey)
      const next = event.key === 'PageDown' || event.key === 'ArrowDown' && !editing || event.key === 'ArrowRight' && (!editing || event.altKey || event.metaKey)
      if (previous || next) { event.preventDefault(); void navigate(index + (previous ? -1 : 1)) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [finish, index, navigate])

  const patch = () => {
    if (operation.current || closing.current || !active || statusRef.current[active.id] === 'pending') return
    if (!active.isOnline) { setLocalError('Fixture is offline'); return }
    const address = Number(target)
    const offset = Number(gap)
    if (!Number.isInteger(address) || address < 1 || address > 512) { setLocalError('Enter a DMX address from 1 to 512'); return }
    if (!Number.isInteger(offset) || offset < 0 || offset > 511) { setLocalError('Gap must be a non-negative whole number'); return }
    if (increment && active.footprint < 1) { setLocalError('Cannot increment: fixture footprint is unknown'); return }
    if (active.footprint && address + active.footprint - 1 > 512) { setLocalError('Fixture footprint extends beyond address 512'); return }
    setLocalError('')
    const updated = { ...statusRef.current, [active.id]: 'pending' as const }
    statusRef.current = updated
    setStatuses(updated)
    runBackground(`Patch ${active.label || active.uid} (${active.uid}) to ${address}`, () => window.rdm.setAddress(active.id, address), success => {
      if (!mounted.current) return
      const nextStatuses = { ...statusRef.current, [active.id]: success ? 'done' as const : 'failed' as const }
      statusRef.current = nextStatuses
      setStatuses(nextStatuses)
    })
    identify(active, false)
    const unsubmitted = (id: string) => updated[id] !== 'pending' && updated[id] !== 'done'
    const next = ids.findIndex((id, i) => i > index && unsubmitted(id))
    const wrapped = next < 0 ? ids.findIndex(unsubmitted) : next
    if (wrapped < 0) { closing.current = true; close(); return }
    if (increment) setTarget(String(address + active.footprint + offset))
    activeRef.current = ids[wrapped]
    setIndex(wrapped)
    const nextFixture = fixtures.find(f => f.id === ids[wrapped])
    if (nextFixture?.isOnline) identify(nextFixture, true)
    else setLocalError('Fixture is offline; patch and identify are unavailable')
  }

  if (!active) return <div className="overlay"><div className="modal"><p>Fixture is no longer available.</p><button className="button" onClick={close}>Close</button></div></div>
  return (
    <div className="overlay" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="patch-title" tabIndex={-1} onKeyDownCapture={event => {
        if (event.target instanceof HTMLSelectElement && (event.key === ' ' || event.altKey && event.key === 'ArrowDown')) selectOpen.current = true
        if (event.key === 'Enter' && !selectOpen.current) { event.preventDefault(); event.stopPropagation(); void patch() }
      }}>
        <div className="modal-top">
          <div><div className="eyebrow">PATCH WORKFLOW</div><h2 id="patch-title">Step-by-step patch</h2><p>Identify and address your fixtures one at a time.</p></div>
          <button className="icon-button" aria-label="Close patch wizard" disabled={busy} onClick={() => void finish()}><X size={19} /></button>
        </div>
        <div className="wizard-nav">
          <button className="icon-button bordered" aria-label="Previous fixture" aria-disabled={busy || index === 0} onClick={() => void navigate(index - 1)}><ChevronLeft size={18} /></button>
          <span>Fixture <strong>{index + 1}</strong> of {ids.length}</span>
          <button className="icon-button bordered" aria-label="Next fixture" aria-disabled={busy || index === ids.length - 1} onClick={() => void navigate(index + 1)}><ChevronRight size={18} /></button>
          <div className="nav-hint"><ArrowLeft size={13} /><ArrowRight size={13} /> navigate &nbsp;·&nbsp; Page Up / Down</div>
        </div>
        <div className="progress"><div style={{ width: `${((index + 1) / ids.length) * 100}%` }} /></div>
        <div className="fixture-card">
          <div className="fixture-card-head">
            <div><div className="eyebrow">ACTIVE FIXTURE</div><h3>{active.manufacturer || 'Unknown manufacturer'} <span>{active.model || 'Unknown model'}</span></h3><div className="muted">{active.label || 'No device label'}</div></div>
            <button className={`identify-button ${active.identify ? 'active' : ''}`} disabled={busy || !active.isOnline || !!identifyPending[active.id]} onClick={() => identify(active, active.identifyUncertain ? false : !active.identify)}><Lightbulb size={15} /> {identifyPending[active.id] ? 'Identify pending' : active.identify ? 'Identifying' : 'Identify'}</button>
          </div>
          <div className="fixture-details">
            <div><span>RDM UID</span><strong className="mono">{active.uid}</strong></div>
            <div><span>NODE & PORT</span><strong>{active.nodeName} · {portLabel(active.port)}</strong></div>
            <div><span>UNIVERSE</span><strong>{universeProtocol(active.port)} {universeValue(active.port)}</strong></div>
            <div><span>CURRENT ADDRESS</span><strong>{active.address || '—'}</strong></div>
          </div>
          <label className="field-label">DMX MODE / PERSONALITY
            <select className="field full" disabled={busy || statuses[active.id] === 'pending' || !active.isOnline || !active.personalities.length} value={active.personality} onPointerDown={() => { selectOpen.current = !selectOpen.current }} onBlur={() => { selectOpen.current = false }} onChange={event => { selectOpen.current = false; void run(() => window.rdm.setPersonality(active.id, Number(event.target.value))) }}>
              {!active.personalities.length && <option value={active.personality}>Unavailable</option>}
              {active.personalities.map(p => <option key={p.number} value={p.number}>{p.name} · {p.footprint} ch</option>)}
            </select>
          </label>
        </div>
        <form onSubmit={event => { event.preventDefault(); void patch() }}>
          <div className="patch-fields">
            <label className="field-label">TARGET DMX ADDRESS
              <input ref={input} className="field target-input" type="number" min="1" max="512" value={target} onChange={event => setTarget(event.target.value)} />
              <small>Enter a value between 1 and 512</small>
            </label>
            <label className="field-label">CHANNEL GAP
              <input className="field gap-input" type="number" min="0" max="511" value={gap} onChange={event => setGap(event.target.value)} />
              <small>Extra channels between fixtures</small>
            </label>
          </div>
          <div className="increment-row"><label><input type="checkbox" checked={increment} onChange={event => setIncrement(event.target.checked)} /> Auto-increment after patch</label><span>+{active.footprint} ch <span className="muted">+ {gap || 0} gap</span></span></div>
          {!active.isOnline && <div className="inline-error" role="alert">Fixture offline; patch and identify are unavailable.</div>}
          {localError && <div className="inline-error" role="alert">{localError}</div>}
          {backgroundErrors.length > 0 && <div className="inline-error" role="alert">{backgroundErrors.map((message, i) => <div key={i}>{message}</div>)}</div>}
          {Object.values(statuses).some(status => status === 'pending') && <div className="patch-pending" role="status">{Object.values(statuses).filter(status => status === 'pending').length} patch(es) awaiting confirmation</div>}
          <div className="modal-bottom"><div className="queue">{ids.map((id, i) => <button type="button" key={id} title={`Fixture ${i + 1}${statuses[id] ? ` · ${statuses[id]}` : ''}`} className={`queue-dot ${i === index ? 'current' : ''} ${statuses[id] || ''}`} disabled={busy} onClick={() => void navigate(i)}>{statuses[id] === 'done' ? <Check size={12} /> : i + 1}</button>)}</div><button className="button primary" disabled={busy || !active.isOnline || statuses[active.id] === 'pending'} type="submit">Patch & advance <ArrowRight size={16} /></button></div>
        </form>
      </section>
    </div>
  )
}
