import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ChangedFile, Entry, GitState, Pulse, TouchedFile } from '../types'

const PANE = 'touchtree'
const TOUCHING = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])
const WRITING = new Set(['Write', 'Edit', 'NotebookEdit'])
const MAX_ROWS = 400
// Cells per tree level: a child's chevron sits under its parent's folder icon.
const INDENT = 3
const COLOR = {
  read: '#b583f0',
  edit: '#f08a3c',
  pending: '#e7c77a',
  done: '#4cc27a',
  added: '#4cc27a',
  removed: '#e5534b',
  folder: '#6ea8fe',
  ahead: '#4fd1c5',
  dim: '#8a8a8a',
  ring: '#e8e2d0',
  quiet: '#3a3a3a',
}
const TINT = {
  read: '#2e2440',
  edit: '#3a2614',
  done: '#1d3a27',
  dim: '#2a2a2a',
  hover: '#242424',
}
const PILL = {
  read: '#3d2f57',
  edit: '#4d321a',
  done: '#25502f',
}
// Outline folder (U+1F5C0); Windows draws it from Segoe UI Symbol, in the text colour.
const FOLDER = String.fromCodePoint(0x1f5c0, 0xfe0e)
const TYPES: Record<string, { label: string; color: string; bg: string }> = {
  js: { label: 'JS', color: '#e7c77a', bg: '#3a3320' },
  jsx: { label: 'JS', color: '#e7c77a', bg: '#3a3320' },
  mjs: { label: 'JS', color: '#e7c77a', bg: '#3a3320' },
  cjs: { label: 'JS', color: '#e7c77a', bg: '#3a3320' },
  ts: { label: 'TS', color: '#6ea8fe', bg: '#1f2a3d' },
  tsx: { label: 'TS', color: '#6ea8fe', bg: '#1f2a3d' },
  json: { label: '{}', color: '#7bc96f', bg: '#1f3320' },
  md: { label: 'MD', color: '#9fb3c8', bg: '#262d36' },
  css: { label: 'CSS', color: '#c792ea', bg: '#2e2440' },
  html: { label: 'HTM', color: '#f08a3c', bg: '#3a2614' },
  py: { label: 'PY', color: '#6ea8fe', bg: '#1f2a3d' },
  txt: { label: 'TXT', color: '#8a8a8a', bg: '#2a2a2a' },
  git: { label: 'GIT', color: '#8a8a8a', bg: '#2a2a2a' },
}
const OTHER_TYPE = { label: '•', color: '#8a8a8a', bg: '#2a2a2a' }

const touched = atom({ plugin: 'touchtree', key: 'touched' } as const, [])
const committed = atom({ plugin: 'touchtree', key: 'committed' } as const, [])
const activity = atom({ plugin: 'touchtree', key: 'activity' } as const, {
  kind: 'idle',
  summary: 'Waiting for a prompt',
})
const git = atom({ plugin: 'touchtree', key: 'git' } as const, {
  name: '',
  root: '',
  branch: '',
  ahead: 0,
  head: '',
  changed: {},
})
const dirs = atom({ plugin: 'touchtree', key: 'dirs' } as const, {})
const expanded = atom({ plugin: 'touchtree', key: 'expanded' } as const, [])
const index = atom({ plugin: 'touchtree', key: 'index' } as const, [])
const view = atom({ plugin: 'touchtree', key: 'view' } as const, {
  base: '',
  project: '',
  query: '',
  showSizes: false,
  hideHidden: false,
  error: '',
})

const pulses = atom({ plugin: 'touchtree', key: 'pulses' } as const, [])
const tick = atom({ plugin: 'touchtree', key: 'tick' } as const, 0)
// How long a folder shimmers after Claude's last action in it; a turn's pulses
// restart at its end, so the shimmer is still running when the reply shows.
const PULSE_MS = 8000
const TICK_MS = 80

// Blends two #rrggbb colours: `amount` 0 is `from`, 1 is `to`.
const mix = (from: string, to: string, amount: number) => {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  return `#${[1, 3, 5]
    .map(at => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * amount).toString(16).padStart(2, '0'))
    .join('')}`
}

// SVG drawings for the desktop pane (it draws Svg; the terminal falls back to text).
const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
const FONT = `font-family="Segoe UI, system-ui, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="central"`
const folderSvg = (stroke: string, fill: string) =>
  svg(
    18,
    15,
    `<path d="M1.5 3.2c0-.9.7-1.6 1.6-1.6h3.6l1.6 1.7h6.6c.9 0 1.6.7 1.6 1.6v7.4c0 .9-.7 1.6-1.6 1.6H3.1c-.9 0-1.6-.7-1.6-1.6z" fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>`,
  )
