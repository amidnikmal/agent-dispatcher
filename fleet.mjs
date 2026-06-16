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
const DEEP = 'Это ГЛУБОКИЙ ("адский") ресёрч, НЕ поверхностный. Если есть веб-доступ — ищи и ЦИТИРУЙ источники (ставь URL); если веб-доступа нет — выжимай максимум из знаний + критикуй существующие доки в godot/docs/research/. Будь МАКСИМАЛЬНО КОНКРЕТЕН: точные имена API/SDK, числа, ценовые тиры в ₽, чек-листы, формулы, ссылки. Контекст: воксельный .io-шутер на Godot 4.6, площадки Яндекс.Игры/VK/Telegram, цель автора $1000/мес. Физика (воксель-рэгдолл со смешной смертью) УЖЕ построена — не повторяй её, опирайся как на готовое. Пиши РАЗВЁРНУТО (много разделов). Сначала прочитай godot/docs/research/REPORT.md и оба трек-файла. '
const TASKS = [
  {
    id: 'r-monetization-impl', agent: 'codex',
    prompt: RU + COMMIT + DEEP + 'Тема: РЕАЛИЗАЦИЯ доходной петли (сейчас она только на бумаге). Раскрой ПОДРОБНО: (1) запись "клипа смешной смерти" в Godot 4.6 HTML5-экспорте — что реально доступно (MediaRecorder API canvas.captureStream / WebCodecs / ffmpeg.wasm), ограничения, размер, как отдать на шеринг VK/Telegram; (2) гача-крейты со скинами: pity (soft/hard), раскрытие шансов — требования сторов РФ/площадок, юридические рамки лутбоксов; (3) КОНКРЕТНЫЕ ценовые тиры IAP в ₽ для Яндекс/VK голоса/RuStore/Telegram Stars (курс Stars), что продавать (премиум-валюта/скины/батл-пасс); (4) формула DAU→$ при hybrid-ARPDAU, конверсии. Отчёт: godot/docs/research/monetization-impl.md.',
  },
  {
    id: 'r-go-to-market', agent: 'codex',
    prompt: RU + COMMIT + DEEP + 'Тема: ВЫХОД НА ПЛОЩАДКИ. Раскрой: Яндекс.Игры + VK Mini Apps/Игры + Telegram Mini Apps — требования к HTML5-сборке (вес, SharedArrayBuffer/потоки, COOP/COEP-заголовки, поддержка Godot-экспорта), процесс модерации и типичные стоперы, чек-лист публикации по шагам, ОРГАНИЧЕСКИЙ трафик (рекомендательная лента Яндекса, Card Completion, кросс-промо портфеля, виральные инвайты — что разрешено где), реалистичная кривая роста DAU без бюджета. Отчёт: godot/docs/research/go-to-market.md.',
  },
  {
    id: 'r-tech-web', agent: 'codex',
    prompt: RU + COMMIT + DEEP + 'Тема: ТЕХНИКА web-экспорта Godot 4.6 под РФ-площадки + перф в браузере. Раскрой: реальный вес сборки и как ужать (brotli, single-thread vs threads, что отключить), WebGL2 vs WebGPU в Godot 4.6 на этих площадках, лимиты памяти, перф "мясорубки" (сотни осколков/воксель-рэгдоллы) в браузере — что тормозит и наш пул осколков/MultiMesh, бюджеты кадра под слабый GPU/мобилу, прогрессивная загрузка ассетов. Конкретные настройки export_presets/проекта. Отчёт: godot/docs/research/tech-web.md.',
  },
  {
    id: 'r-genre-retention', agent: 'kilo',
    prompt: RU + COMMIT + DEEP + 'Тема: УДЕРЖАНИЕ и геймплейная петля .io-шутера. Раскрой: тиар-даун конкурента Voxiom.io (режимы, прогрессия, монетизация), что держит игрока (длина сессии, мгновенный вход/TTV, мета-прогрессия, "ещё один матч"), матчмейкинг при МАЛОМ онлайне (боты-наполнители, как у нас), бенчмарки ретеншна D1/D7/D30 для .io/web-РФ, конкретные крючки. Отчёт: godot/docs/research/genre-retention.md.',
  },
  {
    id: 'r-physics-polish', agent: 'kilo',
    prompt: RU + COMMIT + DEEP + 'Тема: СЛЕДУЮЩИЙ УРОВЕНЬ "смешной смерти" для шерабельности (физика уже построена). Раскрой: impact-decals/следы на вокселях, вариативность расчленёнки (по зоне/силе/направлению), kill-cam/слоумо-повтор для клипа, комичный звук (рандом pitch, grunts, slapstick), camera juice сверх текущего, и КАК это кормит виральную петлю (чтобы смерть хотелось шарить). Конкретика по Godot 4.6 (шейдеры decal, GPUParticles, AudioStream). Отчёт: godot/docs/research/physics-polish.md.',
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
