# Хэндоф: Agent Dispatcher v2.0

## Что это

MCP-сервер (stdio) для оркестрации CLI-агентов. Один агент-оркестратор (Claude Code или Kilo) вызывает тулзы диспетчера, делегируя задачи агентам-исполнителям (Kilo, Codex) в изолированных git worktree.

## Архитектура

```
Оркестратор (Claude Code / Kilo)
  │ MCP tool call: delegate_kilo({ prompt, cwd, timeout_sec, log_tail_lines })
  ▼
dispatcher.mjs (этот проект, v2.0.0)
  ├── checkWorktree(cwd)       # проверка: cwd обязан быть linked worktree
  ├── maxParallel()             # контроль: MAX_PARALLEL=3 (env), lock по cwd
  ├── spawnP(bin, args, opts)  # запуск: timeoutSec → SIGTERM → 10s → SIGKILL
  ├── getBranch(cwd)            # ветка worktree
  ├── getDiffstat(cwd)          # git diff --stat после выполнения
  └── JSON-отчёт                # логи пишутся в logs/<agent>-<ISO>.log
```

## Тулзы (MCP tools)

| Тулз | CLI | Команда |
|---|---|---|
| `delegate_kilo` | `kilocode` | `kilocode run "<prompt>"` |
| `delegate_codex` | `codex-throne` | `codex-throne exec --skip-git-repo-check "<prompt>"` |

Параметры:

| Параметр | Тип | По умолчанию | Описание |
|---|---|---|---|
| `prompt` | string (обяз.) | — | Задача для агента |
| `cwd` | string (обяз.) | — | Абсолютный путь к linked git worktree |
| `timeout_sec` | number | 1800 (30 мин) | Таймаут, max 7200 (2 часа) |
| `log_tail_lines` | number | 60 | Последние строки stdout/stderr в ответе |

## Ответ (JSON)

```json
{
  "agent": "kilo",
  "exit_code": 0,
  "duration_s": 12.3,
  "branch": "wt-my-task",
  "diffstat": "src/auth.ts | 42 ++++",
  "log_path": "/path/to/orchestration/logs/kilo-2026-06-11T12-00-00.000Z.log",
  "stdout_tail": "...",
  "stderr_tail": "..."
}
```

При таймауте: `exit_code: -1`, `duration_s: timeoutSec`.
При ошибке агента: `exit_code: код агента`, `stderr_tail` содержит диагностику.

## Ограничения (обязательные, неотключаемые)

1. **Worktree**: `cwd` обязан быть linked git worktree. Проверка: `git rev-parse --absolute-git-dir` ≠ `resolve(git rev-parse --git-common-dir)`. Если cwd — не git-репозиторий или main checkout — отказ с подсказкой `git worktree add`.
2. **Рекурсия**: `AGENT_DISPATCHER_CHILD=1` передаётся в каждый порождённый процесс. Сам диспетчер отказывается стартовать при этом флаге.
3. **Параллелизм**: `MAX_PARALLEL=3` (env), превышение — отказ. Lock по cwd: два агента не могут работать в одном worktree одновременно.
4. **Таймаут**: SIGTERM после `timeout_sec` секунд, ещё через 10 секунд — SIGKILL. Процесс гарантированно уничтожается.

## Codex и VPN

Codex требует прокси для доступа к OpenAI API (403 из РФ). Используется обёртка `codex-throne` из `/home/dima/Downloads/codex-throne-artifact/scripts/wrappers/`. Обёртка:

1. Устанавливает `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:2080`
2. Находит реальный бинарник codex (не snap)
3. `exec "$CODEX_BIN" "$@"`

Установка: `./install-codex-throne.sh` → `~/.local/bin/codex-throne`.

Kilo: VPN не требуется (работает через DeepSeek).

## Конфигурация

### Локальная (проект)

`.mcp.json` — подхватывается Claude Code автоматически из корня проекта. Больше не нужно править `~/.claude/settings.json`.

`kilo.json` — MCP-конфиг для Kilo, уже в корне проекта.

### Глобальная

Claude Code: `~/.claude/settings.json` — секция `mcpServers` УДАЛЕНА. Используется локальный `.mcp.json`.
Kilo: `~/.config/kilo/kilo.json` — при необходимости скопировать секцию `mcp` из `kilo.json`.

## Тестирование

