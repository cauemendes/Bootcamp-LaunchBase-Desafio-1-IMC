/**
 * SceneSpec: validação e normalização.
 *
 * O formato "flat" (o que a IA devolve) é uma lista de elementos com um rótulo de
 * grupo. O formato "nested" (o que o ExtendScript consome) tem a hierarquia de
 * grupos remontada. `normalizeScene` faz a ponte.
 *
 * Ver docs/scene-spec.md para o contrato completo.
 */

import { normalizeHex } from "./color.js";
import { parsePathData } from "./svg-path.js";

export const SCENE_SPEC_VERSION = "1.0";

const SHAPE_TYPES = new Set(["rect", "ellipse", "polygon", "path", "star", "text", "image"]);

/** Como uma imagem se acomoda na caixa reservada para ela. */
const IMAGE_FITS = new Set(["cover", "contain", "stretch"]);
const LINE_CAPS = new Set(["butt", "round", "square"]);
const LINE_JOINS = new Set(["miter", "round", "bevel"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);


/** Quantas linhas o conteúdo tem. Uma, no mínimo, mesmo vazio. */
function contarLinhas(content) {
  if (typeof content !== "string" || content === "") return 1;
  return content.split("\n").length;
}

/** Comprimento da linha mais longa — é ela que define a largura do bloco. */
function maiorLinha(content) {
  if (typeof content !== "string") return 0;
  let maior = 0;
  for (const linha of content.split("\n")) maior = Math.max(maior, linha.length);
  return maior;
}

/**
 * Avisa quando dois textos são, na verdade, um texto de duas linhas.
 *
 * ── Por que isto merece uma conferência própria ───────────────────────────────
 * "Broad match" dentro de um botão é um texto com uma quebra de linha, não dois textos.
 * Reconstruído como dois, ele fica errado de três formas ao mesmo tempo: a entrelinha
 * vira a distância que o modelo chutou entre duas posições, editar a frase exige mexer
 * em duas camadas, e alinhar o bloco no botão passa a ser impossível sem mover as duas.
 *
 * É um erro que não parece erro numa conferência de tela — as palavras estão todas lá,
 * no lugar aproximado. Ele aparece na hora de editar, que é depois de o trabalho ter
 * sido entregue.
 *
 * A conferência é deliberadamente estreita: mesma fonte, mesmo corpo, mesmo alinhamento,
 * mesma cor, praticamente a mesma coluna, e distância vertical compatível com entrelinha.
 * Melhor deixar passar um caso duvidoso do que acusar um layout que era mesmo de dois
 * textos — aviso falso ensina a ignorar aviso.
 */
function avisarTextoPartido(elements, warnings) {
  const textos = [];

  elements.forEach((el, i) => {
    if (!el || !el.shape || el.shape.type !== "text") return;
    if (typeof el.shape.content !== "string") return;
    if (!isFiniteNumber(el.shape.x) || !isFiniteNumber(el.shape.y)) return;
    if (!isPositiveNumber(el.shape.fontSize)) return;
    textos.push({ i, s: el.shape, cor: el.fill?.color ?? null });
  });

  for (let a = 0; a < textos.length; a++) {
    for (let b = a + 1; b < textos.length; b++) {
      const um = textos[a];
      const outro = textos[b];

      if (um.s.fontSize !== outro.s.fontSize) continue;
      if ((um.s.fontFamily ?? "") !== (outro.s.fontFamily ?? "")) continue;
      if ((um.s.weight ?? "") !== (outro.s.weight ?? "")) continue;
      if ((um.s.align ?? "left") !== (outro.s.align ?? "left")) continue;
      if (um.cor !== outro.cor) continue;

      // Mesma coluna: tolerância de um décimo do corpo, que cobre arredondamento de
      // medição sem aceitar textos que só estão por perto.
      if (Math.abs(um.s.x - outro.s.x) > um.s.fontSize * 0.1) continue;

      // Distância vertical de entrelinha plausível. Abaixo de 0,9 seria sobreposição;
      // acima de 1,8 já é outro bloco de texto.
      const dy = Math.abs(um.s.y - outro.s.y);
      if (dy < um.s.fontSize * 0.9 || dy > um.s.fontSize * 1.8) continue;

      const acima = um.s.y < outro.s.y ? um : outro;
      const abaixo = um.s.y < outro.s.y ? outro : um;

      warnings.push(
        `elements[${um.i}] e elements[${outro.i}] parecem ser UM texto de duas linhas ` +
          `partido em dois: mesma fonte, mesmo corpo, mesma coluna, e ` +
          `${Math.round(dy)}px de distância vertical. Junte num só elemento, com "\\n" ` +
          `no content ("${acima.s.content}\\n${abaixo.s.content}"), posicionado na ` +
          `baseline da PRIMEIRA linha, e informe lineHeight: ${Math.round(dy)}. Em duas ` +
          `camadas a entrelinha não é editável e o bloco não se alinha como um só.`
      );
    }
  }
}

/**
 * Valida um SceneSpec flat.
 *
 * Separa erros (impedem a construção) de avisos (a construção segue, mas o
 * resultado pode não bater com a imagem). Modelos de visão erram devagar: mandam
 * uma cor fora de faixa, um raio negativo, um elemento fora do canvas. Nada disso
 * deve derrubar o build inteiro — o painel mostra os avisos e constrói o resto.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateScene(scene) {
  const errors = [];
  const warnings = [];

  if (!scene || typeof scene !== "object") {
    return { ok: false, errors: ["SceneSpec não é um objeto"], warnings };
  }

  if (scene.version !== SCENE_SPEC_VERSION) {
    warnings.push(
      `version é "${scene.version}", esperava "${SCENE_SPEC_VERSION}" — seguindo assim mesmo`
    );
  }

  // --- canvas ---
  const c = scene.canvas;
  if (!c || typeof c !== "object") {
    errors.push("canvas ausente");
  } else {
    if (!isPositiveNumber(c.width)) errors.push("canvas.width precisa ser um número positivo");
    if (!isPositiveNumber(c.height)) errors.push("canvas.height precisa ser um número positivo");
    if (c.background != null) {
      try {
        normalizeHex(c.background);
      } catch (e) {
        warnings.push(`canvas.background inválido (${c.background}) — tratando como sem fundo`);
      }
    }
    if (c.frameRate != null && !isPositiveNumber(c.frameRate)) {
      warnings.push("canvas.frameRate inválido — usando 30");
    }
    if (c.duration != null && !isPositiveNumber(c.duration)) {
      warnings.push("canvas.duration inválido — usando 10");
    }
  }

  // --- elements ---
  if (!Array.isArray(scene.elements)) {
    errors.push("elements precisa ser um array");
    return { ok: errors.length === 0, errors, warnings };
  }
  if (scene.elements.length === 0) {
    warnings.push("elements está vazio — nada será construído");
  }

  const seenIds = new Set();

  scene.elements.forEach((el, i) => {
    const at = `elements[${i}]`;

    if (!el || typeof el !== "object") {
      errors.push(`${at} não é um objeto`);
      return;
    }

    if (typeof el.id !== "string" || el.id === "") {
      errors.push(`${at}.id ausente`);
    } else if (seenIds.has(el.id)) {
      warnings.push(`${at}.id "${el.id}" duplicado — vai gerar layers com nome repetido`);
    } else {
      seenIds.add(el.id);
    }

    if (!el.shape || typeof el.shape !== "object") {
      errors.push(`${at}.shape ausente`);
      return;
    }
    if (!SHAPE_TYPES.has(el.shape.type)) {
      errors.push(`${at}.shape.type desconhecido: ${JSON.stringify(el.shape.type)}`);
      return;
    }

    validateShape(el.shape, at, errors, warnings, scene.canvas);
    validatePaint(el.fill, `${at}.fill`, false, errors, warnings);
    validatePaint(el.stroke, `${at}.stroke`, true, errors, warnings);

    if (el.shape.type !== "text" && el.fill == null && el.stroke == null) {
      warnings.push(`${at} não tem fill nem stroke — será invisível na comp`);
    }
  });

  avisarTextoPartido(scene.elements, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

function validateShape(shape, at, errors, warnings, canvas) {
  const need = (field) => {
    if (!isFiniteNumber(shape[field])) {
      errors.push(`${at}.shape.${field} precisa ser um número`);
      return false;
    }
    return true;
  };

  switch (shape.type) {
    case "rect": {
      ["x", "y", "w", "h"].forEach(need);
      if (isFiniteNumber(shape.w) && shape.w <= 0) errors.push(`${at}.shape.w precisa ser > 0`);
      if (isFiniteNumber(shape.h) && shape.h <= 0) errors.push(`${at}.shape.h precisa ser > 0`);
      if (isFiniteNumber(shape.roundness) && shape.roundness < 0) {
        warnings.push(`${at}.shape.roundness negativo — usando 0`);
      }
      break;
    }
    case "ellipse": {
      ["cx", "cy", "rx", "ry"].forEach(need);
      if (isFiniteNumber(shape.rx) && shape.rx <= 0) errors.push(`${at}.shape.rx precisa ser > 0`);
      if (isFiniteNumber(shape.ry) && shape.ry <= 0) errors.push(`${at}.shape.ry precisa ser > 0`);
      break;
    }
    case "polygon": {
      if (!Array.isArray(shape.points) || shape.points.length < 2) {
        errors.push(`${at}.shape.points precisa ter pelo menos 2 pontos`);
      } else if (!shape.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isFiniteNumber))) {
        errors.push(`${at}.shape.points tem entrada malformada (esperava [[x,y], ...])`);
      }
      break;
    }
    case "path": {
      if (typeof shape.d !== "string" || shape.d.trim() === "") {
        errors.push(`${at}.shape.d ausente`);
      } else {
        try {
          parsePathData(shape.d);
        } catch (e) {
          errors.push(`${at}.shape.d não pôde ser lido: ${e.message}`);
        }
      }
      break;
    }
    case "star": {
      ["cx", "cy", "outerRadius", "innerRadius"].forEach(need);
      if (!Number.isInteger(shape.points) || shape.points < 3) {
        errors.push(`${at}.shape.points precisa ser inteiro >= 3`);
      }
      if (isFiniteNumber(shape.outerRadius) && isFiniteNumber(shape.innerRadius) &&
          shape.innerRadius > shape.outerRadius) {
        warnings.push(`${at}: innerRadius > outerRadius — a estrela vai sair invertida`);
      }
      break;
    }
    case "image": {
      // Foto, textura, logo — o que não é vetor e não deve ser aproximado com formas.
      // Redesenhar uma fotografia com shapes produz algo pior que um placeholder
      // honesto, e redesenhar um logo é pior ainda: ele tem versão oficial, e uma
      // aproximação feita de print é uso indevido de marca.
      ["x", "y", "w", "h"].forEach(need);
      if (isFiniteNumber(shape.w) && shape.w <= 0) errors.push(`${at}.shape.w precisa ser > 0`);
      if (isFiniteNumber(shape.h) && shape.h <= 0) errors.push(`${at}.shape.h precisa ser > 0`);

      if (shape.source != null && (typeof shape.source !== "string" || shape.source === "")) {
        errors.push(`${at}.shape.source precisa ser o caminho do arquivo, ou um nome de asset da marca`);
      }

      if (shape.fit != null && !IMAGE_FITS.has(shape.fit)) {
        warnings.push(`${at}.shape.fit inválido (${shape.fit}) — usando "cover"`);
      }

      if (shape.source == null) {
        warnings.push(
          `${at} vai entrar como PLACEHOLDER — sem \`source\`, não há arquivo para colocar. ` +
            "A camada fica marcada em laranja na timeline para você trocar pela imagem real."
        );
      }
      break;
    }

    case "text": {
      ["x", "y", "fontSize"].forEach(need);
      if (typeof shape.content !== "string" || shape.content === "") {
        errors.push(`${at}.shape.content ausente`);
      }
      if (shape.align != null && !TEXT_ALIGNS.has(shape.align)) {
        warnings.push(`${at}.shape.align inválido (${shape.align}) — usando "left"`);
      }
      if (typeof shape.content === "string" && shape.content.indexOf("\n") !== -1 && !shape.lineHeight) {
        warnings.push(
          `${at}: texto de várias linhas sem lineHeight — o After Effects vai usar ` +
            `1,2 × o corpo, que costuma ficar mais solto que o original. Meça de ` +
            `baseline a baseline.`
        );
      }
      if (typeof shape.fontFamily !== "string" || shape.fontFamily === "") {
        warnings.push(`${at}: sem fontFamily — o AE vai usar a fonte padrão`);
      }
      break;
    }
  }

  // Aviso de enquadramento: não é erro, mas quase sempre indica que o modelo se
  // confundiu com a escala da imagem.
  if (canvas && isPositiveNumber(canvas.width) && isPositiveNumber(canvas.height)) {
    const b = shapeBounds(shape);
    if (b && (b.x + b.width < 0 || b.y + b.height < 0 || b.x > canvas.width || b.y > canvas.height)) {
      warnings.push(`${at} está inteiramente fora do canvas`);
    }
  }
}

function validatePaint(paint, at, isStroke, errors, warnings) {
  if (paint == null) return;
  if (typeof paint !== "object") {
    errors.push(`${at} precisa ser um objeto ou null`);
    return;
  }

  if (paint.type === "gradient") {
    validateGradient(paint, at, errors, warnings);
  } else {
    try {
      normalizeHex(paint.color);
    } catch (e) {
      errors.push(`${at}.color: ${e.message}`);
    }
  }

  if (paint.opacity != null && (!isFiniteNumber(paint.opacity) || paint.opacity < 0 || paint.opacity > 100)) {
    warnings.push(`${at}.opacity fora de 0–100 — será limitado`);
  }

  if (isStroke) {
    if (!isFiniteNumber(paint.width) || paint.width <= 0) {
      errors.push(`${at}.width precisa ser um número > 0`);
    }
    if (paint.cap != null && !LINE_CAPS.has(paint.cap)) {
      warnings.push(`${at}.cap inválido (${paint.cap}) — usando "butt"`);
    }
    if (paint.join != null && !LINE_JOINS.has(paint.join)) {
      warnings.push(`${at}.join inválido (${paint.join}) — usando "miter"`);
    }
  }
}

/** Bounding box aproximado de um shape, em coordenadas de canvas. */
export function shapeBounds(shape) {
  switch (shape.type) {
    case "rect":
    case "image":
      return { x: shape.x, y: shape.y, width: shape.w, height: shape.h };
    case "ellipse":
      return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, width: shape.rx * 2, height: shape.ry * 2 };
    case "star":
      return {
        x: shape.cx - shape.outerRadius,
        y: shape.cy - shape.outerRadius,
        width: shape.outerRadius * 2,
        height: shape.outerRadius * 2,
      };
    case "polygon": {
      if (!Array.isArray(shape.points) || shape.points.length === 0) return null;
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
    }
    case "path": {
      try {
        const subpaths = parsePathData(shape.d);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const sp of subpaths) {
          for (const [x, y] of sp.vertices) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
        return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      } catch {
        return null;
      }
    }
    case "text":
      // Sem métricas de fonte aqui, isso é um palpite grosseiro. Serve pra centrar
      // âncora e pra checar enquadramento, não pra layout.
      return {
        x: shape.x,
        y: shape.y - shape.fontSize,
        // Conta as linhas: a estimativa alimenta o aviso de enquadramento, e um texto
        // de duas linhas medido como uma sempre pareceria caber.
        width: maiorLinha(shape.content) * shape.fontSize * 0.55,
        height: contarLinhas(shape.content) * (shape.lineHeight || shape.fontSize * 1.2),
      };
    default:
      return null;
  }
}

