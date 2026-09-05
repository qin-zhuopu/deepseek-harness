/**
 * Host transport for the settings-namespace scope contract. The contract types
 * live in `dsh-client-runtime` (the common dependency of every feature that
 * owns a preference); this file owns the per-namespace derivation over the
 * shared {@link SettingsDescribeMirror} and the serialized write path, both of
 * which are Settings-surface concerns. Reads never touch the wire here: the
 * mirror is the one `settings.describe` reader, and every scope is a selector
 * over its snapshot.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionHandle, IApiClient, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot,
  type SettingsScopeSpec, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only, and deliberately NOT `@deepseek-ai/dsh-api-remotes/client`: this
// package is reachable from the Host build graph through its feature-package
// callers, and api-remotes' Client face imports a Host-tsdown-generated
// `/remote` artifact, which would deadlock the Host tsc phase. The gateway's
// Client half declares `ctx.remote` with no generated import, and the
// allowlist's `types` subpath is a pure-type source file, so the pair supplies
// `$on` and its key face without dragging a build artifact in. The runtime
// `remote` injection belongs to the providing plugin's apply, which registers
// the mirror's invalidation subscriptions.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
// The forwarded event's own declaration: `$on`'s key face is
// `Extract<keyof Events, keyof Selection>`, so the allowlist alone resolves to
// never — the owning package's client-safe, type-only subpath supplies the
// cordis `Events` entry (and with it the branded `SettingsNamespace`).
import type {} from '@deepseek-ai/dsh-settings/types'
import type { SettingsSchemaService } from './schema.ts'
import { SettingsDescribeMirror, persistenceAllows, type SettingsDescribeFace, type SettingsPersistence } from './settings-mirror.ts'

type SettingsFace = Pick<IApiClient, 'settings'>

/**
 * One namespace's derived view over the shared describe mirror, plus that
 * namespace's serialized Host writes. Writes carry the latest known namespace
 * revision, fold their answers back into the mirror, and teardown waits for
 * the operation already crossing the wire.
 */
