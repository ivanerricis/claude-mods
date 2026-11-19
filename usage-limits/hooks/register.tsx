import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveAgent, Limit, RemoteState } from '../types'

const limits = atom({ plugin: 'usage-limits', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'usage-limits', key: 'context' } as const, null as number | null)
const remote = atom({ plugin: 'usage-limits', key: 'remote' } as const, null as RemoteState)

const activeAgents = atom({ plugin: 'usage-limits', key: 'activeAgents' } as const, [] as ActiveAgent[])
// Elenco degli agenti aperto di default; la chiave nuova evita di ereditare il "chiuso" delle versioni precedenti.
const agentsOpen = atom({ plugin: 'usage-limits', key: 'agentsListOpen' } as const, true)
const agentModels = atom({ plugin: 'usage-limits', key: 'agentModels' } as const, {} as Record<string, string>)

// "claude-sonnet-5-5" -> "Sonnet 5.5"; "haiku" -> "Haiku"; altro com'è.
function modelName(model: string): string {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?/i.exec(model)
  if (!m || !m[1]) return model
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  const version = m[2] ? ` ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}` : ''
  return family + version
}

const REMOTE_POLL_MS = 5_000

// Stato della Remote Control letto dall'app desktop (get_session "self"); null se non disponibile.
async function fetchRemote($: EngineInterface): Promise<RemoteState> {
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    if (res.isError) return null
    const block = res.content.find(c => c.type === 'text') as { text?: string } | undefined
    const state = block?.text ? (JSON.parse(block.text) as { remoteControlState?: string }).remoteControlState : undefined
    return state === 'on' || state === 'off' || state === 'connecting' || state === 'unavailable' ? state : null
  } catch {
    return null
  }
}

function remoteColor(state: RemoteState): string {
  if (state === 'on') return '#22c55e'
  if (state === 'connecting') return '#eab308'
  return '#808080'
}

function remoteTitle(state: RemoteState): string {
  if (state === 'on') return 'Remote Control attiva'
  if (state === 'connecting') return 'Remote Control in connessione'
  return 'Remote Control spenta'
}

function dot(state: RemoteState): string {
  const fill = state === 'off' ? 'none' : remoteColor(state)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">` +
    `<circle cx="5" cy="5" r="4" fill="${fill}" stroke="${remoteColor(state)}" stroke-width="1.5"/></svg>`
  )
}

const DAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab']

const two = (n: number) => String(n).padStart(2, '0')

function label(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7g'
  if (kind === 'spend_limit') return 'Spesa'
  return kind
}

// "12:30" when the reset is within a day, "lun 03:00" otherwise.
function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const t = new Date(resetsAt)
  if (Number.isNaN(t.getTime())) return ''
  const time = `${two(t.getHours())}:${two(t.getMinutes())}`
  const isSoon = t.getTime() - now < 24 * 60 * 60 * 1000
  return ` · reset ${isSoon ? time : `${DAYS[t.getDay()]} ${time}`}`
}

function colorFor(percent: number): string | undefined {
  if (percent >= 95) return 'red'
  if (percent >= 80) return 'yellow'
  return undefined
}

function ringColor(percent: number): string {
  if (percent >= 95) return '#ef4444'
  if (percent >= 80) return '#eab308'
  return '#3b82f6'
}

// A small progress ring: grey track, coloured arc starting at 12 o'clock.
function ring(percent: number): string {
  const size = 14
  const stroke = 2.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * c
  const mid = size / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="#808080" stroke-opacity="0.35" stroke-width="${stroke}"/>` +
    `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${ringColor(percent)}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"/>` +
    `</svg>`
  )
}

// Agenti (subagent e teammate) che stanno lavorando adesso.
async function refreshAgents($: EngineInterface): Promise<void> {
  let next: ActiveAgent[]
  try {
    const models = await read($, agentModels)
    next = (await $.agent.list())
      .filter(a => a.status === 'running' || a.status === 'pending')
      .map(a => ({
        id: a.id,
        title: a.description || a.name || a.type,
        type: a.type,
        status: a.status,
        model: models[a.id],
      }))
  } catch {
    return
  }
  const same = (a: ActiveAgent[]) =>
    a.length === next.length &&
    a.every(
      (x, i) =>
        x.id === next[i]?.id && x.status === next[i]?.status && x.title === next[i]?.title && x.model === next[i]?.model,
    )
  await update($, activeAgents, prev => (same(prev) ? prev : next))
}


