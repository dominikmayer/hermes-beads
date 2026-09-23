import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  GlyphSpinner,
  PANES_AREA,
  RowButton,
  ScrollArea,
  Separator,
  Skeleton,
  fmtDateTime,
  host,
  queryClient,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

export const ISSUE_VIEWS = Object.freeze(['ready', 'open', 'in_progress', 'blocked'])
export const VIEW_OPTIONS = Object.freeze([
  { id: 'ready', label: 'Ready' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' }
])
export const DISPLAY_OPTIONS_KEY = 'display-options'
export const DEFAULT_DISPLAY_OPTIONS = Object.freeze({ showAssignee: false, showUpdatedAt: false })
const ALWAYS_VISIBLE = { get: () => true, subscribe: callback => (callback(true), () => {}) }

export function normalizeDisplayOptions(value) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    showAssignee: candidate.showAssignee === true,
    showUpdatedAt: candidate.showUpdatedAt === true
  }
}

export function readDisplayOptions(storage) {
  try {
    return normalizeDisplayOptions(storage?.get?.(DISPLAY_OPTIONS_KEY, DEFAULT_DISPLAY_OPTIONS))
  } catch {
    return normalizeDisplayOptions(DEFAULT_DISPLAY_OPTIONS)
  }
}

export function writeDisplayOptions(storage, value) {
  const normalized = normalizeDisplayOptions(value)
  try {
    storage?.set?.(DISPLAY_OPTIONS_KEY, normalized)
  } catch {}
  return normalized
}

