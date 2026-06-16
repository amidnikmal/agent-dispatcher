#!/usr/bin/env node
// Супервизор флота внешних агентов (kilo/codex) с watchdog от залипаний.
// Запуск (в фоне): AGENT_DISPATCHER_CHILD= node fleet.mjs
//
// Что делает:
//  - на каждую задачу заводит ОТДЕЛЬНЫЙ git-worktree репозитория GAME (изоляция),
//  - запускает агента (kilocode run / codex-throne exec) со СТРИМОМ stdout/stderr
//    в logs/<id>.log (mtime обновляется по ходу -> видно прогресс),
//  - WATCHDOG: если лог не обновлялся > STALL_SEC (по умолч. 300с=5мин) и процесс
//    жив -> это залипание: kill + ПЕРЕЗАПУСК той же задачи (worktree сохраняет уже
//    закоммиченное -> агент продолжает с места коммита). Лимит рестартов MAX_RESTARTS.
//  - очередь с лимитом параллелизма MAX_PARALLEL (по умолч. 6),
//  - статус флота пишется в logs/fleet-status.json (поллить можно снаружи).
// Все комментарии и отчёты агентов — на РУССКОМ (требование задачи).

import { spawn, spawnSync } from 'child_process'
import { mkdirSync, openSync, writeFileSync, statSync, existsSync, closeSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const DIR = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(DIR, 'logs')
const GAME = '/home/dima/Desktop/GAME'
const WT_ROOT = join(GAME, '.claude', 'fleet-wt')
const STATUS = join(LOG_DIR, 'fleet-status.json')

const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '6', 10)
const STALL_SEC = parseInt(process.env.STALL_SEC || '300', 10)   // 5 минут тишины = залип
const MAX_RESTARTS = parseInt(process.env.MAX_RESTARTS || '3', 10)
const TASK_TIMEOUT_SEC = parseInt(process.env.TASK_TIMEOUT_SEC || '3600', 10)

mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(WT_ROOT, { recursive: true })

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`
  process.stdout.write(line)
}

// Команды агентов — ТОЧНО как в dispatcher.mjs (kilo=deepseek, codex=gpt-5.5 via throne).
function agentCmd(agent, prompt) {
  // --auto OBYAZATELEN: bez nego kilo auto-rejectit dostup k fajlam (external_directory)
  // i vyhodit 0 NICHEGO ne sdelav (no-op). S --auto avtonomno pishet fajly/commitit.
  if (agent === 'kilo') return ['kilocode', ['run', '--auto', '--model', 'deepseek/deepseek-v4-pro', prompt]]
  if (agent === 'codex') return ['codex-throne', ['exec', '--skip-git-repo-check', prompt]]
  throw new Error('unknown agent ' + agent)
}

// ── Цели флота (ревью + работа по ночному плану). Каждая в своём worktree. ──
const RU = 'ВСЕ комментарии, отчёты и сообщения коммитов пиши ТОЛЬКО на русском языке. '
const COMMIT = 'Работай в текущем git-worktree. Делай атомарные git commit по ходу (чтобы прогресс сохранялся при перезапуске). '
const TASKS = [
  {
    id: 'arch-review', agent: 'kilo',
    prompt: RU + COMMIT + 'Сделай РЕВЬЮ АРХИТЕКТУРЫ блоков проекта Godot в godot/scripts (ragdoll/, voxel/, avatar/, net/, meta/, platform/, ui/ и корневые). Оцени связность/связанность модулей, границы ответственности, циклические зависимости, дублирование ответственности между voxel_humanoid/voxel_body/mesh_voxelizer и между ragdoll-стеком и avatar-стеком. Напиши отчёт в godot/docs/reviews/arch-review.md (создай папку). НЕ переписывай код — только отчёт с конкретными файлами/строками и рекомендациями.',
  },
  {
    id: 'tests-dup', agent: 'codex',
    prompt: RU + COMMIT + 'Проанализируй тесты в godot/tests/*.gd на ДУБЛИКАТЫ и пересечения покрытия (одинаковые проверки в разных suite, мёртвые/избыточные кейсы). Запусти прогон `godot --headless --path godot --script res://tests/run_tests.gd` чтобы видеть состав. Напиши отчёт godot/docs/reviews/tests-dup.md: список дублей, что можно объединить/удалить, пробелы покрытия. НЕ удаляй тесты сам — только отчёт.',
  },
  {
    id: 'code-dup', agent: 'kilo',
    prompt: RU + COMMIT + 'Сделай РЕВЬЮ КОДА godot/scripts на ДУБЛИКАТЫ и плохие практики: повторяющиеся куски (спавн осколков, вокселизация, FIFO-пулы, поиск нод), копипаста между demo-скриптами, магические числа, отсутствие проверок null, нарушения стиля. Напиши отчёт godot/docs/reviews/code-dup.md с конкретными файлами/строками и предложениями рефакторинга. НЕ рефактори сам — только отчёт.',
  },
  {
    id: 'comments-ru', agent: 'kilo',
    prompt: RU + COMMIT + 'Пройди по godot/scripts/**/*.gd и приведи ВСЕ комментарии к РУССКОМУ языку (сейчас часть на транслите/англ). Переведи англоязычные и транслитные комментарии в нормальный русский (кириллица), сохраняя смысл; код и идентификаторы НЕ трогай. Делай по файлу за коммит. Это единственная задача, которой РАЗРЕШЕНО менять код (только комментарии).',
  },
  {
    id: 'do-plan', agent: 'kilo',
    prompt: RU + COMMIT + 'Прочитай ночной план и доки: godot/docs/research/REPORT.md, HANDOFF.md, godot/docs/WEB_PLAN.md, godot/docs/PHYS_RAGDOLL_V2.md, PHYS_RAGDOLL_CONTRACT.md. Выбери из них пункты, которые МОЖНО безопасно сделать прямо сейчас НЕ ломая текущую архитектуру (мелкие фичи/доводки/доки/тесты), и реализуй их в этом worktree. НЕ трогай ragdoll/avatar/voxel физику (её делают другие). Каждый сделанный пункт — отдельный коммит. В конце напиши godot/docs/reviews/do-plan-done.md что сделал и что осталось.',
  },
  {
    id: 'research-review', agent: 'kilo',
    prompt: RU + COMMIT + 'Сделай критическое РЕВЬЮ ресёрча: godot/docs/research/REPORT.md, monetization-virality.md, physics-ragdoll.md. Оцени: обоснованность выводов, противоречия, устаревшие/сомнительные цифры, реализуемость рекомендаций в текущем коде, что уже сделано а что нет. Напиши отчёт godot/docs/reviews/research-review.md с конкретными замечаниями и приоритетами. Только отчёт.',
  },
]

const state = {}
for (const t of TASKS) state[t.id] = { agent: t.agent, status: 'queued', pid: null, restarts: 0, exit_code: null, log: join(LOG_DIR, `${t.id}.log`), started_at: null }
const running = new Map()   // id -> {child, logFd, startedMs}
const queue = [...TASKS]

function writeStatus() {
  const snap = { ts: new Date().toISOString(), max_parallel: MAX_PARALLEL, stall_sec: STALL_SEC, tasks: state }
  try { writeFileSync(STATUS, JSON.stringify(snap, null, 2)) } catch {}
}

function ensureWorktree(id) {
  const wt = join(WT_ROOT, id)
  const branch = `fleet/${id}`
  if (existsSync(wt)) return wt
  // -f на случай, если ветка осталась от прошлого запуска; игнорируем ошибку «уже есть».
  const r = spawnSyncSafe('git', ['-C', GAME, 'worktree', 'add', '-f', wt, '-b', branch])
  if (r.code !== 0 && !/already exists|already checked out/.test(r.err)) {
    // ветка уже была — подключим worktree на неё
    spawnSyncSafe('git', ['-C', GAME, 'worktree', 'add', '-f', wt, branch])
  }
  return wt
}

