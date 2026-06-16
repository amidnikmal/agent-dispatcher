#!/usr/bin/env node
// Перезапуск 5 no-op kilo-задач флота С ФЛАГОМ --auto (без него kilo авто-реджектил
// доступ к файлам и выходил 0 вхолостую). Watchdog: тишина в логе > STALL_SEC -> kill+
// рестарт (cap MAX_RESTARTS). По завершении — сводка (коммиты+артефакты) в rerun-result.txt.
import { spawn } from 'child_process'
import { openSync, statSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { spawnSync } from 'child_process'

const GAME = '/home/dima/Desktop/GAME'
const WT = (id) => `${GAME}/.claude/fleet-wt/${id}`
const LOG = (id) => `/home/dima/Desktop/orchestration/logs/${id}.log`
const RESULT = '/home/dima/Desktop/orchestration/logs/rerun-result.txt'
const STALL_SEC = 300, MAX_RESTARTS = 2, HARD_SEC = 1500

const RU = 'ВСЕ комментарии/отчёты/коммиты — на РУССКОМ. По завершении ОБЯЗАТЕЛЬНО: git add -A && git commit. '
const TASKS = [
  { id: 'arch-review', prompt: RU + 'Сделай ревью архитектуры godot/scripts (ragdoll/ voxel/ avatar/ net/ meta/ platform/ ui/). СОЗДАЙ файл godot/docs/reviews/arch-review.md: связность модулей, дублирование ответственности (voxel_humanoid vs voxel_body vs mesh_voxelizer; ragdoll-стек vs avatar-стек), цикл. зависимости, рекомендации с файлами/строками. Код НЕ меняй, только отчёт + commit.' },
  { id: 'code-dup', prompt: RU + 'Ревью кода godot/scripts на ДУБЛИКАТЫ и плохие практики (копипаста спавна осколков/вокселизации/FIFO-пулов/поиска нод, магические числа, нет null-проверок). СОЗДАЙ godot/docs/reviews/code-dup.md с файлами/строками и предложениями рефакторинга. Код НЕ меняй, только отчёт + commit.' },
  { id: 'comments-ru', prompt: RU + 'Переведи ВСЕ комментарии в godot/scripts/**/*.gd на русский (кириллица), где сейчас англ/транслит; смысл сохрани, КОД И ИДЕНТИФИКАТОРЫ НЕ ТРОГАЙ. Это единственная задача, которой можно менять файлы (только комментарии). Коммить пачками по мере прохода.' },
  { id: 'do-plan', prompt: RU + 'Прочитай godot/docs/research/REPORT.md, HANDOFF.md, godot/docs/WEB_PLAN.md, PHYS_RAGDOLL_V2.md. Выбери 1-3 МЕЛКИХ безопасных пункта (доки/мелкие тесты/утилиты), НЕ трогая физику ragdoll/avatar/voxel и не ломая архитектуру, и реализуй. СОЗДАЙ godot/docs/reviews/do-plan-done.md (что сделал/осталось). Каждый пункт — отдельный commit.' },
  { id: 'research-review', prompt: RU + 'Критическое ревью godot/docs/research/REPORT.md, monetization-virality.md, physics-ragdoll.md: обоснованность выводов, противоречия, устаревшие цифры, реализуемость в текущем коде, что уже сделано а что нет. СОЗДАЙ godot/docs/reviews/research-review.md с приоритетами. Только отчёт + commit.' },
]

const st = {}
for (const t of TASKS) st[t.id] = { restarts: 0, status: 'queued', headBefore: head(t.id) }
const running = new Map()

function head(id) { const r = spawnSync('git', ['-C', WT(id), 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return (r.stdout || '').trim() }
function commitsSince(id) {
  const b = st[id].headBefore
  if (!b) return '(?)'
  const r = spawnSync('git', ['-C', WT(id), 'log', '--oneline', `${b}..HEAD`], { encoding: 'utf8' })
  return (r.stdout || '').trim() || '(нет коммитов)'
}

function launch(t) {
  const fd = openSync(LOG(t.id), 'a')
  appendFileSync(LOG(t.id), `\n===== [${new Date().toISOString()}] RERUN --auto ${t.id} (restart#${st[t.id].restarts}) =====\n`)
  const child = spawn('kilocode', ['run', '--auto', '--model', 'deepseek/deepseek-v4-pro', t.prompt],
    { cwd: WT(t.id), stdio: ['ignore', fd, fd], env: { ...process.env } })
  running.set(t.id, { child, startedMs: Date.now() })
  st[t.id].status = 'running'
  console.log(`launch ${t.id} pid=${child.pid}`)
  child.on('exit', (code) => {
    running.delete(t.id)
    if (st[t.id].status === 'killing') return
    st[t.id].status = code === 0 ? 'done' : `exit${code}`
    console.log(`exit ${t.id} code=${code}`)
    if (running.size === 0 && [...Object.values(st)].every((s) => s.status !== 'running' && s.status !== 'killing')) finish()
  })
}

function finish() {
  const lines = ['=== RERUN ИТОГ ===']
  for (const t of TASKS) {
    const artifact = t.id === 'comments-ru'
      ? `(перевод комментариев)`
      : (existsSync(`${WT(t.id)}/godot/docs/reviews/${t.id === 'do-plan' ? 'do-plan-done' : t.id}.md`) ? 'отчёт СОЗДАН' : 'отчёт ОТСУТСТВУЕТ')
    lines.push(`${t.id}: status=${st[t.id].status} restarts=${st[t.id].restarts} | ${artifact}`)
    lines.push(`  commits: ${commitsSince(t.id).replace(/\n/g, '\n  ')}`)
  }
  lines.push('RERUN COMPLETE')
  const out = lines.join('\n')
  writeFileSync(RESULT, out)
  console.log(out)
  process.exit(0)
}

setInterval(() => {
  const now = Date.now()
  for (const [id, r] of [...running.entries()]) {
    let mt = r.startedMs
    try { mt = statSync(LOG(id)).mtimeMs } catch {}
    const stall = (now - mt) / 1000 > STALL_SEC
    const over = (now - r.startedMs) / 1000 > HARD_SEC
    if (stall || over) {
      console.log(`WATCHDOG ${id}: ${stall ? 'тишина' : 'таймаут'} -> kill`)
      appendFileSync(LOG(id), `\n!!! WATCHDOG kill (${stall ? 'тишина>300с' : 'таймаут'}) !!!\n`)
      st[id].status = 'killing'
      try { r.child.kill('SIGKILL') } catch {}
      running.delete(id)
      if (st[id].restarts < MAX_RESTARTS) { st[id].restarts++; const t = TASKS.find((x) => x.id === id); setTimeout(() => launch(t), 1000) }
      else { st[id].status = 'gave_up'; if (running.size === 0) finish() }
    }
  }
}, 20_000)

console.log(`=== RERUN START: ${TASKS.length} kilo-задач с --auto ===`)
for (const t of TASKS) launch(t)
