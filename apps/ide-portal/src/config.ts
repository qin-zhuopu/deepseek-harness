/**
 * Portal deployment configuration: one YAML file plus the `.env` secrets,
 * every value explicit (0008 Configuration). Loading is fail-loud: a missing
 * or malformed value refuses startup rather than defaulting silently.
 * @module
 */

import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'

/** Jenkins executor connection (0008 Jenkins executor). */
export interface JenkinsConfig {
  /** Root URL of new-jenkins.jereh.cn. */
  url: string
  /** The ide-provision job name. */
  job: string
  /** API-token user for buildWithParameters; never the host SSH credential (SR3). */
  user: string
  /** Name of the environment variable carrying the API token. */
  tokenEnv: string
}

/** IAM sign-in settings; the callback `redirect_uri` composes from the request origin (C10). */
export interface IamConfig {
  /** Provider issuer URI; discovery and JWKS read from it. */
  issuer: string
  /** OAuth2 client id; `EnterpriseDingtalk` is accepted unregistered (C10). */
  clientId: string
  /** Exact callback path; must equal the fragment-relay page the login flow lands on. */
  redirectPath: string
  /**
   * Trust-on-first-use file: `<issuer>/.well-known/openid-configuration` and
   * the document's `jwks_uri` (JWKS) as two raw JSON documents. Where the
   * server cannot reach the IAM, seeding the file once from any network that
   * can makes sign-in and verification fully offline; refresh it after an IAM
   * key rotation or the gate refuses tokens signed with new keys.
   */
  trustFile?: string
}

/** Health-probe budget surfaced to the page as elapsed time (C7). */
export interface HealthConfig {
  /** Seconds between probe attempts. */
  intervalSec: number
  /** Hard probe cap in seconds (N1). */
  timeoutSec: number
  /** Queue-follow and console-tail cadence in milliseconds (N2 keeps this under 2 s). */
  pollMs: number
}

/** Fully validated portal configuration; nothing tunable is hardcoded elsewhere. */
export interface PortalConfig {
  /** Suffix after the per-user host label: `ide-<uid>.<domainSuffix>`. */
  domainSuffix: string
  /** The shared entry vhost hosting this portal. */
  entryHost: string
  /** uid extraction: verified `sub`, cross-checked against `userId` (0007 Identity claims). */
  uid: { claim: 'sub'; crossCheckClaim: string; pattern: string }
  /** Pinned image tag (C6); never `latest`. */
  imageTag: string
  /** Model key source (FR10): `.env` file plus variable name, read at create only. */
  modelKey: { envFile: string; varName: string }
  jenkins: JenkinsConfig
  iam: IamConfig
  health: HealthConfig
  /**
   * Entry behavior (0007 FR3/FR4). `false` (the shipped first version) renders
   * the start page and waits for the user's check-button click: no Jenkins
   * build and no Docker read until the click. `true` reconciles on arrival —
   * a healthy container answers the entry with a `302`, and the cold path
   * provisions without the click.
   */
  autoCheck: boolean
  /** Address to bind; `0.0.0.0` behind nginx-proxy (0005: the proxy reaches the container IP, never loopback). */
  bindHost: string
  /** Port the portal listens on (0 = OS-assigned, for tests). */
  port: number
}

/** Fail-loud scalar read with a message naming the exact key. */
function need(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') throw new Error(`portal config: ${where}.${key} must be a non-empty string`)
  return value
}

/** Fail-loud number read. */
function needNum(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`portal config: ${where}.${key} must be a number`)
  return value
}

/** Fail-loud boolean read. */
function needBool(record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`portal config: ${where}.${key} must be a boolean`)
  return value
}

function section(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`portal config: ${key} must be a mapping`)
  return value as Record<string, unknown>
}

/** Parse and validate the portal YAML config file. */
export function parsePortalConfig(text: string): PortalConfig {
  const doc = parseDocument(text, { prettyErrors: true })
  if (doc.errors.length > 0) throw new Error(`portal config: ${doc.errors[0]?.message ?? 'parse error'}`)
  const raw = doc.toJS() as Record<string, unknown>
  const uid = section(raw, 'uid')
  const modelKey = section(raw, 'modelKey')
  const jenkins = section(raw, 'jenkins')
  const iam = section(raw, 'iam')
  const health = section(raw, 'health')
  const pattern = need(uid, 'pattern', 'uid')
  try {
    new RegExp(pattern)
  } catch {
    throw new Error(`portal config: uid.pattern is not a valid regular expression: ${pattern}`)
  }
  if (need(uid, 'claim', 'uid') !== 'sub') throw new Error('portal config: uid.claim must be "sub" (0007 Identity claims)')
  return {
    domainSuffix: need(raw, 'domainSuffix', 'root'),
    entryHost: need(raw, 'entryHost', 'root'),
    uid: { claim: 'sub', crossCheckClaim: need(uid, 'crossCheckClaim', 'uid'), pattern },
    imageTag: need(raw, 'imageTag', 'root'),
    modelKey: { envFile: need(modelKey, 'envFile', 'modelKey'), varName: need(modelKey, 'varName', 'modelKey') },
    jenkins: {
      url: need(jenkins, 'url', 'jenkins').replace(/\/+$/, ''),
      job: need(jenkins, 'job', 'jenkins'),
      user: need(jenkins, 'user', 'jenkins'),
      tokenEnv: need(jenkins, 'tokenEnv', 'jenkins'),
    },
    iam: {
      issuer: need(iam, 'issuer', 'iam').replace(/\/+$/, ''),
      clientId: need(iam, 'clientId', 'iam'),
      redirectPath: need(iam, 'redirectPath', 'iam'),
      ...(iam['trustFile'] === undefined ? {} : { trustFile: need(iam, 'trustFile', 'iam') }),
    },
    health: { intervalSec: needNum(health, 'intervalSec', 'health'), timeoutSec: needNum(health, 'timeoutSec', 'health'), pollMs: needNum(health, 'pollMs', 'health') },
    bindHost: raw['bindHost'] === undefined ? '127.0.0.1' : need(raw, 'bindHost', 'root'),
    port: raw['port'] === undefined ? 8080 : needNum(raw, 'port', 'root'),
    autoCheck: raw['autoCheck'] === undefined ? false : needBool(raw, 'autoCheck', 'root'),
  }
}

/** Parse one `.env`-style file (KEY=VALUE lines, `#` comments) into a record. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** Read the model key from the configured `.env` (FR10: the only home), fail-loud when absent. */
export function readModelKey(config: PortalConfig): string {
  let text: string
  try {
    text = readFileSync(config.modelKey.envFile, 'utf8')
  } catch {
    throw new Error(`portal config: model key file ${config.modelKey.envFile} is unreadable (FR10)`)
  }
  const value = parseEnvFile(text)[config.modelKey.varName]
  if (value === undefined || value === '') throw new Error(`portal config: ${config.modelKey.varName} missing from ${config.modelKey.envFile} (FR10)`)
  return value
}

/** Read the portal config file from disk. */
export function loadPortalConfig(path: string): PortalConfig {
  return parsePortalConfig(readFileSync(path, 'utf8'))
}
