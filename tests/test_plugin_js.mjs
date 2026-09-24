import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import plugin, {
  acceptsCanonicalRoot,
  acceptsSearch,
  acceptsOverview,
  backFromDetail,
  buildHierarchy,
  buildPluginUrl,
  createListNavigation,
  createQueryScope,
  DEFAULT_DISPLAY_OPTIONS,
  DisplayOptions,
  detailQueryKey,
  CountStrip,
  DISPLAY_OPTIONS_KEY,
  hierarchyIndent,
  IssueDetail,
  IssueRows,
  isPathAncestor,
  issuesQueryKey,
  listSourceIdentity,
  searchQueryKey,
  normalizeDisplayOptions,
  normalizeAbsolutePath,
  normalizeSearchQuery,
  openIssue,
  overviewQueryKey,
  parseApiError,
  pathsEquivalent,
  pollingInterval,
  ProjectPane,
  queryEnablement,
  readDisplayOptions,
  retentionReducer,
  lookupProjectForCwd,
  resolveProjectPath,
  selectProjectForCwd,
  selectRequestedRoot,
  writeDisplayOptions
} from '../desktop/plugin.js'
import { __queryOptions, __setQueryResult, host, queryClient } from '@hermes/plugin-sdk'
import { __flushEffects, __render, __resetHooks } from 'react'

test('desktop entry uses only imports supported by the production runtime loader', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/\bimport\s+(?:[^'";]+?\s+from\s+)?(['"])([^'"]+)\1/g)]
    .map(match => match[2])
  assert.deepEqual(imports, ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
})

function findElement(node, name) {
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'function' && node.type.name === name) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElement(child, name)
    if (found) return found
  }
  return null
}

function findElements(node, predicate, results = []) {
  if (!node || typeof node !== 'object') return results
  if (predicate(node)) results.push(node)
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) findElements(child, predicate, results)
  return results
}

function textContent(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node !== 'object') return ''
  return textContent(node.props?.children)
}

test('selectRequestedRoot chooses the longest absolute ancestor', () => {
  const project = {
    primary_path: '/home/hermes/workspace',
    folders: [
      { path: '/home/hermes/workspace/app' },
      { path: '/home/hermes/workspace/app/packages/api' },
      { path: 'relative/not-allowed' }
    ]
  }
  assert.equal(selectRequestedRoot(project, '/home/hermes/workspace/app/packages/api/src'), '/home/hermes/workspace/app/packages/api')
  assert.equal(selectRequestedRoot(project, '/home/hermes/workspace-other/app'), null)
  assert.equal(normalizeAbsolutePath('/a/./b/../c'), '/a/c')
  assert.equal(isPathAncestor('/a/b', '/a/bc'), false)
  assert.equal(pathsEquivalent('/project/.', '/project/'), true)
  assert.equal(pathsEquivalent('/project', '/project-other'), false)
})

test('resolveProjectPath supports one unambiguous tilde path without widening path acceptance', () => {
  const cwd = '/home/hermes/workspace/projects/Hugo/mitado.ch'
  assert.equal(resolveProjectPath('/home/hermes/workspace', cwd), '/home/hermes/workspace')
  assert.equal(resolveProjectPath('~/workspace/projects/Hugo/mitado.ch', cwd), cwd)
  assert.equal(resolveProjectPath('~/workspace/projects/Hugo', cwd), '/home/hermes/workspace/projects/Hugo')
  assert.equal(resolveProjectPath('~/other', cwd), null)
  assert.equal(resolveProjectPath('relative/project', cwd), null)
  assert.equal(resolveProjectPath('~', cwd), null)
  assert.equal(resolveProjectPath('~/', cwd), null)
  assert.equal(resolveProjectPath('~/workspace/', cwd), null)
  assert.equal(resolveProjectPath('~/workspace//projects', cwd), null)
  assert.equal(resolveProjectPath('~/workspace/./projects', cwd), null)
  assert.equal(resolveProjectPath('~/workspace/../projects', cwd), null)
  assert.equal(resolveProjectPath('~other/workspace', cwd), null)
  assert.equal(resolveProjectPath('~/workspace\\projects', cwd), null)
  assert.equal(resolveProjectPath('~/workspace', '/home/hermes/workspace/projects/workspace/child'), null)
  assert.equal(resolveProjectPath('~/workspace', 'relative/cwd'), null)
})

