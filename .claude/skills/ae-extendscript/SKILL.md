---
name: ae-extendscript
description: Escrever ou depurar ExtendScript (.jsx) para o After Effects — DOM do app, criação de comps e camadas, propriedades, keyframes, expressões via script, undo groups, leitura/escrita de arquivo, e as armadilhas do ECMAScript 3. Use ao mexer em packages/jsx, ao ver "EvalScript error.", ao investigar por que uma propriedade não aceita setValue, ou ao escrever qualquer automação que rode dentro do After Effects.
---

# ExtendScript no After Effects

## A linguagem é ECMAScript 3

Não é JavaScript moderno com algumas coisas faltando — é uma linguagem de 1999. O que
**não existe**:

| Não existe | Use |
|---|---|
| `const`, `let` | `var` |
| arrow function | `function () {}` |
| template literal | concatenação com `+` |
| `JSON.parse` / `JSON.stringify` | `eval("(" + str + ")")` para ler; serializador próprio para escrever |
| `Array.prototype.forEach/map/filter/indexOf` | `for (var i = 0; i < a.length; i++)` |
| `Array.isArray` | `x instanceof Array` |
| `String.prototype.trim` | `str.replace(/^\s+|\s+$/g, "")` |
| `Object.keys` | `for (var k in obj)` com `hasOwnProperty` |
| desestruturação, spread, default params | passar objeto de opções |

`try`/`catch`/`finally` **existem** e funcionam. Getters/setters de objeto também.

Neste projeto, tudo o que passa do ES3 puro está em `packages/jsx/lib/util.jsx`.

## Regra de ouro: lógica não pertence aqui

O ExtendScript deve ser fino e mecânico. Qualquer coisa que dê pra calcular sem o
After Effects — geometria, cor, parsing, validação — vai para `packages/core`, onde
tem teste e roda em qualquer lugar. Foi por isso que o parser de path SVG ficou no
core em vez de ser reescrito em ES3.

## Depurando

`evalScript` devolve a string literal `"EvalScript error."` sem nenhum detalhe quando
o script lança. Isso torna a depuração impossível se o erro subir. O padrão do
projeto: envolver tudo num `try/catch` no topo e retornar `{ok: false, error: "..."}`
serializado, nunca deixar a exceção atravessar a ponte.

Objetos de erro do ExtendScript carregam `e.line` e `e.fileName`, que valem ouro:

```javascript
function describeError(e) {
  if (e && e.line !== undefined && e.fileName) {
    return e.toString() + " (" + e.fileName + ":" + e.line + ")";
  }
  return String(e);
}
```

Para inspeção interativa, o ExtendScript Toolkit foi descontinuado; use o VS Code com
a extensão **Adobe ExtendScript Debugger**, que ainda funciona e permite breakpoints.

## Undo groups

Toda operação que modifica o projeto precisa estar num grupo de undo, senão o usuário
desfaz camada por camada:

```javascript
app.beginUndoGroup("Nome que aparece no menu Edit");
try {
  // trabalho
} finally {
  app.endUndoGroup();   // o finally importa: sem ele, um erro deixa o grupo aberto
}
```

## Criando comps e camadas

```javascript
// addComp(nome, largura, altura, pixelAspect, duração em segundos, frameRate)
var comp = app.project.items.addComp("Minha Comp", 1920, 1080, 1, 10, 30);

var shape = comp.layers.addShape();
var text  = comp.layers.addText("Olá");
var solid = comp.layers.addSolid([1, 0, 0], "Vermelho", 1920, 1080, 1);
var nulo  = comp.layers.addNull();
```

`comp.layers.add*` insere a nova camada no **índice 1** (topo). Construir de trás pra
frente produz o empilhamento certo sem precisar reordenar depois.

`app.project.activeItem` pode ser qualquer coisa — sempre cheque `instanceof CompItem`
antes de usar.

## Propriedades

O acesso é por *matchname* (string estável entre idiomas) ou por nome exibido (muda
com o idioma do app — **nunca use**).

