/**
 * Montar o vídeo: sequenciar cenas numa comp master.
 *
 * ── O passo que faltava ───────────────────────────────────────────────────────
 * Reconstruir e animar uma cena resolve um quadro. Um vídeo é uma sequência deles com
 * tempo, e montar isso à mão — arrastar dez comps na timeline, acertar entradas,
 * conferir contra a locução — é trabalho mecânico que consome a atenção que deveria
 * ir para o polimento.
 *
 * Aqui se decide **quando cada cena entra e quanto dura**. O adapter só coloca.
 *
 * ── De onde vem a duração ─────────────────────────────────────────────────────
 * Em ordem de prioridade:
 *
 * 1. `durationFrames` explícito — o designer sabe, ou o storyboard já definiu.
 * 2. O texto da cena, quando há roteiro. Locução tem velocidade previsível, e uma
 *    estimativa por contagem de palavras erra menos que um chute redondo.
 * 3. O padrão.
 *
 * A estimativa não pretende ser exata. Ela pretende produzir uma timeline onde as
 * cenas já estão perto do lugar certo, para o designer ajustar ouvindo o áudio — que
 * é como esse trabalho é feito de verdade.
 */

/** Velocidade de locução. 150 palavras por minuto é o ritmo de narração comum. */
export const DEFAULT_WPM = 150;

/** Duração padrão de uma cena sem texto e sem duração declarada. */
export const DEFAULT_SCENE_FRAMES = 90;

/** Nenhuma cena legível dura menos que isto, por mais curto que seja o texto. */
export const MIN_SCENE_FRAMES = 24;

export class SequenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "SequenceError";
  }
}

function numero(v, padrao) {
  return typeof v === "number" && Number.isFinite(v) ? v : padrao;
}

