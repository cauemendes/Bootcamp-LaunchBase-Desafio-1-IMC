---
name: ae-shape-layers
description: Referência de matchnames e comportamento de shape layers do After Effects — retângulo, elipse, estrela/polígono, path bezier, fill, stroke, gradiente, trim paths, repeater, transform de grupo, e o sistema de coordenadas de camada versus comp. Use ao criar ou modificar shape layers por script, ao investigar por que addProperty ou setValue falhou numa propriedade vetorial, ou ao converter geometria de SVG/design para o After Effects.
---

# Shape layers por script

## Estrutura

```
ShapeLayer
└── "ADBE Root Vectors Group"          ← Contents
    └── "ADBE Vector Group"            ← um Grupo
        ├── "ADBE Vectors Group"       ← Contents do grupo (note o plural diferente!)
        │   ├── geometria (Rect/Ellipse/Star/Shape - Group)
        │   ├── "ADBE Vector Graphic - Stroke"
        │   └── "ADBE Vector Graphic - Fill"
        └── "ADBE Vector Transform Group"
```

O par mais confuso: **`ADBE Vector Group`** é o grupo; **`ADBE Vectors Group`** (com S
em Vectors) é a lista de conteúdo dentro dele. Trocar um pelo outro é o erro nº 1.

## Matchnames

> ⚠️ **Esta lista foi montada a partir da documentação e ainda não foi verificada
> dentro de um After Effects real neste projeto.** Ao validar, corrija aqui — este
> arquivo é a lista canônica do repositório. Alguns matchnames da Adobe têm erro de
> digitação preservado por compatibilidade (`Roundess` sem o segundo "n" é o caso
> mais famoso), então confirme antes de confiar.

### Retângulo — `ADBE Vector Shape - Rect`
| Propriedade | Matchname | Notas |
|---|---|---|
| Size | `ADBE Vector Rect Size` | `[largura, altura]` |
| Position | `ADBE Vector Rect Position` | **o CENTRO**, não o canto |
| Roundness | `ADBE Vector Rect Roundness` | raio dos cantos em px |

Não tem parâmetro de rotação. Para girar, use a transform do grupo.

### Elipse — `ADBE Vector Shape - Ellipse`
| Propriedade | Matchname | Notas |
|---|---|---|
| Size | `ADBE Vector Ellipse Size` | `[diâmetro X, diâmetro Y]` — diâmetro, não raio |
| Position | `ADBE Vector Ellipse Position` | o centro |

Também não tem rotação própria.

### Estrela / Polígono — `ADBE Vector Shape - Star`
| Propriedade | Matchname | Notas |
|---|---|---|
| Type | `ADBE Vector Star Type` | `1` = estrela, `2` = polígono |
| Points | `ADBE Vector Star Points` | número de pontas |
| Position | `ADBE Vector Star Position` | |
| Rotation | `ADBE Vector Star Rotation` | em graus — esta primitiva **tem** rotação |
| Outer Radius | `ADBE Vector Star Outer Radius` | |
| Inner Radius | `ADBE Vector Star Inner Radius` | **só existe com Type = 1** |
| Outer Roundness | `ADBE Vector Star Outer Roundess` | grafia com erro, provável |
| Inner Roundness | `ADBE Vector Star Inner Roundess` | idem |

Escrever no raio interno de um polígono regular lança — cheque o tipo antes.

### Path livre — `ADBE Vector Shape - Group`
Contém `ADBE Vector Shape`, que recebe um objeto `Shape`:

```javascript
var s = new Shape();
s.vertices    = [[0,0], [100,0], [100,100]];
s.inTangents  = [[0,0], [0,0],   [0,0]];      // relativas ao vértice
s.outTangents = [[0,0], [0,0],   [0,0]];      // relativas ao vértice
s.closed      = true;
pathProp.property("ADBE Vector Shape").setValue(s);
```

Os três arrays precisam ter **o mesmo comprimento**. As tangentes são deslocamentos
a partir do vértice, não pontos absolutos — a conversão desde SVG está documentada em
`packages/core/src/svg-path.js`.

Um `Shape` representa **um** caminho contínuo. Um ícone com furo precisa de dois
`ADBE Vector Shape - Group` no mesmo grupo; a regra de preenchimento cria o furo.