test('selectProjectForCwd chooses the longest active absolute or tilde root', () => {
  const cwd = '/home/hermes/workspace/app/packages/api/src'
  const project = selectProjectForCwd([
    { id: 'archived-deep', archived: true, primary_path: '/home/hermes/workspace/app/packages/api', folders: [] },
    { id: 'broad', archived: false, primary_path: '~/workspace', folders: [] },
    { id: 'nested', archived: false, primary_path: '~/workspace/app', folders: [{ path: '~/workspace/app/packages/api' }] }
  ], cwd)
  assert.equal(project?.id, 'nested')
})

test('display options normalize defaults, partial values, false values, and malformed storage', () => {
  assert.deepEqual(DEFAULT_DISPLAY_OPTIONS, { showAssignee: false, showUpdatedAt: false })
  assert.deepEqual(normalizeDisplayOptions(undefined), DEFAULT_DISPLAY_OPTIONS)
  assert.deepEqual(normalizeDisplayOptions({ showAssignee: true, extra: true }), { showAssignee: true, showUpdatedAt: false })
  assert.deepEqual(normalizeDisplayOptions({ showAssignee: false, showUpdatedAt: false }), DEFAULT_DISPLAY_OPTIONS)
  assert.deepEqual(normalizeDisplayOptions('invalid'), DEFAULT_DISPLAY_OPTIONS)

  const reads = []
  assert.deepEqual(readDisplayOptions({
    get(key, fallback) {
      reads.push([key, fallback])
      return { showUpdatedAt: true }
    }
  }), { showAssignee: false, showUpdatedAt: true })
  assert.equal(reads[0][0], DISPLAY_OPTIONS_KEY)
  assert.deepEqual(readDisplayOptions({ get: () => { throw new Error('read failed') } }), DEFAULT_DISPLAY_OPTIONS)
})

test('display options persistence writes normalized values and tolerates storage errors', () => {
  const writes = []
  const storage = { set: (key, value) => writes.push([key, value]) }
  assert.deepEqual(writeDisplayOptions(storage, { showAssignee: true, ignored: true }), { showAssignee: true, showUpdatedAt: false })
  assert.deepEqual(writes, [[DISPLAY_OPTIONS_KEY, { showAssignee: true, showUpdatedAt: false }]])
  assert.deepEqual(writeDisplayOptions({ set: () => { throw new Error('write failed') } }, { showUpdatedAt: true }), { showAssignee: false, showUpdatedAt: true })
})

test('CountStrip is the single accessible view selector and keeps zero-count buttons active', () => {
  const tree = __render(() => CountStrip({ counts: { ready: 0, open: 2, in_progress: 0, blocked: 1 }, value: 'ready', onChange: () => {} }))
  const buttons = findElements(tree, node => node.type === 'button')
  assert.equal(findElement(tree, 'SegmentedControl'), null)
  assert.equal(buttons.length, 4)
  assert.equal(buttons[0].props['aria-pressed'], true)
  assert.equal(buttons[0].props.children[0].props.children, 0)
  assert.equal(buttons[2].props.children[0].props.children, 0)
  assert.equal(buttons[2].props.disabled, undefined)
  buttons[2].props.onClick()
})

