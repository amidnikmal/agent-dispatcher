import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { runAgent, AGENTS, tail, paramsSchema, resetLocks, running } from './dispatcher.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dispatcherPath = join(__dirname, 'dispatcher.mjs')

let baseDir, repoCwd, worktreeCwd, notGitCwd, fixturesBin, worktree2Cwd
const origPath = process.env.PATH
const origMaxParallel = process.env.MAX_PARALLEL
const KILO = 'kilocode'
const CODEX = 'codex-throne'

before(async () => {
  baseDir = join(tmpdir(), `dispatcher-test-${randomUUID()}`)
  await mkdir(baseDir, { recursive: true })

  repoCwd = join(baseDir, 'repo')
  execSync(`git init "${repoCwd}"`, { encoding: 'utf8' })
  execSync(`git -C "${repoCwd}" commit --allow-empty -m init`, {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' },
  })

  worktreeCwd = join(baseDir, 'wt')
  execSync(`git -C "${repoCwd}" worktree add "${worktreeCwd}" -b test-wt`, { encoding: 'utf8' })

  worktree2Cwd = join(baseDir, 'wt2')
  execSync(`git -C "${repoCwd}" worktree add "${worktree2Cwd}" -b test-wt2`, { encoding: 'utf8' })

  notGitCwd = join(baseDir, 'not-git')
  await mkdir(notGitCwd)

  fixturesBin = join(baseDir, 'bin')
  await mkdir(fixturesBin)

  await writeFile(join(fixturesBin, KILO), [
    '#!/bin/bash',
    'case "$*" in',
    '  *TRAP_TERM*) trap \'\' TERM; exec sleep 9000 ;;',
    '  *SELF_TERM*) kill -TERM $$ ;;',
    '  *SLEEP_9000*) exec sleep 9000 ;;',
    '  *FAIL_1*) echo "stderr fail" >&2; exit 1 ;;',
    '  *) echo "fake-kilo-ok" ;;',
    'esac',
    'exit 0',
  ].join('\n'))
  execSync(`chmod +x "${join(fixturesBin, KILO)}"`)

  await writeFile(join(fixturesBin, CODEX), [
    '#!/bin/bash',
    'case "$*" in',
    '  *SLEEP_9000*) exec sleep 9000 ;;',
    '  *FAIL_2*) echo "codex-stderr" >&2; exit 2 ;;',
    '  *) echo "fake-codex-ok" ;;',
    'esac',
    'exit 0',
  ].join('\n'))
  execSync(`chmod +x "${join(fixturesBin, CODEX)}"`)

  process.env.PATH = `${fixturesBin}:${origPath}`
  process.env.MAX_PARALLEL = '3'
})

after(async () => {
  process.env.PATH = origPath
  if (origMaxParallel !== undefined) {
    process.env.MAX_PARALLEL = origMaxParallel
  } else {
    delete process.env.MAX_PARALLEL
  }
  await rm(baseDir, { recursive: true, force: true })
})

describe('AGENTS registry', () => {
  it('has exactly kilo and codex', () => {
    const keys = Object.keys(AGENTS).sort()
    assert.deepStrictEqual(keys, ['codex', 'kilo'])
  })

  it('codex uses codex-throne binary', () => {
    assert.strictEqual(AGENTS.codex.bin, CODEX)
  })

  it('codex uses exec with --skip-git-repo-check', () => {
    const args = AGENTS.codex.args('test')
    assert.ok(args.includes('exec'))
    assert.ok(args.includes('--skip-git-repo-check'))
  })

  it('kilo uses kilocode binary with run subcommand', () => {
    assert.strictEqual(AGENTS.kilo.bin, KILO)
    assert.deepStrictEqual(AGENTS.kilo.args('test'), ['run', 'test'])
  })

  it('each agent has label, bin, args function', () => {
    for (const [key, agent] of Object.entries(AGENTS)) {
      assert.strictEqual(typeof agent.label, 'string', `${key}: label`)
      assert.strictEqual(typeof agent.bin, 'string', `${key}: bin`)
      assert.strictEqual(typeof agent.args, 'function', `${key}: args`)
      const argv = agent.args('prompt')
      assert.ok(Array.isArray(argv), `${key}: args returns array`)
      assert.ok(argv.includes('prompt'), `${key}: prompt passed`)
    }
  })
})

