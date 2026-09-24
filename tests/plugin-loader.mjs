const virtual = new Map([
  ['@hermes/plugin-sdk', 'hermes-sdk'],
  ['react', 'react-stub'],
  ['react/jsx-runtime', 'jsx-stub']
])

export async function resolve(specifier, context, nextResolve) {
  if (virtual.has(specifier)) return { url: `beads:${virtual.get(specifier)}`, shortCircuit: true }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === 'beads:react-stub') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const runtime = globalThis.__beadsTestRuntime ||= {
          effectDeps: [],
          effectCleanups: [],
          effects: [],
          hooks: [],
          queries: new Map(),
          queryOptions: []
        }
        let cursor = 0
        let effectCursor = 0
        const sameDeps = (left, right) =>
          Array.isArray(left) && Array.isArray(right) &&
          left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
        export const __resetHooks = () => {
          runtime.effectCleanups.forEach(cleanup => cleanup?.())
          runtime.effectDeps = []
          runtime.effectCleanups = []
          runtime.effects = []
          runtime.hooks = []
          runtime.queries = new Map()
          runtime.queryOptions = []
          cursor = 0
          effectCursor = 0
        }
        export const __render = render => {
          cursor = 0
          effectCursor = 0
          runtime.effects = []
          runtime.queryOptions = []
          return render()
        }
        export const __flushEffects = () => {
          const effects = runtime.effects
          runtime.effects = []
          effects.forEach(({ effect, index }) => {
            runtime.effectCleanups[index]?.()
            runtime.effectCleanups[index] = effect()
          })
        }
        export const useEffect = (effect, deps) => {
          const index = effectCursor++
          if (!sameDeps(runtime.effectDeps[index], deps)) runtime.effects.push({ effect, index })
          runtime.effectDeps[index] = deps
        }
        export const useMemo = fn => fn()
        export const useReducer = (reducer, initial) => {
          const index = cursor++
          if (!(index in runtime.hooks)) runtime.hooks[index] = initial
          return [runtime.hooks[index], action => { runtime.hooks[index] = reducer(runtime.hooks[index], action) }]
        }
        export const useRef = value => ({ current: value })
        export const useState = value => {
          const index = cursor++
          if (!(index in runtime.hooks)) runtime.hooks[index] = typeof value === 'function' ? value() : value
          return [runtime.hooks[index], next => {
            runtime.hooks[index] = typeof next === 'function' ? next(runtime.hooks[index]) : next
          }]
        }
      `
    }
  }
  if (url === 'beads:jsx-stub') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const jsx = (type, props, key) => ({ type, props: props || {}, key })
        export const jsxs = jsx
      `
    }
  }
  if (url === 'beads:hermes-sdk') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const component = function Component() { return null }
        export const Badge = component
        export const Button = component
        export const EmptyState = component
        export const ErrorState = component
        export const GlyphSpinner = component
        export const RowButton = component
        export const SearchField = component
        export const ScrollArea = component
        export const SegmentedControl = component
        export const Separator = component
        export const Skeleton = component
        export const PANES_AREA = 'panes'
        export const fmtDateTime = value => String(value)
        const atom = value => ({ get: () => value, subscribe: callback => (callback(value), () => {}) })
        export const host = {
          state: { cwd: atom(''), profile: atom('developer'), connectionId: atom('local') },
          paneVisibility: () => atom(true),
          notify: () => {},
          request: async () => ({})
        }
        export const queryClient = {
          removals: [],
          removeQueries(value) { this.removals.push(value) }
        }
        const runtime = globalThis.__beadsTestRuntime ||= {
          effectDeps: [], effectCleanups: [], effects: [], hooks: [], queries: new Map(), queryOptions: []
        }
        export const __setQueryResult = (key, value) => runtime.queries.set(JSON.stringify(key), value)
        export const __queryOptions = () => runtime.queryOptions
        export const useQuery = options => {
          runtime.queryOptions.push(options)
          return {
            data: null,
            error: null,
            isLoading: false,
            isFetching: false,
            refetch() {},
            ...(runtime.queries.get(JSON.stringify(options.queryKey)) || {})
          }
        }
        export const useValue = target => target.get()
      `
    }
  }
  return nextLoad(url, context)
}
