# Agent Dispatcher — MCP-диспетчер для оркестрации AI-агентов

MCP-сервер, который позволяет одному AI-агенту (Claude Code, Kilo, Codex) делегировать
задачи другим агентам. Работает как хаб: принимает tool-call от ассистента-оркестратора,
запускает целевой CLI и возвращает результат обратно.

## Как это работает

```
┌──────────────────────────────────────────────────────┐
│  Оркестратор (Claude Code / Kilo / Codex)            │
│                                                      │
│  «Напиши тесты для src/auth.ts»                      │
│     │                                                │
│     ▼  MCP tool call                                 │
│  delegate_kilo({ prompt, cwd })                      │
│     │                                                │
│     ▼                                                │
│  ┌─────────────────────────────────┐                 │
│  │  dispatcher.mjs (этот проект)   │                 │
│  │                                 │                 │
│  │  spawn("kilocode", ["run", ...])│                 │
│  │  spawn("codex",    ["exec", ...])│                │
│  │  spawn("claude",   ["-p", ...]) │                 │
│  └──────────────┬──────────────────┘                 │
│     │                                                │
│     ▼  stdout + stderr                               │
│  Возврат результата оркестратору                     │
└──────────────────────────────────────────────────────┘
```

Оркестратор «видит» три тулза (`delegate_kilo`, `delegate_codex`, `delegate_claude`)
и вызывает их точно так же, как любые другие MCP-инструменты.

## Доступные тулзы

| Тулз | Команда | Флаги |
|---|---|---|
| `delegate_kilo` | `kilocode run "<prompt>"` | — |
| `delegate_codex` | `codex exec "<prompt>"` | `--skip-git-repo-check` |
| `delegate_claude` | `claude -p "<prompt>"` | `--dangerously-skip-permissions` |

Все три принимают одинаковые параметры:
- `prompt` (string, обязательный) — задача для агента
- `cwd` (string, опциональный) — рабочая директория (по умолчанию — CWD процесса)

Таймаут выполнения — 5 минут. Буфер вывода — без ограничений (стримится).

## Структура проекта

```
orchestration/
├── dispatcher.mjs    # MCP-сервер (основной файл)
├── package.json      # Зависимости (только @modelcontextprotocol/sdk)
├── kilo.json         # MCP-конфиг для Kilo
├── .gitignore
└── README.md         # Этот файл
```

Настройка для Claude Code — в отдельном файле `~/.claude/settings.json` (см. ниже).

---

## Установка

### 1. Клонирование и зависимости

```bash
git clone <repo-url> orchestration
cd orchestration
npm install
```

### 2. Подключение к Kilo

Файл `kilo.json` уже лежит в корне проекта. Kilo автоматически подхватывает его
при запуске из этой директории (или любой дочерней). Если нужно глобально —
скопируй секцию `mcp` в глобальный `~/.config/kilo/kilo.json`.

Проверка:
```bash
kilocode mcp list
# Должен появиться agent-dispatcher
```

### 3. Подключение к Claude Code

Добавь в `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agent-dispatcher": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/orchestration/dispatcher.mjs"]
    }
  }
}
```

**Важно:** путь до `dispatcher.mjs` должен быть абсолютным. Замени
`/absolute/path/to/orchestration` на реальный путь (например,
`/home/dima/Desktop/orchestration/dispatcher.mjs`).

После добавления — перезапусти Claude Code.

### 4. Подключение к Codex

Codex пока не поддерживает внешние MCP-серверы в конфиге напрямую.
Варианты обхода:
- Запустить Codex как MCP-сервер (`codex mcp-server`) и подключить его к Kilo/Claude
  как один из инструментов диспетчера (а не как оркестратора)
- Использовать диспетчер из Kilo или Claude Code для вызова `delegate_codex`

---

## Использование

### В Claude Code

Просто попроси Клода делегировать задачу — он сам вызовет нужный тулз:

> Напиши unit-тесты для src/auth.ts. Используй delegate_kilo.

Или явно:

> Вызови delegate_codex с задачей «отрефактори src/database.ts, разбей на модули».

### В Kilo

Аналогично — Kilo видит тулзы и сам решает, когда их вызывать:

> Проверь код проекта, делегируй тестирование через delegate_codex.

### В Codex (как подчинённый агент)

Codex запускается через `delegate_codex` из Kilo или Claude Code:

```
delegate_codex({
  prompt: "напиши миграцию для добавления таблицы users",
  cwd: "/home/dima/my-project"
})
```

---

## Ручная проверка

Отправь JSON-RPC запрос через stdin:

```bash
# Список тулзов
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dispatcher.mjs

# Вызов агента
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delegate_kilo","arguments":{"prompt":"say hello"}}}' \
  | node dispatcher.mjs
```

---

## Диагностика

### Агент не отвечает / ошибка аутентификации

**Claude Code** — ошибка `403 Request not allowed`:
```bash
claude login          # перелогиниться
claude -p "test" < /dev/null   # проверить неинтерактивный режим
```

**Codex** — ошибка `403 Forbidden`:
```bash
codex login                    # перелогиниться
codex exec "test"              # проверить неинтерактивный режим
```
Причина чаще всего — IP-блокировка (VPN, геолокация) или просроченный
OAuth-токен.

**Kilo** — должен работать из коробки, если настроен хотя бы один провайдер.
```bash
kilocode run "test"            # проверить
```

### Таймаут (5 минут)

Если агент не успел ответить за 5 минут — диспетчер возвращает
`[TIMEOUT]`. При необходимости увеличь таймаут в `dispatcher.mjs`:
строка `timeout: 300_000` (миллисекунды).

### Не появляются тулзы в Claude Code

1. Проверь, что путь до `dispatcher.mjs` абсолютный и файл существует
2. Проверь синтаксис: `node --check dispatcher.mjs`
3. Перезапусти Claude Code
4. Посмотри логи Claude Code: `~/.claude/logs/`

---

## Добавление нового агента

1. Добавь запись в объект `AGENTS` в `dispatcher.mjs`:

```js
new_agent: {
  label: "MyAgent",
  bin: "my-agent-cli",
  args: (prompt) => ["--non-interactive", prompt],
},
```

2. Тулз `delegate_new_agent` появится автоматически при перезапуске.

Правила для CLI-инструментов:
- Должны принимать prompt как аргумент командной строки
- Должны работать в неинтерактивном режиме (без TTY)
- Не должны требовать stdin (диспетчер передаёт `/dev/null`)
- Должны писать результат в stdout

---

## Примечания

- Диспетчер общается с оркестратором через **stdio** (JSON-RPC), поэтому
  не занимает сетевой порт
- Все переменные окружения родительского процесса наследуются (включая
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` и т.д.)
- Коды ошибок и stderr целевых агентов возвращаются оркестратору как
  часть текстового ответа — он может прочитать и скорректировать задачу
- Диспетчер **не хранит историю**, **не кеширует результаты** —
  каждый вызов запускает свежий процесс
