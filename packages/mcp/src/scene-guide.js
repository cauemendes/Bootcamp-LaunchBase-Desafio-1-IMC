/**
 * Guia do SceneSpec, entregue sob demanda pela ferramenta `describe_scene_format`.
 *
 * Fica fora da descrição de `build_scene` de propósito: descrição de ferramenta
 * ocupa contexto em *toda* conversa com o servidor, e este texto só interessa a quem
 * vai de fato construir uma cena. Divulgação progressiva.
 */

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

\`name\` é o nome que a camada terá na timeline. Escreva como um designer escreveria:
"Botão / Fundo", "Título", "Ícone / Seta" — o papel do elemento, não a forma dele.

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

**Cores repetidas usam exatamente o mesmo hex.** Amostre do meio das áreas chapadas,
longe das bordas, que estão suavizadas e devolvem cor errada.

**Marca antes de cor medida.** Chame \`describe_brand\` antes de construir. Havendo
marca configurada, escreva o nome no lugar do hexadecimal:

\`\`\`json
"fill": { "color": "primary" },
"shape": { "type": "text", "fontFamily": "heading", "…": "…" }
\`\`\`

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

## Não suportado

**Gradiente.** Verificado: a propriedade de paradas de gradiente do After Effects não
é acessível por script (\`propertyValueType\` é \`NO_VALUE\`). Para uma área com
gradiente, use a cor média chapada.

Sombra, blur e textura também não têm representação no formato — aplique como efeito
depois, via \`execute_script\`.
`;