/**
 * Flat → nested. Ordena por `z`, agrupa e monta a estrutura que o construtor
 * ExtendScript espera.
 *
 * @param {object} scene           SceneSpec flat
 * @param {object} [options]
 * @param {"per-group"|"per-element"} [options.layerMode="per-group"]
 *   "per-group"   — elementos com o mesmo `group` viram UMA shape layer com um
 *                   grupo interno por elemento. É como um designer montaria um logo
 *                   à mão: a peça inteira anima junta, e cada parte também.
 *   "per-element" — cada elemento vira sua própria shape layer. Mais liberdade
 *                   (efeitos, máscaras, blend modes por peça), mais layers.
 */
export function normalizeScene(scene, options = {}) {
  const layerMode = options.layerMode ?? "per-group";

  const canvas = {
    width: scene.canvas.width,
    height: scene.canvas.height,
    background: safeHex(scene.canvas.background),
    frameRate: isPositiveNumber(scene.canvas.frameRate) ? scene.canvas.frameRate : 30,
    duration: isPositiveNumber(scene.canvas.duration) ? scene.canvas.duration : 10,
  };

  // Ordem estável: por `z`, empates mantendo a ordem original.
  const sorted = scene.elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => (numOr(a.el.z, 0) - numOr(b.el.z, 0)) || (a.i - b.i))
    .map(({ el }) => el);

  const layers = [];

  // Texto nunca entra numa shape layer — no AE é um tipo de layer diferente.
  // Cada elemento de texto vira sua própria layer, independente do layerMode.
  const buckets = new Map();

  for (const el of sorted) {
    // Imagem e texto são tipos de camada próprios no AE, e nenhum dos dois cabe dentro
    // de um shape layer. Os dois saem daqui antes do agrupamento — o `continue` é o que
    // impede o elemento de virar camada E item de grupo ao mesmo tempo.
    if (el.shape.type === "image") {
      layers.push(buildImageLayer(el));
      continue;
    }

    if (el.shape.type === "text") {
      layers.push(buildTextLayer(el));
      continue;
    }

    const key = layerMode === "per-element" ? el.id : (el.group || `__solo__${el.id}`);
    if (!buckets.has(key)) {
      buckets.set(key, { name: el.group || el.name || el.id, elements: [] });
      layers.push({ __bucketKey: key });
    }
    buckets.get(key).elements.push(el);
  }

  // Substitui os marcadores de bucket pelas shape layers de fato.
  const built = layers.map((entry) => {
    if (!entry.__bucketKey) return entry;
    const bucket = buckets.get(entry.__bucketKey);
    return buildShapeLayer(bucket.name, bucket.elements);
  });

  return {
    version: SCENE_SPEC_VERSION,
    canvas,
    palette: Array.isArray(scene.palette) ? scene.palette : [],
    layers: built,
  };
}

