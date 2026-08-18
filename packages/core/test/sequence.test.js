import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCENE_FRAMES,
  MIN_SCENE_FRAMES,
  SequenceError,
  countWords,
  framesForText,
  planSequence,
} from "../src/sequence.js";

const plano = (scenes, extra = {}) => planSequence({ fps: 30, scenes, ...extra });

// ---------------------------------------------------------------- contagem

test("countWords ignora pontuação e espaço extra", () => {
  assert.equal(countWords("Olá, mundo!  Tudo   bem?"), 4);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords("acentuação é palavra"), 3);
});

test("framesForText segue a velocidade de locução", () => {
  // 150 palavras/min = 2,5 por segundo. 75 palavras ≈ 30s ≈ 900 frames, mais o ar.
  const texto = Array(75).fill("palavra").join(" ");
  const frames = framesForText(texto, { fps: 30 });

  assert.ok(frames > 890 && frames < 930, `${frames} frames`);
});

test("framesForText nunca desce abaixo do mínimo legível", () => {
  // Duas palavras dariam meio segundo. Ninguém lê uma cena em meio segundo.
  assert.ok(framesForText("Compre agora", { fps: 30 }) >= MIN_SCENE_FRAMES);
  assert.ok(framesForText("Já", { fps: 30 }) >= MIN_SCENE_FRAMES, "uma palavra também");
  assert.equal(framesForText("", { fps: 30 }), 0, "sem texto não há estimativa");
});

// ---------------------------------------------------------------- validação

test("exige fps e cenas", () => {
  assert.throws(() => planSequence({ scenes: [{ comp: "A" }] }), /fps/);
  assert.throws(() => planSequence({ fps: 30, scenes: [] }), /scenes/);
  assert.throws(() => plano([{ durationFrames: 30 }]), /comp/);
  assert.throws(() => planSequence(null), SequenceError);
});

// ---------------------------------------------------------------- duração

test("duração declarada ganha do texto e do padrão", () => {
  const { scenes } = plano([{ comp: "Scene 01", durationFrames: 45, script: "texto longo ".repeat(50) }]);

  assert.equal(scenes[0].durationFrames, 45);
  assert.equal(scenes[0].durationSource, "declarada");
});

test("sem duração, o texto do roteiro decide", () => {
  const { scenes } = plano([{ comp: "Scene 01", script: Array(75).fill("palavra").join(" ") }]);

  assert.equal(scenes[0].durationSource, "estimada pelo texto");
  assert.ok(scenes[0].durationFrames > 890);
});

test("sem duração e sem texto, cai no padrão", () => {
  const { scenes } = plano([{ comp: "Scene 01" }]);

  assert.equal(scenes[0].durationFrames, DEFAULT_SCENE_FRAMES);
  assert.equal(scenes[0].durationSource, "padrão");
});

// ---------------------------------------------------------------- tempo

test("cenas entram em sequência, uma depois da outra", () => {
  const { scenes, totalFrames } = plano([
    { comp: "Scene 01", durationFrames: 60 },
    { comp: "Scene 02", durationFrames: 90 },
    { comp: "Scene 03", durationFrames: 30 },
  ]);

  assert.deepEqual(scenes.map((s) => s.startFrame), [0, 60, 150]);
  assert.equal(totalFrames, 180);
});

test("transição faz a cena entrar ANTES da anterior acabar", () => {
  // Sem sobreposição o crossfade aconteceria sobre o nada, e apareceria um piscar de
  // fundo entre as cenas.
  const { scenes, totalFrames } = plano([
    { comp: "Scene 01", durationFrames: 60 },
    { comp: "Scene 02", durationFrames: 60, transitionFrames: 12 },
  ]);

  assert.equal(scenes[0].startFrame, 0);
  assert.equal(scenes[1].startFrame, 48, "entra 12 frames antes do fim da primeira");
  assert.equal(totalFrames, 108);
});

test("transição maior que a cena vira aviso", () => {
  const { warnings } = plano([
    { comp: "Scene 01", durationFrames: 60 },
    { comp: "Scene 02", durationFrames: 10, transitionFrames: 20 },
  ]);

  assert.match(warnings.join(" "), /nunca aparece sozinha/);
});

test("o marcador cai no nome da cena quando não é informado", () => {
  const { scenes } = plano([
    { comp: "Scene 01 - Hook", durationFrames: 30 },
    { comp: "Scene 02", durationFrames: 30, marker: "Product reveal" },
  ]);

  assert.equal(scenes[0].marker, "Scene 01 - Hook");
  assert.equal(scenes[1].marker, "Product reveal");
});

// ---------------------------------------------------------------- áudio

test("descompasso com o áudio vira aviso com o número em segundos", () => {
  const { warnings } = plano(
    [{ comp: "Scene 01", durationFrames: 60 }, { comp: "Scene 02", durationFrames: 60 }],
    { audioDurationFrames: 300 }
  );

  assert.match(warnings.join(" "), /áudio tem 10\.0s/);
  // A mensagem precisa dizer o que fica descoberto, não só o número.
  assert.match(warnings.join(" "), /sobram 6\.0s de áudio sem cena/);
});

test("diferença de menos de um segundo não incomoda", () => {
  const { warnings } = plano([{ comp: "Scene 01", durationFrames: 120 }], { audioDurationFrames: 130 });
  assert.deepEqual(warnings, []);
});

test("fitToAudio estica proporcionalmente e preserva o ritmo relativo", () => {
  // Uma cena com o dobro da outra tem que continuar com o dobro depois do ajuste.
  const { scenes, totalFrames, warnings } = plano(
    [{ comp: "Scene 01", durationFrames: 60 }, { comp: "Scene 02", durationFrames: 120 }],
    { audioDurationFrames: 360, fitToAudio: true }
  );

  assert.equal(totalFrames, 360);
  assert.equal(scenes[0].durationFrames, 120);
  assert.equal(scenes[1].durationFrames, 240);
  assert.equal(scenes[1].durationFrames / scenes[0].durationFrames, 2, "proporção mantida");
  assert.match(warnings.join(" "), /esticadas por 2\.00×/);
});

test("fitToAudio encurta quando o áudio é mais curto", () => {
  const { totalFrames } = plano(
    [{ comp: "Scene 01", durationFrames: 100 }, { comp: "Scene 02", durationFrames: 100 }],
    { audioDurationFrames: 100, fitToAudio: true }
  );

  assert.equal(totalFrames, 100);
});

// ---------------------------------------------------------------- caso real

test("roteiro completo vira uma timeline plausível", () => {
  const { scenes, totalFrames } = planSequence({
    fps: 24,
    scenes: [
      { comp: "Scene 01 - Hook", script: "Você já perdeu vendas por não saber ajustar seus lances?" },
      { comp: "Scene 02 - Problem", script: "A maioria dos anunciantes deixa dinheiro na mesa todo mês." },
      { comp: "Scene 03 - CTA", script: "Comece hoje.", transitionFrames: 8 },
    ],
  });

  assert.equal(scenes.length, 3);
  assert.equal(scenes[0].startFrame, 0);
  assert.ok(scenes[1].startFrame > scenes[0].startFrame);
  // Frase curta no fim não pode virar um piscar.
  assert.ok(scenes[2].durationFrames >= MIN_SCENE_FRAMES);
  assert.ok(totalFrames / 24 > 5, "um roteiro de três falas passa de cinco segundos");
});
