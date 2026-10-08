export type TouchedFile = { path: string; tool: string; mode: 'read' | 'edit' }

export type Activity = {
  kind: 'idle' | 'thinking' | 'reading' | 'editing' | 'done' | 'committed'
  summary: string
  path?: string
  detail?: string
}

export type ChangedFile = { status: string; added: number; removed: number }

export type GitState = {
  name: string
  root: string
  branch: string
  ahead: number
  head: string
  changed: Record<string, ChangedFile>
}

// A file Claude just acted on: its folders shimmer for a moment.
export type Pulse = { path: string; kind: 'read' | 'edit' | 'commit'; at: number }

export type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number }

export type View = {
  base: string
  project: string
  query: string
  showSizes: boolean
  hideHidden: boolean
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    touchtree: {
      touched: TouchedFile[]
      committed: string[]
      activity: Activity
      git: GitState
      dirs: Record<string, Entry[]>
      expanded: string[]
      index: string[]
      view: View
      pulses: Pulse[]
      tick: number
    }
  }
}