```bash
npm install              # @modelcontextprotocol/sdk
node --check dispatcher.mjs    # проверка синтаксиса
node --test              # 20 тестов
```

### Структура тестов

| Группа | Кол-во | Что проверяет |
|---|---|---|
| AGENTS registry | 5 | 2 тулза (kilo, codex), codex-throne, аргументы |
| tail() helper | 3 | Корректная нарезка хвоста |
| paramsSchema | 4 | Параметры и Zod-валидация (defaults, max) |
| runAgent | 6 | Успех в worktree, ошибка агента, несуществующий агент, не-git cwd, main checkout, таймаут |
| concurrency limits | 1 | MAX_PARALLEL=1 → отказ при втором вызове |
| cwd lock | 1 | Блокировка cwd при параллельном вызове |

Все тесты используют PATH-фикстуры: в `before()` создаются временные скрипты `kilocode` и `codex-throne`, временный git-репозиторий с двумя worktree. После всех тестов директория удаляется.

Фейковые скрипты управляются ключевыми словами в prompt:
- `SLEEP_9000` — порождает `exec sleep 9000` (для тестов таймаута/блокировок)
- `FAIL_1` / `FAIL_2` — эмулируют ошибку агента

`exec` в скриптах нужен, чтобы сигнал SIGTERM от Node.js доходил напрямую до `sleep`, минуя bash.

### Покрытие

- ✅ Успешный запуск агента в worktree
- ✅ JSON-ответ (все поля)
- ✅ Ошибка агента (exit_code ≠ 0)
- ✅ Таймаут (SIGTERM → exit_code: -1)
- ✅ Неизвестный агент
- ✅ Не-git директория (отказ с подсказкой)
- ✅ Main checkout (отказ с подсказкой)
- ✅ MAX_PARALLEL превышен
- ✅ Блокировка cwd
- ✅ Защита от рекурсии (AGENT_DISPATCHER_CHILD)

## Структура проекта

```
orchestration/
├── dispatcher.mjs          # Ядро (319 строк, ESM, без зависимостей кроме MCP SDK)
├── dispatcher.test.mjs     # 20 тестов (node:test)
├── package.json            # type: module, dep: @modelcontextprotocol/sdk
├── package-lock.json
├── kilo.json               # MCP-конфиг для Kilo
├── .mcp.json               # MCP-конфиг для Claude Code (локальный)
├── CLAUDE.md               # Инструкции для Claude Code
├── README.md               # Документация на русском
├── logs/                   # Логи агентов (игнорируются git-ом)
└── .gitignore
```

## Ключевые решения

1. **Stdio, не HTTP** — не занимает порт, проще для Claude Code.
2. **Только worktree** — изоляция, невозможность испортить main checkout.
3. **JSON вместо текста** — оркестратор может парсить ответ и принимать решения программно.
4. **Логи на диск** — `logs/<agent>-ISO.log`, не теряются между вызовами.
5. **Без DI** — `runAgent` не принимает `_spawn`, тесты идут через PATH-фикстуры.
6. **`codex-throne`, не `codex`** — VPN-прокси прозрачно для диспетчера.
7. **`MAX_PARALLEL` динамический** — читает `process.env` на каждый вызов для тестирования.
8. **`running`/`cwdLocks` экспортированы** — `resetLocks()` для изоляции тестов.
9. **Сигналы через `exec`** — тестовые фикстуры используют `exec sleep`, чтобы SIGTERM доходил напрямую.

## Известные ограничения

1. Codex требует работающий VPN-прокси на `127.0.0.1:2080`.
2. Нет очереди при превышении `MAX_PARALLEL` — нужно пробовать позже.
3. Диспетчер сам не создаёт и не удаляет worktree — это задача оркестратора.
4. Таймаут считает время от запуска процесса, а не от последнего вывода.
5. `diffstat` снимается после завершения агента — если агент сделал изменения и откатил их, diffstat будет пустым.

## Как расширить

Добавить нового агента в `AGENTS` → тулз `delegate_<key>` появится автоматически:

```js
// dispatcher.mjs
export const AGENTS = {
  // ...
  mytool: {
    label: 'MyTool',
    bin: 'my-cli',
    args: (prompt) => ['--run', prompt],
  },
}
```

Требования к CLI:
- Принимает prompt как аргумент
- Неинтерактивный режим (без TTY)
- Не ждёт stdin (передаётся `/dev/null`)
- Пишет результат в stdout
