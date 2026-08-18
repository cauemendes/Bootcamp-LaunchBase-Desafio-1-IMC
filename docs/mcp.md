# Claude Code operando o After Effects

Este é o caminho principal do projeto: o Claude Code no seu terminal enxerga e opera
o After Effects através de um servidor MCP.

```
Claude Code  ──stdio/MCP──►  servidor  ──arquivos──►  painel no After Effects
```

Não precisa de chave de API. O modelo que enxerga imagem e decide o que fazer é o
próprio Claude Code — este servidor só dá a ele mãos dentro do AE.

---

## Instalação

### 1. Dependências

```bash
npm install
```

### 2. Painel da ponte

**O painel não é um chat.** Ele é uma peça silenciosa que fica ouvindo dentro do
After Effects. Você conversa com o Claude no terminal; o painel só executa. É por
isso que ele não tem campo de texto.

**A — Sem instalar (comece por aqui).** No After Effects:
**File → Scripts → Run Script File…** → escolha `dist/bridge-panel.jsx`.

Esse arquivo vem pronto no repositório — não precisa gerar nada. O painel abre como
janela flutuante e funciona igual à versão encaixável. Precisa repetir quando
reiniciar o After Effects, e é só isso. Nenhuma senha, nenhuma pasta de sistema,
nada que possa falhar em silêncio.

(Se você mexer no código do painel, `npm run bundle` regenera o arquivo.)

**B — Instalando de vez (painel encaixável).**

```bash
bash scripts/install-bridge.sh
```

⚠️ **Rode isso no Terminal.app, não pelo Claude Code.** O script copia para dentro
do pacote do aplicativo e precisa de `sudo` — que não consegue pedir senha quando é
um agente chamando. O script detecta e avisa, mas o caminho A evita o problema
inteiro.

### 3. A permissão que todo mundo esquece

**After Effects → Settings → Scripting & Expressions → marque
"Allow Scripts to Write Files and Access Network".**

Sem isso o painel não consegue escrever o arquivo de resposta, e todo comando dá
timeout sem dizer o porquê. É a causa nº 1 de "instalei e não funciona".

### 4. Abrir o painel

Reinicie o After Effects e abra **Window → bridge-panel.jsx**. Ele inicia sozinho e
deve mostrar **"ouvindo"**. Deixe aberto (pode encaixar em qualquer lugar da
interface — ele é pequeno).

### 5. Registrar o servidor no Claude Code

```bash
claude mcp add vectorize-ae --scope user -- node /caminho/absoluto/para/o/repo/packages/mcp/bin/vectorize-ae-mcp.mjs
```

Use o caminho absoluto — o Claude Code sobe o processo a partir de outra pasta.

`--scope user` grava em `~/.claude.json`, que é o mesmo arquivo que o **aplicativo do
Claude Code no Mac** lê. Com isso o servidor aparece em qualquer conversa, no
aplicativo ou no terminal, sem precisar estar na pasta do repositório. Sem a flag, o
registro fica preso a este projeto.

Confira com `/mcp` dentro do Claude Code: `vectorize-ae` deve aparecer conectado.

---

## Primeiro teste

No Claude Code, com o After Effects aberto:

> Verifique a ponte com o After Effects e me diga o que tem no projeto.

Ele deve chamar `check_bridge` e `describe_project`. Se responder com a versão do AE
e a lista de comps, está tudo ligado.

---

## As ferramentas

| Ferramenta | O que faz |
|---|---|
| `check_bridge` | Confirma que o AE está aberto e o painel ouvindo |
| `describe_project` | Lista as composições do projeto |
| `describe_comp` | Resume uma comp e suas camadas |
| `describe_layer` | Detalha uma camada: transform, keyframes, efeitos, shapes, texto |
| `list_fonts` | Fontes instaladas nesta máquina |
| `save_frame` | Renderiza um frame **e devolve a imagem**, para o Claude ver o resultado |
| `measure_image` | Mede cor, forma e raio de canto nos pixels de um PNG |
| `describe_brand` | Cores e fontes da marca em uso |
| `set_brand` | Registra a identidade do cliente, ou troca de perfil |
| `describe_scene_format` | Explica o formato do SceneSpec |
| `build_scene` | Constrói camadas vetoriais a partir de um SceneSpec |
| `describe_animation_format` | Explica o formato do AnimSpec |
| `animate_layers` | Anima camadas com keyframes editáveis |
| `save_project` | Grava o .aep — nada do que foi criado está em disco antes disso |
| `execute_script` | ExtendScript arbitrário — o escape hatch |

### A marca entra antes, não depois

Um modelo olhando um print devolve `#FF5A1F` porque foi isso que ele mediu nos pixels.
A cor da marca é `#FF5A20`. A diferença é invisível na tela e cara no arquivo: quem
for trocar a cor depois encontra dezoito hexadecimais quase iguais espalhados por
vinte camadas — exatamente o trabalho manual que a ferramenta existe para eliminar.