export function normalizeAbsolutePath(value) {
  if (typeof value !== 'string') return null
  const replaced = value.trim().replaceAll('\\', '/')
  if (!replaced.startsWith('/')) return null
  const parts = []
  for (const part of replaced.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return `/${parts.join('/')}`
}

export function resolveProjectPath(value, resolvedCwd) {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (candidate.startsWith('/')) return normalizeAbsolutePath(candidate)
  if (!candidate.startsWith('~/') || candidate.includes('\\')) return null

  const suffix = candidate.slice(2).split('/')
  if (suffix.some(part => !part || part === '.' || part === '..')) return null

  const cwd = normalizeAbsolutePath(resolvedCwd)
  if (!cwd) return null
  const cwdParts = cwd.split('/').filter(Boolean)
  const matches = []
  for (let index = 0; index + suffix.length <= cwdParts.length; index += 1) {
    if (suffix.every((part, offset) => cwdParts[index + offset] === part)) {
      matches.push(`/${cwdParts.slice(0, index + suffix.length).join('/')}`)
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function isPathAncestor(ancestor, child) {
  const parent = normalizeAbsolutePath(ancestor)
  const target = normalizeAbsolutePath(child)
  if (!parent || !target) return false
  return target === parent || target.startsWith(`${parent}/`)
}

export function pathsEquivalent(left, right) {
  const normalizedLeft = normalizeAbsolutePath(left)
  const normalizedRight = normalizeAbsolutePath(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}

export function selectRequestedRoot(project, resolvedCwd) {
  if (!project || !resolvedCwd) return null
  const candidates = []
  if (typeof project.primary_path === 'string') candidates.push(project.primary_path)
  if (Array.isArray(project.folders)) {
    for (const folder of project.folders) {
      if (folder && typeof folder.path === 'string') candidates.push(folder.path)
    }
  }
  return candidates
    .map(candidate => resolveProjectPath(candidate, resolvedCwd))
    .filter(Boolean)
    .filter(candidate => isPathAncestor(candidate, resolvedCwd))
    .sort((left, right) => right.length - left.length)[0] || null
}

export function selectProjectForCwd(projects, resolvedCwd) {
  if (!Array.isArray(projects)) return null
  return projects
    .filter(project => project && !project.archived)
    .map(project => ({ project, root: selectRequestedRoot(project, resolvedCwd) }))
    .filter(entry => entry.root)
    .sort((left, right) => right.root.length - left.root.length)[0]?.project || null
}

export function createQueryScope({ connectionId, profile, requestedRoot, canonicalRoot = null, view = 'ready', issueId = null }) {
  return {
    connectionId: String(connectionId || ''),
    profile: String(profile || ''),
    requestedRoot: requestedRoot || null,
    canonicalRoot: canonicalRoot || null,
    view,
    issueId: issueId || null
  }
}

export function overviewQueryKey(scope) {
  return ['beads', 'overview', scope.connectionId, scope.profile, scope.requestedRoot]
}

export function issuesQueryKey(scope) {
  return [
    'beads',
    'issues',
    scope.connectionId,
    scope.profile,
    scope.requestedRoot,
    scope.canonicalRoot,
    scope.view
  ]
}

export function detailQueryKey(scope) {
  return [
    'beads',
    'detail',
    scope.connectionId,
    scope.profile,
    scope.requestedRoot,
    scope.canonicalRoot,
    scope.view,
    scope.issueId
  ]
}

export function buildPluginUrl(path, params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

export function pollingInterval(visible, kind) {
  if (!visible) return false
  return kind === 'detail' ? 30000 : 15000
}

export function queryEnablement({ validRoot, selectedIssueId }) {
  return {
    overview: Boolean(validRoot),
    list: Boolean(validRoot && !selectedIssueId),
    detail: Boolean(validRoot && selectedIssueId)
  }
}

export function acceptsOverview(requestedRoot, response) {
  return Boolean(
    response &&
      typeof response === 'object' &&
      response.requestedRoot === requestedRoot &&
      typeof response.root === 'string' &&
      response.root.startsWith('/')
  )
}

export function acceptsCanonicalRoot(canonicalRoot, response) {
  return Boolean(response && typeof response === 'object' && response.root === canonicalRoot)
}

export function retentionReducer(state, action) {
  if (action.type === 'select') {
    return state.identity === action.identity ? state : { identity: action.identity, data: null }
  }
  if (action.type === 'succeed' && state.identity === action.identity) {
    return { identity: state.identity, data: action.data }
  }
  return state
}

export function parseApiError(error) {
  const fallback = { code: 'backend_unavailable', message: 'The Beads backend is unavailable.', retryable: true }
  if (!error) return fallback
  const text = typeof error === 'string' ? error : String(error.message || error)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return fallback
  try {
    const parsed = JSON.parse(match[0])
    const detail = parsed && typeof parsed.detail === 'object' ? parsed.detail : parsed
    if (typeof detail.code !== 'string' || typeof detail.message !== 'string' || typeof detail.retryable !== 'boolean') {
      return fallback
    }
    return { code: detail.code, message: detail.message, retryable: detail.retryable }
  } catch {
    return fallback
  }
}

function basename(path) {
  return String(path || '').split('/').filter(Boolean).at(-1) || ''
}

function formatDateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : fmtDateTime.format(date)
}

function PriorityBadge({ priority }) {
  if (!priority) return null
  return jsx(Badge, { variant: 'outline', children: priority })
}

export function CountStrip({ counts, value, onChange }) {
  return jsx('div', {
    role: 'group',
    'aria-label': 'Issue views',
    className: 'grid grid-cols-4 gap-1 px-3',
    children: VIEW_OPTIONS.map(option =>
      jsxs('button', {
        type: 'button',
        'aria-pressed': value === option.id,
        onClick: () => onChange(option.id),
        className: `rounded-md border px-1.5 py-1 text-center ${value === option.id ? 'border-(--ui-accent) bg-(--ui-bg-secondary)' : 'border-(--ui-stroke-secondary)'}`,
        children: [
          jsx('div', { className: 'text-sm font-semibold tabular-nums', children: counts?.[option.id] ?? 0 }),
          jsx('div', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: option.label })
        ]
      }, option.id)
    )
  })
}

export function DisplayOptions({ open, options, onToggle, onChange }) {
  return jsxs('div', {
    className: 'grid justify-items-end gap-2',
    children: [
      jsx(Button, {
        size: 'sm',
        variant: 'ghost',
        onClick: onToggle,
        'aria-expanded': open,
        'aria-controls': 'beads-display-options',
        children: 'Options'
      }),
      open
        ? jsxs('div', {
            id: 'beads-display-options',
            role: 'group',
            'aria-label': 'Display options',
            className: 'grid gap-1 rounded-md border border-(--ui-stroke-secondary) p-2 text-xs',
            children: [
              jsxs('label', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: options.showAssignee,
                    onChange: event => onChange('showAssignee', event.target.checked)
                  }),
                  jsx('span', { children: 'Assignee / E-mail' })
                ]
              }),
              jsxs('label', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('input', {
                    type: 'checkbox',
                    checked: options.showUpdatedAt,
                    onChange: event => onChange('showUpdatedAt', event.target.checked)
                  }),
                  jsx('span', { children: 'Dates' })
                ]
              })
            ]
          })
        : null
    ]
  })
}

