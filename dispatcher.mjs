import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { spawn } from 'child_process'
import { z } from 'zod'
import { fileURLToPath } from 'url'
import { mkdir, writeFile } from 'fs/promises'
import { join, dirname } from 'path'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(DIR, 'logs')
const isMain = process.argv[1] === fileURLToPath(import.meta.url)

if (process.env.AGENT_DISPATCHER_CHILD) {
  process.stderr.write('AGENT_DISPATCHER_CHILD is set; refusing to spawn recursive dispatcher\n')
  process.exit(1)
}

export let running = 0
export const cwdLocks = new Map()
export function resetLocks() {
  running = 0
  cwdLocks.clear()
}

function maxParallel() {
  return parseInt(process.env.MAX_PARALLEL || '3', 10)
}

function timestamp() {
  return new Date().toISOString().replace(/:/g, '-')
}

function elog(message) {
  process.stderr.write(`[dispatcher] ${message}\n`)
}

function execFileP(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else {
        const err = new Error(`exit code ${code}`)
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      }
    })
    child.on('error', reject)
  })
}

async function checkWorktree(cwd) {
  try {
    const { stdout: absDir } = await execFileP('git', ['rev-parse', '--absolute-git-dir'], { cwd })
    const { stdout: commonDir } = await execFileP('git', ['rev-parse', '--git-common-dir'], { cwd })
    const abs = absDir.trim()
    const common = commonDir.trim()
    const commonPath = common.startsWith('/') ? common : join(cwd, common)
    if (abs === commonPath) {
      throw new Error(
        `cwd must be a linked worktree. '${cwd}' is the main checkout.\n` +
        `Create one: git worktree add ../wt-<task> -b <task>`
      )
    }
    return true
  } catch (err) {
    if (err.message.includes('cwd must be a linked worktree')) throw err
    throw new Error(
      `cwd '${cwd}' is not a git worktree.\n` +
      `Create one: git worktree add ../wt-<task> -b <task>`
    )
  }
}

async function getBranch(cwd) {
  try {
    const { stdout } = await execFileP('git', ['branch', '--show-current'], { cwd })
    return stdout.trim()
  } catch {
    return '(unknown)'
  }
}

async function getStatusShort(cwd) {
  try {
    const { stdout } = await execFileP('git', ['status', '--short'], { cwd })
    return stdout.trim() || '(clean)'
  } catch {
    return '(error)'
  }
}

async function getDiffstat(cwd) {
  try {
    const { stdout } = await execFileP('git', ['diff', 'HEAD', '--stat'], { cwd })
    return stdout.trim() || '(no changes)'
  } catch {
    return '(no changes)'
  }
}

// Resolve the current HEAD sha so we can detect commits the agent makes during
// its run. Agents that `git commit` leave a CLEAN working tree, so
// getStatusShort/getDiffstat alone read as "(clean)"/"(no changes)" and look
// like the agent did nothing — these helpers surface the committed work.
async function getHead(cwd) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd })
    return stdout.trim()
  } catch {
    return null
  }
}

// Reports what the agent committed since `baseSha`: commit count, the new
// commit subjects, and a diffstat of base..HEAD. Returns nulls when nothing
// was committed (or HEAD is unavailable), so the orchestrator can tell apart
// "committed and cleaned up" from "did nothing".
async function getCommitsSince(cwd, baseSha) {
  if (!baseSha) return { committed: 0, commit_log: null, committed_diffstat: null }
  try {
    const range = `${baseSha}..HEAD`
    const { stdout: countOut } = await execFileP('git', ['rev-list', '--count', range], { cwd })
    const committed = parseInt(countOut.trim(), 10) || 0
    if (committed === 0) return { committed: 0, commit_log: null, committed_diffstat: null }
    const { stdout: logOut } = await execFileP('git', ['log', '--oneline', range], { cwd })
    const { stdout: statOut } = await execFileP('git', ['diff', range, '--stat'], { cwd })
    return {
      committed,
      commit_log: logOut.trim() || null,
      committed_diffstat: statOut.trim() || null,
    }
  } catch {
    return { committed: 0, commit_log: null, committed_diffstat: null }
  }
}

