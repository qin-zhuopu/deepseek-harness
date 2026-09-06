/**
 * Config loading behavior: fail-loud on every malformed value and the exact
 * wire values the rest of the portal derives.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPortalConfig, parsePortalConfig } from '../src/config.ts'

const VALID = `
domainSuffix: jereh-pe.cn
entryHost: ide.jereh-pe.cn
uid: {claim: sub, crossCheckClaim: userId, pattern: "^[0-9]{1,8}$"}
imageTag: dev-amd64-abc1234
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

describe('config file (N3)', () => {
  it('loadPortalConfig reads from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ide-portal-cfg-'))
    dirs.push(dir)
    const file = join(dir, 'portal.yaml')
    await writeFile(file, VALID)
    expect(loadPortalConfig(file).entryHost).toBe('ide.jereh-pe.cn')
  })
})
