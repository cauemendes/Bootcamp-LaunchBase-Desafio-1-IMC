/**
 * Guia do SceneSpec, entregue sob demanda pela ferramenta `describe_scene_format`.
 *
 * Fica fora da descrição de `build_scene` de propósito: descrição de ferramenta
 * ocupa contexto em *toda* conversa com o servidor, e este texto só interessa a quem
 * vai de fato construir uma cena. Divulgação progressiva.
 */

/**
 * O quanto medir antes de construir.
 *
 * Não é um detalhe de implementação: é a decisão de negócio da ferramenta. Medir cada
 * forma produz o resultado mais fiel e foi o que fez uma reconstrução levar dezessete
 * minutos. Aproximar entrega em poucos minutos algo que já está editável — e editável
 * é o ponto: o designer arruma um stroke grosso em segundos.
 *
 * O risco de aproximar é real e o usuário o nomeou: se a base sair torta e a animação
 * for construída em cima, refazer custa mais do que teria custado medir. Por isso
 * existe um nível intermediário como padrão, e a escolha é dele — não do modelo.
 */
const FIDELIDADE = {
  draft: `## Nível de fidelidade: RASCUNHO

Velocidade acima de exatidão. Meça o **essencial** e aproxime o resto:

- Meça a paleta (as cores precisam estar certas — cor errada é o que mais incomoda).
- Meça a caixa dos 3 ou 4 elementos maiores, que definem o enquadramento.
- **Estime** o resto: posições relativas, tamanhos pequenos, raios de canto.
- NÃO itere. Uma passada, um \`save_frame\` para conferir que nada saiu grotesco, e
  entregue.
- Diferença de poucos pixels não é problema a ser resolvido aqui — o arquivo está
  editável e o ajuste leva segundos na mão do designer.

Se algo sair claramente errado — elemento fora do lugar, cor que não existe no
original — corrija esse item e só ele.`,

  balanced: `## Nível de fidelidade: EQUILIBRADO (padrão)

- Meça a paleta e a caixa de **todos** os elementos com \`measure_image\`.
- Meça o raio dos cantos onde ele é visível.
- Estime o que é barato de ajustar depois: espaçamento de texto, espessura de traço
  fina, detalhe de poucos pixels.
- Uma rodada de verificação com \`save_frame\`, corrigindo o que estiver claramente
  fora. Não persiga diferença de 1 ou 2 pixels.`,

  precise: `## Nível de fidelidade: PRECISO

Exatidão acima de velocidade. Vale quando a reconstrução vai virar base de uma
animação longa, e refazer depois sairia caro.

- Meça **tudo**: cada forma, cada raio, cada espessura de traço, cada posição de texto.
- Confira a espessura de traço com \`scanLine\` atravessando o traço, não no olho.
- Renderize e compare com o original, iterando até a diferença ser imperceptível.
- Reporte o que não deu para reproduzir em vez de aproximar em silêncio.`,
};

export function sceneFormatGuide(fidelity = "balanced") {
  const nivel = FIDELIDADE[fidelity] ?? FIDELIDADE.balanced;
  return `${SCENE_FORMAT_GUIDE}\n\n${nivel}\n`;
}