function spawnP(bin, args, { cwd, timeoutSec }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_DISPATCHER_CHILD: '1' },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let closed = false

    const killTimer = setTimeout(() => {
      timedOut = true
      elog(`SIGTERM → ${bin} (pid ${child.pid}) after ${timeoutSec}s`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!closed) {
          elog(`SIGKILL → ${bin} (pid ${child.pid}) after ${timeoutSec + 10}s`)
          child.kill('SIGKILL')
        }
      }, 10_000)
    }, timeoutSec * 1000)

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code, signal) => {
      closed = true
      clearTimeout(killTimer)
      if (timedOut) {
        const err = new Error('timeout')
        err.killed = true
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else if (signal) {
        const err = new Error(`terminated by ${signal}`)
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      } else if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const err = new Error(`exit code ${code}`)
        err.stdout = stdout
        err.stderr = stderr
        reject(err)
      }
    })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
  })
}

export function tail(str, lines) {
  const arr = str.split('\n')
  const start = Math.max(0, arr.length - lines)
  return arr.slice(start).join('\n')
}

export const paramsSchema = {
  prompt: z.string().describe("The task for the agent to execute, e.g. 'write unit tests for src/auth.ts'"),
  cwd: z.string().describe("Absolute path of the git worktree where the agent will work"),
  timeout_sec: z.number().int().min(1).max(7200).default(1800)
    .describe('Timeout in seconds. Default 1800 (30 min), max 7200 (2 hours)'),
  log_tail_lines: z.number().int().min(1).max(500).default(60)
    .describe('Number of last lines of stdout/stderr to return in the JSON response'),
}

export const AGENTS = {
  kilo: {
    label: 'Kilo',
    bin: 'kilocode',
    args: (prompt) => ['run', '--model', 'deepseek/deepseek-v4-pro', prompt],
  },
  // codex-throne is a VPN wrapper over codex (not a different binary).
  // DO NOT replace 'codex-throne' with 'codex' — doing so will cause
  // 403 errors from api.openai.com when running outside US.
  codex: {
    label: 'Codex',
    bin: 'codex-throne',
    args: (prompt) => ['exec', '--skip-git-repo-check', prompt],
  },
  // A separate Claude Code instance as a peer delegate. -p runs headless;
  // bypassPermissions gives it the same autonomy as kilo/codex (it must edit
  // files, run builds/tests and `git commit` in its worktree). This is required
  // because spawnP closes stdin — any interactive permission prompt would
  // otherwise hang until the timeout. Recursion is prevented by the
  // AGENT_DISPATCHER_CHILD guard at the top of this file: a delegated Claude
  // cannot start another agent-dispatcher server.
  claude: {
    label: 'Claude',
    bin: 'claude',
    args: (prompt) => ['-p', prompt, '--permission-mode', 'bypassPermissions'],
  },
}

function buildToolDescription(label, bin) {
  return `Delegate a task to ${label} (${bin}). The agent works in a git worktree ` +
    `and returns a JSON report with branch, diffstat, and log tails. ` +
    `The orchestrator reviews the diff to accept/reject changes.`
}