function LoadingRows() {
  return jsx('div', {
    className: 'grid gap-2 p-3',
    children: [0, 1, 2, 3].map(index =>
      jsxs('div', {
        className: 'grid gap-2 rounded-md border border-(--ui-stroke-secondary) p-3',
        children: [jsx(Skeleton, { className: 'h-3 w-2/3' }), jsx(Skeleton, { className: 'h-3 w-1/3' })]
      }, index)
    )
  })
}

function Warning({ error, onRetry }) {
  const failure = parseApiError(error)
  return jsxs('div', {
    className: 'mx-3 flex items-center gap-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5 text-xs text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'min-w-0 flex-1', children: failure.message }),
      failure.retryable ? jsx(Button, { size: 'sm', variant: 'ghost', onClick: onRetry, children: 'Retry' }) : null
    ]
  })
}

export function IssueRows({ rows, onSelect, displayOptions = DEFAULT_DISPLAY_OPTIONS }) {
  if (!rows.length) return jsx(EmptyState, { title: 'No issues', description: 'This Beads view is empty.' })
  return jsx(ScrollArea, {
    className: 'min-h-0 flex-1',
    children: jsx('div', {
      className: 'grid gap-1 p-2',
      children: rows.map(issue =>
        jsx(RowButton, {
          className: 'grid w-full gap-1 rounded-md border border-transparent p-2 text-left hover:border-(--ui-stroke-secondary) hover:bg-(--ui-bg-secondary)',
          onClick: () => onSelect(issue.id),
          children: jsxs('div', {
            className: 'min-w-0',
            children: [
              jsxs('div', {
                className: 'flex items-start gap-2',
                children: [
                  jsx(PriorityBadge, { priority: issue.priority }),
                  jsx('span', { className: 'min-w-0 flex-1 text-xs font-medium', children: issue.title })
                ]
              }),
              jsxs('div', {
                className: 'mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[0.625rem] text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: issue.id }),
                  issue.type ? jsx('span', { children: issue.type }) : null,
                  displayOptions.showAssignee && issue.assignee ? jsx('span', { children: issue.assignee }) : null,
                  displayOptions.showUpdatedAt && issue.updatedAt ? jsx('span', { children: formatDateTime(issue.updatedAt) }) : null
                ]
              })
            ]
          })
        }, issue.id)
      )
    })
  })
}

function DetailSection({ title, value }) {
  if (!value) return null
  return jsxs('section', {
    className: 'grid gap-1',
    children: [
      jsx('h3', { className: 'text-[0.6875rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)', children: title }),
      jsx('div', { className: 'whitespace-pre-wrap text-xs leading-5 text-(--ui-text-secondary)', children: value })
    ]
  })
}

