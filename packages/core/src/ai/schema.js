/**
 * JSON Schema do SceneSpec flat, para `output_config.format`.
 *
 * Três restrições de structured outputs moldam este schema — vale saber por quê
 * antes de mexer:
 *
 *  1. **Sem recursão.** Por isso `elements` é uma lista plana com um campo `group`
 *     de texto, em vez de grupos aninhados. `normalizeScene()` remonta a
 *     hierarquia depois.
 *  2. **`additionalProperties: false` em todo objeto**, e `required` listando
 *     TODAS as propriedades. Não existe campo opcional — o que seria opcional vira
 *     `anyOf` com `null`.
 *  3. **Sem restrições numéricas** (`minimum`, `maximum`, `minLength`...). Elas são
 *     silenciosamente ignoradas, então as faixas válidas vão descritas em
 *     `description` (o modelo lê) e são checadas em `validateScene()`.
 */

const paint = (extra = {}) => ({
  type: "object",
  properties: {
    color: { type: "string", description: 'Cor em hex, formato "#RRGGBB".' },
    opacity: { type: "number", description: "Opacidade de 0 a 100." },
    ...extra,
  },
  required: ["color", "opacity", ...Object.keys(extra)],
  additionalProperties: false,
});

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const point = {
  type: "array",
  items: { type: "number" },
  description: "Par [x, y] em pixels de canvas.",
};