export const SCENE_FORMAT_GUIDE = `# SceneSpec — formato aceito por build_scene

Descreve um design 2D como formas geométricas. O After Effects reconstrói isso como
shape layers e camadas de texto nativas e editáveis.

## Coordenadas

Origem (0,0) no canto SUPERIOR ESQUERDO. X cresce para a direita, Y para baixo.
Tudo em pixels, na resolução real da imagem. Igual a SVG e Figma.

## Estrutura

\`\`\`json
{
  "version": "1.0",
  "canvas": {
    "width": 1920, "height": 1080,
    "background": "#0E0E12",
    "frameRate": 30, "duration": 10
  },
  "palette": [ { "name": "Marca/Primária", "hex": "#FF4D2E" } ],
  "elements": [
    {
      "id": "card-fundo",
      "name": "Card / Fundo",
      "group": "Card",
      "z": 0,
      "shape": { "type": "rect", "x": 100, "y": 200, "w": 880, "h": 600,
                 "roundness": 32, "rotation": 0 },
      "fill":   { "color": "#1A1A22", "opacity": 100 },
      "stroke": { "color": "#FF4D2E", "width": 6,
                  "cap": "round", "join": "round", "opacity": 100 }
    }
  ]
}
\`\`\`

\`background\` pode ser null. \`fill\` e \`stroke\` podem ser null (mas não os dois,
senão o elemento fica invisível). \`z\` crescente = mais à frente.

\`group\` junta o que forma uma unidade visual — um logo e seu texto, um botão e seu
rótulo. Com layerMode "per-group" (o padrão), elementos do mesmo grupo viram uma
camada só, com um grupo interno por elemento. String vazia = elemento solto.

\`name\` é o nome que a camada terá na timeline.

**Nomes DENTRO do After Effects em inglês** — camada, grupo, comp, marcador. O arquivo
circula entre times e clientes, e inglês é o padrão que qualquer motion designer lê sem
tradução.

**Isto vale só para os nomes.** Continue conversando com o usuário no idioma dele —
esta regra é sobre o conteúdo do arquivo, não sobre o idioma da conversa.

Escreva o nome como um designer escreveria — o papel do elemento, não a forma dele:
"Button / Background", "Title", "Icon / Arrow", "Card / Shadow". Nunca "Rect 3".

## Tipos de forma

**rect** — \`x\`, \`y\` (canto superior esquerdo), \`w\`, \`h\`, \`roundness\`, \`rotation\`
**ellipse** — \`cx\`, \`cy\` (centro), \`rx\`, \`ry\` (raios; iguais = círculo)
**star** — \`cx\`, \`cy\`, \`points\`, \`outerRadius\`, \`innerRadius\`, \`rotation\`
          (innerRadius igual a outerRadius = polígono regular)
**polygon** — \`points\`: [[x,y], …], \`closed\`: bool. Lados retos.
**path** — \`d\`: dados de path SVG. Comandos M L H V C S Q T Z, maiúsculos e
          minúsculos. **Arco (A/a) NÃO é suportado** — aproxime com curvas C.
**text** — \`x\`, \`y\` (ponto de ancoragem, na baseline), \`content\`, \`fontFamily\`,
          \`fontSize\`, \`weight\`, \`align\` (left/center/right), \`letterSpacing\`

## Regras que decidem a qualidade do resultado

**Prefira a primitiva mais específica.** Um círculo descrito como \`path\` funciona,
mas quem for animar perde o controle de raio. Retângulo é \`rect\`, círculo é
\`ellipse\`, estrela é \`star\`. Só use \`path\` para curvas orgânicas, ícones e
silhuetas que não são nenhuma das outras.

**Texto é \`text\`, sempre.** Nunca desenhe letra como path — o texto precisa
continuar editável para ajuste e tradução.

**Texto de duas linhas é UM elemento, não dois.** Um rótulo como "Broad match" dentro de
um botão é um texto com quebra de linha. Reconstruído como dois elementos, ele fica errado
de três formas ao mesmo tempo: a entrelinha passa a ser a distância entre duas posições
chutadas, editar a frase exige mexer em duas camadas, e alinhar o bloco no botão fica
impossível sem mover as duas. E nada disso aparece numa conferência de tela — as palavras
estão todas lá, no lugar aproximado. Aparece na hora de editar, depois de entregue.

\`\`\`json
{ "shape": { "type": "text", "content": "Broad\\nmatch", "x": 260, "y": 512,
             "fontSize": 64, "lineHeight": 62, "align": "center", "…": "…" } }
\`\`\`

A posição é a baseline da **primeira** linha. \`lineHeight\` é de baseline a baseline, em
pixels — meça as duas baselines no frame e subtraia. Sem ele o After Effects usa 1,2 × o
corpo, que é mais solto que a maioria dos designs.

**Decida por elemento: vetor ou pixel.** Reconstruir com formas é o que dá editabilidade,
e é para isso que esta ferramenta existe. Mas há coisa que não se reconstrói, e insistir
produz um resultado pior que honesto — parece tentativa.

| Reconstrua com formas | Recorte com \`crop_image\` |
|---|---|
| cartão, barra, botão, pílula, moldura | ilustração desenhada à mão |
| ícone de linha, seta, marca de check | personagem, produto renderizado |
| texto, fundo chapado, divisória | qualquer coisa com sombreado ou dezenas de curvas |

O teste é simples: **se você conseguiria descrever a forma em uma frase, é vetor.** "Um
retângulo arredondado laranja com stroke escuro" é uma frase. Um tênis com solado
ondulado, cabedal em três tons e sombra no chão não é — e medir primitivas nele devolve um
borrão de formas coloridas.

\`crop_image\` recorta a região do frame de referência e grava um PNG. O caminho vai direto
em \`source\` de uma forma \`image\`. Passe \`removeBackground: true\` sempre que a ilustração
for ficar sobre algo reconstruído — sem isso o retângulo do recorte tapa o que está atrás,
e o defeito parece de ordem de camada. Áreas internas da mesma cor do fundo são
preservadas, então o branco de dentro do desenho não vira buraco.

**Meça a região com folga.** Folga se tira depois com \`trim: true\`, que aperta o recorte
na ilustração e devolve as coordenadas certas. Corte não se recupera: se o recorte cortar
o desenho, o arquivo abre normal, com a ilustração dentro e o fundo limpo, e só de perto
se vê que falta um pedaço — quando a cena já está montada. A ferramenta avisa se sobrou
desenho encostando na borda, e esse aviso quer dizer "refaça com mais folga".

A ferramenta diz quanto do recorte virou transparente. Perto de 100% significa que a
ilustração foi removida junto; perto de 0%, que o fundo não era chapado. Nos dois casos,
olhe o arquivo antes de usar. A ilustração fica com os pixels originais, o resto da
cena continua vetor, e é o resto que se anima — cartão que entra, barra que cresce, botão
que pulsa. A ilustração normalmente só precisa de posição e escala.

Um quadro com uma ilustração no meio de interface é o caso mais comum, não a exceção.

**Seta é um tipo próprio — não desenhe traço e triângulo separados.**

\`\`\`json
{ "shape": { "type": "arrow", "x1": 120, "y1": 380, "x2": 430, "y2": 250, "bend": -60,
             "headLength": 0, "headWidth": 0 },
  "stroke": { "color": "ink", "width": 6 } }
\`\`\`

A ponta encosta em \`x2, y2\` e é girada para a direção em que o traço **chega** ali — num
traço curvo isso não é a direção de início para fim, e é exatamente aí que uma seta
montada à mão sai torta.

Seta grossa e cheia — daquelas em que o corpo é um bloco, não um traço — não é este tipo:
é uma forma fechada. Faça como \`polygon\` com os vértices do contorno, ou recorte se ela
tiver afilamento e canto arredondado. \`arrow\` é para seta de traço, incluindo a fina e
curva que liga dois elementos.

Nas duas, **a espessura do traço e o tamanho da ponta são medidas, não estimativas**: use
\`scanLine\` atravessando o traço e atravessando a ponta. Seta é dos elementos em que o
olho mais erra, porque ela é fina e o contorno escuro engorda a leitura — e uma seta com
metade da espessura certa salta aos olhos ao lado da original.

E símbolo tipográfico — ≠, ×, →, %, + — costuma ser **texto**, não forma. Reconstruído
como formas soltas, cada barra vira um elemento posicionado no chute, e o resultado é um
símbolo que não fecha: as barras não se cruzam onde deviam. Se o desenho for um glifo,
use \`text\`; se for desenhado à mão com cor própria em cada parte, recorte. O traço para na base da ponta, senão o stroke aparece por dentro
do bico e engrossa ele.

\`bend\` é o quanto o meio do traço se afasta de uma reta imaginária entre as duas pontas,
em pixels. 0 é reta. Se a curva sair para o lado errado, inverta o sinal. Deixe
\`headLength\` e \`headWidth\` em 0 para a ponta acompanhar a espessura do traço — ponta de
tamanho fixo some num traço grosso e vira bandeira num traço fino.

A cor da ponta sai do \`stroke\`, como numa seta desenhada à mão. E as duas partes ficam na
mesma camada, então arrastar a seta no After Effects move ela inteira.

**Cores repetidas usam exatamente o mesmo hex.** Amostre do meio das áreas chapadas,
longe das bordas, que estão suavizadas e devolvem cor errada.

**Espessura de stroke medida no olho sai grossa.** A borda suavizada acrescenta um ou
dois pixels de cada lado, e somá-los engorda o traço visivelmente — foi o desvio mais
notado numa reconstrução real. Meça com \`scanLine\` atravessando o traço: o
comprimento do trecho de cor sólida é a espessura, sem os pixels de transição. Na
dúvida entre dois valores, escolha o menor: traço fino demais passa despercebido,
grosso demais salta aos olhos.

**No After Effects o stroke é centrado no path, e isso não se configura.** Metade da
espessura cai para fora da forma, metade para dentro. Ferramentas de design têm
alinhamento de stroke — no Figma e no Illustrator o padrão de caixa e botão costuma ser
*inside* —, e ali a espessura toda fica dentro da borda.

A consequência é que copiar tamanho e espessura sem compensar engorda a forma em uma
espessura inteira, e o traço parece mais grosso do que é mesmo estando com a largura
certa. Uma caixa de 200px com stroke *inside* de 8px ocupa 200px na arte original e
208px reconstruída.

Compensando: quando o traço da arte parece encostar por dentro da borda — o caso comum
—, encolha a forma em uma espessura e mantenha a largura medida.

\`\`\`json
{ "shape": { "type": "rect", "x": 104, "y": 104, "width": 192, "height": 192 },
  "stroke": { "color": "#111111", "width": 8 } }
\`\`\`

Isto vale em dobro para contornos concêntricos, do tipo caixa dentro de caixa: o erro se
acumula a cada nível, e o espaço entre os dois contornos é o primeiro lugar onde ele
aparece.

**Marca antes de cor medida.** Chame \`describe_brand\` antes de construir. Havendo
marca configurada, escreva o nome no lugar do hexadecimal:

\`\`\`json
"fill": { "color": "primary" },
"shape": { "type": "text", "fontFamily": "heading", "…": "…" }
\`\`\`

O token de fonte também traz o **peso** definido no perfil. Marcas costumam usar bold em
quase todo rótulo — quando o perfil declara \`{ family: "Ember Modern Display", style:
"Bold" }\`, o texto sai bold sem você repetir isso em cada elemento. Declarar \`weight\` no
elemento continua vencendo, para o caso de um texto específico ser diferente do padrão.

Vale por dois motivos: o hex que você mede num print é o que a compressão deixou, não
o que a marca especifica; e um SceneSpec com nomes sobrevive à troca de cliente. Se
você escrever o hex medido mesmo assim, uma cor próxima de uma cor da marca é
encostada nela automaticamente, com aviso.

Sem marca configurada, **pergunte ao usuário** se existe um guia de marca para o
projeto antes de construir. Se não houver, use os hex medidos — mas não invente uma
paleta.

**Fontes:** chame \`list_fonts\` com filtro para conferir se a família existe nesta
máquina antes de pedir por ela. Fonte ausente é substituída em silêncio e o layout
muda. Sem certeza, deixe \`fontFamily\` vazio e ajuste depois.

## Reconstruir só uma parte

Nem toda tarefa é a imagem inteira. "Só o cursor do mouse", "só o card do meio", "só
o botão" são pedidos comuns e o caminho é o mesmo — muda o escopo, não o método.

Monte o SceneSpec **apenas com os elementos pedidos**, e chame \`build_scene\` com
\`reuseComp: true\` para as camadas entrarem na composição que já está aberta, em vez
de criar uma nova.

Duas coisas que decidem se o resultado presta:

**Mantenha as coordenadas do original.** O canvas continua sendo a imagem inteira e
o elemento continua na posição em que ele aparece nela. Recortar o canvas em volta do
elemento parece mais limpo e destrói o alinhamento com o resto da cena — e alinhar de
novo à mão é o trabalho que se queria evitar.

**Meça antes.** \`measure_image\` com uma semente dentro da forma devolve os limites
exatos e o raio de cada canto. Estimar no olho um elemento pequeno erra
proporcionalmente mais que estimar um grande.

A imagem de referência é lida do disco, não do After Effects. \`describe_project\`
devolve o caminho de cada arquivo importado — basta a imagem estar no projeto, não
precisa estar dentro de uma composição. Se ela nem foi importada, peça o caminho ao
usuário.

Quando o elemento estiver por cima de outra coisa — um cursor sobre uma interface —
amostre a cor dele longe da borda: os pixels da divisa são mistura das duas camadas e
não são cor de nenhuma das duas.

## Gradiente

Suportado, com uma ressalva que importa. Use em \`fill\` ou \`stroke\`:

\`\`\`json
"fill": {
  "type": "gradient",
  "kind": "linear",
  "from": "#ff6200",
  "to": "#161d26",
  "start": [100, 200],
  "end": [980, 800]
}
\`\`\`

\`kind\` é \`linear\` (padrão) ou \`radial\`. \`start\` e \`end\` são pontos no canvas;
omitindo os dois, o adapter usa a diagonal do próprio elemento. \`from\` e \`to\`
aceitam nome de cor da marca, igual a qualquer outra cor.

**As duas cores não são aplicadas automaticamente.** A propriedade de paradas de
gradiente do After Effects tem \`propertyValueType\` igual a \`NO_VALUE\` — a API não
expõe, e não há como definir por script. Verificado no 26.3. O gradiente nasce no
preto-e-branco padrão do AE e o designer define as cores em dois cliques.

Para ele saber quais, as cores medidas vão para o **nome do grupo**:
\`Fundo · #ff6200 → #161d26\`. Aparece na timeline, do lado de quem vai editar. Então
meça as duas pontas com \`measure_image\` e informe os valores reais — eles são a
instrução, mesmo não sendo aplicados.

Se exatidão automática importar mais que estrutura, o efeito Gradient Ramp
(\`ADBE Ramp\`) tem Start Color e End Color scriptáveis: um solid com Ramp e a shape
como track matte, montado via \`execute_script\`. Custa duas camadas e um matte em vez
de uma shape editável.

## Foto, textura e logo: o que não é vetor

Nem tudo numa arte pode ser redesenhado com formas. Uma fotografia reconstruída com
shapes fica pior que um espaço reservado, e um logo redesenhado a partir de print fica
errado de um jeito que ninguém aceita — existe versão oficial.

Para esses casos existe a forma \`image\`:

\`\`\`json
{
  "id": "foto-produto",
  "name": "Foto / Produto",
  "shape": {
    "type": "image",
    "x": 120, "y": 340, "w": 480, "h": 360,
    "fit": "cover",
    "source": "logo",
    "label": "foto do produto em fundo claro"
  }
}
\`\`\`

**Com \`source\`** — caminho de arquivo, ou o nome de um asset da marca (veja
\`describe_brand\`) — o arquivo é importado e posicionado na caixa. \`fit\` é
\`cover\` (preenche e sobra fora, padrão), \`contain\` (cabe inteira) ou \`stretch\`.

**Sem \`source\`** entra um placeholder marcado: retângulo cinza na caixa medida,
nome prefixado com \`[IMAGEM]\`, **rótulo laranja** na timeline e um comentário na
camada dizendo o que colocar. Três sinais, porque um só se perde numa comp de trinta
camadas. Rótulo aqua marca imagem que **foi** colocada — confira o enquadramento.

\`label\` é o que o designer lê para saber o que vai ali. Descreva o conteúdo, não o
elemento: "foto do produto em fundo claro" diz o que colocar; "Imagem 3" não diz nada.

**Quando usar placeholder em vez de tentar:** fotografia, textura, degradê complexo com
imagem, ilustração pintada, e logo sem arquivo oficial. Marcar honestamente o que não
foi reproduzido vale mais que uma aproximação que passa por pronta.

## Não suportado

Sombra, blur e textura não têm representação no formato — aplique como efeito depois,
via \`execute_script\`.
`;