export function IssueDetail({ issue, onBack, displayOptions = DEFAULT_DISPLAY_OPTIONS }) {
  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 px-3 py-2',
        children: [
          jsx(Button, { size: 'sm', variant: 'ghost', onClick: onBack, children: 'Back' }),
          jsx('span', { className: 'truncate text-xs text-(--ui-text-tertiary)', children: issue.id })
        ]
      }),
      jsx(Separator, {}),
      jsx(ScrollArea, {
        className: 'min-h-0 flex-1',
        children: jsxs('div', {
          className: 'grid gap-4 p-3',
          children: [
            jsxs('div', {
              className: 'grid gap-2',
              children: [
                jsx('h2', { className: 'text-sm font-semibold', children: issue.title }),
                jsxs('div', {
                  className: 'flex flex-wrap gap-2 text-[0.6875rem] text-(--ui-text-tertiary)',
                  children: [
                    jsx(PriorityBadge, { priority: issue.priority }),
                    jsx('span', { children: issue.status }),
                    issue.type ? jsx('span', { children: issue.type }) : null,
                    displayOptions.showAssignee && issue.assignee ? jsx('span', { children: issue.assignee }) : null,
                    displayOptions.showUpdatedAt && issue.updatedAt ? jsx('span', { children: formatDateTime(issue.updatedAt) }) : null
                  ]
                })
              ]
            }),
            jsx(DetailSection, { title: 'Description', value: issue.description }),
            jsx(DetailSection, { title: 'Design', value: issue.design }),
            jsx(DetailSection, { title: 'Acceptance criteria', value: issue.acceptanceCriteria }),
            jsx(DetailSection, { title: 'Notes', value: issue.notes }),
            issue.parentId ? jsx(DetailSection, { title: 'Parent', value: issue.parentId }) : null,
            issue.blockerIds?.length ? jsx(DetailSection, { title: 'Blocked by', value: issue.blockerIds.join(', ') }) : null,
            issue.relations?.length
              ? jsx(DetailSection, {
                  title: 'Relations',
                  value: issue.relations
                    .map(relation => {
                      const metadata = [relation.direction, relation.type].filter(Boolean).join(', ')
                      return metadata ? `${relation.id} (${metadata})` : relation.id
                    })
                    .join('\n')
                })
              : null
          ]
        })
      })
    ]
  })
}

export async function lookupProjectForCwd(request, cwd, profile) {
  const response = await request('projects.for_cwd', { cwd, profile })
  if (response?.project) return response

  try {
    const listing = await request('projects.list', { profile })
    if (!Array.isArray(listing?.projects)) return response
    const project = selectProjectForCwd(listing.projects, response?.cwd || cwd)
    return project ? { ...response, project } : response
  } catch {
    return response
  }
}

