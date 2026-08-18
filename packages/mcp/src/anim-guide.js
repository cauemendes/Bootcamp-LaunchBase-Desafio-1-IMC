/**
 * Guia do AnimSpec, entregue sob demanda por `describe_animation_format`.
 *
 * Separado do guia de cena pelo mesmo motivo que aquele é separado da descrição da
 * ferramenta: quem só vai reconstruir um design não precisa carregar vocabulário de
 * animação no contexto, e vice-versa.
 */

export const ANIM_FORMAT_GUIDE = `# AnimSpec — formato aceito por animate_layers

Anima camadas que já existem na composição, com **keyframes de verdade**.

Não são expressões, e isso é uma decisão. O designer que recebe o arquivo quer
atrasar uma entrada em dois frames arrastando um keyframe — não lendo código para
entender o que reescrever.

## Estrutura

\`\`\`json
{
  "fps": 24,
  "staggerFrames": 3,
  "targets": [
    { "layer": "Título",     "preset": "slideIn", "direction": "up",
      "distance": 40, "durationFrames": 12, "ease": "snap", "overshoot": 8 },
    { "layer": "Subtítulo",  "preset": "fadeIn",  "durationFrames": 10 },
    { "layer": "Seta / Esquerda", "preset": "drawOn", "durationFrames": 18 }
  ]
}
\`\`\`

\`fps\` tem que ser o da comp — pegue de \`describe_project\` ou \`describe_comp\`.

## Tempo em frames, não em segundos

Frame é como um motion designer conta, e evita keyframe fora da grade: um valor em
segundos que não cai exatamente num frame produz keyframe entre frames, difícil de
selecionar na timeline e que faz a animação parecer trêmula sem motivo aparente.

\`startFrame\` (padrão 0) e \`durationFrames\` (**padrão 10**).

Dez frames é o default calibrado por quem usa a ferramenta: 0,42s a 24fps, 0,33s a
30fps, e um número redondo de arrastar na timeline quando quiser mais rápido ou mais
lento. Não mude sem motivo — a decisão de tempo é do designer, e ele ajusta o keyframe.

Acima de 1 segundo arrasta; abaixo de 3 frames o easing não é percebido e o resultado
parece um corte. Fora da faixa você recebe aviso, não erro.

## Presets

| Preset | O que faz | Parâmetros |
|---|---|---|
| \`fadeIn\` / \`fadeOut\` | opacidade | — |
| \`slideIn\` / \`slideOut\` | desliza, com fade junto | \`direction\`, \`distance\`, \`withFade\` |
| \`popIn\` / \`popOut\` | escala | \`fromScale\` |
| \`rotateIn\` | gira até a rotação atual | \`degrees\` |
| \`drawOn\` | contorno se desenhando (Trim Paths) | — |
| \`dropIn\` | cai de cima, bate e quica | \`distance\`, \`bounce\` |
| \`spin\` | rotação contínua, linear | \`turns\` ou \`degrees\` |
| \`swing\` | gira até um ângulo e volta | \`degrees\` |

\`direction\` é para onde o elemento **vai**: \`up\`, \`down\`, \`left\`, \`right\`.
\`"up"\` entra de baixo subindo.

\`drawOn\` só funciona em shape layer, e o Trim Paths é criado se não existir.

\`dropIn\` é para peso: o impacto acontece a 65% da duração e o resto é o quique,
porque distribuir igualmente faz a queda parecer flutuante. A queda **acelera** — ease
na chegada suavizaria o impacto, que é o oposto do que uma queda pede. \`bounce\` é a
altura do quique em % da distância; padrão 18, e 0 desliga.

\`spin\` ignora \`ease\` de propósito: rotação contínua é o único caso em que linear
é a escolha certa, porque qualquer easing cria um começo e um fim perceptíveis — e um
ponteiro de relógio não deve ter nenhum dos dois. Use \`turns\` para voltas inteiras
ou \`degrees\` para um ângulo específico.

\`swing\` volta ao ponto de partida, com o pico no meio. Ângulo negativo recua em vez
de avançar.

## Easing

\`ease\`: \`linear\`, \`easeIn\`, \`easeOut\`, \`easeInOut\`, \`snap\` (padrão).

A regra que resolve quase tudo: **desacelere na chegada**. O olho perdoa partida
abrupta, não parada abrupta. Por isso o padrão é \`snap\`, que é ease-out forte —
influência 75, o valor que dá o acabamento de motion moderno.

Use \`easeIn\` para saída (o elemento some sem pedir atenção) e \`easeInOut\` para
movimento entre dois pontos visíveis na tela. \`linear\` só para rotação contínua e
coisas que não devem ter início nem fim perceptíveis.

## Stagger

\`staggerFrames\` atrasa cada alvo em relação ao anterior. **2 a 4 frames** é a faixa
que funciona; mais que 5 com muitos itens faz a sequência arrastar.

O atraso segue a **ordem da lista \`targets\`**, não o índice da camada na timeline.
Ordene pela leitura do design — de cima para baixo, do foco para a periferia.
Escalonar por índice de camada dá resultado aleatório e parece erro.

## Overshoot

\`overshoot\` em porcentagem: passa do valor final e volta. É o que separa "animado"
de "animado bem". Faixa útil **5 a 15**; acima de 20 vira desenho animado e você
recebe aviso.

Não se aplica a fade — opacidade acima de 100 não existe.

## Antes de animar

Escala e rotação giram em torno da âncora. Se a âncora não estiver no centro do
conteúdo, \`popIn\` joga o elemento para o canto em vez de crescer no lugar. O
\`build_scene\` já centraliza por padrão; em camada que veio de outro lugar, confira
com \`describe_layer\`.

Keyframes existentes na propriedade são **substituídos**, e expressão ativa é
removida — com expressão no lugar, o keyframe escrito não teria efeito nenhum e a
falha seria invisível.

## Depois de animar

Chame \`save_frame\` em dois ou três instantes diferentes e olhe. Nenhuma chamada ter
dado erro não é a mesma coisa que o timing ter ficado bom.
`;
