# Agent Dispatcher — MCP-диспетчер для оркестрации AI-агентов

MCP-сервер для делегирования задач CLI-агентам (Kilo, Codex). Принимает tool-call
от оркестратора (Claude Code), запускает агента в git worktree и возвращает
структурированный JSON-отчёт.

## Как это работает

```
Оркестратор (Claude Code)
   │  MCP tool call: delegate_kilo({ prompt, cwd, ... })
   ▼
dispatch.mjs
   │  spawn("kilocode", ["run", prompt])
   │  spawn("codex-throne", ["exec", "--skip-git-repo-check", prompt])
   ▼
JSON-отчёт: { agent, exit_code, duration_s, branch, diffstat, log_path, ... }
```

## Доступные тулзы

| Тулз | CLI | Команда |
|---|---|---|
| `delegate_kilo` | `kilocode` | `kilocode run "<prompt>"` |
| `delegate_codex` | `codex-throne` | `codex-throne exec --skip-git-repo-check "<prompt>"` |

Оба принимают одинаковые параметры:

| Параметр | Тип | Описание |
|---|---|---|
| `prompt` | string | Задача для агента |
| `cwd` | string | Абсолютный путь к git worktree (обязательно worktree, не main) |
| `timeout_sec` | number | Таймаут (default 1800, max 7200) |
| `log_tail_lines` | number | Сколько последних строк логов вернуть (default 60) |

### Ответ

```json
{
  "agent": "kilo",
  "exit_code": 0,
  "duration_s": 12.3,
  "branch": "wt-my-task",
  "status_short": " M src/auth.ts\n?? newfile.txt",
  "diffstat": "src/auth.ts | 42 ++++\n1 file changed, 42 insertions(+)",
  "log_path": "/path/to/orchestration/logs/kilo-2026-06-11T12-00-00.000Z.log",
  "timed_out": false,
  "error": null,
  "stdout_tail": "...",
  "stderr_tail": "..."
}
```

## Ограничения

- **Worktree**: `cwd` обязан быть linked git worktree. `git rev-parse --absolute-git-dir` ≠ `--git-common-dir`.
- **Параллелизм**: `MAX_PARALLEL=3` (env). Lock по cwd.
- **Рекурсия**: `AGENT_DISPATCHER_CHILD=1` запрещает запуск диспетчера внутри агента.
- **Таймаут**: SIGTERM через `timeout_sec`, +10 сек → SIGKILL.

## Структура проекта

```
orchestration/
├── dispatcher.mjs          # MCP-сервер
├── dispatcher.test.mjs     # Тесты (node:test, PATH-фикстуры)
├── package.json            # deps: @modelcontextprotocol/sdk, zod
├── .mcp.json               # MCP-конфиг для Claude Code
├── CLAUDE.md               # Протокол оркестратора для Claude Code
├── logs/                   # Логи агентов
├── .gitignore
└── README.md
```

## Установка

```bash
git clone <repo-url> orchestration
cd orchestration
npm install
```

### Codex: VPN-обёртка

Codex требует прокси (VPN) для доступа к API OpenAI. Используется обёртка
`codex-throne`, которая устанавливается из
`/home/dima/Downloads/codex-throne-artifact/scripts/wrappers/`:

```bash
cd /home/dima/Downloads/codex-throne-artifact/scripts/wrappers
./install-codex-throne.sh    # → ~/.local/bin/codex-throne
```

### Подключение к Claude Code

`.mcp.json` уже в корне проекта. Claude Code подхватывает его автоматически.

**Важно:** путь до `dispatcher.mjs` в `.mcp.json` должен быть абсолютным.

## Проверка

```bash
node --check dispatcher.mjs     # синтаксис
node --test                      # тесты
```

Ручной вызов:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dispatcher.mjs
```

## Добавление нового агента

Добавить в `AGENTS` в `dispatcher.mjs`:

```js
tool_name: {
  label: 'Tool',
  bin: 'cli-binary',
  args: (prompt) => ['--flag', prompt],
},
```

Тулз `delegate_tool_name` появится автоматически.

## Troubleshooting

### Codex: ошибка 403 от api.openai.com

Проблема решена VPN-обёрткой `codex-throne`. НЕ заменяйте `codex-throne` на `codex` —
использование голого бинарника `codex` из РФ приведёт к 403 Forbidden от OpenAI API.

`codex-throne` автоматически устанавливает `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:2080`
и проксирует запросы через VPN-туннель.
