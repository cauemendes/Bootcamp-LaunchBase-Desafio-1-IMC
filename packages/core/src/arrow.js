/**
 * Setas: de dois pontos para traço + ponta, com a ponta no ângulo certo.
 *
 * ── Por que isto merece um módulo ─────────────────────────────────────────────
 * O After Effects não tem seta. Uma seta é um path com stroke mais um triângulo
 * preenchido, e o triângulo precisa estar exatamente na ponta do path, girado para a
 * direção em que o path chega ali. Num traço curvo, essa direção é a tangente no fim
 * da curva — não a direção de A para B.
 *
 * Deixar isso para o modelo é pedir o erro que já apareceu: ponta deslocada, ponta
 * girada errado, ponta boiando fora do traço, e o traço aparecendo por dentro do
 * triângulo. São quatro erros distintos, todos de trigonometria, e nenhum deles é sobre
 * design — é exatamente o tipo de cálculo que não pertence a quem está olhando a imagem.
 *
 * O resultado continua editável: o traço é um path bezier e a ponta é um triângulo de
 * três vértices. O designer arrasta qualquer um dos dois no After Effects.
 */

/** Ponta com este tamanho relativo ao stroke fica parecida com o que se desenha à mão. */
const HEAD_POR_STROKE = 3.6;
const HEAD_MINIMO = 8;
/** Largura da base em relação ao comprimento. Menor que 1 dá a ponta afilada usual. */
const PROPORCAO_LARGURA = 0.78;

export class ArrowError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArrowError";
  }
}

const num = (v) => typeof v === "number" && Number.isFinite(v);
const arred = (v) => Math.round(v * 100) / 100;

/**
 * Calcula os pontos de uma seta.
 *
 * @param {Object} spec
 * @param {number} spec.x1  origem
 * @param {number} spec.y1
 * @param {number} spec.x2  ponta (é aqui que o triângulo encosta)
 * @param {number} spec.y2
 * @param {number} [spec.bend]        curvatura em px, perpendicular à reta A→B.
 *                                    Positivo curva para um lado, negativo para o outro.
 * @param {number} [spec.headLength]  comprimento da ponta
 * @param {number} [spec.headWidth]   largura da base da ponta
 * @param {number} [spec.strokeWidth] espessura do traço, usada para dimensionar a ponta
 * @returns {{ shaft: string, head: number[][], angle: number }}
 *          `shaft` é path data SVG; `head` são os três vértices; `angle` em graus.
 */
export function arrowGeometry(spec) {
  if (spec == null || typeof spec !== "object") {
    throw new ArrowError("A seta precisa de um objeto com x1, y1, x2, y2.");
  }

  const { x1, y1, x2, y2 } = spec;
  for (const [nome, v] of [["x1", x1], ["y1", y1], ["x2", x2], ["y2", y2]]) {
    if (!num(v)) throw new ArrowError(`A seta precisa de ${nome} numérico.`);
  }

  const dx = x2 - x1;
  const dy = y2 - y1;
  const comprimento = Math.hypot(dx, dy);

  if (comprimento === 0) {
    throw new ArrowError("A seta tem origem e ponta no mesmo lugar — não há direção.");
  }

  const stroke = num(spec.strokeWidth) && spec.strokeWidth > 0 ? spec.strokeWidth : 2;
  const headLength = num(spec.headLength) && spec.headLength > 0
    ? spec.headLength
    : Math.max(HEAD_MINIMO, stroke * HEAD_POR_STROKE);
  const headWidth = num(spec.headWidth) && spec.headWidth > 0
    ? spec.headWidth
    : headLength * PROPORCAO_LARGURA;

  const bend = num(spec.bend) ? spec.bend : 0;

  // Controle da quadrática: meio da reta, deslocado na perpendicular. É a forma mais
  // previsível de descrever curvatura para quem está olhando uma imagem — "curva 40px
  // para cima" é observável; um par de tangentes de Bézier, não.
  const perpX = -dy / comprimento;
  const perpY = dx / comprimento;
  const cx = (x1 + x2) / 2 + perpX * bend;
  const cy = (y1 + y2) / 2 + perpY * bend;

  // Direção de chegada. Numa quadrática é a tangente no fim — do controle para a ponta.
  // Usar A→B aqui é o erro que deixa a ponta torta em toda seta curva.
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tam = Math.hypot(tx, ty) || comprimento;
  const dirX = tx / tam;
  const dirY = ty / tam;

  // O traço termina na base do triângulo, não na ponta: sobreposto, o stroke aparece
  // por dentro da ponta e engrossa o bico.
  const baseX = x2 - dirX * headLength;
  const baseY = y2 - dirY * headLength;

  const ladoX = -dirY * (headWidth / 2);
  const ladoY = dirX * (headWidth / 2);

  const shaft = bend === 0
    ? `M ${arred(x1)} ${arred(y1)} L ${arred(baseX)} ${arred(baseY)}`
    : `M ${arred(x1)} ${arred(y1)} Q ${arred(cx)} ${arred(cy)} ${arred(baseX)} ${arred(baseY)}`;

  return {
    shaft,
    head: [
      [arred(x2), arred(y2)],
      [arred(baseX + ladoX), arred(baseY + ladoY)],
      [arred(baseX - ladoX), arred(baseY - ladoY)],
    ],
    angle: arred((Math.atan2(dirY, dirX) * 180) / Math.PI),
  };
}

/**
 * Expande um elemento `arrow` em dois elementos comuns.
 *
 * A ponta herda a cor do stroke, não a do fill: numa seta desenhada à mão o bico é da
 * mesma cor do traço, e ter que declarar a mesma cor duas vezes é convite para elas
 * divergirem numa das vinte setas de um diagrama.
 */
export function expandArrow(el) {
  const s = el.shape;
  const g = arrowGeometry({ ...s, strokeWidth: el.stroke?.width });

  const corDaPonta = el.fill?.color ?? el.stroke?.color;

  // ── Traço e ponta precisam morar na mesma camada ────────────────────────────
  // Sem grupo, cada elemento vira uma camada própria, e a seta chegaria ao After
  // Effects partida em duas. Quem for mexer nela arrasta uma metade e deixa a outra
  // para trás — e isso acontece na primeira vez que alguém encosta no arquivo.
  //
  // Com grupo declarado, respeita o do usuário: ele sabe o que está organizando.
  const base = { group: el.group || el.id, z: el.z };

  return [
    {
      ...base,
      id: `${el.id}-shaft`,
      name: el.name ? `${el.name} Line` : undefined,
      shape: { type: "path", d: g.shaft },
      stroke: el.stroke,
      fill: null,
    },
    {
      ...base,
      id: `${el.id}-head`,
      name: el.name ? `${el.name} Head` : undefined,
      shape: { type: "polygon", points: g.head, closed: true },
      fill: corDaPonta == null ? null : { color: corDaPonta, opacity: el.fill?.opacity ?? 100 },
      stroke: null,
    },
  ];
}