function buildShapeLayer(name, elements) {
  return {
    type: "shape",
    name,
    // No AE, o primeiro item de "Contents" é desenhado por ÚLTIMO (fica na frente).
    // Nosso array está em ordem de trás pra frente, então invertemos aqui — assim o
    // construtor pode só percorrer em ordem e chamar addProperty.
    contents: elements
      .slice()
      .reverse()
      .map((el) => ({
        type: "group",
        name: el.name || el.id,
        id: el.id,
        items: buildGroupItems(el),
      })),
  };
}

/**
 * Itens dentro de um grupo do AE, na ordem em que devem ser adicionados.
 *
 * Ordem importa: no AE, um Fill/Stroke pinta os paths que estão ACIMA dele na
 * lista. Geometria primeiro, depois stroke, depois fill — assim o fill fica por
 * baixo do stroke, que é o comportamento que a maioria dos designs assume.
 */
function buildGroupItems(el) {
  const items = [{ kind: "geometry", shape: resolveGeometry(el.shape) }];
  if (el.stroke) items.push({ kind: "stroke", ...normalizePaint(el.stroke, true) });
  if (el.fill) items.push({ kind: "fill", ...normalizePaint(el.fill, false) });
  return items;
}

/**
 * Converte a geometria para a forma que o ExtendScript consegue construir direto.
 *
 * `rect`, `ellipse` e `star` passam intactos — no AE eles têm primitivas nativas
 * com parâmetros editáveis (tamanho, raio, número de pontas), e transformar isso em
 * um path de vértices seria jogar fora exatamente a editabilidade que a ferramenta
 * existe pra entregar.
 *
 * `polygon` e `path` viram uma lista de subpaths bezier. O parser de SVG mora aqui,
 * no core, onde tem teste — o adapter ExtendScript recebe só vértices e tangentes.
 */
