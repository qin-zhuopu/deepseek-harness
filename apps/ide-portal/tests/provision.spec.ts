/**
 * The host executor (`docker/ide-provision/provision.sh`) exercised hermeti-
 * cally: a fake docker CLI and fake curl model the container, the vhost answer,
 * and C2's PID1 freeze, so the reconcile verdicts, the two-step start, the
 * [DSH_STEP] marker protocol and the SR5 model-key path (stdin in, 0600 env
 * file, never argv, unlinked on exit) are all observed end to end without a
 * daemon. The fake CLI models containers as files under FAKE_DOCKER_DIR
 * (fixtures/fake-docker, fixtures/fake-curl).
 */

import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(here, '..', '..', '..', 'docker', 'ide-provision', 'provision.sh')
/** Directory holding the `docker`/`curl` symlinks prepended to PATH per suite. */
let binDir: string

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** One provision.sh invocation against the fixture fakes (fast probe cadence). */
function runScript(dir: string, stdin: string, args: string[]): Promise<Run> {
  return new Promise((resolvePromise) => {
    execFile(
      'bash',
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          FAKE_DOCKER_DIR: dir,
          IDE_ENV_DIR: dir,
          IDE_PROBE_INTERVAL: '1',
          IDE_PROBE_TIMEOUT: '3',
        },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        void error // exit status is the assertion, delivered through `code`
        resolvePromise({ code: typeof error?.code === 'number' ? error.code : 1, stdout, stderr })
      },
    ).stdin?.end(stdin)
  })
}

/** The step lines of a run as `step status detail` strings, sequence stripped. */
function steps(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter(line => line.startsWith('[DSH_STEP]'))
    .map(line => line.replace(/^\[DSH_STEP\] \d+ /, ''))
}

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ide-provision-'))
  binDir = await mkdtemp(join(tmpdir(), 'ide-provision-bin-'))
  const links: [string, string][] = [['fake-docker', 'docker'], ['fake-curl', 'curl']]
  for (const [fixture, name] of links) {
    await chmod(join(here, 'fixtures', fixture), 0o755)
    await symlink(join(here, 'fixtures', fixture), join(binDir, name))
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
})

/** Reset the fake model: container state, image presence, HTTP answer. */
async function seed(options: { container?: string; image?: boolean; http?: string }): Promise<void> {
  for (const entry of await import('node:fs/promises').then(fs => fs.readdir(dir))) {
    await rm(join(dir, entry), { force: true })
  }
  if (options.container !== undefined) await writeFile(join(dir, 'ide-14409.state'), options.container)
  if (options.image === true) await writeFile(join(dir, 'image.state'), '')
  if (options.http !== undefined) await writeFile(join(dir, 'http.code'), options.http)
}

describe('reconcile (probe action, FR6)', () => {
  it('answers absent when no container exists', async () => {
    await seed({ image: true, http: '200' })
    const run = await runScript(dir, '', ['14409', 'probe', 'img:tag', 'req-1', 'jereh-pe.cn'])
    expect(run.code).toBe(0)
    expect(steps(run.stdout)).toEqual(['reconcile info absent', 'ready ok nothing to reconcile'])
  })

  it('answers healthy when the web answers, whatever the gate code', async () => {
    await seed({ container: 'running', image: true, http: '401' })
    const run = await runScript(dir, '', ['14409', 'probe', 'img:tag', 'req-2', 'jereh-pe.cn'])
    expect(steps(run.stdout)[0]).toBe('reconcile info healthy')
  })

  it('answers running-unhealthy when the front does not answer', async () => {
    await seed({ container: 'running', image: true, http: '502' })
    const run = await runScript(dir, '', ['14409', 'probe', 'img:tag', 'req-3', 'jereh-pe.cn'])
    expect(steps(run.stdout)[0]).toBe('reconcile info running-unhealthy')
  })

  it('answers stopped for an exited container', async () => {
    await seed({ container: 'exited', image: true, http: '200' })
    const run = await runScript(dir, '', ['14409', 'probe', 'img:tag', 'req-4', 'jereh-pe.cn'])
    expect(steps(run.stdout)[0]).toBe('reconcile info stopped')
  })
})