test('DisplayOptions starts closed and exposes native labelled checkboxes when opened', () => {
  let changed = null
  let tree = __render(() => DisplayOptions({
    open: false,
    options: DEFAULT_DISPLAY_OPTIONS,
    onToggle: () => {},
    onChange: (key, value) => { changed = [key, value] }
  }))
  const optionButton = findElements(tree, node => node.props?.['aria-expanded'] !== undefined)[0]
  assert.equal(optionButton.props['aria-expanded'], false)
  assert.equal(findElements(tree, node => node.type === 'input').length, 0)

  tree = __render(() => DisplayOptions({
    open: true,
    options: DEFAULT_DISPLAY_OPTIONS,
    onToggle: () => {},
    onChange: (key, value) => { changed = [key, value] }
  }))
  assert.equal(findElements(tree, node => node.props?.['aria-expanded'] !== undefined)[0].props['aria-expanded'], true)
  const group = findElements(tree, node => node.props?.role === 'group' && node.props?.['aria-label'] === 'Display options')
  assert.equal(group.length, 1)
  const inputs = findElements(tree, node => node.type === 'input')
  assert.equal(inputs.length, 2)
  inputs[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(changed, ['showAssignee', true])
})

test('lookupProjectForCwd preserves a normal project response without listing', async () => {
  const calls = []
  const response = {
    project: { id: 'project', primary_path: '/home/hermes/workspace' },
    cwd: '/home/hermes/workspace/app',
    branch: 'main'
  }
  const result = await lookupProjectForCwd(async (method, params) => {
    calls.push([method, params])
    return response
  }, '/home/hermes/workspace/app', 'developer')
  assert.equal(result, response)
  assert.deepEqual(calls, [['projects.for_cwd', { cwd: '/home/hermes/workspace/app', profile: 'developer' }]])
})

test('lookupProjectForCwd falls back to projects.list for tilde roots and preserves cwd and branch', async () => {
  const calls = []
  const response = { project: null, cwd: '/home/hermes/workspace/projects/Hugo/mitado.ch', branch: 'main' }
  const result = await lookupProjectForCwd(async (method, params) => {
    calls.push([method, params])
    if (method === 'projects.for_cwd') return response
    return {
      projects: [
        { id: 'archived', archived: true, primary_path: '/home/hermes/workspace/projects/Hugo', folders: [] },
        { id: 'mitado', archived: false, primary_path: '~/workspace/projects/Hugo/mitado.ch', folders: [] }
      ],
      active_id: 'mitado'
    }
  }, response.cwd, 'developer')
  assert.equal(result.cwd, response.cwd)
  assert.equal(result.branch, response.branch)
  assert.equal(result.project.id, 'mitado')
  assert.deepEqual(calls, [
    ['projects.for_cwd', { cwd: response.cwd, profile: 'developer' }],
    ['projects.list', { profile: 'developer' }]
  ])
})

test('lookupProjectForCwd keeps the original no-project response when fallback data is invalid', async () => {
  const response = { project: null, cwd: '/home/hermes/workspace/project', branch: '' }
  for (const listResult of [{ projects: null }, Promise.reject(new Error('list unavailable'))]) {
    const result = await lookupProjectForCwd(async method => method === 'projects.for_cwd' ? response : await listResult, response.cwd, 'developer')
    assert.equal(result, response)
  }
})

test('query keys include connection profile requested root canonical root view and issue', () => {
  const scope = createQueryScope({
    connectionId: 'ssh:prod',
    profile: 'developer',
    requestedRoot: '/requested',
    canonicalRoot: '/canonical',
    view: 'blocked',
    issueId: 'gt--xyz'
  })
  assert.deepEqual(overviewQueryKey(scope), ['beads', 'overview', 'ssh:prod', 'developer', '/requested'])
  assert.deepEqual(issuesQueryKey(scope), ['beads', 'issues', 'ssh:prod', 'developer', '/requested', '/canonical', 'blocked'])
  assert.deepEqual(detailQueryKey(scope), ['beads', 'detail', 'ssh:prod', 'developer', '/requested', '/canonical', 'blocked', 'gt--xyz'])
})

test('buildPluginUrl uses URLSearchParams encoding', () => {
  const url = buildPluginUrl('/issues/gt--xyz', { root: '/home/hermes/workspace/a b', view: 'in_progress' })
  assert.equal(url, '/issues/gt--xyz?root=%2Fhome%2Fhermes%2Fworkspace%2Fa+b&view=in_progress')
})

test('visibility intervals and list detail exclusion are closed', () => {
  assert.equal(pollingInterval(false, 'list'), false)
  assert.equal(pollingInterval(true, 'overview'), 15000)
  assert.equal(pollingInterval(true, 'list'), 15000)
  assert.equal(pollingInterval(true, 'detail'), 30000)
  assert.deepEqual(queryEnablement({ validRoot: '/root', selectedIssueId: null }), {
    overview: true,
    list: true,
    detail: false
  })
  assert.deepEqual(queryEnablement({ validRoot: '/root', selectedIssueId: 'gt-1' }), {
    overview: true,
    list: false,
    detail: true
  })
})

test('response guards reject stale requested and canonical roots', () => {
  assert.equal(acceptsOverview('/requested', { requestedRoot: '/requested', root: '/canonical' }), true)
  assert.equal(acceptsOverview('/requested', { requestedRoot: '/old', root: '/canonical' }), false)
  assert.equal(acceptsCanonicalRoot('/canonical', { root: '/canonical', issues: [] }), true)
  assert.equal(acceptsCanonicalRoot('/canonical', { root: '/other', issues: [] }), false)
  assert.equal(acceptsSearch('/canonical', 'needle', { root: '/canonical', query: 'needle' }), true)
  assert.equal(acceptsSearch('/canonical', 'needle', { root: '/canonical', query: 'old' }), false)
})

test('hierarchy projection returns every issue once in stable depth-first order', () => {
  const issues = [
    { id: 'child-first', title: 'Child first', parentId: 'parent' },
    { id: 'parent', title: 'Parent', parentId: null },
    { id: 'sibling', title: 'Sibling', parentId: 'parent' },
    { id: 'grandchild', title: 'Grandchild', parentId: 'child-first' },
    { id: 'missing', title: 'Missing parent', parentId: 'outside' },
    { id: 'self', title: 'Self', parentId: 'self' },
    { id: 'cycle-a', title: 'Cycle A', parentId: 'cycle-b' },
    { id: 'cycle-b', title: 'Cycle B', parentId: 'cycle-a' }
  ]
  const rows = buildHierarchy(issues)
  assert.deepEqual(rows.map(row => [row.issue.id, row.depth]), [
    ['parent', 0],
    ['child-first', 1],
    ['grandchild', 2],
    ['sibling', 1],
    ['missing', 0],
    ['self', 0],
    ['cycle-a', 0],
    ['cycle-b', 0]
  ])
  assert.equal(rows.find(row => row.issue.id === 'missing').parentPresent, false)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['depth', 'issue', 'parentPresent'])
  assert.equal(new Set(rows.map(row => row.issue.id)).size, issues.length)
  assert.equal(rows.length, issues.length)
  assert.deepEqual(buildHierarchy(null), [])
})

