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
    args: (prompt) => ['run', prompt],
  },
  // codex-throne is a VPN wrapper over codex (not a different binary).
  // DO NOT replace 'codex-throne' with 'codex' — doing so will cause
  // 403 errors from api.openai.com when running outside US.
  codex: {
    label: 'Codex',
    bin: 'codex-throne',
    args: (prompt) => ['exec', '--skip-git-repo-check', prompt],
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

  try {
    const branch = await getBranch(cwd)
    const { stdout, stderr } = await spawnP(agent.bin, agent.args(prompt), { cwd, timeoutSec })
    const durationMs = Date.now() - start

    const statusShortPost = await getStatusShort(cwd)
    const diffstatPost = await getDiffstat(cwd)

    await mkdir(LOG_DIR, { recursive: true })
    await writeFile(logFile, [
      `agent: ${agentKey}`,
      `prompt: ${prompt}`,
      `cwd: ${cwd}`,
      `timeout_sec: ${timeoutSec}`,
      `branch: ${branch}`,
      `exit_code: 0`,
      `duration_ms: ${durationMs}`,
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