// --- Diagnosi (0.7.0): perché la riga non si vede sul telefono in Remote Control. ---
// Scrive in ~/.claude/usage-limits-diag.log (fuori da ogni repository), una riga per evento.
const DIAG_MAX = 300
const NL = String.fromCharCode(10)
let diagLines: string[] | null = null
let diagSession = ''
let lastSurfaces = ''
const renderSeen = new Map<string, string>()

async function diag($: EngineInterface, msg: string): Promise<void> {
  try {
    const path = `${$.plugin.root}/../../usage-limits-diag.log`
    if (diagLines === null) {
      try {
        diagLines = (await $.fs.read(path)).split(NL).filter(Boolean)
      } catch {
        diagLines = []
      }
    }
    if (!diagSession) diagSession = (await $.session.id()).slice(0, 8)
    diagLines.push(`${new Date(await $.clock.now()).toISOString()} [${diagSession}] ${msg}`)
    if (diagLines.length > DIAG_MAX) diagLines = diagLines.slice(-DIAG_MAX)
    await $.fs.write(path, diagLines.join(NL) + NL)
  } catch {
    // la diagnosi non deve mai rompere la mod
  }
}

async function diagSurfaces($: EngineInterface, why: string): Promise<void> {
  try {
    const now = (await $.session.surfaces()).join(',')
    if (now === lastSurfaces && why === 'poll') return
    lastSurfaces = now
    await diag($, `surfaces (${why}): [${now}]`)
  } catch (err) {
    await diag($, `surfaces (${why}) errore: ${String(err)}`)
  }
}

// Una riga per superficie quando cambia l'esito del disegno (non a ogni ridisegno).
async function diagRender($: EngineInterface, surface: string, outcome: string, extra: string): Promise<void> {
  if (renderSeen.get(surface) === outcome) return
  renderSeen.set(surface, outcome)
  await diag($, `AbovePrompt surface=${surface} -> ${outcome} ${extra}`)
}

function statusText(status: string): string {
  return status === 'pending' ? 'in avvio' : 'al lavoro'
}

