/**
 * Config loading behavior: fail-loud on every malformed value, the `.env`
 * model-key read, and the exact wire values the rest of the portal derives.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPortalConfig, parseEnvFile, parsePortalConfig, readModelKey } from '../src/config.ts'

const VALID = `
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: dev-amd64-abc1234
modelKey: {envFile: .env, varName: NR_API_KEY}
jenkins: {url: https://jenkins.test/, job: ide-provision, user: portal, tokenEnv: IDE_JENKINS_TOKEN}
iam: {issuer: https://iam.test/idp/, clientId: EnterpriseDingtalk, redirectPath: /auth/callback}
health: {intervalSec: 30, timeoutSec: 600, pollMs: 1500}
port: 0
`

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('parsePortalConfig', () => {
  it('loads a complete file and normalizes trailing slashes', () => {
    const config = parsePortalConfig(VALID)
    expect(config.jenkins.url).toBe('https://jenkins.test')
    expect(config.iam.issuer).toBe('https://iam.test/idp')
    expect(config.uid.claim).toBe('sub')
    expect(config.port).toBe(0)
    // The shipped default is manual: the check button drives the first probe.
    expect(config.autoCheck).toBe(false)
  })

  it('reads autoCheck: true as the auto entry mode', () => {
    expect(parsePortalConfig(`${VALID}\nautoCheck: true\n`).autoCheck).toBe(true)
  })

  it('refuses a non-boolean autoCheck', () => {
    expect(() => parsePortalConfig(`${VALID}\nautoCheck: "yes"\n`)).toThrow(/autoCheck/)
  })

  it('refuses a missing section naming the key', () => {
    expect(() => parsePortalConfig(VALID.replace(/^iam:.*$/m, ''))).toThrow(/iam/)
  })

  it('refuses a uid.claim other than sub', () => {
    expect(() => parsePortalConfig(VALID.replace('claim: sub', 'claim: uid'))).toThrow(/uid.claim must be "sub"/)
  })

  it('refuses an invalid uid regex', () => {
    expect(() => parsePortalConfig(VALID.replace('"^[0-9]{1,8}$"', '"^[0-9("'))).toThrow(/regular expression/)
  })

  it('refuses a non-numeric timeout', () => {
    expect(() => parsePortalConfig(VALID.replace('timeoutSec: 600', 'timeoutSec: "600"'))).toThrow(/timeoutSec/)
  })
})

describe('model key file (FR10)', () => {
  it('parses KEY=VALUE lines and skips comments and blanks', () => {
    expect(parseEnvFile('# c\nA=1\n\n B = 2 \n')).toEqual({ A: '1', B: '2' })
  })

  it('reads the named var from the configured file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-cfg-'))
    dirs.push(dir)
    const envFile = join(dir, '.env')
    await writeFile(envFile, 'NR_API_KEY=sk-platform\nOTHER=x\n')
    const config = { ...parsePortalConfig(VALID), modelKey: { envFile, varName: 'NR_API_KEY' } }
    expect(readModelKey(config)).toBe('sk-platform')
  })

  it('fails loud when the file or the var is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-cfg-'))
    dirs.push(dir)
    const base = parsePortalConfig(VALID)
    expect(() => readModelKey({ ...base, modelKey: { envFile: join(dir, 'nope.env'), varName: 'NR_API_KEY' } })).toThrow(/unreadable/)
    const empty = join(dir, 'empty.env')
    await writeFile(empty, 'X=1\n')
    expect(() => readModelKey({ ...base, modelKey: { envFile: empty, varName: 'NR_API_KEY' } })).toThrow(/missing/)
  })

  it('loadPortalConfig reads from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-cfg-'))
    dirs.push(dir)
    const file = join(dir, 'portal.yaml')
    await writeFile(file, VALID)
    expect(loadPortalConfig(file).entryHost).toBe('ide.jereh-pe.cn')
  })
})