```javascript
var t = layer.property("ADBE Transform Group");
t.property("ADBE Position").setValue([960, 540]);
t.property("ADBE Anchor Point").setValue([0, 0]);
t.property("ADBE Scale").setValue([100, 100]);
t.property("ADBE Rotate Z").setValue(45);
t.property("ADBE Opacity").setValue(50);
```

Coisas que mordem:

- **`setValue` falha se a propriedade tiver keyframes.** Use `setValueAtTime` nesse
  caso. Cheque com `prop.numKeys > 0`.
- **`setValue` falha se a propriedade tiver expressão.** Limpe com
  `prop.expression = ""` antes.
- **Propriedade escondida por outra opção lança ao ser escrita.** O caso clássico é
  `ADBE Vector Star Inner Radius` num polígono regular: o AE não expõe raio interno
  quando o tipo é polígono. Verifique a condição antes de escrever, não com try/catch.
- **`prop.canSetExpression`** diz se dá pra atribuir expressão.

Propriedades de cor esperam `[r, g, b]` ou `[r, g, b, a]` com componentes de 0 a 1 —
não 0–255. O alpha é opcional; três componentes bastam.

**Matchname errado devolve `null`, não lança.** `layer.property("ADBE Coisa Errada")`
retorna `null` em silêncio, e o erro só aparece uma linha depois como
`TypeError: null is not an object`. Ao caçar um matchname suspeito, cheque o retorno
antes de encadear — é a diferença entre "não existe" e "existe mas recusou o valor".

## Texto: `fontFamily` é somente leitura

No After Effects 2026 (26.3), escrever em `textDocument.fontFamily` lança
`Unable to set "fontFamily". It is a readOnly attribute.` — verificado. O mesmo vale
para `fontStyle`.

O caminho válido é `textDocument.font`, que espera o **nome PostScript**
(`HelveticaNeue-Bold`), não o nome de família. Para chegar nele a partir de um nome
humano, use `app.fonts`. Veja `packages/jsx/selftest-fonts.jsx` para a forma exata da
API nesta versão.

## Keyframes e easing

```javascript
var pos = layer.property("ADBE Transform Group").property("ADBE Position");
pos.setValueAtTime(0,   [0, 540]);
pos.setValueAtTime(1,   [960, 540]);

// Easing: influence de 0.1 a 100, speed na unidade da propriedade por segundo.
var easeOut = new KeyframeEase(0, 75);
pos.setTemporalEaseAtKey(2, [easeOut, easeOut], [easeOut, easeOut]);
```

Para propriedades multidimensionais, os arrays de ease precisam ter **um item por
dimensão** — posição 2D quer dois, 3D quer três. Errar isso lança.

`setInterpolationTypeAtKey(index, KeyframeInterpolationType.BEZIER)` controla o tipo.

## Arquivos

```javascript
var f = new File(caminho);
if (f.exists && f.open("r")) {
  f.encoding = "UTF-8";     // defina ANTES de ler; o padrão varia por SO
  var conteudo = f.read();
  f.close();
}
```

`File` e `Folder` usam URI-encoding em `.fsName` vs `.absoluteURI` — ao passar
caminhos entre o painel e o ExtendScript, prefira `fsName` e teste com caminho que
tenha espaço e acento.

## Performance

- `app.beginSuppressDialogs(true)` evita que um diálogo trave um script em lote.
- Escrever propriedade é caro. Numa cena grande, o custo está no número de `setValue`,
  não na quantidade de JS.
- `comp.openInViewer()` no fim, não a cada camada.
- `layer.sourceRectAtTime(t, extents)` — o segundo argumento `false` pula o cálculo de
  extensões (sombra, blur) e é bem mais rápido quando não há efeito aplicado.

## Referência

O **After Effects Scripting Guide** da Adobe é a fonte canônica do DOM.
Para matchnames de shape layers, veja a skill `ae-shape-layers` neste repositório —
ela guarda a lista já verificada.