test('hierarchy indentation increases by ten pixels and caps after depth six', () => {
  assert.deepEqual([0, 1, 2, 6, 7, 99].map(hierarchyIndent), [0, 10, 20, 60, 60, 60])
})

test('pane navigation keeps the originating list or search source', () => {
  const searchSource = { kind: 'search', query: 'needle', previousView: 'blocked' }
  const list = createListNavigation(searchSource)
  const detail = openIssue(list, 'gt-1')
  assert.deepEqual(detail, { kind: 'detail', source: searchSource, issueId: 'gt-1' })
  assert.deepEqual(backFromDetail(detail), list)
  assert.equal(normalizeSearchQuery('  needle  '), 'needle')
  assert.equal(listSourceIdentity(searchSource), 'search\u0000blocked\u0000needle')
})

test('search keys include the full identity and search never interval polls', () => {
  const scope = createQueryScope({ connectionId: 'local', profile: 'developer', requestedRoot: '/requested', canonicalRoot: '/canonical', query: 'needle' })
  assert.deepEqual(searchQueryKey(scope), ['beads', 'search', 'local', 'developer', '/requested', '/canonical', 'needle'])
  assert.equal(pollingInterval(true, 'search'), false)
})

test('production retention reducer clears on canonical switch and rejects late data', () => {
  const projectA = 'local\u0000developer\u0000/requested\u0000/canonical-a\u0000ready'
  const projectB = 'local\u0000developer\u0000/requested\u0000/canonical-b\u0000ready'
  let state = retentionReducer({ identity: null, data: null }, { type: 'select', identity: projectA })
  state = retentionReducer(state, { type: 'succeed', identity: projectA, data: [{ id: 'gt-1' }] })
  assert.deepEqual(state.data, [{ id: 'gt-1' }])
  state = retentionReducer(state, { type: 'select', identity: projectB })
  assert.equal(state.data, null)
  state = retentionReducer(state, { type: 'succeed', identity: projectA, data: [{ id: 'late' }] })
  assert.equal(state.data, null)
})

