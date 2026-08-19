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

## Nunca use objeto comum como mapa

Este custou uma noite de diagnóstico e vale ler antes de escrever qualquer tabela de
lookup.

```javascript
var ESCAPES = { "\n": "\\n", "\t": "\\t" };
if (ESCAPES[ch]) out += ESCAPES[ch];      // ⚠️ arma armada
```

Um objeto comum herda de `Object.prototype`. Se **qualquer** script instalado no
After Effects tiver feito `Object.prototype.x = function () {}` alguma vez — e
scripts antigos de AE fazem isso o tempo todo — `ESCAPES[ch]` devolve o método
herdado em vez de `undefined`. O `if` aceita (função é truthy) e a concatenação
seguinte estoura com:

```
Object of type Function found where a Number, Array, or Property is needed
```

A mensagem não menciona string, nem objeto, nem lookup. Aponta para lugar nenhum.

**O que fazer:** comparação direta (`if (ch === "\n")`) quando são poucos casos, ou
`obj.hasOwnProperty(chave) ? obj[chave] : null` quando o mapa é grande. Vale para
qualquer chave vinda de fora — nome de ferramenta, nome de propriedade, caractere.

Como isso apareceu na prática: a ponte com o Claude Code parecia um problema de
permissão de arquivo. Todo comando dava timeout, o painel dizia "falhei ao
responder", e a suspeita passou por permissão de scripting, escrita em subpasta e
`rename()` — três hipóteses erradas — porque a resposta nunca chegava a ser montada.
O que localizou foi instrumentar por etapa e usar `vec.describeError`, que anexa
`arquivo:linha`. `e.toString()` sozinho esconde a linha.

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

## Texto e fontes (verificado no 26.3)

Escrever em `textDocument.fontFamily` lança
`Unable to set "fontFamily". It is a readOnly attribute.` O mesmo vale para
`fontStyle`. O caminho válido é `textDocument.font`, que espera o **nome PostScript**
(`HelveticaNeue-Bold`), não o nome de família.

`TextDocument` é um **snapshot**: alterar o objeto não muda nada até `setValue`.
Junte todas as mudanças num objeto só e grave uma vez — cada `setValue` recalcula o
layout do texto.

### `app.fonts` no 26.3

```
allFonts                            Array de FAMÍLIAS, não de fontes ⚠️
getFontsByFamilyNameAndStyleName()  → Array de fontes. Existe e funciona.
getFontsByPostScriptName()          → Array de fontes. Existe e funciona.
getFontByID()                       → uma fonte
missingOrSubstitutedFonts           Array do que o AE substituiu
fontsDuplicateByPostScriptName      famílias em conflito
mruFontFamilyList                   últimas usadas
```

⚠️ **`allFonts` é aninhado.** Cada item é um array com as variantes de uma família:

```javascript
app.fonts.allFonts[0]              // → [ABCDiatype-Regular, ABCDiatype-Bold, …]
app.fonts.allFonts[0].familyName   // → undefined  (é um array, não uma fonte)
app.fonts.allFonts[0][0].familyName // → "ABC Diatype"
```

Ler direto devolve `undefined` em silêncio, não erro. Para percorrer, aninhe dois
laços — ver `vec.buildFontIndex()` em `packages/jsx/lib/ae-font.jsx`.

`getFontsByFamilyName` **não existe** nesta versão. Use
`getFontsByFamilyNameAndStyleName(familia, estilo)`, que devolve array — cheque
`length` antes de indexar.

Para detectar substituição de fonte, `app.fonts.missingOrSubstitutedFonts` é mais
confiável que comparar nomes antes e depois: é o próprio AE reportando.

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
tenha espaço e acento. `Folder.name` também vem codificado: `"Adobe%20After%20Effects%202026"`.
Compare sempre com `decodeURI(f.name)`, senão o filtro nunca casa — e `getFiles()`
devolve lista vazia sem erro nenhum.

