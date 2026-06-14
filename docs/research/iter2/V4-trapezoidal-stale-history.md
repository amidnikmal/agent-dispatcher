# V4: Trapezoidal stale history on circuit events

## Вердикт: ПОДТВЕРЖДЕНО

Trapezoidal-история (`capCurrent`/`indVoltage`) НЕ инвалидируется на событиях цепи
(переключатель, скачок источника, смена топологии). `hasHistory` определяется
исключительно по наличию ключа в map — без проверки валидности для новой топологии.

## Доказательство

### 1. `hasHistory` — чистое наличие ключа

`src/solver/CircuitSolver.cpp:197`:
```cpp
bool hasHistory = state.capCurrent.count(comp.id) > 0;
```

`src/solver/CircuitSolver.cpp:208`:
```cpp
bool hasHistory = state.indVoltage.count(comp.id) > 0;
```

Комментарий в коде (строки 194–196) подтверждает: fallback на BE только на **самом
первом шаге** компонента — нет проверки, что история всё ещё согласована с цепью.

### 2. `onCircuitEvent()` → `wake()` не очищает историю

`src/simulation/LiveSim.cpp:95-111` — `onCircuitEvent()`:
- Пересчитывает `tau`, `osc`, авто-скорость.
- Вызывает `applySpeed()` (только `m_dt`/`m_speed`).
- Вызывает `wake()`.

`src/simulation/LiveSim.cpp:118-126` — `wake()`:
```cpp
void LiveSim::wake() {
    m_settled = false;
    m_quietSteps = 0;
    m_accumulator = std::clamp(m_accumulator, 0.0, m_dt);
}
```
Ни `capCurrent`, ни `indVoltage` не тронуты.

### 3. `wakeKeepSpeed()` — то же самое

`src/simulation/LiveSim.cpp:71` — просто `wake()`; используется для ручки-динамо
(`src/ui/MainWindow.cpp:187`). Тоже не чистит историю.

### 4. Кто и когда чистит

- `discharge()` (`LiveSim.cpp:113-116`) → `m_state.reset()` → полный сброс.
- `snapToAsymptote()` (`LiveSim.cpp:228-232`) — обнуляет `capCurrent`/`indVoltage`
  ТОЛЬКО для элементов с DC-путём и ТОЛЬКО при засыпании.
- **На событиях цепи — никто не чистит.**

### 5. Путь воспроизведения

`MainWindow::circuitEvent()` (MainWindow.cpp:276-280) — вызывается при:
- щелчке выключателя (`toggleSwitch`, строка 198)
- правке значения/топологии компонента
→ `onCircuitEvent()` → `wake()` → история переживает.

На следующем вызове `advance()` → `integrateStep()` → `stepTransient()`:
`hasHistory == true` (ключи есть), метод Trapezoidal → используется старый
`capCurrent`/`indVoltage` из предыдущей топологии → несовместимая история →
persistent ringing.

## Последствия

При переключении метода на Trapezoidal и последующем щелчке выключателя
(или другой смене топологии) реактивные элементы стартуют с «чужим» током/напряжением
в trapezoidal-источнике, что порождает численный звон, не затухающий пока
солвер не уснёт и не вызовет `snapToAsymptote()`.