### Fill — `ADBE Vector Graphic - Fill`
| Propriedade | Matchname |
|---|---|
| Color | `ADBE Vector Fill Color` |
| Opacity | `ADBE Vector Fill Opacity` |
| Fill Rule | `ADBE Vector Fill Rule` (`1` = nonzero, `2` = even-odd) |

### Stroke — `ADBE Vector Graphic - Stroke`
| Propriedade | Matchname | Notas |
|---|---|---|
| Color | `ADBE Vector Stroke Color` | |
| Opacity | `ADBE Vector Stroke Opacity` | |
| Width | `ADBE Vector Stroke Width` | |
| Line Cap | `ADBE Vector Stroke Line Cap` | `1` butt, `2` round, `3` projecting |
| Line Join | `ADBE Vector Stroke Line Join` | `1` miter, `2` round, `3` bevel |
| Miter Limit | `ADBE Vector Stroke Miter Limit` | |
| Dashes | `ADBE Vector Stroke Dashes` | grupo; adicione `ADBE Vector Stroke Dash 1` |

**Ordem importa:** Fill e Stroke pintam os paths que estão **acima** deles na lista.
Geometria primeiro, depois stroke, depois fill — assim o fill fica por baixo do
stroke, que é o que a maioria dos designs assume.

### Transform do grupo — `ADBE Vector Transform Group`
`ADBE Vector Anchor`, `ADBE Vector Position`, `ADBE Vector Scale`,
`ADBE Vector Rotation`, `ADBE Vector Group Opacity`, `ADBE Vector Skew`.

Girar um retângulo em torno do próprio centro: âncora **e** posição do grupo no centro
da forma, depois a rotação.

### Modificadores
| O quê | Matchname |
|---|---|
| Trim Paths | `ADBE Vector Filter - Trim` (`Start`/`End`/`Offset`) |
| Repeater | `ADBE Vector Filter - Repeater` |
| Merge Paths | `ADBE Vector Filter - Merge` |
| Offset Paths | `ADBE Vector Filter - Offset` |
| Round Corners | `ADBE Vector Filter - RC` |
| Wiggle Paths | `ADBE Vector Filter - Roughen` |
| Pucker & Bloat | `ADBE Vector Filter - PB` |
| Zig Zag | `ADBE Vector Filter - Zigzag` |

Um modificador afeta os paths **acima** dele no mesmo grupo.

## Sistema de coordenadas

Este é o ponto que mais gera bug ao converter design para AE.

Uma shape layer nova nasce com `Position` no centro da comp e `Anchor Point` em
`(0,0)`. O conteúdo é desenhado no espaço da camada, e a âncora é o ponto do espaço
da camada que vai parar em `Position`.

**Truque que este projeto usa:** com `Anchor Point = [0,0]` **e** `Position = [0,0]`,
o espaço da camada coincide com o da comp, com origem no canto superior esquerdo. Aí
uma coordenada de ferramenta de design (SVG, Figma) entra direto, sem conversão.

O custo é que a âncora fica no canto da comp, péssimo pra animar. Conserto:

```javascript
var rect = layer.sourceRectAtTime(comp.time, false);
var centro = [rect.left + rect.width / 2, rect.top + rect.height / 2];
layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue(centro);
layer.property("ADBE Transform Group").property("ADBE Position").setValue(centro);
```

Mover âncora e posição para o mesmo valor mantém o visual e deixa a camada animável.

## Gradientes: cuidado

`ADBE Vector Graphic - G-Fill` tem `ADBE Vector Grad Type` (1 linear, 2 radial),
`ADBE Vector Grad Start Pt` e `ADBE Vector Grad End Pt`, que são diretos.

**`ADBE Vector Grad Colors` não é.** As paradas ficam num array numérico achatado sem
API declarada, e escrever nele por script é notoriamente instável entre versões. Não
existe uma forma documentada e estável de definir paradas de gradiente por script.

Recomendação até isso ser resolvido: usar cor sólida, ou criar o gradiente e escrever
com `try/catch` caindo para sólido se falhar. Ver `docs/roadmap.md`.