describe('tail() helper', () => {
  it('returns last N lines', () => {
    assert.strictEqual(tail('a\nb\nc\nd\ne', 2), 'd\ne')
  })

  it('returns full text when fewer lines than N', () => {
    assert.strictEqual(tail('a\nb', 10), 'a\nb')
  })

  it('returns empty for empty input', () => {
    assert.strictEqual(tail('', 5), '')
  })
})

describe('paramsSchema', () => {
  it('has prompt, cwd, timeout_sec, log_tail_lines keys', () => {
    const keys = Object.keys(paramsSchema)
    assert.ok(keys.includes('prompt'))
    assert.ok(keys.includes('cwd'))
    assert.ok(keys.includes('timeout_sec'))
    assert.ok(keys.includes('log_tail_lines'))
  })

  it('timeout_sec has default 1800 via Zod', () => {
    const result = paramsSchema.timeout_sec.safeParse(undefined)
    assert.strictEqual(result.success, true)
    assert.strictEqual(result.data, 1800)
  })

  it('timeout_sec rejects value above 7200', () => {
    const result = paramsSchema.timeout_sec.safeParse(7201)
    assert.strictEqual(result.success, false)
  })

  it('log_tail_lines has default 60 via Zod', () => {
    const result = paramsSchema.log_tail_lines.safeParse(undefined)
    assert.strictEqual(result.success, true)
    assert.strictEqual(result.data, 60)
  })
})

describe('runAgent', () => {
  it('succeeds in a worktree and returns valid JSON report', async () => {
    const result = await runAgent('kilo', 'test prompt', worktreeCwd, 30, 10)
    const parsed = JSON.parse(result)
    assert.strictEqual(parsed.agent, 'kilo')
    assert.strictEqual(parsed.exit_code, 0)
    assert.strictEqual(parsed.branch, 'test-wt')
    assert.ok(typeof parsed.duration_s === 'number')
    assert.ok(parsed.duration_s >= 0)
    assert.strictEqual(parsed.status_short, '(clean)')
    assert.strictEqual(parsed.diffstat, '(no changes)')
    assert.ok(parsed.log_path.includes('logs'))
    assert.ok(parsed.log_path.includes('kilo'))
    assert.strictEqual(parsed.timed_out, false)
    assert.strictEqual(parsed.error, null)
    assert.ok(parsed.stdout_tail.includes('fake-kilo-ok'))
  })

  it('returns error exit_code when agent fails', async () => {
    const result = await runAgent('kilo', 'FAIL_1 test', worktreeCwd, 30, 10)
    const parsed = JSON.parse(result)
    assert.strictEqual(parsed.agent, 'kilo')
    assert.strictEqual(parsed.exit_code, 1)
    assert.strictEqual(parsed.timed_out, false)
    assert.ok(parsed.error === null || parsed.error === 'exit code 1')
    assert.ok(parsed.stderr_tail.includes('stderr fail'))
  })

  it('rejects call with nonexistent agent', async () => {
    await assert.rejects(
      () => runAgent('nonexistent', 'test', worktreeCwd, 30, 10),
      /Unknown agent: nonexistent/
    )
  })

  it('rejects non-git cwd', async () => {
    await assert.rejects(
      () => runAgent('kilo', 'test', notGitCwd, 30, 10),
      /is not a git worktree/
    )
  })

  it('rejects main checkout as cwd', async () => {
    await assert.rejects(
      () => runAgent('kilo', 'test', repoCwd, 30, 10),
      /is the main checkout/
    )
  })

  it('detects timeout and returns exit_code -1', async () => {
    const result = await runAgent('kilo', 'SLEEP_9000 test', worktreeCwd, 2, 10)
    const parsed = JSON.parse(result)
    assert.strictEqual(parsed.agent, 'kilo')
    assert.strictEqual(parsed.exit_code, -1)
    assert.strictEqual(parsed.timed_out, true)
    assert.ok(parsed.duration_s <= 12, `duration ${parsed.duration_s}s exceeds timeout+grace`)
  })
})

