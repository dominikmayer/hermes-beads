import assert from 'node:assert/strict'
import test from 'node:test'

import plugin, {
  acceptsCanonicalRoot,
  acceptsOverview,
  buildPluginUrl,
  createQueryScope,
  detailQueryKey,
  isPathAncestor,
  issuesQueryKey,
  normalizeAbsolutePath,
  overviewQueryKey,
  parseApiError,
  pathsEquivalent,
  pollingInterval,
  ProjectPane,
  queryEnablement,
  retentionReducer,
  selectRequestedRoot
} from '../desktop/plugin.js'
import { __queryOptions, __setQueryResult, queryClient } from '@hermes/plugin-sdk'
import { __flushEffects, __render, __resetHooks } from 'react'

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

test('plugin registers one right pane and clears Beads queries on dispose', () => {
  const registrations = []
  const disposers = []
  plugin.register({
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
  assert.deepEqual(registrations[0].data, { placement: 'right', width: '360px' })
  assert.equal(disposers.length, 1)
  disposers[0]()
  assert.deepEqual(queryClient.removals.at(-1), { queryKey: ['beads'] })
})