Por isso o Claude **pergunta** se existe guia de marca antes da primeira construção.
Informando, o SceneSpec passa a usar nomes:

```json
"fill": { "color": "primary" },
"shape": { "type": "text", "fontFamily": "heading" }
```

E um hex medido que esteja perto de uma cor da marca é encostado nela, com aviso. O
limite é conservador: pega ruído de compressão, não troca cores que são realmente
outras.

Um perfil por cliente, guardados em `~/Library/Application Support/vectorize-ae/brands/`.
Trocar de cliente é `set_brand` com `activateSlug`. Sem marca configurada nada quebra:
as cores vêm da imagem e o texto sai em Arial.

### Sobre o tamanho do conjunto

São quinze, e isso é uma decisão. Cada ferramenta ocupa contexto em toda conversa; um
conjunto grande piora a escolha do modelo em vez de melhorar. O que não couber vai
por `execute_script`, e só vira ferramenta dedicada quando houver motivo — uma
operação destrutiva que precisa de confirmação, um resultado que precisa de
formatação própria, ou algo que o modelo erra fazendo à mão.

### `save_frame` é o que fecha o laço

Sem ver o resultado, o modelo aplica uma animação e conclui que funcionou porque
nenhuma chamada deu erro — o que não é a mesma coisa que ter ficado bom. Com
`save_frame` ele renderiza, olha, e corrige.

Tenta primeiro `comp.saveFrameToPng()`, que é o caminho nativo. No After Effects 26.3
do macOS esse método existe, retorna sem erro e **não grava arquivo nenhum** — por
isso o resultado é conferido no disco antes de ser aceito, e a fila de render entra
como contorno quando não colar. A resposta diz qual caminho foi usado.

### Animação sai como keyframe, não como expressão

Expressão é mais curta de escrever e péssima de receber. O designer abre o arquivo,
quer atrasar uma entrada em dois frames, e encontra código no lugar de keyframe — para
ajustar precisa ler, entender e reescrever. Keyframe se arrasta.

Este projeto existe para entregar arquivo editável, então `animate_layers` escreve
keyframes de verdade, com o easing temporal do After Effects.

O AnimSpec fala em **frames**, não em segundos. É como um motion designer conta, e
evita a praga do keyframe fora da grade — um valor em segundos que não cai exatamente
num frame produz keyframe entre frames, difícil de selecionar na timeline e que faz a
animação parecer trêmula sem motivo aparente.

As faixas de timing da skill de motion graphics viraram validação: duração de entrada
acima de 1s recebe aviso de que arrasta, abaixo de 3 frames de que o easing não vai
ser percebido, overshoot acima de 20% de que virou cartoon. Aviso, não erro — a
decisão continua sua.

E o stagger segue a **ordem da lista**, não o índice da camada na timeline. Escalonar
por índice dá resultado aleatório e parece erro; a ordem de leitura do design é uma
decisão de quem monta o spec.

### O que não é vetor entra marcado

Uma fotografia redesenhada com shapes fica pior que um espaço reservado. Um logo
redesenhado a partir de print fica errado de um jeito que ninguém aceita — existe versão
oficial, e a aproximação é uso indevido de marca.

A forma `image` cobre os dois casos. Com um arquivo (caminho, ou o nome de um asset da
marca) ele é importado e enquadrado na caixa medida. Sem arquivo, entra um placeholder
que **grita**: retângulo cinza no lugar certo, nome prefixado com `[IMAGEM]`, rótulo
laranja na timeline, e um comentário na camada dizendo o que colocar ali. Três sinais,
porque um só se perde numa comp de trinta camadas. Rótulo aqua marca imagem que foi
colocada — confira o enquadramento.

Por isso `set_brand` também guarda `assets`: registre o logo uma vez e o SceneSpec passa
a referi-lo por nome. Vale perguntar por logos junto das cores e fontes, no começo.

### Salvar é sua decisão — a ferramenta só não deixa passar em branco

`save_project` existe mas não é automático: gravar o arquivo de alguém sem ele pedir é
pior que não gravar. O que a ferramenta faz é avisar. Quando o projeto **nunca** foi
salvo, `build_scene` devolve isso em destaque, junto de um caminho pronto na Mesa — o
cenário que isso protege é produzir vinte telas numa noite e o After Effects fechar com
nada em disco.

### Fidelidade é uma escolha, não um padrão escondido

Medir cada forma dá o resultado mais fiel e foi o que fez uma reconstrução levar
dezessete minutos. Aproximar entrega em poucos minutos algo que já está editável — e
editável é o ponto: um stroke grosso demais se arruma em segundos.

Mas aproximar tem risco real: se a base sair torta e a animação for construída em
cima, refazer custa mais do que teria custado medir.

Então a escolha é sua, por tarefa. `describe_scene_format` aceita `fidelity`:

- **draft** — mede a paleta e os blocos maiores, estima o resto, não itera. Para
  explorar e para peça descartável.
- **balanced** (padrão) — mede todas as formas, uma rodada de conferência, não persegue
  diferença de dois pixels.