export function ProjectPane({ ctx, connectionId, profile, project, requestedRoot, visible }) {
  const [view, setView] = useState('ready')
  const [selectedIssueId, setSelectedIssueId] = useState(null)
  const [displayOptions, setDisplayOptions] = useState(() => readDisplayOptions(ctx.storage))
  const [displayOptionsOpen, setDisplayOptionsOpen] = useState(false)
  const [rowsState, updateRows] = useReducer(retentionReducer, { identity: null, data: null })
  const [detailState, updateDetail] = useReducer(retentionReducer, { identity: null, data: null })
  const identity = `${connectionId}\u0000${profile}\u0000${requestedRoot}`

  const baseScope = createQueryScope({ connectionId, profile, requestedRoot, view, issueId: selectedIssueId })
  const overviewQuery = useQuery({
    queryKey: overviewQueryKey(baseScope),
    enabled: Boolean(requestedRoot),
    queryFn: async () => {
      const response = await ctx.rest(buildPluginUrl('/overview', { root: requestedRoot }))
      if (!acceptsOverview(requestedRoot, response)) throw new Error('stale_response')
      return response
    },
    refetchInterval: () => pollingInterval(visible, 'overview'),
    refetchOnWindowFocus: true,
    retry: 1
  })
  const canonicalRoot = acceptsOverview(requestedRoot, overviewQuery.data) ? overviewQuery.data.root : null
  const listIdentity = `${identity}\u0000${canonicalRoot || ''}\u0000${view}`
  const detailIdentity = `${listIdentity}\u0000${selectedIssueId || ''}`
  const rows = rowsState.identity === listIdentity ? rowsState.data : null
  const detail = detailState.identity === detailIdentity ? detailState.data : null
  const scope = createQueryScope({ connectionId, profile, requestedRoot, canonicalRoot, view, issueId: selectedIssueId })
  const enabled = queryEnablement({ validRoot: canonicalRoot && overviewQuery.data?.available, selectedIssueId })
  const issuesQuery = useQuery({
    queryKey: issuesQueryKey(scope),
    enabled: enabled.list,
    queryFn: async () => {
      const response = await ctx.rest(buildPluginUrl('/issues', { root: canonicalRoot, view }))
      if (!acceptsCanonicalRoot(canonicalRoot, response)) throw new Error('stale_response')
      return response
    },
    refetchInterval: () => pollingInterval(visible, 'list'),
    refetchOnWindowFocus: true,
    retry: 1
  })
  const detailQuery = useQuery({
    queryKey: detailQueryKey(scope),
    enabled: enabled.detail,
    queryFn: async () => {
      const response = await ctx.rest(buildPluginUrl(`/issues/${encodeURIComponent(selectedIssueId)}`, { root: canonicalRoot }))
      if (!acceptsCanonicalRoot(canonicalRoot, response)) throw new Error('stale_response')
      return response
    },
    refetchInterval: () => pollingInterval(visible, 'detail'),
    refetchOnWindowFocus: true,
    retry: 1
  })

  useEffect(() => updateRows({ type: 'select', identity: listIdentity }), [listIdentity])
  useEffect(() => updateDetail({ type: 'select', identity: detailIdentity }), [detailIdentity])
  useEffect(() => {
    if (issuesQuery.data && acceptsCanonicalRoot(canonicalRoot, issuesQuery.data)) {
      updateRows({ type: 'succeed', identity: listIdentity, data: issuesQuery.data.issues || [] })
    }
  }, [canonicalRoot, issuesQuery.data, listIdentity])
  useEffect(() => {
    if (detailQuery.data && acceptsCanonicalRoot(canonicalRoot, detailQuery.data)) {
      updateDetail({ type: 'succeed', identity: detailIdentity, data: detailQuery.data })
    }
  }, [canonicalRoot, detailIdentity, detailQuery.data])

  const refresh = () => {
    overviewQuery.refetch()
    if (selectedIssueId) detailQuery.refetch()
    else issuesQuery.refetch()
  }
  const changeView = nextView => {
    setView(nextView)
    setSelectedIssueId(null)
  }
  const changeDisplayOption = (key, checked) => {
    const next = writeDisplayOptions(ctx.storage, { ...displayOptions, [key]: checked })
    setDisplayOptions(next)
  }
  const refreshing = overviewQuery.isFetching || issuesQuery.isFetching || detailQuery.isFetching

  if (overviewQuery.isLoading) return jsx(LoadingRows, {})
  if (overviewQuery.error && !overviewQuery.data) {
    const failure = parseApiError(overviewQuery.error)
    const description = failure.code === 'backend_unavailable'
      ? 'Enable the Beads Agent plugin for the active profile and restart its backend. If it is already enabled, retry after the connection recovers.'
      : failure.message
    return jsx(ErrorState, {
      title: 'Beads backend unavailable',
      description,
      children: jsx(Button, { size: 'sm', variant: 'outline', onClick: refresh, children: 'Retry' })
    })
  }
  if (!overviewQuery.data?.available) {
    return jsx(EmptyState, { title: 'No Beads project', description: 'This project does not have an available Beads workspace.' })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('header', {
        className: 'grid gap-2 p-3',
        children: [
          jsxs('div', {
            className: 'flex items-start gap-2',
            children: [
              jsxs('div', {
                className: 'min-w-0 flex-1',
                children: [
                  jsx('div', { className: 'truncate text-sm font-semibold', children: overviewQuery.data.project?.name || project.name }),
                  jsxs('div', {
                    className: 'truncate text-[0.6875rem] text-(--ui-text-tertiary)',
                    children: [overviewQuery.data.project?.repository || basename(canonicalRoot), displayOptions.showUpdatedAt && overviewQuery.data.observedAt ? ` · ${formatDateTime(overviewQuery.data.observedAt)}` : '']
                  })
                ]
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx(DisplayOptions, {
                    open: displayOptionsOpen,
                    options: displayOptions,
                    onToggle: () => setDisplayOptionsOpen(open => !open),
                    onChange: changeDisplayOption
                  }),
                  jsx(Button, {
                    size: 'sm',
                    variant: 'outline',
                    onClick: refresh,
                    disabled: refreshing,
                    children: refreshing ? jsx(GlyphSpinner, {}) : 'Refresh'
                  })
                ]
              })
            ]
          })
        ]
      }),
      jsx(CountStrip, { counts: overviewQuery.data.counts, value: view, onChange: changeView }),
      jsx('div', { className: 'py-2', children: jsx(Separator, {}) }),
      overviewQuery.error && overviewQuery.data
        ? jsx(Warning, { error: overviewQuery.error, onRetry: () => overviewQuery.refetch() })
        : null,
      issuesQuery.error && rows ? jsx(Warning, { error: issuesQuery.error, onRetry: () => issuesQuery.refetch() }) : null,
      detailQuery.error && detail ? jsx(Warning, { error: detailQuery.error, onRetry: () => detailQuery.refetch() }) : null,
      selectedIssueId
        ? detail
          ? jsx(IssueDetail, { issue: detail, displayOptions, onBack: () => setSelectedIssueId(null) })
          : detailQuery.error
            ? jsx(ErrorState, {
                title: 'Issue unavailable',
                description: parseApiError(detailQuery.error).message,
                children: jsx(Button, { size: 'sm', variant: 'outline', onClick: () => setSelectedIssueId(null), children: 'Back' })
              })
            : jsx(LoadingRows, {})
        : rows
          ? jsx(IssueRows, { rows, displayOptions, onSelect: issueId => setSelectedIssueId(issueId) })
          : issuesQuery.error
            ? jsx(ErrorState, {
                title: 'Issues unavailable',
                description: parseApiError(issuesQuery.error).message,
                children: jsx(Button, { size: 'sm', variant: 'outline', onClick: () => issuesQuery.refetch(), children: 'Retry' })
              })
            : jsx(LoadingRows, {})
    ]
  })
}

