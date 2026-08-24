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

/**
 * Duração padrão de uma entrada, em frames.
 *
 * Dez, não uma fração do fps. Calibrado por quem usa: dá 0,42s a 24fps e 0,33s a
 * 30fps, ambos dentro da faixa que funciona, e é um número redondo de arrastar na
 * timeline quando o designer quiser mais rápido ou mais lento.
 */
export const DEFAULT_DURATION_FRAMES = 10;

/** Presets, na linguagem do que a animação faz — não da propriedade que ela mexe. */
export const PRESETS = [
  "fadeIn", "fadeOut",
  "slideIn", "slideOut",
  "popIn", "popOut",
  "revealIn",
  "rotateIn",
  "drawOn",
  "dropIn",
  "spin",
  "swing",
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

  // Alguns presets precisam que a camada seja preparada antes do primeiro keyframe —
  // `revealIn` precisa de uma máscara. Isso não é animação, é montagem, e sai separado
  // porque o adapter tem que criar a máscara ANTES de escrever qualquer chave.
  const setups = [];

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
    const duracao = Math.round(numero(alvo.durationFrames, DEFAULT_DURATION_FRAMES));

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

    const daCamada = [];
    for (const track of expandir(preset, alvo, { inicio, duracao, ease, onde, warnings, setups: daCamada })) {
      tracks.push({ layer: alvo.layer, ...track });
    }
    for (const setup of daCamada) setups.push({ layer: alvo.layer, ...setup });
  });

  return { tracks, setups, warnings };
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
  const { inicio, duracao, ease, onde, warnings, setups } = ctx;
  const fim = inicio + duracao;
  const e = EASINGS[ease];

  const overshoot = numero(alvo.overshoot, 0);
  if (overshoot > 20) {
    warnings.push(`${onde}: overshoot de ${overshoot}% passa de cartoon. A faixa útil é 5 a 15.`);
  }

  // `settle` é o recuo depois do overshoot: passa do alvo, volta um pouco para o outro
  // lado, e só então assenta — 0 → 110 → 96 → 100. É como uma mola de verdade se
  // acomoda, e sem overshoot não existe: não há de onde recuar.
  const settle = numero(alvo.settle, 0);
  if (settle > 0 && overshoot <= 0) {
    warnings.push(
      `${onde}: settle sem overshoot não faz nada — o recuo acontece DEPOIS de passar ` +
        "do alvo. Informe overshoot também, ou tire o settle."
    );
  }
  if (settle > overshoot) {
    warnings.push(
      `${onde}: settle de ${settle}% maior que o overshoot de ${overshoot}% faz o ` +
        "elemento recuar mais do que avançou, e a entrada parece tremer."
    );
  }

  /** De dois a quatro keyframes entre dois valores, com easing, overshoot e settle. */
  const mover = (property, mode, de, para, { permiteOvershoot = true } = {}) => {
    const keys = [{ frame: inicio, value: de, easeOut: e.out, easeIn: e.in }];

    if (permiteOvershoot && overshoot > 0) {
      // Com settle há dois keyframes intermediários, então o pico sobe para 60% para
      // abrir espaço ao recuo. Sozinho, o pico fica em 70% — o retorno precisa de
      // espaço para ser lido como peso e não como tremor.
      const temSettle = settle > 0;
      const pico = inicio + Math.max(1, Math.round(duracao * (temSettle ? 0.6 : 0.7)));

      // Só faz sentido se o keyframe intermediário não colidir com as pontas.
      if (pico > inicio && pico < fim) {
        keys.push({
          frame: pico,
          value: passarDoAlvo(de, para, overshoot),
          easeOut: e.in,
          easeIn: e.in,
        });

        const recuo = inicio + Math.max(1, Math.round(duracao * 0.82));
        if (temSettle && recuo > pico && recuo < fim) {
          keys.push({
            frame: recuo,
            value: passarDoAlvo(de, para, -settle),
            easeOut: e.in,
            easeIn: e.in,
          });
        }
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

    /*
     * Texto que sobe aparecendo atrás de uma máscara.
     *
     * ── Por que isto não é `slideIn` com uma máscara em cima ────────────────────
     * Máscara vive no espaço da camada e é aplicada ANTES do transform: mascarar a
     * camada e animar a posição dela move o recorte junto, e o texto desliza inteiro
     * em vez de aparecer. É o erro que faz o rig parecer quebrado sem nenhuma mensagem.
     *
     * O que funciona é mexer no texto DENTRO da camada — a posição do animator de
     * texto, que age no estágio da fonte, antes da máscara. A máscara fica parada, os
     * glifos passam por trás dela. É o mesmo rig que se monta à mão.
     *
     * Consequência: só serve para camada de texto. Shape e imagem não têm animator, e
     * o adapter recusa dizendo isso.
     */
    case "revealIn": {
      const nome = alvo.direction ?? "up";
      const dir = DIRECOES[nome];
      if (!dir) {
        throw new AnimError(
          `${onde}.direction desconhecido: ${JSON.stringify(alvo.direction)}. ` +
            `Disponíveis: ${Object.keys(DIRECOES).join(", ")}.`
        );
      }

      // A distância certa é o tamanho da própria camada: menos que isso e o texto já
      // começa meio visível dentro da janela, que é o defeito clássico deste rig. Só
      // que o tamanho do texto só existe dentro do After Effects — então o valor sai
      // daqui em unidade de camada e o adapter multiplica pelo que mediu.
      const explicita = typeof alvo.distance === "number" && isFinite(alvo.distance);
      const d = explicita ? alvo.distance : 1;
      const unit = explicita ? "px" : dir[1] !== 0 ? "layerHeight" : "layerWidth";

      // De onde o texto vem é o oposto de para onde ele vai, e é o lado em que a
      // máscara tem que ser rente: folga ali deixaria o texto aparecer antes da hora.
      const origem = { up: "bottom", down: "top", left: "right", right: "left" }[nome];

      setups.push({
        kind: "revealMask",
        from: origem,
        padding: Math.max(0, numero(alvo.maskPadding, 2)),
      });

      const track = mover("textPosition", "offset", [dir[0] * d, dir[1] * d], [0, 0]);
      track.unit = unit;

      const tracks = [track];

      // Sem fade por padrão: a máscara já resolve o aparecimento, e somar opacidade
      // deixa o texto cinzento no meio do movimento em vez de nítido atrás da janela.
      if (alvo.withFade === true) {
        tracks.push(mover("opacity", "absolute", [0], [100], { permiteOvershoot: false }));
      }

      return tracks;
    }

    case "rotateIn": {
      const graus = numero(alvo.degrees, -15);
      return [mover("rotation", "offset", [graus], [0])];
    }

    case "dropIn": {
      // Cai e quica. O impacto é o ponto dramático, então ele acontece em 65% da
      // duração — o resto é o quique e o assentamento. Distribuir igualmente faria a
      // queda parecer flutuante, que é o oposto de peso.
      const altura = numero(alvo.distance, 200);
      const quique = numero(alvo.bounce, 18);
      const alturaQuique = -(altura * (quique / 100));

      const impacto = Math.max(1, Math.round(duracao * 0.65));
      const pico = Math.max(impacto + 1, Math.round(duracao * 0.82));

      const keys = [
        // Acelera na queda: influência baixa saindo, para ganhar velocidade.
        { frame: inicio, value: [0, -altura], easeOut: 0.1, easeIn: 0.1 },
        // Chega batendo. Ease alto na entrada aqui suavizaria o impacto, que é
        // justamente o que não se quer numa queda.
        { frame: inicio + impacto, value: [0, 0], easeOut: 0.1, easeIn: 0.1 },
      ];

      if (quique > 0 && pico < duracao) {
        keys.push({ frame: inicio + pico, value: [0, alturaQuique], easeOut: 70, easeIn: 70 });
        keys.push({ frame: fim, value: [0, 0], easeOut: 0.1, easeIn: 75 });
      } else {
        keys[keys.length - 1].frame = fim;
      }

      return [{ property: "position", mode: "offset", keys }];
    }

    case "spin": {
      // Rotação contínua é o único caso em que linear é a escolha certa: qualquer
      // easing cria um começo e um fim perceptíveis, e um ponteiro de relógio ou uma
      // engrenagem não deve ter nenhum dos dois.
      const voltas = numero(alvo.turns, 1);
      const graus = numero(alvo.degrees, voltas * 360);

      return [
        {
          property: "rotation",
          mode: "offset",
          keys: [
            { frame: inicio, value: [0], easeOut: 0.1, easeIn: 0.1 },
            { frame: fim, value: [graus], easeOut: 0.1, easeIn: 0.1 },
          ],
        },
      ];
    }

    case "swing": {
      // Vai e volta: gira até o ângulo e retorna ao ponto de partida. Serve para um
      // seletor que avança e recua, e para qualquer coisa que precise indicar
      // movimento sem sair do lugar.
      const graus = numero(alvo.degrees, 15);
      const meio = inicio + Math.max(1, Math.round(duracao / 2));

      return [
        {
          property: "rotation",
          mode: "offset",
          keys: [
            { frame: inicio, value: [0], easeOut: e.out, easeIn: e.in },
            { frame: meio, value: [graus], easeOut: e.in, easeIn: e.in },
            { frame: fim, value: [0], easeOut: e.in, easeIn: e.in },
          ],
        },
      ];
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
