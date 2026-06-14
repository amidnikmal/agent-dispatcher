# V15 — Heat-свечение: мощность vs температура

## Вердикт: **ПОДТВЕРЖДЕНО** (finding TRUE)

Heat-свечение основано на мгновенной мощности, а не на температуре.
При I=0 свечение исчезает мгновенно — тепловая инерция игнорируется.

## Доказательство

### 1. PowerModel вычисляет долю от мгновенной мощности

`src/physics/PowerModel.h:22-26`:
```cpp
inline double heatFraction(ComponentType type, double power, double maxDissipatedPower) {
    if (maxDissipatedPower <= 1e-12) return 0.0;
    return dissipatedPowerOnly(type, power) / maxDissipatedPower;
}
```
`dissipatedPowerOnly` = `max(0.0, I*dV)` — чистая мгновенная мощность, без температуры.

### 2. Все три проекции используют heatFraction / brakeHeatFromPower / frictionHeatFromPower

- **Электрическая** — `src/projection/ProjectionBuilder.cpp:191`:
  `double frac = physics::heatFraction(ComponentType::Resistor, branchPower, ctx.maxP);`
- **Механическая** — `src/projection/ProjectionBuilder.cpp:1070-1072`:
  `double heat = mechanics::brakeHeatFromPower(comp.type, power);`
  → оборачивает `dissipatedPowerOnly(type, power)` (`MechanicsMapping.h:41-43`).
- **Гидравлическая** — `src/projection/ProjectionBuilder.cpp:1572-1574`:
  `double heat = hydraulic::frictionHeatFromPower(comp.type, power);`
  → оборачивает `dissipatedPowerOnly(type, power)` (`HydraulicMapping.h:41-43`).

Ни в одной из трёх точек визуализации **не запрашивается температура** из ThermalState.

### 3. ThermalModel существует, но рендер его не использует

`src/physics/ThermalModel.h:17-21` — `ThermalState { temperature[id] }`, RC-модель,
интегрируется backward Euler с τ = 50 с. `temperatureFor()` (`ThermalModel.h:24-27`)
используется только в:
- `src/ui/MainWindow.cpp:497` — термометр (текстовый readout)
- `src/simulation/SignalRecorder.h:82` — осциллограф (канал ElemT)

Grep `temperatureFor|ThermalState` в `src/projection/` → **0 вхождений**.

### 4. Физический источник

Тепловое излучение ~ T⁴ (закон Стефана–Больцмана). При отключении тока температура
спадает по экспоненте с τ = R_th·C_th, а не мгновенно. В текущей визуализации при
I→0 → P_diss→0 → heatFraction→0 → свечение исчезает мгновенно, даже если компонент
ещё горячий. Тепловая инерция (C_th) полностью проигнорирована в рендере.

## Идеал

Заменить `heatFraction(P, maxP)` на `temperatureFraction = (T - T_amb) / (T_max - T_amb)`,
пробросив `ThermalState` (или его температуру по componentId) в `ProjectionBuilder`.