function spawnSyncSafe(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout || '', err: r.stderr || '' }
}

function launch(task) {
  const wt = ensureWorktree(task.id)
  const logFd = openSync(state[task.id].log, 'a')
  const [bin, args] = agentCmd(task.agent, task.prompt)
  writeFileSync(state[task.id].log, `\n===== [${new Date().toISOString()}] ЗАПУСК ${task.id} (${task.agent}) restart#${state[task.id].restarts} cwd=${wt} =====\n`, { flag: 'a' })
  const child = spawn(bin, args, {
    cwd: wt,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },   // AGENT_DISPATCHER_CHILD НЕ ставим — мы не dispatcher
  })
  running.set(task.id, { child, logFd, startedMs: Date.now() })
  state[task.id].status = 'running'
  state[task.id].pid = child.pid
  state[task.id].started_at = new Date().toISOString()
  log(`launch ${task.id} (${task.agent}) pid=${child.pid} wt=${wt}`)
  writeStatus()

  child.on('exit', (code, signal) => {
    running.delete(task.id)
    try { require('fs').closeSync(logFd) } catch {}
    if (state[task.id].status === 'killing') return  // watchdog уже планирует рестарт
    state[task.id].exit_code = code
    state[task.id].status = (code === 0) ? 'done' : 'failed'
    log(`exit ${task.id} code=${code} signal=${signal} -> ${state[task.id].status}`)
    writeStatus()
    pump()
  })
}

function pump() {
  while (running.size < MAX_PARALLEL && queue.length > 0) {
    launch(queue.shift())
  }
  // всё завершено?
  if (running.size === 0 && queue.length === 0) {
    log('=== ФЛОТ ЗАВЕРШЁН ===')
    writeStatus()
  }
}

// WATCHDOG: лог не двигается > STALL_SEC или превышен общий таймаут -> kill + рестарт.
setInterval(() => {
  const now = Date.now()
  for (const [id, r] of [...running.entries()]) {
    let mtime = r.startedMs
    try { mtime = statSync(state[id].log).mtimeMs } catch {}
    const stalledSec = (now - mtime) / 1000
    const ranSec = (now - r.startedMs) / 1000
    const stalled = stalledSec > STALL_SEC
    const overtime = ranSec > TASK_TIMEOUT_SEC
    if (stalled || overtime) {
      const why = stalled ? `тишина ${Math.round(stalledSec)}s>${STALL_SEC}` : `таймаут ${Math.round(ranSec)}s`
      log(`WATCHDOG: ${id} завис (${why}) -> kill+restart#${state[id].restarts + 1}`)
      writeFileSync(state[id].log, `\n!!! [${new Date().toISOString()}] WATCHDOG kill: ${why} !!!\n`, { flag: 'a' })
      state[id].status = 'killing'
      try { r.child.kill('SIGKILL') } catch {}
      running.delete(id)
      if (state[id].restarts < MAX_RESTARTS) {
        state[id].restarts++
        state[id].status = 'restarting'
        const task = TASKS.find((t) => t.id === id)
        setTimeout(() => { launch(task); }, 1500)   // worktree сохраняет коммиты -> продолжит
      } else {
        state[id].status = 'gave_up'
        log(`WATCHDOG: ${id} исчерпал рестарты (${MAX_RESTARTS}) -> сдаюсь`)
        pump()
      }
      writeStatus()
    }
  }
}, 20_000)

log(`=== СТАРТ ФЛОТА: ${TASKS.length} задач, parallel=${MAX_PARALLEL}, stall=${STALL_SEC}s, restarts<=${MAX_RESTARTS} ===`)
pump()
