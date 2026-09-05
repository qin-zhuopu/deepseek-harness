/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc, type RpcFetch } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/**
 * Whether this browser is admitted to the Host's privileged plane. `true` for
 * a loopback or fixture page (decided before the first paint) and for a remote
 * page once the mounted auth gate confirms the page's credential; `false`
 * while the page is anonymous. The verdict arrives asynchronously on a remote
 * page, so consumers subscribe as well as read the snapshot.
 */
export interface PrivatePlaneSource {
  /** Latest verdict; false until a remote page's admission answer lands. */
  getSnapshot(): boolean
  /** Subscribe to the verdict change from anonymous to admitted. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Carrier override installed on the page global before plugin boot. The served
 * web app leaves it unset and gets HTTP + WebSocket; a shell that owns a
 * different physical transport (the worker preview's postMessage tunnel)
 * provides both halves here instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /** Build the API carrier: unary calls plus the two downstream event streams. */
  createApiClient(): IApiClient
  /** Transport for generic unary RPC channels (the Typert gateway). */
  fetch: RpcFetch
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including the account home and native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Whether the Host treats this browser as authenticated into its privileged plane. */
  readonly privatePlane: PrivatePlaneSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const api: IApiClient = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  // The privileged-plane verdict for this page: loopback (or non-browser) pages
  // are admitted synchronously; a remote page learns its verdict from the auth
  // gate's own surface (GET /auth-state, reachable only with a verified
  // credential). The page itself can only be served to an admitted browser
  // when a gate is mounted — the guard redirects unauthenticated navigations
  // to the login — so no reload dance is needed: the probe answers on load.
  const loopbackPage = pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)
  let planeAllowed = loopbackPage || fixture
  const planeListeners = new Set<() => void>()
  // The probe is the only writer and only runs while the plane is closed, so
  // every publish is a real transition.
  const publishPlane = (): void => {
    planeAllowed = true
    for (const listener of [...planeListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] private-plane listener threw:', error)
      }
    }
  }
  if (!planeAllowed) {
    // The auth surface's own admission echo: a mounted gate answers
    // {authenticated:true} only for a verified credential (its guard 401s
    // everyone else), and with no gate mounted the path is unclaimed — the
    // SPA fallback answers HTML and the JSON parse below refuses it. The
    // literal path pairs with DEFAULT_STATE_PATH in dsh-host-auth-core.
    void globalThis.fetch('/auth-state', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return
        const body = await response.json() as { authenticated?: unknown }
        if (body.authenticated === true) publishPlane()
      })
      .catch(() => { /* anonymous page: stays out of the privileged plane */ })
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: loopbackPage,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    privatePlane: {
      getSnapshot: () => planeAllowed,
      subscribe: (listener) => {
        planeListeners.add(listener)
        return () => { planeListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
