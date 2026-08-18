/**
 * AnimSpec: descrever animação de forma declarativa e resolver em keyframes.
 *
 * ── Por que keyframe e não expressão ──────────────────────────────────────────
 * Expressão é mais curta de escrever e péssima de receber. O designer abre o projeto,
 * quer atrasar uma entrada em dois frames, e encontra código no lugar de keyframe —
 * para ajustar precisa ler a expressão, entender e reescrever. Keyframe se arrasta.
 *
 * Este projeto existe para entregar arquivo editável. Então a animação sai como
 * keyframes de verdade, com easing temporal do After Effects, no lugar onde o
 * designer espera encontrar.
 *
 * ── Divisão de trabalho ───────────────────────────────────────────────────────
 * Aqui se decide *o quê*: quais keyframes, em que frame, com que influência de
 * easing. O adapter no ExtendScript só aplica.
 *
 * Valores relativos ficam como `mode: "offset"`, porque o valor atual da camada só
 * existe dentro do After Effects. "Entra deslizando 40px de baixo" é
 * `[0, 40] → [0, 0]` em offset; o adapter soma a posição que a camada já tem. Sem
 * isso, todo preset precisaria saber a posição de cada camada antes de existir.
 *
 * ── Tempo em frames ──────────────────────────────────────────────────────────
 * A entrada é em frames, não em segundos. É como um motion designer conta, e evita a
 * praga do keyframe fora da grade: um valor em segundos que não cai exatamente num
 * frame produz keyframe entre frames, que não dá para selecionar direito na timeline
 * e faz a animação parecer trêmula sem motivo aparente.
 */

/**
 * Easing como influência de keyframe do After Effects.
 *
 * Cada keyframe tem duas influências: `out` molda o trecho depois dele, `in` molda o
 * trecho antes. Uma entrada que desacelera na chegada é `out` baixo no primeiro
 * keyframe e `in` alto no último — e não o contrário, que é o erro fácil de cometer.
 *
 * Os números vêm da skill de motion graphics: 33 é o padrão do AE, 75 é o que dá o
 * "snap" de motion moderno, acima de 85 arrasta na chegada.
 */
export const EASINGS = {
  linear: { out: 0.1, in: 0.1 },
  easeIn: { out: 33, in: 0.1 },
  easeOut: { out: 0.1, in: 33 },
  easeInOut: { out: 60, in: 60 },
  snap: { out: 0.1, in: 75 },
};

export const DEFAULT_EASE = "snap";

/** Presets, na linguagem do que a animação faz — não da propriedade que ela mexe. */
export const PRESETS = [
  "fadeIn", "fadeOut",
  "slideIn", "slideOut",
  "popIn", "popOut",
  "rotateIn",
  "drawOn",
];

const DIRECOES = {
  up: [0, 1],
  down: [0, -1],
  left: [1, 0],
  right: [-1, 0],
};

export class AnimError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnimError";
  }
}

function numero(valor, padrao) {
  return typeof valor === "number" && isFinite(valor) ? valor : padrao;
}

/**
 * Resolve um AnimSpec em trilhas de keyframe.
 *
 * @param {object} spec
 * @param {number} spec.fps                frame rate da comp
 * @param {number} [spec.staggerFrames=0]  atraso acumulado entre alvos, em frames
 * @param {Array}  spec.targets            o que animar
 * @returns {{tracks: Array, warnings: string[]}}
 */
export function resolveAnimation(spec) {
  if (spec == null || typeof spec !== "object") {
    throw new AnimError("O AnimSpec precisa ser um objeto.");
  }

  const fps = numero(spec.fps, 0);
  if (fps <= 0) throw new AnimError("AnimSpec precisa de `fps` maior que zero.");

  const alvos = spec.targets;
  if (!Array.isArray(alvos) || alvos.length === 0) {
    throw new AnimError("AnimSpec precisa de pelo menos um item em `targets`.");
  }

  const stagger = Math.max(0, numero(spec.staggerFrames, 0));
  const tracks = [];
  const warnings = [];

  alvos.forEach((alvo, i) => {
    const onde = `targets[${i}]`;

    if (typeof alvo?.layer !== "string" || alvo.layer === "") {
      throw new AnimError(`${onde}.layer precisa ser o nome da camada.`);
    }

    const preset = alvo.preset;
    if (!PRESETS.includes(preset)) {
      throw new AnimError(
        `${onde}.preset desconhecido: ${JSON.stringify(preset)}. ` +
          `Disponíveis: ${PRESETS.join(", ")}.`
      );
    }

    const ease = alvo.ease ?? DEFAULT_EASE;
    if (!EASINGS[ease]) {
      throw new AnimError(
        `${onde}.ease desconhecido: ${JSON.stringify(ease)}. ` +
          `Disponíveis: ${Object.keys(EASINGS).join(", ")}.`
      );
    }

    // O stagger segue a ORDEM DA LISTA, não o índice da camada na timeline. Escalonar
    // por índice dá resultado aleatório e parece erro; a ordem de leitura do design é
    // uma decisão de quem monta o spec.
    const inicio = Math.round(numero(alvo.startFrame, 0) + i * stagger);
    const duracao = Math.round(numero(alvo.durationFrames, Math.round(fps * 0.4)));

    if (duracao < 1) throw new AnimError(`${onde}.durationFrames precisa ser >= 1.`);

    const segundos = duracao / fps;
    if (segundos > 1.2) {
      warnings.push(
        `${onde} (${alvo.layer}): ${duracao} frames = ${segundos.toFixed(2)}s. ` +
          "Entrada de elemento costuma funcionar entre 0,3 e 0,5s; acima de 1s arrasta."
      );
    }
    if (duracao < 3) {
      warnings.push(
        `${onde} (${alvo.layer}): ${duracao} frames é curto demais para o easing ser ` +
          "percebido — o resultado vai parecer um corte."
      );
    }

    for (const track of expandir(preset, alvo, { inicio, duracao, ease, onde, warnings })) {
      tracks.push({ layer: alvo.layer, ...track });
    }
  });

  return { tracks, warnings };
}

