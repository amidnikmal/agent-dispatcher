# Fleet / MCP — выводы и HANDOFF (2026-06-16)

Оркестрация внешних агентов (kilo/codex) для проекта `/home/dima/Desktop/GAME` (Godot-игра).

## Что есть
- `dispatcher.mjs` — MCP-сервер: `delegate_kilo`/`delegate_codex`/`delegate_claude`,
  каждый запускает агента в git-worktree, отдаёт JSON-отчёт (branch/diffstat/commit/timed_out/log),
  per-agent таймаут (SIGTERM→SIGKILL). Запуск `node dispatcher.mjs` (через `.mcp.json`). MAX_PARALLEL env.
- Агенты: kilo=`kilocode run … deepseek/deepseek-v4-pro`; codex=`codex-throne exec` (VPN-обёртка
  над codex/gpt-5.5 — НЕ заменять на `codex`: 403 вне US); claude=`claude -p`.
- `fleet.mjs` (добавлен) — супервизор: N задач, у каждой свой worktree GAME, СТРИМ логов в
  `logs/<id>.log`, **watchdog** (тишина >STALL_SEC=5мин → kill+рестарт, cap), статус в
  `logs/fleet-status.json`. `rerun_kilo.mjs` — разовый перезапуск kilo.

## ГЛАВНЫЕ ВЫВОДЫ (грабли + фиксы)
1. **kilo без `--auto` = no-op.** `kilocode run` авто-ОТКЛОНЯЕТ доступ к рабочей папке (под
   `.claude/` → external_directory) и выходит 0, ничего не сделав (лог: `auto-rejecting`).
   Фикс: `kilocode run --auto …`. ИСПРАВЛЕНО в `fleet.mjs`. ⚠️ В `dispatcher.mjs` AGENTS.kilo
   ВСЁ ЕЩЁ без `--auto` — добавить.
2. **exit 0 ≠ сделано.** Проверять реальные коммиты/файлы в worktree, не код возврата. Watchdog
   по тишине НЕ ловит «вышел 0 вхолостую» — нужна пост-проверка diff.
3. **Воркеры — ТОЛЬКО в worktree, НИКОГДА в главном чекауте.** `rerun_kilo.mjs` сделал
   `git checkout` в ГЛАВНОМ чекауте GAME → переключил ветку, правки легли не туда, повредил
   `main` (чинили cherry-pick). Делать: `git -C <repo> worktree add <path> -b <branch>`, cwd=worktree.
4. **Watchdog по mtime работает**, но dispatcher.mjs буферизует stdout (лог пишется в конце,
   прогресс не виден) → для watchdog СТРИМить вывод (как fleet.mjs).
5. codex (gpt-5.5/xhigh) медленный/дорогой; kilo (deepseek) быстрый. ≤6 параллельно (12 ядер) — I/O-bound.

## Прогон флота (6 ревью GAME)
✅ arch-review, code-dup, tests-dup, do-plan — реальные отчёты в ветках `fleet/<id>` репо GAME.
❌ research-review (no-op даже после рестарта). ⚠️ comments-ru (частично; хайджекнул main, п.3).

## TODO
- Добавить `--auto` kilo в `dispatcher.mjs`.
- В fleet/rerun: только worktree, без `git checkout` в главном чекауте (п.3).
- Пост-проверка артефактов после exit 0 (п.2).
- Почему research-review стабильно no-op даже с `--auto`.
