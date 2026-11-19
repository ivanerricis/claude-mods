export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Stato della Remote Control come lo riporta l'app; null finché non è noto. */
export type RemoteState = 'on' | 'off' | 'connecting' | 'unavailable' | null

/** Un agente al lavoro, come lo mostra l'elenco sotto la riga. */
export type ActiveAgent = { id: string; title: string; type: string; status: string; model?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': {
      limits: Limit[]
      context: number | null
      remote: RemoteState
      activeAgents: ActiveAgent[]
      agentsListOpen: boolean
      /** Modello di ogni agente, per id, preso all'avvio (agent.spawn). */
      agentModels: Record<string, string>
    }
  }
}