- **precise** — mede tudo e itera até a diferença ser imperceptível. Para quando a
  reconstrução vai virar base de uma animação longa.

A descrição da ferramenta manda perguntar quando você não disser qual quer, em vez de
o modelo decidir por você.

### Nada está salvo até `save_project`

`build_scene` e `animate_layers` mexem na memória do After Effects. O `.aep` em disco
continua como estava, e o trabalho some se o aplicativo fechar. É o comportamento
normal do AE — mas numa sessão em que o Claude constrói vinte camadas, é fácil sair
achando que está tudo guardado.

`save_project` tem uma proteção que não é opcional: projeto que nunca foi salvo exige
`path`. Sem arquivo definido, `app.project.save()` abre o diálogo de "salvar como", e
diálogo modal congela a thread que roda o polling do painel — a ponte para de
responder esperando um clique, e nada na tela diz isso.

### Gradiente: geometria por script, cores pela sua mão

Gradient fill e gradient stroke nativos são criados com o tipo e os pontos certos. As
**paradas de cor não**: `ADBE Vector Grad Colors` tem `propertyValueType` igual a
`NO_VALUE` e o After Effects não expõe essa propriedade para script — verificado no
26.3. É a mesma limitação que o Overlord tem ao trazer arte do Illustrator.

O que dá para fazer é não desperdiçar a medição. As duas cores são medidas na imagem e
entram no **nome do grupo**: `Fundo · #ff6200 → #161d26`. Aparece na timeline, do lado
de quem vai editar, e o gradiente se resolve em dois cliques sem precisar voltar à
referência.

### `measure_image` tira o palpite do caminho

Na primeira reconstrução real o modelo escreveu um decodificador de PNG do zero, no
meio da tarefa, e gastou com isso a maior parte de dezessete minutos — porque
precisava da cor exata de cada área e do raio de cada canto, e não tinha como medir.

Agora tem. Numa chamada ele amostra cores, mede formas e varre linhas atrás de bordas.
Duas respostas importam mais que os números:

`uniformity` diz o quanto a amostra é confiável. Perto de 1 caiu em área chapada;
abaixo de 0.8 caiu numa borda suavizada, e aquele hex não é uma cor do design — é
mistura de duas.

Os quatro cantos vêm medidos **separados**. Foi assim que apareceu um card cujo canto
superior direito tinha raio de 172px contra 114px do esquerdo: o contorno fora
desenhado à mão. Quem assume um retângulo uniforme erra na silhueta, que é o primeiro
lugar onde o olho compara.

---

## Como isso funciona por dentro

O After Effects não tem servidor de scripting — nenhum processo de fora consegue
chamá-lo. Alguma coisa precisa rodar *dentro* dele, e é o painel.

```
servidor  →  escreve  <pasta>/cmd/<id>.json   →  painel lê, executa no AE
servidor  ←  lê       <pasta>/res/<id>.json   ←  painel escreve a resposta
```

A pasta fica em `~/Library/Application Support/vectorize-ae/bridge` no macOS
(`Folder.userData` no ExtendScript resolve no mesmo lugar, então os dois lados se
encontram sem configuração). Dá pra mudar com `VECTORIZE_AE_BRIDGE_DIR`.

Dois detalhes que evitam falhas intermitentes:

- **Id por comando.** O resultado carrega o id do comando. É o que impede o servidor
  de ler a resposta da pergunta anterior — a falha clássica desse tipo de ponte.
- **Escrita conferida.** O lado Node escreve num `.tmp` e renomeia, que é o jeito
  clássico de nunca expor arquivo pela metade. O painel **não pode** fazer o mesmo:
  no After Effects 2026 do macOS, `rename()` dentro da subpasta `res/` falha em
  silêncio e o arquivo fica com zero byte. Então o painel grava direto no arquivo
  final, relê para conferir o que ficou no disco, e cai para a pasta raiz
  (`res-<id>.json`) se a subpasta não aceitar. O servidor procura nos dois lugares e
  trata JSON incompleto como "ainda não chegou", tentando de novo — em vez de
  estourar.

O painel também descarta comandos de sessões antigas ao iniciar. Um comando que
ficou para trás seria executado quando o painel abrisse, mexendo no projeto sem
ninguém ter pedido nada naquele momento.

---

## Quando algo não funciona

**"A ponte não respondeu"** — na ordem: o After Effects está aberto? O painel está
aberto em Window → bridge-panel.jsx? Mostra "ouvindo"? A permissão de escrita está
marcada nas preferências?

**O painel não aparece no menu Window** — reinicie o After Effects depois de
instalar. O AE só varre a pasta de painéis na inicialização.

**Comandos dão timeout depois de funcionar por um tempo** — o painel foi fechado, ou
o After Effects está com um diálogo modal aberto. O polling não roda enquanto há
diálogo na frente.

**O log do painel mostra o erro real.** É o primeiro lugar a olhar, antes de
qualquer outra coisa.