/** Palavras de verdade — pontuação e espaço duplo não contam. */
export function countWords(text) {
  if (typeof text !== "string") return 0;
  const limpo = text.replace(/[^\p{L}\p{N}'’-]+/gu, " ").trim();
  return limpo === "" ? 0 : limpo.split(/\s+/).length;
}

/**
 * Quantos frames o texto leva para ser falado.
 *
 * O acréscimo fixo é o ar entre frases: uma cena com quatro palavras não dura
 * 1,6 segundos na prática, porque existe respiro antes e depois. Sem isso a timeline
 * fica apertada de um jeito que obriga a refazer tudo com o áudio na mão.
 */
export function framesForText(text, { fps, wordsPerMinute = DEFAULT_WPM, padFrames = 12 } = {}) {
  const palavras = countWords(text);
  if (palavras === 0) return 0;

  const segundos = (palavras / wordsPerMinute) * 60;
  return Math.max(MIN_SCENE_FRAMES, Math.round(segundos * fps) + padFrames);
}

/**
 * Resolve um plano de sequência.
 *
 * @param {object} spec
 * @param {number} spec.fps
 * @param {Array}  spec.scenes                  { comp, durationFrames?, script?, transitionFrames?, marker? }
 * @param {number} [spec.defaultDurationFrames]
 * @param {number} [spec.wordsPerMinute]
 * @param {number} [spec.audioDurationFrames]   duração real do áudio, se já conhecida
 * @param {boolean} [spec.fitToAudio]           esticar/encolher tudo para casar com o áudio
 * @returns {{scenes: Array, totalFrames: number, warnings: string[]}}
 */
export function planSequence(spec) {
  if (spec == null || typeof spec !== "object") {
    throw new SequenceError("O plano de sequência precisa ser um objeto.");
  }

  const fps = numero(spec.fps, 0);
  if (fps <= 0) throw new SequenceError("O plano precisa de `fps` maior que zero.");

  if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) {
    throw new SequenceError("O plano precisa de pelo menos uma cena em `scenes`.");
  }

  const wpm = numero(spec.wordsPerMinute, DEFAULT_WPM);
  const padrao = Math.round(numero(spec.defaultDurationFrames, DEFAULT_SCENE_FRAMES));
  const warnings = [];

  const resolvidas = spec.scenes.map((cena, i) => {
    const onde = `scenes[${i}]`;

    if (typeof cena?.comp !== "string" || cena.comp === "") {
      throw new SequenceError(`${onde}.comp precisa ser o nome da composição da cena.`);
    }

    let duracao = numero(cena.durationFrames, null);
    let origem = "declarada";

    if (duracao === null && typeof cena.script === "string" && cena.script.trim() !== "") {
      duracao = framesForText(cena.script, { fps, wordsPerMinute: wpm });
      origem = "estimada pelo texto";
    }

    if (duracao === null) {
      duracao = padrao;
      origem = "padrão";
    }

    duracao = Math.max(1, Math.round(duracao));

    if (duracao < MIN_SCENE_FRAMES) {
      warnings.push(
        `${onde} (${cena.comp}): ${duracao} frames é menos de um segundo — o espectador ` +
          "não tem tempo de ler nem de entender o que apareceu."
      );
    }

    return {
      comp: cena.comp,
      durationFrames: duracao,
      transitionFrames: Math.max(0, Math.round(numero(cena.transitionFrames, 0))),
      marker: typeof cena.marker === "string" && cena.marker !== "" ? cena.marker : cena.comp,
      durationSource: origem,
    };
  });

  // A transição sobrepõe: a cena entra ANTES da anterior acabar, senão o crossfade
  // teria que acontecer sobre o nada e apareceria um piscar de fundo entre as cenas.
  let cursor = 0;
  const scenes = resolvidas.map((cena, i) => {
    const inicio = cursor;
    cursor += cena.durationFrames - (i + 1 < resolvidas.length ? resolvidas[i + 1].transitionFrames : 0);

    if (cena.transitionFrames >= cena.durationFrames) {
      warnings.push(
        `${cena.comp}: a transição (${cena.transitionFrames}f) é maior que a própria cena ` +
          `(${cena.durationFrames}f) — ela nunca aparece sozinha na tela.`
      );
    }

    return { ...cena, startFrame: inicio };
  });

  const ultima = scenes[scenes.length - 1];
  let totalFrames = ultima.startFrame + ultima.durationFrames;

  const audio = numero(spec.audioDurationFrames, null);

  // ── Pedir para casar com o áudio e não passar o áudio ───────────────────────
  // Era um não-fazer-nada silencioso: `fitToAudio: true` sem `audioDurationFrames`
  // caía fora do bloco abaixo e a sequência saía com as durações originais. O
  // resultado é uma comp master montada, plausível e com o ritmo errado — e nada
  // indicando que a instrução foi ignorada.
  if (spec.fitToAudio && audio === null) {
    warnings.push(
      "IGNOREI o fitToAudio: ele precisa de `audioDurationFrames` para saber com o que " +
        "casar, e nenhum valor foi passado. As cenas ficaram com as durações originais. " +
        "A duração do áudio está em `describe_project`, no item de footage."
    );
  }

  if (audio !== null) {
    const diferenca = audio - totalFrames;

    if (spec.fitToAudio) {
      // Esticar proporcionalmente mantém o ritmo relativo entre as cenas, que é o que
      // o designer definiu. Distribuir a diferença igualmente achataria a intenção.
      const fator = audio / totalFrames;
      let acumulado = 0;

      scenes.forEach((cena, i) => {
        cena.startFrame = acumulado;
        cena.durationFrames = Math.max(1, Math.round(cena.durationFrames * fator));
        cena.transitionFrames = Math.round(cena.transitionFrames * fator);
        acumulado += cena.durationFrames - (i + 1 < scenes.length ? Math.round(scenes[i + 1].transitionFrames) : 0);
      });

      totalFrames = scenes[scenes.length - 1].startFrame + scenes[scenes.length - 1].durationFrames;
      warnings.push(
        `As cenas foram esticadas por ${fator.toFixed(2)}× para casar com o áudio. ` +
          "O ritmo relativo entre elas foi mantido; confira ouvindo."
      );
    } else if (Math.abs(diferenca) > fps) {
      // "sobra 6s" não diz de quê. Dizer o que fica descoberto é o que permite decidir
      // sem abrir a timeline.
      const descricao =
        diferenca > 0
          ? `sobram ${(diferenca / fps).toFixed(1)}s de áudio sem cena nenhuma cobrindo`
          : `as cenas passam ${(-diferenca / fps).toFixed(1)}s além do fim do áudio`;

      warnings.push(
        `O áudio tem ${(audio / fps).toFixed(1)}s e as cenas somam ${(totalFrames / fps).toFixed(1)}s — ` +
          `${descricao}. Use \`fitToAudio\` para ajustar proporcionalmente, ou corrija as durações.`
      );
    }
  }

  return { scenes, totalFrames, warnings };
}