function BeadsPane({ ctx }) {
  const cwd = useValue(host.state.cwd)
  const profile = useValue(host.state.profile)
  const connectionId = useValue(host.state.connectionId)
  const visibilityAtom = typeof host.paneVisibility === 'function' ? host.paneVisibility('beads:pane') : ALWAYS_VISIBLE
  const visible = useValue(visibilityAtom)
  const projectQuery = useQuery({
    queryKey: ['beads', 'project', connectionId || '', profile || '', cwd || ''],
    enabled: Boolean(connectionId && profile && cwd),
    queryFn: () => lookupProjectForCwd(host.request, cwd, profile),
    refetchOnWindowFocus: true,
    staleTime: 15000
  })
  const resolved = pathsEquivalent(projectQuery.data?.cwd, cwd) ? projectQuery.data : null
  const requestedRoot = useMemo(
    () => selectRequestedRoot(resolved?.project, resolved?.cwd),
    [resolved?.project, resolved?.cwd]
  )

  if (!cwd) return jsx(EmptyState, { title: 'Desktop Project required', description: 'Open a Desktop Project to inspect its Beads issues.' })
  if (projectQuery.isLoading || !resolved) {
    if (projectQuery.error) {
      return jsx(ErrorState, { title: 'Project lookup failed', description: String(projectQuery.error.message || projectQuery.error) })
    }
    return jsx(LoadingRows, {})
  }
  if (!resolved.project || !requestedRoot) {
    return jsx(EmptyState, { title: 'No matching Hermes Project', description: `No project folder contains ${resolved.cwd}.` })
  }
  const identity = `${connectionId || ''}\u0000${profile || ''}\u0000${requestedRoot}`
  return jsx(ProjectPane, {
    key: identity,
    ctx,
    connectionId: connectionId || '',
    profile,
    project: resolved.project,
    requestedRoot,
    visible
  })
}

export default {
  id: 'beads',
  name: 'Beads',
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: 'Beads',
      data: {
        placement: 'main',
        dock: { pane: 'workspace', pos: 'right' },
        width: '360px'
      },
      render: () => jsx(BeadsPane, { ctx })
    })
    ctx.onDispose(() => queryClient.removeQueries({ queryKey: ['beads'] }))
  }
}