export const SHAPE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      description: "Retângulo, opcionalmente com cantos arredondados.",
      properties: {
        type: { type: "string", enum: ["rect"] },
        x: { type: "number", description: "Canto superior esquerdo, eixo X." },
        y: { type: "number", description: "Canto superior esquerdo, eixo Y." },
        w: { type: "number", description: "Largura em pixels, maior que 0." },
        h: { type: "number", description: "Altura em pixels, maior que 0." },
        roundness: { type: "number", description: "Raio dos cantos em pixels; 0 se for canto reto." },
        rotation: { type: "number", description: "Rotação em graus, sentido horário. 0 se não estiver rotacionado." },
      },
      required: ["type", "x", "y", "w", "h", "roundness", "rotation"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Elipse ou círculo.",
      properties: {
        type: { type: "string", enum: ["ellipse"] },
        cx: { type: "number", description: "Centro, eixo X." },
        cy: { type: "number", description: "Centro, eixo Y." },
        rx: { type: "number", description: "Raio horizontal." },
        ry: { type: "number", description: "Raio vertical. Igual a rx se for círculo." },
      },
      required: ["type", "cx", "cy", "rx", "ry"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Polígono de lados retos, definido por vértices.",
      properties: {
        type: { type: "string", enum: ["polygon"] },
        points: { type: "array", items: point, description: "Vértices em ordem, [[x,y], ...]." },
        closed: { type: "boolean", description: "true se o último vértice liga de volta no primeiro." },
      },
      required: ["type", "points", "closed"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Forma livre com curvas, em dados de path SVG.",
      properties: {
        type: { type: "string", enum: ["path"] },
        d: {
          type: "string",
          description:
            'Atributo "d" de path SVG. Comandos suportados: M L H V C S Q T Z (maiúsculos e ' +
            "minúsculos). NÃO use o comando de arco A/a — aproxime arcos com curvas C.",
        },
      },
      required: ["type", "d"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Estrela ou polígono regular.",
      properties: {
        type: { type: "string", enum: ["star"] },
        cx: { type: "number", description: "Centro, eixo X." },
        cy: { type: "number", description: "Centro, eixo Y." },
        points: { type: "integer", description: "Número de pontas, 3 ou mais." },
        outerRadius: { type: "number", description: "Raio até as pontas." },
        innerRadius: {
          type: "number",
          description: "Raio até os vales. Igual a outerRadius para polígono regular.",
        },
        rotation: { type: "number", description: "Rotação em graus, sentido horário." },
      },
      required: ["type", "cx", "cy", "points", "outerRadius", "innerRadius", "rotation"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Texto. Vira uma camada de texto nativa do After Effects.",
      properties: {
        type: { type: "string", enum: ["text"] },
        x: { type: "number", description: "Ponto de ancoragem do texto, eixo X." },
        y: { type: "number", description: "Baseline do texto, eixo Y." },
        content: {
          type: "string",
          description:
            "O texto exatamente como aparece na imagem. Texto de VÁRIAS LINHAS vai num " +
            'elemento só, com "\\n" entre as linhas — nunca em dois elementos. Dois ' +
            "elementos deixam a entrelinha não-editável e o bloco impossível de alinhar " +
            "como um só.",
        },
        fontFamily: {
          type: "string",
          description:
            'Nome da família da fonte, o mais próximo que der ("Helvetica", "Arial", ' +
            '"Futura"). String vazia se não conseguir identificar.',
        },
        fontSize: { type: "number", description: "Corpo da fonte em pixels." },
        weight: {
          type: "string",
          description:
            'Peso/estilo: "Regular", "Bold", "Light", "Medium"... Olhe a imagem e decida: ' +
            "texto de rótulo, botão e título quase sempre é Bold. Deixar vazio NÃO é " +
            "neutro — o After Effects cai em Regular sem avisar, e um rótulo bold saindo " +
            "regular salta aos olhos. Chutar errado é um clique para corrigir.",
        },
        align: { type: "string", enum: ["left", "center", "right"] },
        letterSpacing: { type: "number", description: "Tracking em milésimos de em; 0 se for normal." },
        lineHeight: {
          type: "number",
          description:
            "Entrelinha em pixels, medida de baseline a baseline. Obrigatória quando o " +
            "content tem mais de uma linha; 0 quando é uma linha só. Sem ela o After " +
            "Effects usa 1,2 × o corpo, que quase sempre é mais solto que o original.",
        },
      },
      required: [
        "type", "x", "y", "content", "fontFamily", "fontSize", "weight", "align",
        "letterSpacing", "lineHeight",
      ],
      additionalProperties: false,
    },
  ],
};

export const SCENE_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", description: 'Sempre "1.0".' },
    canvas: {
      type: "object",
      properties: {
        width: { type: "number", description: "Largura da imagem em pixels." },
        height: { type: "number", description: "Altura da imagem em pixels." },
        background: nullable({
          type: "string",
          description: 'Cor de fundo em hex "#RRGGBB", ou null se o design não tiver fundo sólido.',
        }),
        frameRate: { type: "number", description: "Frame rate da comp. Use 30 salvo instrução em contrário." },
        duration: { type: "number", description: "Duração da comp em segundos. Use 10." },
      },
      required: ["width", "height", "background", "frameRate", "duration"],
      additionalProperties: false,
    },
    palette: {
      type: "array",
      description: "Cores distintas do design, nomeadas pelo papel que exercem.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: 'Nome descritivo, ex: "Brand/Primary", "Texto/Escuro".' },
          hex: { type: "string", description: 'Cor em hex "#RRGGBB".' },
        },
        required: ["name", "hex"],
        additionalProperties: false,
      },
    },
    elements: {
      type: "array",
      description: "Todo elemento visível do design, de trás para frente.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identificador único em kebab-case." },
          name: {
            type: "string",
            description:
              "Nome legível da camada, como um designer nomearia no After Effects. " +
              'Ex: "Botão / Fundo", "Título", "Ícone / Seta".',
          },
          group: {
            type: "string",
            description:
              "Rótulo do agrupamento lógico. Elementos que formam uma unidade (um logo, " +
              'um botão, um card) compartilham o mesmo rótulo. String vazia se o elemento ' +
              "for solto.",
          },
          z: {
            type: "integer",
            description: "Ordem de pintura. 0 é o mais atrás; números maiores ficam na frente.",
          },
          shape: SHAPE_SCHEMA,
          fill: nullable(paint()),
          stroke: nullable(
            paint({
              width: { type: "number", description: "Espessura do traço em pixels." },
              cap: { type: "string", enum: ["butt", "round", "square"] },
              join: { type: "string", enum: ["miter", "round", "bevel"] },
            })
          ),
        },
        required: ["id", "name", "group", "z", "shape", "fill", "stroke"],
        additionalProperties: false,
      },
    },
  },
  required: ["version", "canvas", "palette", "elements"],
  additionalProperties: false,
};