test('production ProjectPane retains same-root data and clears on canonical-root switch', () => {
  __resetHooks()
  const requestedRoot = '/home/hermes/workspace/project-link'
  const project = { name: 'Project' }
  const ctx = { rest: async () => ({}) }
  const overviewKey = ['beads', 'overview', 'local', 'developer', requestedRoot]
  const issuesAKey = ['beads', 'issues', 'local', 'developer', requestedRoot, '/canonical-a', 'ready']
  __setQueryResult(overviewKey, {
    data: { requestedRoot, root: '/canonical-a', available: true, counts: {}, project: { name: 'Project' } }
  })
  __setQueryResult(issuesAKey, { data: { root: '/canonical-a', issues: [{ id: 'gt-1', title: 'Issue 1' }] } })

  const render = () => __render(() => ProjectPane({
    ctx,
    connectionId: 'local',
    profile: 'developer',
    project,
    requestedRoot,
    visible: true
  }))

  render()
  __flushEffects()
  let tree = render()
  assert.deepEqual(findElement(tree, 'IssueRows')?.props.rows, [{ id: 'gt-1', title: 'Issue 1' }])

  __setQueryResult(issuesAKey, { error: new Error('refresh failed') })
  tree = render()
  assert.deepEqual(findElement(tree, 'IssueRows')?.props.rows, [{ id: 'gt-1', title: 'Issue 1' }])
  assert.equal(__queryOptions().find(options => options.queryKey[1] === 'issues').enabled, true)

  __setQueryResult(overviewKey, {
    data: { requestedRoot, root: '/canonical-b', available: true, counts: {}, project: { name: 'Project' } }
  })
  tree = render()
  assert.equal(findElement(tree, 'IssueRows'), null)
  assert.ok(findElement(tree, 'LoadingRows'))
})

test('metadata options hide assignee and dates by default and reveal them consistently', () => {
  const issue = {
    id: 'gt-1',
    title: 'Issue 1',
    status: 'open',
    type: 'task',
    assignee: 'me@example.com',
    updatedAt: 'updated-date'
  }
  const hiddenRows = __render(() => IssueRows({ rows: [issue], onSelect: () => {} }))
  assert.doesNotMatch(textContent(hiddenRows), /me@example\.com/)
  assert.doesNotMatch(textContent(hiddenRows), /updated-date/)
  const shownRows = __render(() => IssueRows({
    rows: [issue],
    onSelect: () => {},
    displayOptions: { showAssignee: true, showUpdatedAt: true }
  }))
  assert.match(textContent(shownRows), /me@example\.com/)
  assert.match(textContent(shownRows), /updated-date/)

  const hiddenDetail = __render(() => IssueDetail({ issue, onBack: () => {} }))
  assert.doesNotMatch(textContent(hiddenDetail), /me@example\.com/)
  assert.doesNotMatch(textContent(hiddenDetail), /updated-date/)
  const shownDetail = __render(() => IssueDetail({
    issue,
    onBack: () => {},
    displayOptions: { showAssignee: true, showUpdatedAt: true }
  }))
  assert.match(textContent(shownDetail), /me@example\.com/)
  assert.match(textContent(shownDetail), /updated-date/)
})