function resolveGeometry(shape) {
  switch (shape.type) {
    case "polygon": {
      const vertices = shape.points.map((p) => [p[0], p[1]]);
      const zeros = vertices.map(() => [0, 0]);
      return {
        type: "bezier",
        subpaths: [
          {
            closed: shape.closed !== false,
            vertices,
            inTangents: zeros,
            outTangents: zeros.map(() => [0, 0]),
          },
        ],
      };
    }

    case "path":
      return { type: "bezier", subpaths: parsePathData(shape.d) };

    case "rect":
      return {
        type: "rect",
        // O AE posiciona retângulo pelo CENTRO; o SceneSpec usa o canto superior
        // esquerdo, que é o que uma ferramenta de design reporta.
        cx: shape.x + shape.w / 2,
        cy: shape.y + shape.h / 2,
        w: shape.w,
        h: shape.h,
        roundness: Math.max(0, numOr(shape.roundness, 0)),
        rotation: numOr(shape.rotation, 0),
      };

    case "ellipse":
      return { type: "ellipse", cx: shape.cx, cy: shape.cy, w: shape.rx * 2, h: shape.ry * 2 };

    case "star":
      return {
        type: "star",
        cx: shape.cx,
        cy: shape.cy,
        points: shape.points,
        outerRadius: shape.outerRadius,
        innerRadius: shape.innerRadius,
        rotation: numOr(shape.rotation, 0),
        // innerRadius == outerRadius vira polígono regular; o AE tem uma flag
        // separada pra isso (1 = estrela, 2 = polígono).
        isPolygon: shape.innerRadius >= shape.outerRadius,
      };

    default:
      throw new Error(`resolveGeometry: tipo não suportado "${shape.type}"`);
  }
}