describe('concurrency limits', () => {
  before(() => {
    process.env.MAX_PARALLEL = '1'
    resetLocks()
  })

  after(() => {
    process.env.MAX_PARALLEL = '3'
  })

  it('rejects when MAX_PARALLEL is exceeded', async () => {
    const slow = runAgent('kilo', 'SLEEP_9000 long', worktreeCwd, 1, 10)
    await new Promise(r => setTimeout(r, 500))

    await assert.rejects(
      () => runAgent('codex', 'test', worktree2Cwd, 10, 10),
      /MAX_PARALLEL/
    )

    await slow.catch(() => {})
  })
})

describe('cwd lock', () => {
  before(() => {
    process.env.MAX_PARALLEL = '3'
    resetLocks()
  })

  after(() => {
    process.env.MAX_PARALLEL = '3'
  })

  it('rejects when same cwd is already used by another agent', async () => {
    const slow = runAgent('kilo', 'SLEEP_9000 lock', worktreeCwd, 1, 10)
    await new Promise(r => setTimeout(r, 500))

    await assert.rejects(
      () => runAgent('codex', 'test', worktreeCwd, 10, 10),
      /already locked/
    )

    await slow.catch(() => {})
  })
})

describe('recursion guard', () => {
  it('refuses to start with AGENT_DISPATCHER_CHILD=1', () => {
    let stderr = ''
    try {
      execSync(`node "${dispatcherPath}"`, {
        encoding: 'utf8',
        env: { ...process.env, AGENT_DISPATCHER_CHILD: '1', PATH: process.env.PATH },
      })
    } catch (err) {
      stderr = err.stderr || ''
    }
    assert.ok(stderr.includes('AGENT_DISPATCHER_CHILD'))
  })
})

describe('tools/list integration', () => {
  it('returns exactly delegate_kilo and delegate_codex', () => {
    const output = execSync(
      `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node "${dispatcherPath}"`,
      { encoding: 'utf8', cwd: __dirname }
    )
    const response = JSON.parse(output.trim().split('\n').pop())
    const names = response.result.tools.map(t => t.name).sort()
    assert.deepStrictEqual(names, ['delegate_codex', 'delegate_kilo'])
  })
})

describe('SIGKILL escalation', () => {
  it('kills trap-ignoring process with SIGKILL and frees slot', async () => {
    resetLocks()
    const result = await runAgent('kilo', 'TRAP_TERM test', worktreeCwd, 2, 10)
    const parsed = JSON.parse(result)
    assert.strictEqual(parsed.agent, 'kilo')
    assert.strictEqual(parsed.exit_code, -1)
    assert.strictEqual(parsed.timed_out, true)
    assert.strictEqual(running, 0)
  })
})

describe('untracked file', () => {
  it('detects untracked file in status_short', async () => {
    await writeFile(join(worktreeCwd, 'newfile.txt'), 'untracked content')
    const result = await runAgent('kilo', 'test', worktreeCwd, 30, 10)
    const parsed = JSON.parse(result)
    assert.ok(parsed.status_short.includes('newfile.txt'))
    await rm(join(worktreeCwd, 'newfile.txt'), { force: true })
  })
})

describe('self-termination', () => {
  it('reports terminated by SIGTERM with timed_out: false and exit_code: -1', async () => {
    const result = await runAgent('kilo', 'SELF_TERM test', worktreeCwd, 30, 10)
    const parsed = JSON.parse(result)
    assert.strictEqual(parsed.agent, 'kilo')
    assert.strictEqual(parsed.exit_code, -1)
    assert.strictEqual(parsed.timed_out, false)
    assert.ok(parsed.error.includes('terminated by SIGTERM'))
  })
})