function order(kind: string): number {
  return kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : 2
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => usage.context.percent ?? null)
    // Remote Control e fine degli agenti non hanno un evento proprio: si rileggono a intervalli.
    const refresh = async () => {
      const state = await fetchRemote($)
      await update($, remote, prev => (prev === state ? prev : state))
      await refreshAgents($)
    }
    await refresh()
    await diagSurfaces($, 'session.start')
    $.clock.every(REMOTE_POLL_MS, () => {
      void refresh()
      void diagSurfaces($, 'poll')
    })
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await diag($, `attach surface=${e.surface} client=${e.clientId} viewport=${JSON.stringify(e.viewport ?? null)}`)
    renderSeen.delete(e.surface)
    if (e.surface !== 'terminal') $.ui.toast(`usage-limits: collegato ${e.surface}`)
    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    await diag($, `detach surface=${e.surface} client=${e.clientId} reason=${e.reason}`)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => e.rateLimits)
    await update($, context, prev => e.context.percent ?? prev)
    const state = await fetchRemote($)
    await update($, remote, prev => (prev === state ? prev : state))
    await refreshAgents($)
    return next(e)
  })

  // Un agente appena avviato compare subito, senza aspettare il prossimo giro del timer.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // Il modello non è in $.agent.list(): lo si ricorda qui, per id.
    const { agentId, model } = result
    if (agentId && model) {
      await update($, agentModels, prev => ({ ...prev, [agentId]: model }))
    }
    await refreshAgents($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = [...(await read($, limits))].sort((a, b) => order(a.kind) - order(b.kind))

    const ctx = await read($, context)
    const rc = await read($, remote)
    // "unavailable" (sessione che l'app non può collegare) o sconosciuto: niente pallino.
    const showRc = rc === 'on' || rc === 'off' || rc === 'connecting'
    const running = await read($, activeAgents)
    const nAgents = running.length
    const isOpen = await read($, agentsOpen)
    const agentsText = `Agenti ${nAgents} ${isOpen ? '▴' : '▾'}`
    const toggle = () => update($, agentsOpen, open => !open)

    const info = `cols=${e.props.bodyColumns} collapsed=${e.props.isCollapsed} viewport=${JSON.stringify(e.viewport ?? null)}`
    if (e.props.hasSurvey || (list.length === 0 && ctx === null && !showRc)) {
      await diagRender($, e.surface, e.props.hasSurvey ? 'next(survey)' : 'next(nessun dato)', info)
      return next(e)
    }
    await diagRender($, e.surface, `albero (limiti=${list.length} ctx=${ctx} rc=${rc})`, info)

    const now = await $.clock.now()
    const text = (l: Limit) => `${label(l.kind)} ${Math.round(l.percentUsed)}%${resetText(l.resetsAt, now)}`

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
        <Box>
          {showRc && (
            <Text key="rc" color={rc === 'on' ? 'green' : rc === 'connecting' ? 'yellow' : undefined} dimColor={rc === 'off'}>
              {rc === 'off' ? '○' : '●'}
              {list.length > 0 || ctx !== null ? '  ' : ''}
            </Text>
          )}
          {list.map((l, i) => (
            <Text key={l.kind} color={colorFor(l.percentUsed)} dimColor={colorFor(l.percentUsed) === undefined}>
              {i > 0 ? '   |   ' : ''}
              {text(l)}
            </Text>
          ))}
          {ctx !== null && (
            <Text key="context" color={colorFor(ctx)} dimColor={colorFor(ctx) === undefined}>
              {list.length > 0 ? '   |   ' : ''}
              Contesto {Math.round(ctx)}%
            </Text>
          )}
          {(list.length > 0 || ctx !== null) && <Text key="sep" dimColor>{'   |   '}</Text>}
          <Button key="agents" plain onPress={toggle}>
            <Text color={nAgents > 0 ? 'cyan' : undefined} dimColor={nAgents === 0}>
              {agentsText}
            </Text>
          </Button>
        </Box>
        {isOpen && agentList(Box, Text)}
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {showRc && <Svg key="rc" source={dot(rc)} alt={remoteTitle(rc)} width={10} height={10} />}
        {list.map(l => (
          <Box key={l.kind} flexDirection="row" alignItems="center" columnGap={1}>
            <Svg source={ring(l.percentUsed)} alt={`${Math.round(l.percentUsed)}%`} width={14} height={14} />
            <Text color={colorFor(l.percentUsed)} dimColor={colorFor(l.percentUsed) === undefined}>
              {text(l)}
            </Text>
          </Box>
        ))}
        {ctx !== null && (
          <Box key="context" flexDirection="row" alignItems="center" columnGap={1}>
            <Svg source={ring(ctx)} alt={`${Math.round(ctx)}%`} width={14} height={14} />
            <Text color={colorFor(ctx)} dimColor={colorFor(ctx) === undefined}>
              Contesto {Math.round(ctx)}%
            </Text>
          </Box>
        )}
        <Button key="agents" plain onPress={toggle}>
          <Text color={nAgents > 0 ? 'cyan' : undefined} dimColor={nAgents === 0}>
            {agentsText}
          </Text>
        </Button>
      </Box>
      {isOpen && agentList(Box, Text)}
      </Box>
    )

    // Elenco aperto dal clic su "Agenti N": un agente per riga.
    function agentList(B: typeof Box, T: typeof Text) {
      return (
        <B key="agent-list" flexDirection="column">
          {running.length === 0 ? (
            <T dimColor>Nessun agente al lavoro</T>
          ) : (
            running.map(a => (
              <T key={a.id}>
                {'• '}
                {a.title}
                <T dimColor>{`  ${a.model ? `${modelName(a.model)} · ` : ''}${a.type} · ${statusText(a.status)}`}</T>
              </T>
            ))
          )}
        </B>
      )
    }
  }).catch(async ($, e, next) => {
    await diag($, `AbovePrompt surface=${e.surface} ERRORE nel hook`)
    return next(e)
  })
}