export class SettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private tail: Promise<void> = Promise.resolve()
  private writeGeneration = 0
  private disposed = false
  private unsubscribe: (() => void) | undefined
  /**
   * Revision answered by a superseded write still ahead of the mirror: the
   * mirror only folds the LATEST settlement in, so a queued successor takes
   * its fence from here first.
   */
  private pendingRevision: number | undefined

  /**
   * @param api - settings wire face (writes only; reads ride the mirror).
   * @param spec - namespace identity and optional narrowing decoder.
   * @param mirror - the shared describe mirror this scope derives from.
   * @param persistence - what admits this browser to the settings RPCs: the
   * privileged-plane source (a remote browser stays process-local until an
   * auth gate admits it), a constant, or `host` for in-process transports.
   * @param schema - settings-owned schema operations.
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly spec: SettingsScopeSpec<T>,
    private readonly mirror: SettingsDescribeMirror,
    private readonly persistence: SettingsPersistence,
    private readonly schema: SettingsSchemaService,
  ) {
    const mayRead = persistenceAllows(persistence)
    this.store = createSnapshotStore<SettingsScopeSnapshot<T>>({
      status: mayRead ? 'loading' : 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: mayRead ? 'host' : 'memory',
    })
    // Deriving and write-gating read the live persistence verdict on every
    // call, so a privileged-plane flip needs no re-construction: the mirror's
    // snapshot changes (its `refreshPermission` starts the admission read)
    // drive both the mode publication and the first derive.
    this.watchMirror()
  }

  /** Derive now and follow the mirror's snapshot publications. */
  private watchMirror(): void {
    if (this.disposed || this.unsubscribe !== undefined) return
    this.unsubscribe = this.mirror.subscribe(() => { this.derive() })
    this.derive()
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Queue one field write; see {@link SettingsScope.set} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ op: 'set', path: [field], value })
  }

  /**
   * Queue one field clear; see {@link SettingsScope.unset} for the ordering,
   * revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void> {
    return this.write({ op: 'unset', path: [field] })
  }

  private write(op: SettingsPathOpView): Promise<void> {
    const generation = ++this.writeGeneration
    return this.enqueue(async () => {
      const revision = this.pendingRevision ?? this.getSnapshot().revision
      let response: Awaited<ReturnType<SettingsFace['settings']['mutate']>>
      try {
        response = await this.api.settings.mutate({
          ns: this.spec.namespace,
          ops: [op],
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
      } catch (_settingsWriteFailure) {
        await this.recover(generation)
        return
      }
      if (!response.result.ok) {
        await this.recover(generation)
        return
      }
      if (this.disposed) return
      if (generation === this.writeGeneration) {
        this.pendingRevision = undefined
        this.mirror.acceptView(response.result.value)
      } else {
        this.pendingRevision = response.result.value.revision
      }
    })
  }

  /** Reload Host state for the latest failed write; superseded failures leave recovery to it. */
  private async recover(generation: number): Promise<void> {
    if (this.disposed || generation !== this.writeGeneration) return
    this.pendingRevision = undefined
    await this.mirror.load()
  }

  /**
   * Stop queued operations, stop deriving, and wait for the current wire call
   * to settle.
   * @returns settlement after the controller reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.writeGeneration += 1
    this.unsubscribe?.()
    await this.tail
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (!persistenceAllows(this.persistence) || this.disposed) return Promise.resolve()
    const task = this.tail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    // The returned task carries its own settlement to the caller; the queue
    // tail is kept fulfilled so one failed subscriber cannot strand later operations.
    this.tail = task.catch(() => {})
    return task
  }

  private derive(): void {
    if (this.disposed) return
    const mayRead = persistenceAllows(this.persistence)
    const mirrored = this.mirror.getSnapshot()
    if (!mayRead) {
      // The browser is outside the privileged plane: the namespace stays
      // process-local. A view held from before the flip keeps serving as the
      // last-known value; the Host-side guards still own every write.
      this.store.update((draft) => {
        draft.mode = 'memory'
        if (draft.value === undefined) draft.status = 'unavailable'
        draft.writable = false
      })
      return
    }
    this.watchMirror()
    if (mirrored.view === undefined) {
      this.store.update((draft) => {
        draft.mode = 'host'
        // An `unavailable` status here is the process-local verdict left over
        // from before the page entered the privileged plane; the read the
        // admission started is what answers now.
        if (draft.status === 'unavailable') draft.status = 'loading'
      })
      return
    }
    const { writable } = mirrored.view
    const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
    if (view === undefined) {
      this.store.update((draft) => {
        draft.status = 'unavailable'
        draft.mode = 'host'
        draft.writable = writable
      })
      return
    }
    const decoded = this.decode(view)
    this.store.update((draft) => {
      draft.revision = view.revision
      draft.base = view.base
      draft.user = view.user
      draft.writable = writable
      draft.mode = 'host'
      if (decoded === undefined) return
      draft.status = 'ready'
      draft.value = decoded
    })
  }

  private decode(view: SettingsNamespaceView): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(view.value)
    // Sections are plain objects by construction; schemastery alone would
    // resolve null or an array through object defaults instead of refusing.
    if (typeof view.value !== 'object' || view.value === null || Array.isArray(view.value)) return undefined
    let failure: string | undefined
    try {
      failure = this.schema.validate(this.schema.rehydrate(view.schema), view.value)
    } catch (_malformedSchemaEnvelope) {
      // A schema envelope this client cannot rehydrate vouches for no section;
      // the value is treated exactly like a schema-invalid one.
      return undefined
    }
    return failure === undefined ? view.value as T : undefined
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    settingsScope: SettingsScopeBinder
  }
}

/**
 * The settings domain's base service. Features that own a preference reach the
 * settings transport through this service rather than a shared function: the
 * client bundle purity gate forbids cross-plugin value imports and directs
 * cross-plugin collaboration through cordis services
 * (`packages/client/tsdown.client.ts`).
 */
export class SettingsScopeBinder extends Service {
  private readonly mirror: SettingsDescribeMirror
  private readonly schema: SettingsSchemaService

  /**
   * @param ctx - the providing plugin's context.
   * @param config - the shared describe mirror every bound scope derives from,
   * plus the settings-owned schema operations.
   */
  constructor(ctx: Context, config: { mirror: SettingsDescribeMirror; schema: SettingsSchemaService }) {
    super(ctx, 'settingsScope')
    this.mirror = config.mirror
    this.schema = config.schema
  }

  /**
   * The shared mirror's read/fold face for cross-namespace surfaces (schema
   * introspection, the served-namespace directory). Per-namespace consumers
   * use {@link bind}; both derive from the same snapshot, so they can never
   * disagree about the document.
   * @returns the describe face over the shared mirror.
   */
  describe(): SettingsDescribeFace {
    return this.mirror
  }

  /**
   * Bind one namespace scope on the CALLER's plugin lifecycle — the service
   * proxy binds `this.ctx` to the caller at call time, so the scope's disposer
   * belongs to the calling fiber. The scope derives from the shared mirror
   * (whose invalidation subscriptions live with the providing plugin), so
   * binding adds no wire read of its own and activation never blocks on the
   * settings transport.
   * @param spec - domain-owned namespace contract.
   * @returns the bound scope consumed by the domain's services and rows.
   */
  bind<T>(spec: SettingsScopeSpec<T>): SettingsScope<T> {
    const ctx = this.ctx
    const connection = ctx.get('connection') as ConnectionHandle
    const controller = new SettingsScopeController<T>(
      connection.api,
      spec,
      this.mirror,
      connection.isLoopback ? 'host' : connection.privatePlane,
      this.schema,
    )
    ctx.effect(() => {
      void this.mirror.ensure()
      return async () => {
        await controller.dispose()
      }
    }, `ui-settings: ${spec.namespace} settings scope`)
    return controller
  }
}