/**
 * Camada de imagem: um arquivo colocado na caixa, ou um placeholder marcado.
 *
 * `label` é o que o designer vai ler na timeline quando não houver arquivo. Vale mais
 * que o nome do elemento porque descreve o conteúdo esperado — "foto do produto em
 * fundo claro" diz o que colocar; "Imagem 3" não diz nada.
 */
function buildImageLayer(el) {
  const s = el.shape;

  return {
    type: "image",
    name: el.name || el.id,
    id: el.id,
    x: s.x,
    y: s.y,
    width: s.w,
    height: s.h,
    source: typeof s.source === "string" && s.source !== "" ? s.source : null,
    fit: IMAGE_FITS.has(s.fit) ? s.fit : "cover",
    label: typeof s.label === "string" ? s.label : "",
    opacity: clamp(numOr(el.fill?.opacity, 100), 0, 100),
  };
}

function buildTextLayer(el) {
  const s = el.shape;
  return {
    type: "text",
    name: el.name || el.id,
    id: el.id,
    content: s.content,
    x: s.x,
    y: s.y,
    fontFamily: s.fontFamily || "",
    fontSize: s.fontSize,
    weight: s.weight || "",
    align: TEXT_ALIGNS.has(s.align) ? s.align : "left",
    letterSpacing: numOr(s.letterSpacing, 0),
    // Entrelinha em pixels, medida de baseline a baseline. Zero significa "deixe o
    // After Effects decidir" — ele usa 1,2 × o corpo, que é solto para a maioria dos
    // designs mas é um padrão honesto quando ninguém mediu.
    lineHeight: numOr(s.lineHeight, 0),
    color: safeHex(el.fill?.color) || "#ffffff",
    opacity: clamp(numOr(el.fill?.opacity, 100), 0, 100),
  };
}

