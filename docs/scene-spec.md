# SceneSpec

O formato intermediário entre "quem entendeu a imagem" e "quem constrói no After
Effects". Todo o resto do projeto é plugável em volta dele.

## Duas formas do mesmo dado

**Flat** — o que a IA produz. Lista de elementos, sem aninhamento (structured
outputs não aceita schema recursivo). Schema em `packages/core/src/ai/schema.js`.

**Nested** — o que o ExtendScript consome. Grupos remontados a partir do campo
`group`. Produzido por `normalizeScene()`.

```js
import { normalizeScene } from "@vectorize-ae/core";
const nested = normalizeScene(flatFromAI);
```

Você quase sempre trabalha com o flat. O nested é detalhe de implementação do
construtor.

---

## Estrutura flat

```jsonc
{
  "version": "1.0",
  "canvas": {
    "width": 1920,
    "height": 1080,
    "background": "#0E0E12",   // ou null, se o design não tiver fundo sólido
    "frameRate": 30,
    "duration": 10
  },
  "palette": [
    { "name": "Brand/Primary", "hex": "#FF4D2E" },
    { "name": "Ink",           "hex": "#101014" }
  ],
  "elements": [
    {
      "id": "bg-panel",
      "name": "BG / Painel",
      "group": "Fundo",         // rótulo de agrupamento; "" = solto na raiz
      "z": 0,                    // ordem de pintura, 0 = mais atrás
      "shape": { "type": "rect", "x": 0, "y": 0, "w": 1920, "h": 1080,
                 "roundness": 0, "rotation": 0 },
      "fill":   { "color": "#0E0E12", "opacity": 100 },
      "stroke": null
    }
  ]
}
```

### Ordem de pintura

`z` crescente = mais à frente. O construtor ordena por `z` e cria as layers do AE na
ordem inversa (no AE, índice 1 é o topo). Se dois elementos empatarem em `z`, vale a
ordem em que aparecem no array.

---

## Tipos de shape

Todas as coordenadas em pixels de canvas, origem no canto superior esquerdo.

### `rect`
```jsonc
{ "type": "rect", "x": 100, "y": 80, "w": 400, "h": 240,
  "roundness": 24, "rotation": 0 }
```
`x`/`y` é o **canto superior esquerdo** (não o centro — o AE usa centro internamente,
a conversão é feita pelo construtor). `rotation` em graus, horário.

### `ellipse`
```jsonc
{ "type": "ellipse", "cx": 300, "cy": 200, "rx": 120, "ry": 120 }
```
Centro e raios. `rx == ry` é um círculo.

### `polygon`
```jsonc
{ "type": "polygon", "points": [[10,10],[90,10],[50,80]], "closed": true }
```
Linhas retas entre vértices. Para curvas, use `path`.

### `path`
```jsonc
{ "type": "path", "d": "M10,10 C20,0 40,0 50,10 L50,50 Z" }
```
Dados de path SVG. O parser em `packages/core/src/svg-path.js` suporta
`M m L l H h V v C c S s Q q T t Z z` e converte quadráticas para cúbicas (o AE só
tem bezier cúbica). Arcos (`A`/`a`) **não** são suportados — convertam para curvas
antes.

### `star`
```jsonc
{ "type": "star", "cx": 400, "cy": 300, "points": 5,
  "outerRadius": 100, "innerRadius": 45, "rotation": 0 }
```
`innerRadius` menor que `outerRadius` gera estrela; iguais geram polígono regular.

### `text`
```jsonc
{ "type": "text", "x": 120, "y": 300, "content": "LANÇAMENTO",
  "fontFamily": "Arial", "fontSize": 72, "weight": "Bold",
  "align": "left", "letterSpacing": 0 }
```
Vira uma **text layer** nativa do AE, não um shape. `x`/`y` é o ponto de ancoragem do
texto — para `align: "left"`, o começo da baseline.

O `fontFamily` é um palpite do modelo a partir do visual. Se a fonte não existir na
máquina, o AE substitui silenciosamente e o layout sai diferente — o painel avisa
quando isso acontece. Fontes são o ponto mais frágil da reconstrução; ver
[`roadmap.md`](roadmap.md).

---

## Fill e stroke

```jsonc
"fill":   { "color": "#FF4D2E", "opacity": 100 },
"stroke": { "color": "#101014", "width": 8,
            "cap": "round", "join": "round", "opacity": 100 }
```

Ambos podem ser `null`. `cap`: `butt` | `round` | `square`. `join`: `miter` |
`round` | `bevel`. `opacity` de 0 a 100.

**Gradientes ainda não estão no schema.** Ver [`roadmap.md`](roadmap.md) — escrever
paradas de gradiente por script no AE é notoriamente instável e vai precisar de
validação dentro do AE antes de entrar no contrato.

---

## Cores

Sempre hex `#RRGGBB` no SceneSpec. A conversão para o `[r, g, b]` de 0–1 que o AE
espera acontece em `packages/core/src/color.js`.

⚠️ Se o projeto do AE estiver num espaço de trabalho linear, os valores que o
scripting recebe são interpretados nesse espaço e as cores saem mais claras do que a
imagem original. `hexToAeColor()` aceita um parâmetro de gama para compensar, e o
painel expõe isso como uma opção. Em projeto sRGB padrão (o default), não faça nada.