export async function runAgent(agentKey, prompt, cwd, timeoutSec, logTailLines) {
  const agent = AGENTS[agentKey]
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`)

  await checkWorktree(cwd)

  if (cwdLocks.has(cwd)) {
    throw new Error(`cwd '${cwd}' is already locked by another running agent`)
  }

  if (running >= maxParallel()) {
    throw new Error(`MAX_PARALLEL (${maxParallel()}) reached. Try again later.`)
  }

  running++
  const lockKey = cwd
  cwdLocks.set(lockKey, true)

  const ts = timestamp()
  const logFile = join(LOG_DIR, `${agentKey}-${ts}.log`)
  const start = Date.now()

  // Snapshot HEAD before the run so committed work is visible afterwards even
  // when the working tree is clean (see getCommitsSince).
  const headBefore = await getHead(cwd)

  try {
    const branch = await getBranch(cwd)
    const { stdout, stderr } = await spawnP(agent.bin, agent.args(prompt), { cwd, timeoutSec })
    const durationMs = Date.now() - start

    const statusShortPost = await getStatusShort(cwd)
    const diffstatPost = await getDiffstat(cwd)
    const commits = await getCommitsSince(cwd, headBefore)

    await mkdir(LOG_DIR, { recursive: true })
    await writeFile(logFile, [
      `agent: ${agentKey}`,
      `prompt: ${prompt}`,
      `cwd: ${cwd}`,
      `timeout_sec: ${timeoutSec}`,
      `branch: ${branch}`,
      `exit_code: 0`,
      `duration_ms: ${durationMs}`,
      `committed: ${commits.committed}`,
      `commit_log: ${commits.commit_log || '(none)'}`,
      `--- stdout ---`,
      stdout || '(empty)',
      `--- stderr ---`,
      stderr || '(empty)',
    ].join('\n'), 'utf8')

    return JSON.stringify({
      agent: agentKey,
      exit_code: 0,
      duration_s: Math.round(durationMs / 100) / 10,
      branch,
      status_short: statusShortPost,
      diffstat: diffstatPost,
      committed: commits.committed,
      commit_log: commits.commit_log,
      committed_diffstat: commits.committed_diffstat,
      log_path: logFile,
      timed_out: false,
      error: null,
      stdout_tail: tail(stdout, logTailLines),
      stderr_tail: tail(stderr, logTailLines),
    })
  } catch (err) {
    const duration_s = Math.round((Date.now() - start) / 100) / 10

    let exitCode = -1
    let timedOut = false
    let errorMessage = null

    if (err.killed) {
      timedOut = true
    } else if (err.message && err.message.startsWith('exit code ')) {
      exitCode = parseInt(err.message.split(' ')[2], 10)
    } else {
      errorMessage = err.message
    }

    const stdout = err.stdout || ''
    const stderr = err.stderr || ''
    const branch = await getBranch(cwd)
    const statusShortPost = await getStatusShort(cwd)
    const diffstatPost = await getDiffstat(cwd)
    // Even on timeout/error the agent may have committed partial work.
    const commits = await getCommitsSince(cwd, headBefore)

    await mkdir(LOG_DIR, { recursive: true })
    await writeFile(logFile, [
      `agent: ${agentKey}`,
      `prompt: ${prompt}`,
      `cwd: ${cwd}`,
      `timeout_sec: ${timeoutSec}`,
      `branch: ${branch}`,
      `exit_code: ${timedOut ? 'timeout' : exitCode}`,
      `timed_out: ${timedOut}`,
      `error: ${errorMessage}`,
      `committed: ${commits.committed}`,
      `commit_log: ${commits.commit_log || '(none)'}`,
      `--- stdout ---`,
      stdout || '(empty)',
      `--- stderr ---`,
      stderr || '(empty)',
    ].join('\n'), 'utf8')

    return JSON.stringify({
      agent: agentKey,
      exit_code: timedOut ? -1 : exitCode,
      duration_s,
      branch,
      status_short: statusShortPost,
      diffstat: diffstatPost,
      committed: commits.committed,
      commit_log: commits.commit_log,
      committed_diffstat: commits.committed_diffstat,
      log_path: logFile,
      timed_out: timedOut,
      error: errorMessage,
      stdout_tail: tail(stdout, logTailLines),
      stderr_tail: tail(stderr, logTailLines),
    })
  } finally {
    running--
    cwdLocks.delete(lockKey)
  }
}

const server = new McpServer({
  name: 'agent-dispatcher',
  version: '2.0.0',
})

for (const [key, agent] of Object.entries(AGENTS)) {
  server.tool(
    `delegate_${key}`,
    buildToolDescription(agent.label, agent.bin),
    paramsSchema,
    async ({ prompt, cwd, timeout_sec, log_tail_lines }) => {
      try {
        const result = await runAgent(key, prompt, cwd, timeout_sec, log_tail_lines)
        return { content: [{ type: 'text', text: result }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `[ERROR] ${err.message}` }], isError: true }
      }
    }
  )
}

if (isMain) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