test('hierarchy rows are always visible list items with one selectable control and decorative guides', () => {
  let selected = null
  const tree = __render(() => IssueRows({
    rows: [
      { id: 'parent', title: 'Parent', parentId: null },
      { id: 'child', title: 'Child', parentId: 'parent' },
      { id: 'grandchild', title: 'Grandchild', parentId: 'child' },
      { id: 'missing', title: 'Missing parent', parentId: 'outside' },
      { id: 'self', title: 'Self parent', parentId: 'self' },
      { id: 'cycle-a', title: 'Cycle A', parentId: 'cycle-b' },
      { id: 'cycle-b', title: 'Cycle B', parentId: 'cycle-a' }
    ],
    hierarchical: true,
    onSelect: id => { selected = id }
  }))
  const lists = findElements(tree, node => node.props?.role === 'list')
  const items = findElements(tree, node => node.props?.role === 'listitem')
  const rows = findElements(tree, node => typeof node.type === 'function' && node.props?.className?.includes('text-left'))
  const guides = findElements(tree, node => node.props?.['aria-hidden'] === true)
  assert.equal(lists.length, 1)
  assert.equal(items.length, 7)
  assert.equal(rows.length, 7)
  assert.equal(findElements(tree, node => node.props?.['aria-expanded'] !== undefined).length, 0)
  assert.equal(findElements(tree, node => node.type === 'button').length, 0)
  assert.deepEqual(guides.map(guide => guide.props.style.inlineSize), ['10px', '20px'])
  for (const guide of guides) {
    assert.match(guide.props.style.borderInlineEnd, /var\(--ui-stroke-secondary\)/)
  }
  assert.match(textContent(rows[1]), /Parent parent/)
  assert.match(textContent(rows[2]), /Parent child/)
  assert.match(rows[1].props.children.props.children[0].props.className, /sr-only/)
  assert.match(textContent(rows[3]), /Parent outside not in this view/)
  assert.equal(rows[3].props.children.props.children[0], null)
  assert.match(textContent(rows[4]), /Parent self/)
  assert.match(textContent(rows[5]), /Parent cycle-b/)
  assert.match(textContent(rows[6]), /Parent cycle-a/)
  rows[0].props.onClick()
  assert.equal(selected, 'parent')
})

test('search rows stay flat in source order without hierarchy guides or parent context', () => {
  const tree = __render(() => IssueRows({
    rows: [
      { id: 'child', title: 'Child', parentId: 'parent' },
      { id: 'parent', title: 'Parent', parentId: null }
    ],
    hierarchical: false,
    onSelect: () => {}
  }))
  const items = findElements(tree, node => node.props?.role === 'listitem')
  assert.deepEqual(items.map(textContent), ['Childchild', 'Parentparent'])
  assert.equal(findElements(tree, node => node.props?.['aria-hidden'] === true).length, 0)
  assert.doesNotMatch(textContent(tree), /Parent parent|not in this view/)
})

test('hierarchy expansion state and controls are absent', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const issueRowsSource = source.slice(source.indexOf('export function IssueRows'), source.indexOf('function DetailSection'))
  assert.doesNotMatch(source, /expandedIds|expansionState|expansionIdentity|toggleExpanded|childCount/)
  assert.doesNotMatch(issueRowsSource, /aria-expanded|onToggle|Expand|Collapse/)
})

test('ProjectPane debounces native search, replaces counts, and returns from detail to search', async () => {
  __resetHooks()
  const requestedRoot = '/home/hermes/workspace/project'
  const overviewKey = ['beads', 'overview', 'local', 'developer', requestedRoot]
  const readyKey = ['beads', 'issues', 'local', 'developer', requestedRoot, '/canonical', 'ready']
  const searchKey = ['beads', 'search', 'local', 'developer', requestedRoot, '/canonical', 'needle']
  const detailKey = ['beads', 'detail', 'local', 'developer', requestedRoot, '/canonical', 'ready', 'gt-1']
  __setQueryResult(overviewKey, { data: { requestedRoot, root: '/canonical', available: true, counts: {}, project: { name: 'Project' } } })
  __setQueryResult(readyKey, { data: { root: '/canonical', issues: [{ id: 'ready', title: 'Ready' }] } })
  const render = () => __render(() => ProjectPane({
    ctx: { storage: { get: (_key, fallback) => fallback, set: () => {} }, rest: async () => ({}) },
    connectionId: 'local',
    profile: 'developer',
    project: { name: 'Project' },
    requestedRoot,
    visible: true
  }))

  let tree = render()
  __flushEffects()
  tree = render()
  findElements(tree, node => node.props?.placeholder === 'Search IDs and issue text')[0].props.onChange('  needle  ')
  tree = render()
  __flushEffects()
  assert.equal(__queryOptions().some(options => options.queryKey[1] === 'search' && options.enabled), false)
  await new Promise(resolve => setTimeout(resolve, 275))
  tree = render()
  __flushEffects()
  __setQueryResult(searchKey, { data: { root: '/canonical', query: 'needle', issues: [{ id: 'gt-1', title: 'Search hit', matchKinds: ['description'] }] } })
  tree = render()
  __flushEffects()
  tree = render()
  assert.equal(findElement(tree, 'CountStrip'), null)
  assert.match(textContent(tree), /1 search results for/)
  assert.equal(findElement(tree, 'IssueRows').props.hierarchical, false)

  __setQueryResult(detailKey, { data: { root: '/canonical', id: 'gt-1', title: 'Search hit', status: 'open' } })
  findElement(tree, 'IssueRows').props.onSelect('gt-1')
  tree = render()
  __flushEffects()
  tree = render()
  assert.ok(findElement(tree, 'IssueDetail'))
  findElement(tree, 'IssueDetail').props.onBack()
  tree = render()
  assert.match(textContent(tree), /search results for/)
})