/**
 * Confere um gradiente.
 *
 * As duas cores são validadas mesmo o After Effects não aceitando definir paradas de
 * gradiente por script. Elas não são decoração: vão para o nome do grupo e para o
 * aviso, e é com elas que o designer preenche o gradiente em dois cliques. Aceitar um
 * hex inválido aqui só transferiria o erro para o momento em que ele fosse ler o
 * valor na tela.
 */
function validateGradient(paint, at, errors, warnings) {
  for (const campo of ["from", "to"]) {
    try {
      normalizeHex(paint[campo]);
    } catch (e) {
      errors.push(`${at}.${campo}: ${e.message}`);
    }
  }

  if (paint.kind != null && paint.kind !== "linear" && paint.kind !== "radial") {
    warnings.push(`${at}.kind inválido (${paint.kind}) — usando "linear"`);
  }

  for (const ponto of ["start", "end"]) {
    const v = paint[ponto];
    if (v == null) continue;
    if (!Array.isArray(v) || v.length !== 2 || !v.every(isFiniteNumber)) {
      errors.push(`${at}.${ponto} precisa ser [x, y] em pixels do canvas`);
    }
  }
}

function normalizePaint(paint, isStroke) {
  if (paint.type === "gradient") return normalizeGradient(paint, isStroke);

  const out = {
    color: safeHex(paint.color) || "#000000",
    opacity: clamp(numOr(paint.opacity, 100), 0, 100),
  };
  if (isStroke) {
    out.width = Math.max(0, numOr(paint.width, 1));
    out.cap = LINE_CAPS.has(paint.cap) ? paint.cap : "butt";
    out.join = LINE_JOINS.has(paint.join) ? paint.join : "miter";
  }
  return out;
}