/**
 * Um preset vira uma ou mais trilhas.
 *
 * `overshoot` insere um keyframe intermediário que passa do alvo antes de assentar.
 * É o que separa "animado" de "animado bem", e a faixa útil é 5% a 15% — acima disso
 * vira desenho animado. Fica em 70% da duração porque o retorno precisa de espaço
 * para ser percebido como peso, não como tremor.
 */
function expandir(preset, alvo, ctx) {
  const { inicio, duracao, ease, onde, warnings } = ctx;
  const fim = inicio + duracao;
  const e = EASINGS[ease];

  const overshoot = numero(alvo.overshoot, 0);
  if (overshoot > 20) {
    warnings.push(`${onde}: overshoot de ${overshoot}% passa de cartoon. A faixa útil é 5 a 15.`);
  }

  /** Dois ou três keyframes entre dois valores, com o easing e o overshoot pedidos. */
  const mover = (property, mode, de, para, { permiteOvershoot = true } = {}) => {
    const keys = [{ frame: inicio, value: de, easeOut: e.out, easeIn: e.in }];

    if (permiteOvershoot && overshoot > 0) {
      const meio = inicio + Math.max(1, Math.round(duracao * 0.7));
      // Só faz sentido se o keyframe intermediário não colidir com as pontas.
      if (meio > inicio && meio < fim) {
        keys.push({
          frame: meio,
          value: passarDoAlvo(de, para, overshoot),
          easeOut: e.in,
          easeIn: e.in,
        });
      }
    }

    keys.push({ frame: fim, value: para, easeOut: e.in, easeIn: e.in });

    return { property, mode, keys };
  };

  switch (preset) {
    case "fadeIn":
      return [mover("opacity", "absolute", [0], [100], { permiteOvershoot: false })];

    case "fadeOut":
      return [mover("opacity", "absolute", [100], [0], { permiteOvershoot: false })];

    case "slideIn":
    case "slideOut": {
      const dir = DIRECOES[alvo.direction ?? "up"];
      if (!dir) {
        throw new AnimError(
          `${onde}.direction desconhecido: ${JSON.stringify(alvo.direction)}. ` +
            `Disponíveis: ${Object.keys(DIRECOES).join(", ")}.`
        );
      }

      const d = numero(alvo.distance, 40);
      // `DIRECOES` guarda para onde o elemento VAI; o deslocamento inicial é de onde
      // ele vem, que é o mesmo vetor vezes a distância. Y cresce para baixo, então
      // "entrar subindo" começa com Y positivo — inverter isso faz o elemento descer
      // e ninguém percebe no código, só no resultado.
      const deslocado = [dir[0] * d, dir[1] * d];
      const parado = [0, 0];

      const tracks = [
        preset === "slideIn"
          ? mover("position", "offset", deslocado, parado)
          : mover("position", "offset", parado, deslocado),
      ];

      // Deslizar sem fade deixa o elemento aparecendo de dentro do nada quando ele
      // entra de fora do quadro. Combinar é o padrão, e desligar é uma escolha.
      if (alvo.withFade !== false) {
        tracks.push(
          preset === "slideIn"
            ? mover("opacity", "absolute", [0], [100], { permiteOvershoot: false })
            : mover("opacity", "absolute", [100], [0], { permiteOvershoot: false })
        );
      }

      return tracks;
    }

    case "popIn":
    case "popOut": {
      const de = numero(alvo.fromScale, 0);
      const cheio = [100, 100];
      const pequeno = [de, de];

      return [
        preset === "popIn" ? mover("scale", "absolute", pequeno, cheio) : mover("scale", "absolute", cheio, pequeno),
      ];
    }

    case "rotateIn": {
      const graus = numero(alvo.degrees, -15);
      return [mover("rotation", "offset", [graus], [0])];
    }

    case "drawOn": {
      // Trim Paths com End de 0 a 100%: o contorno se desenhando. Só existe em shape
      // layer, e o adapter cria o efeito se ele ainda não estiver lá.
      return [mover("trimEnd", "absolute", [0], [100], { permiteOvershoot: false })];
    }

    default:
      throw new AnimError(`Preset sem implementação: ${preset}`);
  }
}

/** O valor do overshoot: passa do alvo na direção do movimento, em porcentagem. */
function passarDoAlvo(de, para, percentual) {
  return para.map((fim, i) => {
    const delta = fim - de[i];
    // Sem deslocamento nesse eixo não há para onde passar — 0 em vez de NaN ou ruído.
    if (delta === 0) return fim;
    return Number((fim + delta * (percentual / 100)).toFixed(3));
  });
}
