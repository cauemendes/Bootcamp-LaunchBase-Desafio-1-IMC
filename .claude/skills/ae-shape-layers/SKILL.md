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

> ✅ **Verificado no After Effects 2026 (26.3), macOS**, com `packages/jsx/selftest.jsx`.
> Ao mexer nesta lista, rode o autoteste de novo e atualize a nota — este arquivo é a
> lista canônica do repositório.

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
| Outer Roundness | `ADBE Vector Star Outer Roundess` | ✅ a grafia **com erro** é a válida |
| Inner Roundness | `ADBE Vector Star Inner Roundess` | mesma grafia com erro |

⚠️ `ADBE Vector Star Outer Roundness` (grafia correta) devolve `null` — verificado no
26.3. A Adobe preservou o erro de digitação por compatibilidade. Acessar propriedade
inexistente não lança: devolve `null`, e o erro só aparece uma linha depois como
`TypeError: null is not an object`. Isso vale pra qualquer matchname errado, então na
dúvida cheque o retorno antes de encadear.

Escrever no raio interno de um polígono regular lança — **confirmado no 26.3**. Cheque
o tipo antes em vez de envolver em try/catch.

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

## Gradientes: as paradas não são scriptáveis

`ADBE Vector Graphic - G-Fill` tem `ADBE Vector Grad Type` (1 linear, 2 radial),
`ADBE Vector Grad Start Pt` e `ADBE Vector Grad End Pt`. **Esses três funcionam** —
verificado no 26.3.

**As paradas de cor não.** Ler ou escrever `ADBE Vector Grad Colors` lança:

```
Can not get or set a value from this property
(matchname is "ADBE Vector Grad Colors").
This property's propertyValueType is PropertyValueType.NO_VALUE.
```

`NO_VALUE` significa que a propriedade não expõe valor nenhum ao scripting. Não é
questão de achar o formato certo do array — **não há valor para ler nem escrever**.
Verificado no After Effects 2026 (26.3).

O que resta, em ordem de esforço:

1. **Cor sólida** com a cor média do gradiente. É o que o projeto faz hoje.
2. **Duas camadas com máscara de gradiente** — sólido A, sólido B, e um Linear Wipe
   ou track matte fazendo a transição. Feio por dentro, correto por fora, e animável.
3. **Animation preset (.ffx)** gravado à mão com o gradiente pronto, aplicado por
   script. Funciona, mas cada gradiente vira um arquivo — não escala.
4. **Importar SVG/AI** com o gradiente e deixar o AE converter. Perde o controle sobre
   o resultado.

Nenhuma é boa o bastante para entrar no formato sem uma decisão consciente.

## Stroke é sempre centrado no path

O After Effects não tem alinhamento de stroke. Metade da espessura cai para fora da forma,
metade para dentro, e não há propriedade que mude isso.

Isso importa ao reconstruir arte vinda de ferramenta de design, onde alinhamento existe e
*inside* é o padrão de caixa e botão no Figma e no Illustrator. Copiar tamanho e espessura
sem compensar engorda a forma em uma espessura inteira: uma caixa de 200px com stroke
inside de 8px ocupa 200px na origem e 208px no AE. O traço parece mais grosso do que é,
mesmo com a largura correta — e o sintoma relatado por quem olha é "o stroke ficou grosso",
que manda procurar no lugar errado.

Para um stroke que era inside, encolha a forma em uma espessura e mantenha a largura:
`width - w`, `height - w`, posição deslocada em `w/2`.

Em contornos concêntricos o erro se acumula a cada nível, e o espaço entre eles é onde
aparece primeiro.

## Entrelinha exige desligar o automático

`TextDocument.leading` é ignorado enquanto `autoLeading` for true — e true é o padrão, com
1,2 × o corpo. Design costuma fechar mais que isso, e a diferença aparece justamente onde
mais se nota: texto de duas linhas dentro de um botão.

```javascript
doc.autoLeading = false;
doc.leading = entrelinhaEmPixels;   // baseline a baseline
```

Em try/catch: as duas propriedades são relativamente novas no TextDocument, e ficar sem a
entrelinha pedida é muito melhor que derrubar a camada.

E texto de várias linhas é **uma** camada com `\n` no `sourceText`, nunca duas camadas
empilhadas. Em duas, a entrelinha deixa de existir como propriedade — vira a distância
entre duas posições —, editar a frase exige mexer nas duas, e o bloco não se alinha como
um só. O erro não aparece em conferência de tela; aparece na hora de editar.

## Comp aninhada entra em 100%, não encaixada

`master.layers.add(compCena)` coloca a comp em escala 100% — pixel a pixel, centralizada.
Quando a cena tem o mesmo tamanho da master isso está certo. Quando não tem, sai tarja em
volta ou conteúdo estourando o quadro, e nada no código pediu isso.

```javascript
var fx = master.width / compCena.width;
var fy = master.height / compCena.height;
var f = Math.min(fx, fy);          // contain; Math.max seria cover
layer.property("ADBE Transform Group").property("ADBE Scale").setValue([f * 100, f * 100]);
```

Prefira `contain` como padrão. `cover` corta, e cortar é irreversível: some conteúdo sem
deixar rastro. Tarja é feia e visível, e quem olha decide o que fazer. E avise quando
escalar — uma montagem de dezenas de cenas erra todas de uma vez, em silêncio.