/**
 * Gradiente normalizado para o adapter.
 *
 * `from` e `to` seguem viajando embora o After Effects não deixe defini-las por
 * script: o adapter as usa no nome do grupo e no aviso, para o designer saber quais
 * cores colocar sem voltar na imagem original.
 */
function normalizeGradient(paint, isStroke) {
  const out = {
    paint: "gradient",
    // `gradient`, não `kind`: quem chama monta `{ kind: "fill", ...aqui }`, e um campo
    // `kind` neste objeto sobrescreveria "fill" ou "stroke" no spread — o adapter
    // deixaria de saber se pinta o interior ou o contorno, sem erro nenhum.
    gradient: paint.kind === "radial" ? "radial" : "linear",
    from: safeHex(paint.from) || "#000000",
    to: safeHex(paint.to) || "#ffffff",
    start: Array.isArray(paint.start) ? [numOr(paint.start[0], 0), numOr(paint.start[1], 0)] : null,
    end: Array.isArray(paint.end) ? [numOr(paint.end[0], 0), numOr(paint.end[1], 0)] : null,
    opacity: clamp(numOr(paint.opacity, 100), 0, 100),
  };

  if (isStroke) {
    out.width = Math.max(0, numOr(paint.width, 1));
    out.cap = LINE_CAPS.has(paint.cap) ? paint.cap : "butt";
    out.join = LINE_JOINS.has(paint.join) ? paint.join : "miter";
  }

  return out;
}

// --- helpers ---

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveNumber(v) {
  return isFiniteNumber(v) && v > 0;
}

function numOr(v, fallback) {
  return isFiniteNumber(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function safeHex(v) {
  if (v == null) return null;
  try {
    return normalizeHex(v);
  } catch {
    return null;
  }
}