test('ProjectPane persists display options, restores them on remount, and hides header dates by default', () => {
  __resetHooks()
  const requestedRoot = '/home/hermes/workspace/project'
  const overviewKey = ['beads', 'overview', 'local', 'developer', requestedRoot]
  const issuesKey = ['beads', 'issues', 'local', 'developer', requestedRoot, '/canonical', 'ready']
  const saved = { showAssignee: false, showUpdatedAt: false }
  const writes = []
  const storage = {
    get: (key, fallback) => key === DISPLAY_OPTIONS_KEY ? saved : fallback,
    set: (key, value) => {
      writes.push([key, value])
      Object.assign(saved, value)
    }
  }
  const ctx = { storage, rest: async () => ({}) }
  const setQueries = () => {
    __setQueryResult(overviewKey, {
      data: { requestedRoot, root: '/canonical', available: true, counts: {}, observedAt: 'observed-date', project: { name: 'Project', repository: 'repo' } }
    })
    __setQueryResult(issuesKey, { data: { root: '/canonical', issues: [{ id: 'gt-1', title: 'Issue 1', assignee: 'me@example.com' }] } })
  }
  const render = () => __render(() => ProjectPane({
    ctx,
    connectionId: 'local',
    profile: 'developer',
    project: { name: 'Project' },
    requestedRoot,
    visible: true
  }))

  setQueries()
  let tree = render()
  __flushEffects()
  tree = render()
  assert.equal(writes.length, 0)
  assert.doesNotMatch(textContent(findElements(tree, node => node.type === 'header')[0]), /observed-date/)

  findElement(tree, 'DisplayOptions').props.onToggle()
  tree = render()
  assert.equal(findElement(tree, 'DisplayOptions').props.open, true)
  const optionsTree = __render(() => DisplayOptions(findElement(tree, 'DisplayOptions').props))
  const inputs = findElements(optionsTree, node => node.type === 'input')
  inputs[0].props.onChange({ target: { checked: true } })
  tree = render()
  assert.deepEqual(writes, [[DISPLAY_OPTIONS_KEY, { showAssignee: true, showUpdatedAt: false }]])
  assert.equal(findElement(tree, 'IssueRows').props.displayOptions.showAssignee, true)

  __resetHooks()
  setQueries()
  tree = render()
  __flushEffects()
  tree = render()
  assert.equal(findElement(tree, 'IssueRows').props.displayOptions.showAssignee, true)
})