const badgeSvg = (label: string, color: string, background: string) =>
  svg(30, 20, `<rect width="30" height="20" rx="6" fill="${background}"/><text x="15" y="10.5" font-size="10" fill="${color}" ${FONT}>${label}</text>`)
const pillWidth = (word: string) => Math.round(word.length * 7.6 + 18)
const pillSvg = (word: string, color: string, background: string) => {
  const width = pillWidth(word)
  return svg(width, 22, `<rect width="${width}" height="22" rx="11" fill="${background}"/><text x="${width / 2}" y="11.5" font-size="13" fill="${color}" ${FONT}>${word}</text>`)
}

// Paths are kept absolute with forward slashes; `key` is the case-folded form
// used for comparisons, since Windows paths are case-insensitive.
const norm = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  return /^[A-Za-z]:\/$/.test(slashed) || slashed === '/' ? slashed : slashed.replace(/\/+$/, '')
}
const key = (path: string) => norm(path).toLowerCase()
const join = (dir: string, name: string) => (norm(dir).endsWith('/') ? `${norm(dir)}${name}` : `${norm(dir)}/${name}`)
const isAbsolute = (path: string) => /^([A-Za-z]:)?\//.test(norm(path))
const parent = (path: string) => {
  const clean = norm(path)
  const cut = clean.lastIndexOf('/')
  if (cut < 0) return clean
  const up = clean.slice(0, cut)
  return /^[A-Za-z]:$/.test(up) || up === '' ? `${up}/` : up
}
const baseName = (path: string) => norm(path).split('/').pop() ?? path
const isInside = (path: string, dir: string) => key(path).startsWith(`${key(dir).replace(/\/$/, '')}/`)
const relative = (path: string, dir: string) =>
  isInside(path, dir) ? norm(path).slice(norm(dir).replace(/\/$/, '').length + 1) : norm(path)
const folderOf = (path: string, dir: string) => (key(parent(path)) === key(dir) ? '' : relative(parent(path), dir))

const typeOf = (name: string) => {
  const lower = name.toLowerCase()
  if (lower.startsWith('.git')) return TYPES.git ?? OTHER_TYPE
  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : ''
  return TYPES[ext] ?? OTHER_TYPE
}

