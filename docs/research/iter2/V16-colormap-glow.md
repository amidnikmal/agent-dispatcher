# V16: ВЕРДИКТ — палитра potentialColor + glow (B5)

Дата: 2026-06-14T19:03. Worktree: wt-v16. Агент: orchestrator (Кило).

## B5.1: `potentialColor()` — rainbow-derivative, немонотонная светлота

**ВЕРДИКТ: ЛОЖНАЯ находка (DISCREPANCY SUBSTANTIATED). Оба утверждения B5.1 подтверждены кодом.**

### Доказательство

Файл: `src/render/ColorMaps.h:19-32`

Четыре стопа:
| Стоп | R,G,B | Hex | L* (CIE76) | Hue |
|------|-------|-----|------------|-----|
| stop0 | (49,78,130) | #314E82 | 33.4 | dark blue |
| stop1 | (72,136,170) | #4888AA | 53.9 | teal |
| stop2 | (213,170,82) | #D5AA52 | 71.9 | yellow/gold |
| stop3 | (211,92,68) | #D35C44 | 53.9 | red |

**Светлота немонотонна**: L* идёт 33.4 → 53.9 → 71.9 → 53.9 (пик на жёлтом stop2, падение на 18 единиц к красному stop3). Это создаёт false boundary на переходе жёлтый→красный (t ∈ [0.75, 1.0]).

**Три hue-перехода** (blue→teal→yellow→red) — классический rainbow-derivative паттерн, отвергнутый в научной визуализации (Rogowitz & Treinish, 1995; BIDS, 2015).

**Для сравнения — viridis** (перцептивно-равномерная): L* монотонно растёт 14.9 → 35.7 → 54.5 → 90.9, без false boundaries, colourblind-safe.

### Источники

- BIDS Colormap Project: https://bids.github.io/colormap/
- Rogowitz & Treinish (1995): «Why Should Engineers and Scientists Be Worried About Color?» — https://doi.org/10.1109/VISUAL.1995.480803

---

## B5.2: Glow — концентрические круги, не Gaussian bloom

**ВЕРДИКТ: ЛОЖНАЯ находка (DISCREPANCY SUBSTANTIATED). B5.2 подтверждён.**

### Доказательство

Файл: `src/render/PrimitiveRenderer.cpp:137-148`

Реализация:
```cpp
dl->AddCircleFilled(c, r * 1.8f, withAlpha(glow.color, scaleA(6)), 48);   // large fill α=6k
dl->AddCircleFilled(c, r, withAlpha(glow.color, scaleA(255)), 48);          // core fill α=255k
for (int ring = 1; ring <= 4; ++ring) {
    float rr = r * (0.45f + 0.32f * ring);
    dl->AddCircle(c, rr, withAlpha(glow.color, scaleA(max(0, 28 - ring*4))), 64, 1.0f);
}
```

Это 1 большая залитая окружность + 1 core-заливка + 4 концентрических кольца (ring) с линейным alpha-спадом (28 → 24 → 20 → 16). **Никакого separable Gaussian blur, offscreen FBO, HDR-экстракции, ping-pong blur — только концентрические примитивы ImDrawList.**

Настоящий bloom (LearnOpenGL): двухпроходный separable Gaussian blur (horizontal + vertical) над яркими регионами в offscreen FBO, additive blend с исходной сценой.

### Источник

- LearnOpenGL Bloom: https://learnopengl.com/Advanced-Lighting/Bloom

---

## Итог

| Пункт B5 | Утверждение находки | Вердикт | Обоснование |
|----------|---------------------|---------|-------------|
| 5.1 | potentialColor — rainbow-derivative, немонотонная светлота | **Подтверждено** | 4 стопа blue→teal→yellow→red; L*: 33→54→72→54 (немонотонно); 3 hue-перехода |
| 5.2 | Glow — концентрические круги, не Gaussian bloom | **Подтверждено** | 5 концентрических ImDrawList-окружностей, без blur/FBO/HDR |