test('switching views from issue detail returns to the list and clears the detail selection', () => {
  __resetHooks()
  const requestedRoot = '/home/hermes/workspace/project'
  const overviewKey = ['beads', 'overview', 'local', 'developer', requestedRoot]
  const readyIssuesKey = ['beads', 'issues', 'local', 'developer', requestedRoot, '/canonical', 'ready']
  const detailKey = ['beads', 'detail', 'local', 'developer', requestedRoot, '/canonical', 'ready', 'gt-1']
  const blockedIssuesKey = ['beads', 'issues', 'local', 'developer', requestedRoot, '/canonical', 'blocked']
  const ctx = { storage: { get: (_key, fallback) => fallback, set: () => {} }, rest: async () => ({}) }
  const render = () => __render(() => ProjectPane({
    ctx,
    connectionId: 'local',
    profile: 'developer',
    project: { name: 'Project' },
    requestedRoot,
    visible: true
  }))
  __setQueryResult(overviewKey, { data: { requestedRoot, root: '/canonical', available: true, counts: {}, project: { name: 'Project' } } })
  __setQueryResult(readyIssuesKey, { data: { root: '/canonical', issues: [{ id: 'gt-1', title: 'Issue 1' }] } })
  __setQueryResult(detailKey, { data: { root: '/canonical', id: 'gt-1', title: 'Issue 1', status: 'ready' } })
  __setQueryResult(blockedIssuesKey, { data: { root: '/canonical', issues: [{ id: 'gt-2', title: 'Blocked issue' }] } })

  let tree = render()
  __flushEffects()
  tree = render()
  findElement(tree, 'IssueRows').props.onSelect('gt-1')
  tree = render()
  __flushEffects()
  tree = render()
  assert.ok(findElement(tree, 'IssueDetail'))
  findElement(tree, 'CountStrip').props.onChange('blocked')
  tree = render()
  __flushEffects()
  tree = render()
  assert.equal(findElement(tree, 'IssueDetail'), null)
  assert.deepEqual(findElement(tree, 'CountStrip').props.value, 'blocked')
  assert.deepEqual(findElement(tree, 'IssueRows').props.rows, [{ id: 'gt-2', title: 'Blocked issue' }])
})

test('production ProjectPane explains how to enable a disabled Agent backend', () => {
  __resetHooks()
  const requestedRoot = '/home/hermes/workspace/project'
  __setQueryResult(['beads', 'overview', 'local', 'developer', requestedRoot], {
    error: new Error('404 Not Found')
  })
  const tree = __render(() => ProjectPane({
    ctx: { rest: async () => ({}) },
    connectionId: 'local',
    profile: 'developer',
    project: { name: 'Project' },
    requestedRoot,
    visible: true
  }))
  assert.equal(tree.props.title, 'Beads backend unavailable')
  assert.match(tree.props.description, /Enable the Beads Agent plugin for the active profile/)
  assert.match(tree.props.description, /restart its backend/)
})

test('API errors parse only normalized bodies', () => {
  assert.deepEqual(
    parseApiError(new Error('503: {"detail":{"code":"beads_unavailable","message":"No backend","retryable":false}}')),
    { code: 'beads_unavailable', message: 'No backend', retryable: false }
  )
  assert.deepEqual(parseApiError(new Error('raw private stderr')), {
    code: 'backend_unavailable',
    message: 'The Beads backend is unavailable.',
    retryable: true
  })
})

test('plugin registers one Files-center right pane, migrates once, and clears Beads queries on dispose', () => {
  const registrations = []
  const disposers = []
  const writes = []
  plugin.register({
    storage: {
      get: (_key, fallback) => fallback,
      set: (key, value) => writes.push([key, value])
    },
    register(contribution) {
      registrations.push(contribution)
      return () => {}
    },
    onDispose(disposer) {
      disposers.push(disposer)
    }
  })
  assert.equal(plugin.id, 'beads')
  assert.equal(plugin.defaultEnabled, false)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'pane')
  assert.deepEqual(registrations[0].data, {
    placement: 'right',
    dock: { pane: 'files', pos: 'center', enforce: true },
    width: '360px'
  })
  assert.deepEqual(writes, [['files-center-dock-v1', true]])
  assert.equal(disposers.length, 1)
  disposers[0]()
  assert.deepEqual(queryClient.removals.at(-1), { queryKey: ['beads'] })

  const migrated = []
  plugin.register({
    storage: { get: () => true, set: () => assert.fail('migration should not be rewritten') },
    register: contribution => migrated.push(contribution),
    onDispose: () => {}
  })
  assert.deepEqual(migrated[0].data.dock, { pane: 'files', pos: 'center' })

  const notifications = []
  const originalNotify = host.notify
  const originalConsoleError = console.error
  host.notify = value => notifications.push(value)
  console.error = () => {}
  try {
    plugin.register({
      storage: { get: () => false, set: () => { throw new Error('storage failed') } },
      register: () => {},
      onDispose: () => {}
    })
  } finally {
    host.notify = originalNotify
    console.error = originalConsoleError
  }
  assert.deepEqual(notifications, [{
    kind: 'warning',
    message: 'Beads could not save its sidebar placement. The pane may move again after restart.'
  }])
})