**Mas `decodeURI` lança exceção num `%` solto.** `decodeURI("100%.png")` estoura, e um
arquivo assim na pasta derruba a varredura inteira — não só aquela entrada. Pior
quando o decode está dentro do callback de `getFiles`: a exceção volta como lista
vazia, e o sintoma aponta para o lugar errado ("não achei o arquivo" em vez de "não
consegui ler a pasta"). Envolva em `try/catch` e caia para o nome cru:

```javascript
function nomeLegivel(f) {
  try { return decodeURI(f.name); } catch (e) { return String(f.name); }
}
```

Corolário: prefira `getFiles()` sem callback e filtre depois. Assim a falha de uma
entrada fica isolada, em vez de contaminar o resultado.

### As funções de arquivo devolvem `false`, não lançam erro

`open()`, `write()`, `rename()` e `remove()` sinalizam falha pelo retorno. Ignorar o
retorno — que é o que quase todo código de AE por aí faz — transforma um erro de I/O
em arquivo de zero byte e log vazio. Sempre confira:

```javascript
if (!f.open("w")) throw new Error("open falhou em " + f.fsName);
if (f.write(texto) === false) throw new Error("write falhou");
```

### Escrita em subpasta pode falhar em silêncio (visto no 26.3, macOS)

Gravar em `<pasta>/res/arquivo.json` produziu arquivos vazios e `rename()` devolvendo
`false`, enquanto a mesma gravação em `<pasta>/arquivo.json` funcionou. Ler e apagar
dentro de subpasta funcionava normalmente — só a escrita quebrava.

Não há explicação confirmada. O que resolve na prática: **gravar, reler e comparar
com o que se pretendia escrever**, caindo para a pasta raiz quando não bate. É o que
`vecWriteVerified()` em `packages/jsx/bridge-panel.jsx` faz.

Consequência de projeto: o padrão `.tmp` + `rename` para escrita atômica **não é
confiável em subpasta**. Quem lê precisa tratar JSON incompleto como "ainda não
chegou" e tentar de novo, em vez de estourar.

## Importação de arte: o AE não lê SVG

Formatos vetoriais que o After Effects importa: **.ai, .eps, .pdf**. SVG não — nunca
leu. O import falha e a camada simplesmente não aparece, o que na prática vira "sumiu
uma camada" no meio de uma cena com vinte.

Ao colocar arte vetorial, ligue `layer.collapseTransformation = true`. É a rasterização
contínua: sem ela, um `.ai` colocado a 40% e depois ampliado sai borrado. No logo do
cliente isso é o tipo de detalhe que ninguém perdoa.

## Diálogo modal: o script não consegue fechar

Não existe jeito de clicar em OK por script. Para clicar, o script precisaria rodar — e
a thread que o executaria é exatamente a que o modal bloqueou. **A única defesa é
impedir que ele apareça**, com `app.beginSuppressDialogs()` em volta da operação.

Num painel que faz polling isso não é detalhe: um aviso na tela congela a ponte, e o
sintoma que chega ao usuário é "perdi a conexão" — apontando para o lugar errado.

### Enquanto o diálogo está na tela, `scheduleTask` não roda

Consequência que custa horas se não estiver escrita: o modal bloqueia a thread principal,
e é ela que executa as tarefas agendadas. Então **clicar em Parar → Iniciar no painel não
resolve nada** — o clique agenda a tarefa, e a tarefa fica na fila até o diálogo sair.

Isso produz um sintoma que parece impossível: o heartbeat congelado no mesmo número de
ciclos por minutos a fio, imune a reinício. Não é a ponte com defeito; é um diálogo
esperando um clique, às vezes atrás da janela principal.

O sinal que separa os dois casos é **quanto tempo a ponte viveu antes de congelar**.
Poucos segundos = diálogo na subida do app ou na abertura do projeto. Por isso vale gravar
`uptime` no heartbeat: sem ele, os dois casos dão a mesma mensagem e o conselho vai para o
lado errado.

### Polling atropela os outros scripts do usuário

Pior consequência da regra acima, e a que mais custa confiança: o After Effects **recusa
executar script enquanto há diálogo modal esperando resposta**, e recusa mostrando outro
diálogo — `Cannot run a script while a modal dialog is waiting for response`. Cada ciclo
de polling é uma execução de script. A 350ms isso são 171 diálogos de erro por minuto de
diálogo aberto.

O estrago não fica no seu painel. Qualquer script do usuário que abra janela própria —
Motion, Ease and Wizz, um painel qualquer — fica inutilizável enquanto sua ponte escuta.

Não há como capturar essa recusa: ela acontece antes do seu código. O que dá para fazer é
medir depois — se o ciclo chegou muito mais tarde que o combinado, houve bloqueio — e
reagir em três níveis:

1. **Ocioso é lento.** Ninguém está esperando nada; verificar a cada 2s em vez de 350ms
   corta 85% das colisões de graça. Rápido só numa janela após um comando.
2. **Recuo exponencial** ao detectar bloqueio, com recuperação de um degrau por vez.
   Voltar direto ao rápido recria a tempestade, porque o diálogo que bloqueou é
   normalmente o primeiro de vários.
3. **Pausa automática** depois de alguns bloqueios seguidos. Bloqueio que insiste significa
   que tem gente usando o app, e a resposta certa é sair da frente e esperar ser chamada.

O terceiro nível é o que realmente resolve — os dois primeiros só reduzem. E o motivo da
pausa tem que chegar a quem consome a ponte de fora: "parada" faz um agente mandar
reiniciar, que é justamente voltar a atrapalhar.

Falta ainda o mais simples: **painel encaixado volta com o workspace**, então auto-iniciar
significa escutar toda vez que a pessoa abre o app para trabalhar, sem ter pedido. Grave a
escolha num arquivo e respeite-a na carga. Instalação nova nasce parada; escutar é a opção
que pode incomodar.

### Não inicie o polling na carga do painel

Painel encaixado carrega junto com o workspace, durante a subida do After Effects — antes
de haver projeto aberto. Começar a escutar ali põe uma tarefa agendada rodando no meio da
carga do app e do projeto.

```javascript
// Errado: roda durante a subida do AE.
meuStart();

// Certo: repeat=false só registra o timer; o callback espera a thread principal
// desocupar. Se o AE ainda estiver subindo — ou com um diálogo na frente — ele atrasa.
app.scheduleTask("meuStart()", 4000, false);
```

`internal verification failure, sorry! {no current context}` é o erro que aparece quando
algo consulta o DOM num momento em que o AE não tem contexto válido. Se ele surge ao abrir
o projeto e há um script fazendo polling desde a subida, isole antes de acusar: tire o
painel da pasta ScriptUI Panels, reinicie o AE e abra o mesmo projeto. Se o erro
permanecer, ele é do projeto ou de outro plugin — não do painel.

## Painel de ScriptUI: o arquivo pode carregar duas vezes

Painel encaixado mais um flutuante do Run Script File, ou fechar e reabrir a aba: o mesmo
arquivo roda de novo na mesma engine. Duas consequências, as duas já custaram tempo aqui.

**`var meuEstado = {...}` no topo é refeito.** As contas voltam a zero e `running` volta a
false com a tarefa agendada ainda de pé. Guarde o estado em `$.global`, com um número de
versão para o caso de uma versão nova do arquivo achar um estado antigo na engine:

```javascript
var SCHEMA = 2;
if (!$.global.meuEstado || $.global.meuEstado.schema !== SCHEMA) {
  $.global.meuEstado = { schema: SCHEMA, /* ... */ uis: [] };
}
var estado = $.global.meuEstado;
```

**Guardar `estado.ui` num slot só é pior.** O último painel carregado toma o slot, e daí em
diante todo status e todo texto de botão vão para *aquele* painel — não para o painel em
que a pessoa clicou. O sintoma é o pior possível para depurar: clicar em Iniciar, nada
mudar, e nenhum erro em lugar nenhum. Mantenha uma **lista** de painéis e escreva em todos,
podando quem lança (painel fechado tem widget destruída, e escrever nela lança).

Vale também fazer o clique se anunciar no log. "Cliquei e não mudou nada" é ambíguo entre o
handler não ter rodado e ter rodado e falhado, e ScriptUI engole exceção de handler sem
deixar rastro.

## Um relator de erro não pode lançar

```javascript
// Errado: o argumento é avaliado antes da chamada. Se describeError lançar, a exceção
// escapa do catch que devia relatá-la.
catch (e) { log("falhou: " + vec.describeError(e)); }
```

Com camadas de captura aninhadas isso é pior do que parece: a exceção sobe, lança de novo
na camada de cima pelo mesmo motivo, e termina num `catch (e2) {}` que engole. A falha
original desaparece sem uma linha de log. Embrulhe o relator:

```javascript
function motivo(e) {
  try { return vec.describeError(e); } catch (a) {}
  try { return String(e); } catch (b) {}
  return "erro que não consegui descrever";
}
```

## Dá para testar painel fora do After Effects

Quase nada do que um painel de ponte faz precisa do AE: ele mexe em estado, em widget e em
arquivo. Um host falso em Node cobre os três, e cobre justamente onde os defeitos estavam.

Ver `packages/jsx/test/bridge-panel.test.js`. Três decisões que fizeram diferença:

- **`scheduleTask` do host falso não dispara sozinho** — quem dispara é o teste. É a única
  forma de expressar o cenário do diálogo modal, em que a tarefa existe e não roda.
- **O bundle é montado a partir das fontes**, não lido de `dist/`. Um teste que aprova um
  bundle velho é pior que nenhum teste.
- **O global do sandbox só inventa stub para nome que começa em maiúscula** (a forma dos
  enums do AE). Nome minúsculo tem que devolver `undefined`, senão o idioma
  `var vec = vec || {}` captura o stub e `vec.quote` passa a ser um número.

## Force resolução Full antes de exportar frame

O seletor Full / Half / Third do painel de composição é `comp.resolutionFactor` — Half é
`[2,2]`. Uma comp em Half exporta o frame com metade da largura e da altura.

Isso importa porque o frame exportado costuma ser a régua de todas as medições feitas em
cima dele, e o modo de falhar é o pior possível: **nada falha.** As medidas saem coerentes
entre si e erradas por um fator constante, e a cena reconstruída sai proporcional e do
tamanho errado. Trabalhar em Half numa comp pesada é o caso normal, não a exceção.

```javascript
var antes = comp.resolutionFactor;
comp.resolutionFactor = [1, 1];
try { exportar(); } finally { comp.resolutionFactor = antes; }
```

E confronte o tamanho do arquivo gerado com `comp.width`/`comp.height` de fora, onde há
como ler o cabeçalho do PNG. Se houver outra causa além da resolução, ela aparece como
aviso em vez de cena torta.

## Painel copiado não é painel rodando

A engine de `#targetengine` só relê o arquivo do painel quando o After Effects sobe.
Copiar o `.jsx` novo com o aplicativo aberto **não troca o código em execução**.

Isto já produziu um diagnóstico falso: um aviso da fila de render que havia sido corrigido
reapareceu, e a leitura natural — "a correção está errada" — estava errada. A correção
estava certa e não estava rodando.

Carimbe um número de build no painel, mande-o no heartbeat, e compare do lado de fora.
Divergência passa a ser fato observável em vez de hipótese, e o aviso tem que vir **antes**
de qualquer outro diagnóstico: investigar comportamento de código velho é investigar código
que não existe mais.

## `timeSpanStart` da fila de render é em tempo de exibição

`comp.displayStartTime` não é zero quando a comp veio de uma sequência maior. A fila de
render espera `timeSpanStart` **absoluto nessa régua**, não relativo ao início da comp:

```javascript
item.timeSpanStart = comp.displayStartTime + tempoRelativo;
item.timeSpanDuration = comp.frameDuration;
```

Errando isso, o AE abre "will cause render to have frames outside of range" — que é um
diálogo modal, com a consequência do parágrafo anterior. Numa comp com
`displayStartTime` de 137s foi assim que a ponte caiu no meio de uma tarefa.

## `scheduleTask` morre se a função lançar

`app.scheduleTask(codigo, ms, true)` repete até `cancelTask` — **ou até uma exceção
escapar da função agendada.** Aí o After Effects cancela a tarefa e nada avisa: a
interface continua exatamente como estava, mostrando o último estado que alguém escreveu
nela.

Num painel que faz polling isso é devastador. O painel continua dizendo "ouvindo" e não
está escutando mais nada. Aconteceu aqui: oito horas de tentativas de fora contra uma
tarefa que havia sido cancelada de madrugada.

Duas defesas, e vale ter as duas:

```javascript
function meuPoll() {
  try {
    trabalho();
  } catch (e) {
    try { log(e); } catch (e2) {}   // até o log pode lançar, se a UI morreu
  }
}

// Supervisor: segunda tarefa independente que reanima a primeira.
function supervisor() {
  if (agora() - ultimoCiclo > INTERVALO * 3) {
    app.cancelTask(idDoPoll);
    idDoPoll = app.scheduleTask("meuPoll()", INTERVALO, true);
  }
}
```

## Não renderize para `Folder.temp` no macOS

`Folder.temp` resolve para `/private/var/folders/…/T/TemporaryItems`, uma pasta
especial do sistema. A fila de render do After Effects **roda sem erro e não deixa
arquivo ali** — o sintoma é "a fila rodou mas não encontrei o arquivo gerado", que
parece problema de render e é problema de destino.

Escreva numa pasta sua. Neste projeto é `Folder.userData/vectorize-ae/bridge/frames`,
que é território comprovado: a ponte grava ali o tempo todo.

## `saveFrameToPng` pode existir e não fazer nada (26.3, macOS)

O método está presente, a chamada retorna sem lançar erro, e **nenhum arquivo é
gravado**. Testado com destino em pasta diferente: mesmo resultado. Não é permissão —
a mesma pasta aceita escrita por `File.write` na mesma sessão.

Ou seja: `typeof comp.saveFrameToPng === "function"` não garante nada. A única
verificação que vale é conferir `destino.exists` **depois** da chamada.

O caminho que funciona é a fila de render com um template de output, mais lento porém
confiável. `vec.tools.save_frame` ainda não faz esse fallback — é o primeiro item
pendente.

## O design de origem raramente é geometricamente regular

Medindo o contorno de um card de UI num print da Amazon, os cantos superiores tinham
raios diferentes: ~172px à direita contra ~114px à esquerda. O contorno tinha sido
desenhado à mão, não era um retângulo arredondado uniforme.

Isso importa na hora de escolher a primitiva: forçar `rect` com um `roundness` só
aproxima os quatro cantos pela média e o resultado fica visivelmente diferente do
original justamente na silhueta, que é o que o olho compara primeiro. Quando a
medição acusar assimetria, `path` é a escolha certa — é o caso em que abrir mão da
primitiva animável vale a pena.

## Performance

- `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)` em volta de toda
  operação longa. Diálogo modal congela a thread principal, que é a **mesma** que roda
  o polling do painel da ponte: com alguém na frente é um clique, numa execução noturna
  é tudo parado até de manhã. O que abre sem ser chamado: substituição de fonte,
  footage faltando, confirmação de tamanho de comp. Restaure com `false` — despejar os
  alertas acumulados no fim travaria o painel na saída.
- Escrever propriedade é caro. Numa cena grande, o custo está no número de `setValue`,
  não na quantidade de JS.
- `comp.openInViewer()` no fim, não a cada camada.
- `layer.sourceRectAtTime(t, extents)` — o segundo argumento `false` pula o cálculo de
  extensões (sombra, blur) e é bem mais rápido quando não há efeito aplicado.

## Referência

O **After Effects Scripting Guide** da Adobe é a fonte canônica do DOM.
Para matchnames de shape layers, veja a skill `ae-shape-layers` neste repositório —
ela guarda a lista já verificada.