const clockTime = (ms: number) => {
  if (!ms) return ''
  const when = new Date(ms)
  if (when.toDateString() === new Date().toDateString()) {
    return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  }
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const run = async ($: EngineInterface, argv: string[]) => {
  const { exitCode, stdout } = await $.process.run(argv)
  return exitCode === 0 ? stdout : ''
}

const unquote = (path: string) => (path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path)

const listDir = async ($: EngineInterface, dir: string) => {
  let problem = ''
  const found = await $.fs.list(dir).catch((error: unknown) => {
    problem = `Could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`
    return []
  })
  await update($, view, current => ({ ...current, error: problem }))
  const entries: Entry[] = found
    .map(one => ({
      name: one.name,
      kind: one.kind === 'dir' ? ('dir' as const) : ('file' as const),
      size: one.size,
      mtimeMs: one.mtimeMs,
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  await update($, dirs, all => ({ ...all, [key(dir)]: entries }))
}

// Opens every folder between the tree's base and the file, so the file Claude
// touched is in view, and re-lists its folder to pick up a newly written file.
const reveal = async ($: EngineInterface, path: string) => {
  const { base } = await read($, view)
  if (!base || !isInside(path, base)) return
  const chain: string[] = []
  for (let dir = parent(path); isInside(dir, base); dir = parent(dir)) chain.unshift(dir)
  await listDir($, base)
  for (const dir of chain) await listDir($, dir)
  await update($, expanded, list => [...new Set([...list, ...chain.map(key)])])
}

// Re-lists the base folder and the open folders still reachable from it, so a
// folder deleted since it was opened is dropped instead of failing to list.
const relistShown = async ($: EngineInterface) => {
  const { base } = await read($, view)
  if (!base) return
  const open = new Set(await read($, expanded))
  const reached = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    await listDir($, dir)
    for (const entry of (await read($, dirs))[key(dir)] ?? []) {
      const path = join(dir, entry.name)
      if (entry.kind === 'dir' && open.has(key(path))) {
        reached.add(key(path))
        await walk(path)
      }
    }
  }
  await walk(base)
  const gone = await Promise.all(
    [...open].filter(dirKey => !reached.has(dirKey)).map(async dirKey => ((await $.fs.list(dirKey).catch(() => null)) ? null : dirKey)),
  )
  const drop = new Set(gone.filter(Boolean))
  if (drop.size > 0) await update($, expanded, list => list.filter(one => !drop.has(one)))
}

// The files and folders the tree shows: the base folder and every open folder
// beneath it, walked as the pane draws them so paths keep their own case.
type Shown = { files: Map<string, { path: string; mtimeMs: number }>; folders: Map<string, string> }
const snapshot = async ($: EngineInterface): Promise<Shown> => {
  const listing = await read($, dirs)
  const open = new Set(await read($, expanded))
  const { base } = await read($, view)
  const files: Shown['files'] = new Map()
  const folders: Shown['folders'] = new Map()
  const walk = (dir: string) => {
    for (const entry of listing[key(dir)] ?? []) {
      const path = join(dir, entry.name)
      if (entry.kind === 'dir') {
        folders.set(key(path), path)
        if (open.has(key(path))) walk(path)
      } else {
        files.set(key(path), { path, mtimeMs: entry.mtimeMs })
      }
    }
  }
  if (base) walk(base)
  return { files, folders }
}

// Lists a folder a shell command made, and its folders a few levels down, and
// opens them, so the files inside are shown and compared.
const openNewFolder = async ($: EngineInterface, dir: string, depth: number): Promise<void> => {
  await listDir($, dir)
  await update($, expanded, list => [...new Set([...list, key(dir)])])
  if (depth >= 2) return
  for (const entry of (await read($, dirs))[key(dir)] ?? []) {
    if (entry.kind === 'dir' && !entry.name.startsWith('.')) await openNewFolder($, join(dir, entry.name), depth + 1)
  }
}

// A shell command may create or change files that no file tool named: re-list
// what is shown, and count each new or modified file there as Claude's edit.
const markShellChanges = async ($: EngineInterface, before: Shown) => {
  await relistShown($)
  const middle = await snapshot($)
  const fresh = [...middle.folders].filter(([dirKey]) => !before.folders.has(dirKey)).slice(0, 10)
  for (const [, dir] of fresh) await openNewFolder($, dir, 0)
  const after = fresh.length > 0 ? await snapshot($) : middle

  const made = [...after.files.values()]
    .filter(file => !key(file.path).includes('/.git/'))
    .filter(file => {
      const was = before.files.get(key(file.path))
      return was === undefined || was.mtimeMs !== file.mtimeMs
    })
    .slice(0, 50)
  if (made.length === 0) return

  const madeKeys = new Set(made.map(file => key(file.path)))
  const hits: TouchedFile[] = made.map(file => ({ path: file.path, tool: 'Bash', mode: 'edit' }))
  await update($, touched, list => [...list.filter(one => !madeKeys.has(key(one.path))), ...hits].slice(-200))
  await update($, committed, list => list.filter(one => !madeKeys.has(key(one))))
  for (const file of made) turnEdits.add(file.path)
  await pulse($, made.map(file => file.path), 'edit')
  refreshGitLater($)
}

// Marks files Claude just read, edited or committed, so their folders shimmer
// for PULSE_MS; a timer then drops the stale entries, which redraws the pane.
const pulse = async ($: EngineInterface, paths: string[], kind: Pulse['kind']) => {
  if (paths.length === 0) return
  const at = Date.now()
  await update($, pulses, list => [...list.filter(one => at - one.at < PULSE_MS), ...paths.map(path => ({ path, kind, at }))].slice(-300))
  startTicker($)
}

// While any pulse is live, a timer moves the shimmer band on each TICK_MS by
// bumping `tick`, which redraws the pane; it stops itself once none are left.
let ticker: { cancel: () => void } | undefined
const startTicker = ($: EngineInterface) => {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => void stepTicker($))
}
const stepTicker = async ($: EngineInterface) => {
  const live = (await read($, pulses)).filter(one => Date.now() - one.at < PULSE_MS)
  if (live.length === 0) {
    ticker?.cancel()
    ticker = undefined
    await update($, pulses, () => [])
    return
  }
  await update($, tick, n => n + 1)
}

const setActivity = ($: EngineInterface, next: Activity) => update($, activity, () => next)

// git can take several seconds on a big repo, longer than a hook's 10 s budget
// and the poll's period: so it never runs inside a hook's await, and never twice.
let gitBusy = false
const refreshGit = async ($: EngineInterface) => {
  if (gitBusy) return
  gitBusy = true
  try {
    await refreshGitNow($)
  } finally {
    gitBusy = false
  }
}
const refreshGitLater = ($: EngineInterface) => {
  $.clock.after(0, () => void refreshGit($))
}

const refreshGitNow = async ($: EngineInterface) => {
  const { head: before = '' } = await read($, git)
  const status = await run($, ['git', 'status', '--porcelain=v1', '-b'])
  const numstat = await run($, ['git', 'diff', '--numstat', 'HEAD'])
  const head = (await run($, ['git', 'rev-parse', '--short', 'HEAD'])).trim()
  const root = norm((await run($, ['git', 'rev-parse', '--show-toplevel'])).trim())

  const lines = status.split('\n').filter(Boolean)
  const branchLine = lines.shift() ?? ''
  const branch = branchLine.replace(/^## /, '').split('...')[0]?.split(' ')[0] ?? ''
  const ahead = Number(/ahead (\d+)/.exec(branchLine)?.[1] ?? 0)

  const counts: Record<string, { added: number; removed: number }> = {}
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added = '0', removed = '0', path = ''] = line.split('\t')
    counts[unquote(path)] = { added: Number(added) || 0, removed: Number(removed) || 0 }
  }
  const changed: Record<string, ChangedFile> = {}
  for (const line of lines) {
    const raw = line.slice(3)
    const path = unquote(raw.includes(' -> ') ? raw.split(' -> ').pop() ?? raw : raw).replace(/\/$/, '')
    changed[path] = { status: line.slice(0, 2).trim(), ...(counts[path] ?? { added: 0, removed: 0 }) }
  }

  const next: GitState = { name: root ? baseName(root) : '', root, branch, ahead, head, changed }
  await update($, git, () => next)

  if (before && head && head !== before && root) {
    const stillChanged = new Set(Object.keys(changed).map(path => key(join(root, path))))
    const hits = await read($, touched)
    const already = new Set((await read($, committed)).map(key))
    // A commit Claude ran lands every file in it; one made elsewhere lands only
    // the files Claude edited that are clean now.
    const byClaude = Date.now() - claudeCommitAt < 60_000
    const inCommit = byClaude
      ? (await run($, ['git', 'diff', '--name-only', before, head]))
          .split('\n')
          .filter(Boolean)
          .map(path => join(root, unquote(path)))
          .slice(0, 300)
      : []
    const landed = [
      ...inCommit,
      ...hits.filter(hit => hit.mode === 'edit' && !stillChanged.has(key(hit.path))).map(hit => hit.path),
    ].filter((path, at, all) => !already.has(key(path)) && all.findIndex(one => key(one) === key(path)) === at)
    if (byClaude) claudeCommitAt = 0
    if (landed.length > 0) {
      await update($, committed, list => [...new Set([...list, ...landed])])
      await pulse($, landed, 'commit')
      await setActivity($, {
        kind: 'committed',
        summary: `Claude committed ${landed.length} ${landed.length === 1 ? 'file' : 'files'}`,
        detail: head,
      })
    }
  }
}

const refreshIndex = async ($: EngineInterface) => {
  // --full-name: paths relative to the repo root (joined onto git.root later),
  // not to the session folder git runs in.
  const out = await run($, ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--full-name'])
  const list = out.split('\n').filter(Boolean).map(unquote).slice(0, 20000)
  await update($, index, () => list)
}

const openPane = async ($: EngineInterface) => {
  const { name } = await read($, git)
  const { project } = await read($, view)
  await $.ui.open({ id: PANE, title: `Files: ${name || baseName(project) || 'project'}` })
}

// When the current turn began (ms), so its pulses can restart when it ends.
let turnStartedAt = 0

// When Claude last ran `git commit` (ms), so the next HEAD change is credited to it.
let claudeCommitAt = 0

// Edits made during the current turn, for the "Claude edited N files" summary.
let turnEdits = new Set<string>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'touchtree',
      description: 'Show the files Claude touched and the project tree',
    })
    const project = norm(await $.session.root())
    await update($, view, current => ({ ...current, base: current.base || project, project }))
    const { base } = await read($, view)
    await listDir($, base)
    void openPane($)
    refreshGitLater($)
    $.clock.after(0, () => void refreshIndex($))
    $.clock.every(5000, () => void refreshGit($))

    return next(e)
  })

  on('command.run', { command: 'touchtree' }, async $ => {
    await openPane($)

    return { text: 'Files pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    turnEdits = new Set()
    turnStartedAt = Date.now()
    await setActivity($, { kind: 'thinking', summary: 'Claude is thinking' })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = Date.now()
    await update($, pulses, list => list.map(one => (one.at >= turnStartedAt ? { ...one, at: ended } : one)))
    const now = await read($, activity)
    if (now.kind !== 'committed') {
      const hits = await read($, touched)
      const edits = turnEdits.size
      await setActivity($, {
        kind: 'done',
        summary:
          edits > 0
            ? `Claude edited ${edits} ${edits === 1 ? 'file' : 'files'}`
            : hits.length > 0
              ? 'Claude read files, nothing edited'
              : 'Nothing touched',
        path: edits === 1 ? [...turnEdits][0] : undefined,
      })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const named =
      'file_path' in e && typeof e.file_path === 'string'
        ? e.file_path
        : 'notebook_path' in e && typeof e.notebook_path === 'string'
          ? e.notebook_path
          : undefined
    let path: string | undefined
    let mode: TouchedFile['mode'] = 'read'
    if (named && TOUCHING.has(e.tool)) {
      const { project } = await read($, view)
      const full = isAbsolute(named) ? norm(named) : join(project, named)
      path = full
      mode = WRITING.has(e.tool) ? 'edit' : 'read'
      const previous = (await read($, touched)).find(one => key(one.path) === key(full))
      const hit: TouchedFile = { path: full, tool: e.tool, mode: previous?.mode === 'edit' ? 'edit' : mode }
      await update($, touched, list => [...list.filter(one => key(one.path) !== key(full)), hit].slice(-200))
      if (mode === 'edit') {
        turnEdits.add(full)
        await update($, committed, list => list.filter(one => key(one) !== key(full)))
      }
      await setActivity($, { kind: mode === 'edit' ? 'editing' : 'reading', summary: '', path: full })
      await pulse($, [full], mode === 'edit' ? 'edit' : 'read')
    }

    const before = e.tool === 'Bash' ? await snapshot($) : undefined
    const isCommit = e.tool === 'Bash' && 'command' in e && typeof e.command === 'string' && /\bgit\b.*\bcommit\b/.test(e.command)
    // Set before the call: the 5 s poll may see the new HEAD while it still runs.
    if (isCommit) claudeCommitAt = Date.now()

    const result = await next(e)

    if (path) {
      await reveal($, path)
      if (mode === 'edit') refreshGitLater($)
    }
    if (before) await markShellChanges($, before)
    if (isCommit) {
      refreshGitLater($)
      $.clock.after(0, () => void refreshIndex($))
    }
    const now = await read($, activity)
    if (now.kind !== 'committed') await setActivity($, { kind: 'thinking', summary: 'Claude is thinking' })

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const live = (await read($, pulses)).filter(one => Date.now() - one.at < PULSE_MS)
    const frameNo = await read($, tick)
    const Input = 'Input' in elements ? elements.Input : undefined

    const hits = await read($, touched)
    const done = new Set((await read($, committed)).map(key))
    const now = await read($, activity)
    const state = await read($, git)
    const listing = await read($, dirs)
    const open = new Set(await read($, expanded))
    const files = await read($, index)
    const settings = await read($, view)
    const project = settings.project

    const changedAbs = new Map<string, ChangedFile>()
    if (state.root) {
      for (const [path, change] of Object.entries(state.changed)) changedAbs.set(key(join(state.root, path)), change)
    }
    const changedKeys = [...changedAbs.keys()]
    const added = [...changedAbs.values()].reduce((sum, one) => sum + one.added, 0)
    const removed = [...changedAbs.values()].reduce((sum, one) => sum + one.removed, 0)
    const hitOf = (path: string) => hits.find(one => key(one.path) === key(path))
    const isNow = (path: string) => now.path !== undefined && key(now.path) === key(path)

    // The status card.
    const didEdit = now.kind === 'done' && now.summary.startsWith('Claude edited')
    const lead =
      now.kind === 'reading' || (now.kind === 'done' && !didEdit && hits.length > 0)
        ? COLOR.read
        : now.kind === 'editing' || didEdit
          ? COLOR.edit
          : now.kind === 'committed'
            ? COLOR.done
            : COLOR.dim
    const tint = lead === COLOR.read ? TINT.read : lead === COLOR.edit ? TINT.edit : lead === COLOR.done ? TINT.done : TINT.dim
    const icon =
      now.kind === 'committed' ? '✓' : now.kind === 'editing' || didEdit ? '✎' : now.kind === 'reading' || now.kind === 'done' ? '◉' : now.kind === 'idle' ? '○' : '✳'
    const label = now.kind === 'idle' ? 'IDLE' : now.kind === 'done' || now.kind === 'committed' ? 'DONE' : 'RIGHT NOW'
    const headline =
      now.kind === 'reading' && now.path
        ? `Claude is reading ${baseName(now.path)}`
        : now.kind === 'editing' && now.path
          ? `Claude is editing ${baseName(now.path)}`
          : now.kind === 'thinking'
            ? 'Claude is thinking'
            : now.kind === 'idle'
              ? 'Waiting for a prompt'
              : now.summary
    const isActive = now.kind === 'reading' || now.kind === 'editing' || now.kind === 'done'
    const onlyChange = now.kind === 'done' && now.path ? changedAbs.get(key(now.path)) : undefined
    const subline =
      (now.kind === 'reading' || now.kind === 'editing') && now.path ? (
        <Text dimColor>in {folderOf(now.path, project) || baseName(project)}</Text>
      ) : now.kind === 'done' && now.path ? (
        <Text>
          <Text dimColor>{relative(now.path, project)} </Text>
          {onlyChange ? <Text color={COLOR.added}>+{onlyChange.added} </Text> : null}
          {onlyChange ? <Text color={COLOR.removed}>−{onlyChange.removed}</Text> : null}
        </Text>
      ) : now.kind === 'committed' ? (
        <Text dimColor>{now.detail ?? ''}</Text>
      ) : (
        <Text dimColor>
          {hits.length === 0 ? 'no files touched yet' : `${hits.length} ${hits.length === 1 ? 'file' : 'files'} touched so far`}
        </Text>
      )

    const pill = (text: string, color: string, background: string) => (
      <Text color={color} backgroundColor={background} bold>{` ${text} `}</Text>
    )
    const typeBadge = (name: string) => {
      const type = typeOf(name)
      return Svg ? (
        <Svg source={badgeSvg(type.label, type.color, type.bg)} alt={type.label} width={30} height={20} />
      ) : (
        pill(type.label.padEnd(3), type.color, type.bg)
      )
    }
    const folderIcon = (isHidden: boolean) =>
      Svg ? (
        <Svg source={isHidden ? folderSvg('#8a8a8a', '#262626') : folderSvg(COLOR.folder, '#1d2a3f')} alt="folder" width={18} height={15} />
      ) : (
        <Text color={isHidden ? COLOR.dim : COLOR.folder}>{FOLDER}</Text>
      )
    // A row's frame. A tinted row is a rounded bubble: the desktop draws
    // borderStyle "round" with a radius; its border takes a cell above and below
    // but next to no width. Plain rows have half a cell of padding, so the bubble
    // The border is about 3/4 of a cell above and below, plain rows have 1/2,
    // so a quarter-cell pull keeps every bubble one row tall, stacked or not.
    const frame = (tint?: string) =>
      tint
        ? {
            borderStyle: 'round',
            borderColor: tint,
            backgroundColor: tint,
            paddingX: 2,
            marginY: -0.25,
          }
        : { paddingX: 2, paddingY: 0.5, hover: { backgroundColor: TINT.hover } }
    const diff = (change: ChangedFile) =>
      change.status === '??' ? (
        <Text color={COLOR.pending}>new</Text>
      ) : (
        <Text>
          <Text color={COLOR.added}>+{change.added} </Text>
          <Text color={COLOR.removed}>−{change.removed}</Text>
        </Text>
      )
    // What Claude last did to a file, which tints its row and names its pill.
    type Mark = { word: string; color: string; tint: string; pill: string }
    const markOf = (path: string): Mark | undefined => {
      const pathKey = key(path)
      const hit = hitOf(path)
      if (done.has(pathKey) && !changedAbs.has(pathKey)) return { word: 'committed', color: COLOR.done, tint: TINT.done, pill: PILL.done }
      if (isNow(path) && now.kind === 'editing') return { word: 'editing', color: COLOR.edit, tint: TINT.edit, pill: PILL.edit }
      if (isNow(path) && now.kind === 'reading') return { word: 'reading', color: COLOR.read, tint: TINT.read, pill: PILL.read }
      if (hit?.mode === 'edit') return { word: 'edited', color: COLOR.edit, tint: TINT.edit, pill: PILL.edit }
      if (hit) return { word: 'read', color: COLOR.read, tint: TINT.read, pill: PILL.read }
      return undefined
    }
    const markPill = (mark: Mark) =>
      Svg ? (
        <Svg source={pillSvg(mark.word, mark.color, mark.pill)} alt={mark.word} width={pillWidth(mark.word)} height={22} />
      ) : (
        pill(mark.word, mark.color, mark.pill)
      )
    // A folder takes the colour of the strongest mark inside it:
    // committed, then edited, then read.
    const RANK: Record<string, number> = { committed: 3, editing: 2, edited: 2, reading: 1, read: 1 }
    const folderMarkOf = (dir: string) => {
      const prefix = `${key(dir)}/`
      let best: Mark | undefined
      for (const path of [...hits.map(one => one.path), ...done]) {
        if (!key(path).startsWith(prefix)) continue
        const mark = markOf(path)
        if (mark && (!best || (RANK[mark.word] ?? 0) > (RANK[best.word] ?? 0))) best = mark
      }
      return best
    }
    const isPulsing = (dir: string) => live.some(one => key(one.path).startsWith(`${key(dir)}/`))
    const shimmerName = (name: string, base: string) => {
      const span = name.length + 8
      const center = ((frameNo * 0.6) % span) - 4
      return [...name].map((letter, at) => {
        const glow = Math.max(0, 1 - Math.abs(at - center) / 3)
        return (
          <Text key={`s${at}`} color={glow > 0 ? mix(base, '#ffffff', glow * 0.85) : base} bold={glow > 0.5}>
            {letter}
          </Text>
        )
      })
    }

    // Button handlers.
    const toggle = async (dir: string) => {
      const dirKey = key(dir)
      if (open.has(dirKey)) {
        await update($, expanded, list => list.filter(one => one !== dirKey))
        return
      }
      await listDir($, dir)
      await update($, expanded, list => [...new Set([...list, dirKey])])
    }
    const refreshAll = async () => {
      await relistShown($)
      refreshGitLater($)
      $.clock.after(0, () => void refreshIndex($))
    }
    const goTo = async (dir: string) => {
      await listDir($, dir)
      await update($, view, current => ({ ...current, base: dir, query: '' }))
    }

    // The file rows: a list of matches while a query is typed, the tree otherwise.
    type Row = { path: string; name: string; depth: number; isDir: boolean; entry?: Entry; folder?: string }
    const rows: Row[] = []
    const query = settings.query.trim().toLowerCase()
    if (query) {
      const pool = state.root
        ? files.map(path => join(state.root, path))
        : Object.entries(listing).flatMap(([dir, entries]) =>
            entries.filter(one => one.kind === 'file').map(one => join(dir, one.name)),
          )
      for (const path of pool) {
        if (rows.length >= 60) break
        const rel = relative(path, project)
        if (!rel.toLowerCase().includes(query)) continue
        if (settings.hideHidden && rel.split('/').some(part => part.startsWith('.'))) continue
        rows.push({ path, name: baseName(path), depth: 0, isDir: false, folder: folderOf(path, project) })
      }
    } else {
      const walk = (dir: string, depth: number) => {
        for (const entry of listing[key(dir)] ?? []) {
          if (rows.length >= MAX_ROWS) return
          if (settings.hideHidden && entry.name.startsWith('.')) continue
          const path = join(dir, entry.name)
          rows.push({ path, name: entry.name, depth, isDir: entry.kind === 'dir', entry })
          if (entry.kind === 'dir' && open.has(key(path))) walk(path, depth + 1)
        }
      }
      walk(settings.base, 0)
    }

    const under = (dir: string) => `${key(dir)}/`
    const changedUnder = (dir: string) => changedKeys.filter(one => one.startsWith(under(dir))).length

    const treeRow = (row: Row) => {
      const isHidden = row.name.startsWith('.')
      if (row.isDir) {
        const count = changedUnder(row.path)
        const color = folderMarkOf(row.path)?.color ?? (count > 0 ? COLOR.pending : undefined)
        const isOpen = open.has(key(row.path))
        const shimmer = isPulsing(row.path)
        return (
          <Box key={`dir:${key(row.path)}`} justifyContent="space-between" alignItems="center" {...frame()}>
            <Box alignItems="center">
              {row.depth > 0 ? <Box width={row.depth * INDENT} /> : null}
              <Box width={2}>
                <Button plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => void toggle(row.path)} />
              </Box>
              <Box width={3} alignItems="center">
                {folderIcon(isHidden)}
              </Box>
              <Text> </Text>
              {shimmer ? (
                <Text>{shimmerName(row.name, color ?? (isHidden ? COLOR.dim : '#e6e6e6'))}</Text>
              ) : (
                <Text color={color} dimColor={isHidden && !color}>{row.name}</Text>
              )}
            </Box>
            {count > 0 ? <Text color={COLOR.pending}>{count} changed</Text> : null}
          </Box>
        )
      }

      const pathKey = key(row.path)
      const change = changedAbs.get(pathKey)
      // A file Claude touched gets its action's tint, and a pill in a brighter
      // shade of it; an uncommitted file Claude didn't touch shows its +/−.
      const mark = markOf(row.path)
      const background = mark?.tint
      const color = mark?.color ?? (change ? COLOR.pending : undefined)
      const right = mark ? (
        <Box alignItems="center">
          {change && mark.word.startsWith('edit') ? diff(change) : null}
          <Text> </Text>
          {markPill(mark)}
        </Box>
      ) : change ? (
        diff(change)
      ) : (
        <Text dimColor>
          {settings.showSizes && row.entry ? `${sizeOf(row.entry.size)}  ` : ''}
          {row.entry ? clockTime(row.entry.mtimeMs) : ''}
        </Text>
      )
      return (
        <Box
          key={`file:${pathKey}`}
          justifyContent="space-between"
          alignItems="center"
          {...frame(background)}
        >
          <Box flexShrink={1} alignItems="center">
            {row.depth > 0 ? <Box width={row.depth * INDENT} /> : null}
            <Box width={5} justifyContent="flex-end" alignItems="center">
              {typeBadge(row.name)}
            </Box>
            <Text color={color} bold={Boolean(background)} dimColor={isHidden && !color}> {row.name}</Text>
            {row.folder ? <Text color={COLOR.dim}>  {row.folder}</Text> : null}
          </Box>
          {right}
        </Box>
      )
    }

    const baseLabel = key(settings.base) === key(project) ? baseName(project) : baseName(settings.base)
    const isClean = changedAbs.size === 0

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={isActive ? COLOR.ring : COLOR.quiet} paddingX={2} paddingY={1}>
          <Box>
            <Box backgroundColor={tint} paddingX={1} marginRight={2} alignSelf="flex-start">
              <Text color={lead === COLOR.dim ? undefined : lead} bold>{icon}</Text>
            </Box>
            <Box flexDirection="column" flexShrink={1}>
              <Text color={lead === COLOR.dim ? undefined : lead} dimColor={lead === COLOR.dim} bold>{label}</Text>
              <Text bold>{headline}</Text>
              {subline}
            </Box>
          </Box>
          <Box justifyContent="space-between" marginTop={1}>
            <Text>
              <Text color={COLOR.folder}>⑂ </Text>
              <Text bold>{state.branch || 'no git repo'}</Text>
              {state.ahead ? <Text color={COLOR.ahead} bold> ↑{state.ahead}</Text> : null}
            </Text>
            {isClean ? (
              <Text dimColor>clean, nothing changed</Text>
            ) : (
              <Text>
                <Text color={COLOR.added}>+{added} </Text>
                <Text color={COLOR.removed}>−{removed}</Text>
                <Text dimColor> · </Text>
                <Text color={COLOR.pending}>{changedAbs.size} changed</Text>
              </Text>
            )}
          </Box>
          <Text>
            <Text color={COLOR.read}>● </Text>
            <Text>Claude read   </Text>
            <Text color={COLOR.edit}>● </Text>
            <Text>Claude edited   </Text>
            <Text color={COLOR.pending}>● </Text>
            <Text>Not committed</Text>
          </Text>
        </Box>

        {Input ? (
          <Input
            key="find"
            placeholder="⌕  Find a file"
            value={settings.query}
            submitLabel="find"
            onInput={value => void update($, view, current => ({ ...current, query: value }))}
            onSubmit={value => void update($, view, current => ({ ...current, query: value }))}
          />
        ) : null}

        <Box flexDirection="column" gap={1}>
          <Box gap={1} flexWrap="wrap">
            <Button label="Refresh" onPress={() => void refreshAll()} />
            <Button label="Collapse all" onPress={() => void update($, expanded, () => [])} />
            <Button
              label={settings.showSizes ? 'Hide sizes' : 'Show sizes'}
              onPress={() => void update($, view, current => ({ ...current, showSizes: !current.showSizes }))}
            />
          </Box>
          <Box gap={1} flexWrap="wrap">
            <Button label="Up a folder" onPress={() => void goTo(parent(settings.base))} />
            <Button label="Back to project" onPress={() => void goTo(project)} />
            <Button
              label={settings.hideHidden ? 'Show hidden files' : 'Hide hidden files'}
              onPress={() => void update($, view, current => ({ ...current, hideHidden: !current.hideHidden }))}
            />
          </Box>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={COLOR.quiet} paddingX={2} paddingY={1}>
          <Box justifyContent="space-between">
            <Text dimColor bold>CLAUDE TOUCHED</Text>
            <Text dimColor bold>{hits.length} {hits.length === 1 ? 'FILE' : 'FILES'}</Text>
          </Box>
          {hits.length === 0 ? <Text dimColor>  Nothing yet</Text> : null}
          {hits.slice(-50).map(hit => {
            const change = changedAbs.get(key(hit.path))
            const folder = folderOf(hit.path, project)
            const mark = markOf(hit.path)
            return (
              <Box
                key={`hit:${key(hit.path)}`}
                justifyContent="space-between"
                alignItems="center"
                {...frame(mark?.tint)}
              >
                <Box flexShrink={1} alignItems="center">
                  {typeBadge(baseName(hit.path))}
                  <Text color={mark?.color} bold>  {baseName(hit.path)}</Text>
                  {folder ? <Text color={COLOR.dim}>  {folder}</Text> : null}
                </Box>
                <Box alignItems="center">
                  {change && mark?.word.startsWith('edit') ? diff(change) : null}
                  <Text> </Text>
                  {mark ? markPill(mark) : null}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text dimColor bold>{query ? `MATCHES · ${rows.length}${rows.length >= 60 ? '+' : ''}` : 'ALL FILES'}</Text>
            <Text dimColor bold>{baseLabel.toUpperCase()}</Text>
          </Box>
          {settings.error ? <Text color={COLOR.removed}>{settings.error}</Text> : null}
          {rows.length === 0 && !settings.error ? (
            <Text dimColor>
              {query
                ? 'No file matches'
                : listing[key(settings.base)] === undefined
                  ? 'Loading files… press Refresh if this stays'
                  : 'Empty folder'}
            </Text>
          ) : null}
          {rows.map(treeRow)}
          {rows.length >= MAX_ROWS ? <Text dimColor>… more files; collapse a folder or search</Text> : null}
          {state.head ? (
            <Box marginTop={1} justifyContent="flex-end">
              <Text color={isClean ? COLOR.done : COLOR.pending}>● {isClean ? 'committed' : 'uncommitted changes'} </Text>
              <Text dimColor>{state.head}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