describe('create (FR4, FR10, SR5)', () => {
  it('runs the two-step recipe and streams the markers', async () => {
    await seed({ image: true, http: '200' })
    const run = await runScript(dir, 'sk-secret\n', ['14409', 'create', 'harbor.jereh.cn/base/dsh-aio:dev-amd64', 'req-5', 'jereh-pe.cn'])
    expect(run.code).toBe(0)
    expect(steps(run.stdout)).toEqual([
      'image-pull ok harbor.jereh.cn/base/dsh-aio:dev-amd64 already local',
      'docker-run ok created ide-14409 on ide-14409.jereh-pe.cn',
      'start-hook ok fired /usr/local/bin/entrypoint.sh into ide-14409',
      'probe-internal ok HTTP 200 after 1 tries, 0s',
      'probe-proxy ok HTTP 200 after 1 tries, 0s',
      'ready ok request req-5',
    ])
    const argv = await readFile(join(dir, 'run-args.txt'), 'utf8')
    expect(argv).toContain('--name ide-14409')
    expect(argv).toContain('--env-file')
    expect(argv).toContain('VIRTUAL_HOST=ide-14409.jereh-pe.cn')
    expect(argv).toContain('DSH_IAM_GATE=1')
    expect(argv).toContain('sleep 60000')
    expect(argv).not.toContain('NR_API_KEY') // SR5: the key rides the env file, never argv
    expect(existsSync(join(dir, 'ide-14409.env'))).toBe(false) // unlinked on exit
  })

  it('treats a name conflict as created (two racing builds, US4)', async () => {
    await seed({ container: 'created', image: true, http: '200' })
    const run = await runScript(dir, 'sk-secret\n', ['14409', 'create', 'img:tag', 'req-6', 'jereh-pe.cn'])
    expect(run.code).toBe(0)
    expect(steps(run.stdout)[0]).toBe('docker-run info ide-14409 already exists (created); continuing as start')
  })

  it('refuses create without a model key on stdin', async () => {
    await seed({ image: true, http: '200' })
    const run = await runScript(dir, '', ['14409', 'create', 'img:tag', 'req-7', 'jereh-pe.cn'])
    expect(run.code).toBe(1)
    expect(steps(run.stdout)).toContain('docker-run fail no model key on stdin for create (FR10)')
  })

  it('re-fires the hook once and then fails probe-internal on the C2 freeze', async () => {
    await seed({ image: true, http: '502' })
    await writeFile(join(dir, 'no-hook-flip.state'), '')
    const run = await runScript(dir, 'sk-secret\n', ['14409', 'create', 'img:tag', 'req-8', 'jereh-pe.cn'])
    expect(run.code).toBe(1)
    const lines = steps(run.stdout)
    expect(lines).toContain('start-hook info no answer after 2s, re-firing hook once')
    expect(lines[lines.length - 1]).toMatch(/^probe-internal fail no health answer within 3s/)
    const calls = await readFile(join(dir, 'calls.txt'), 'utf8')
    expect(calls.trim().split('\n')).toHaveLength(2) // fired once, re-fired once, no more
  })
})

describe('start (FR6 recovery) and stop', () => {
  it('starts an exited container and accepts the gated answer as healthy', async () => {
    await seed({ container: 'exited', image: true, http: '401' })
    const run = await runScript(dir, '', ['14409', 'start', 'img:tag', 'req-9', 'jereh-pe.cn'])
    expect(run.code).toBe(0)
    expect(steps(run.stdout)).toEqual([
      'start-hook ok fired /usr/local/bin/entrypoint.sh into ide-14409',
      'probe-internal ok HTTP 401 after 1 tries, 0s',
      'probe-proxy ok HTTP 401 after 1 tries, 0s',
      'ready ok request req-9',
    ])
  })

  it('fails when there is nothing to start', async () => {
    await seed({ image: true, http: '200' })
    const run = await runScript(dir, '', ['14409', 'start', 'img:tag', 'req-10', 'jereh-pe.cn'])
    expect(run.code).toBe(1)
    expect(steps(run.stdout)).toEqual(['reconcile fail no ide-14409 to start'])
  })

  it('stop is idempotent', async () => {
    await seed({ image: true, http: '200' })
    const gone = await runScript(dir, '', ['14409', 'stop', 'img:tag', 'req-11', 'jereh-pe.cn'])
    expect(steps(gone.stdout)).toEqual(['ready ok ide-14409 already gone'])
    await seed({ container: 'running', image: true, http: '200' })
    const stopped = await runScript(dir, '', ['14409', 'stop', 'img:tag', 'req-12', 'jereh-pe.cn'])
    expect(steps(stopped.stdout)).toEqual(['ready ok ide-14409 stopped'])
    expect(await readFile(join(dir, 'ide-14409.state'), 'utf8')).toContain('exited')
  })
})

describe('input validation (host re-check behind Jenkins, SR1)', () => {
  it('refuses a non-numeric uid', async () => {
    await seed({ image: true, http: '200' })
    const run = await runScript(dir, '', ['14a9', 'probe', 'img:tag', 'req-13', 'jereh-pe.cn'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('bad uid argument')
  })

  it('refuses an unknown action and an unvalidated image', async () => {
    await seed({ image: true, http: '200' })
    expect((await runScript(dir, '', ['14409', 'rm', 'img:tag', 'req-14', 'jereh-pe.cn'])).code).toBe(2)
    expect((await runScript(dir, '', ['14409', 'probe', 'img; rm -rf /', 'req-15', 'jereh-pe.cn'])).code).toBe(2)
  })
})
