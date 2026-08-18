import test from "node:test";
import assert from "node:assert/strict";

import {
  AnimError,
  DEFAULT_DURATION_FRAMES,
  DEFAULT_EASE,
  EASINGS,
  PRESETS,
  resolveAnimation,
} from "../src/anim.js";

const spec = (targets, extra = {}) => ({ fps: 30, targets, ...extra });
const um = (targets, extra) => resolveAnimation(spec(targets, extra));

// ---------------------------------------------------------------- validação

test("exige fps e ao menos um alvo", () => {
  assert.throws(() => resolveAnimation({ targets: [{ layer: "a", preset: "fadeIn" }] }), /fps/);
  assert.throws(() => resolveAnimation({ fps: 30, targets: [] }), /targets/);
  assert.throws(() => resolveAnimation(null), AnimError);
});

test("preset e ease desconhecidos listam os válidos em vez de só recusar", () => {
  const preset = () => um([{ layer: "a", preset: "explodir" }]);
  assert.throws(preset, /explodir/);
  assert.throws(preset, /fadeIn/);

  const ease = () => um([{ layer: "a", preset: "fadeIn", ease: "elastico" }]);
  assert.throws(ease, /elastico/);
  assert.throws(ease, /snap/);
});

test("direção inválida no slide é erro explícito", () => {
  assert.throws(() => um([{ layer: "a", preset: "slideIn", direction: "diagonal" }]), /diagonal/);
});

// ---------------------------------------------------------------- easing

test("entrada desacelera na chegada, não na partida", () => {
  // O erro fácil aqui é inverter: influência alta no primeiro keyframe faz o elemento
  // sair devagar e chegar batendo, que é o oposto do que a animação pede.
  const { tracks } = um([{ layer: "Título", preset: "fadeIn", ease: "snap" }]);
  const keys = tracks[0].keys;

  assert.equal(keys[0].easeOut, EASINGS.snap.out);
  assert.equal(keys[keys.length - 1].easeIn, EASINGS.snap.in);
  assert.ok(keys[keys.length - 1].easeIn > keys[0].easeOut, "a chegada é mais suave que a partida");
});

test("o ease padrão é o snap", () => {
  const { tracks } = um([{ layer: "a", preset: "fadeIn" }]);
  assert.equal(tracks[0].keys.at(-1).easeIn, EASINGS[DEFAULT_EASE].in);
});

// ---------------------------------------------------------------- tempo

test("frames viram inteiros, sempre", () => {
  // Keyframe fora da grade de frames não dá para selecionar direito na timeline e faz
  // a animação parecer trêmula sem motivo aparente.
  const { tracks } = um([{ layer: "a", preset: "fadeIn", startFrame: 2.4, durationFrames: 11.6 }]);

  for (const k of tracks[0].keys) {
    assert.equal(k.frame, Math.round(k.frame), `frame ${k.frame} não é inteiro`);
  }
});

test("stagger segue a ordem da lista, não o índice da camada", () => {
  const { tracks } = um(
    [
      { layer: "Título", preset: "fadeIn", durationFrames: 10 },
      { layer: "Subtítulo", preset: "fadeIn", durationFrames: 10 },
      { layer: "Botão", preset: "fadeIn", durationFrames: 10 },
    ],
    { staggerFrames: 3 }
  );

  assert.deepEqual(
    tracks.map((t) => ({ layer: t.layer, inicio: t.keys[0].frame })),
    [
      { layer: "Título", inicio: 0 },
      { layer: "Subtítulo", inicio: 3 },
      { layer: "Botão", inicio: 6 },
    ]
  );
});

test("stagger soma ao startFrame de cada alvo", () => {
  const { tracks } = um(
    [
      { layer: "a", preset: "fadeIn", startFrame: 10 },
      { layer: "b", preset: "fadeIn", startFrame: 10 },
    ],
    { staggerFrames: 4 }
  );

  assert.equal(tracks[0].keys[0].frame, 10);
  assert.equal(tracks[1].keys[0].frame, 14);
});

// ---------------------------------------------------------------- presets

test("fadeIn é opacidade absoluta de 0 a 100", () => {
  const { tracks } = um([{ layer: "a", preset: "fadeIn", durationFrames: 12 }]);

  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].property, "opacity");
  assert.equal(tracks[0].mode, "absolute");
  assert.deepEqual(tracks[0].keys.map((k) => k.value), [[0], [100]]);
  assert.equal(tracks[0].keys.at(-1).frame, 12);
});

test("slideIn de baixo desloca no Y positivo e volta a zero", () => {
  // Offset porque a posição atual da camada só existe dentro do After Effects.
  const { tracks } = um([{ layer: "a", preset: "slideIn", direction: "up", distance: 40 }]);
  const pos = tracks.find((t) => t.property === "position");

  assert.equal(pos.mode, "offset");
  assert.deepEqual(pos.keys[0].value, [0, 40], "vem de baixo: Y cresce para baixo");
  assert.deepEqual(pos.keys.at(-1).value, [0, 0]);
});

test("slideIn traz fade junto, e dá para desligar", () => {
  const com = um([{ layer: "a", preset: "slideIn" }]).tracks;
  assert.deepEqual(com.map((t) => t.property).sort(), ["opacity", "position"]);

  const sem = um([{ layer: "a", preset: "slideIn", withFade: false }]).tracks;
  assert.deepEqual(sem.map((t) => t.property), ["position"]);
});

test("popIn escala de 0 a 100 em escala absoluta", () => {
  const { tracks } = um([{ layer: "a", preset: "popIn" }]);

  assert.equal(tracks[0].property, "scale");
  assert.equal(tracks[0].mode, "absolute");
  assert.deepEqual(tracks[0].keys[0].value, [0, 0]);
  assert.deepEqual(tracks[0].keys.at(-1).value, [100, 100]);
});

test("drawOn usa trimEnd de 0 a 100", () => {
  const { tracks } = um([{ layer: "Seta", preset: "drawOn", durationFrames: 18 }]);

  assert.equal(tracks[0].property, "trimEnd");
  assert.deepEqual(tracks[0].keys.map((k) => k.value), [[0], [100]]);
});

test("todo preset da lista pública resolve", () => {
  for (const preset of PRESETS) {
    const { tracks } = um([{ layer: "a", preset }]);
    assert.ok(tracks.length >= 1, `${preset} não produziu trilha`);
    for (const t of tracks) {
      assert.ok(t.keys.length >= 2, `${preset}: precisa de pelo menos dois keyframes`);
    }
  }
});

// ---------------------------------------------------------------- overshoot

test("overshoot insere um keyframe que passa do alvo e volta", () => {
  const { tracks } = um([
    { layer: "a", preset: "slideIn", direction: "up", distance: 100, durationFrames: 15, overshoot: 10, withFade: false },
  ]);

  const keys = tracks[0].keys;
  assert.equal(keys.length, 3);

  // Vindo de +100 para 0, passar 10% significa ir a -10 antes de assentar.
  assert.equal(keys[1].value[1], -10);
  assert.deepEqual(keys[2].value, [0, 0]);
  assert.ok(keys[1].frame > keys[0].frame && keys[1].frame < keys[2].frame);
});

test("overshoot não mexe no eixo que não se move", () => {
  const { tracks } = um([
    { layer: "a", preset: "slideIn", direction: "up", distance: 50, overshoot: 10, withFade: false },
  ]);

  assert.equal(tracks[0].keys[1].value[0], 0, "X não se moveu, então não passa do alvo");
});

test("fade não ganha overshoot — opacidade acima de 100 não existe", () => {
  const { tracks } = um([{ layer: "a", preset: "fadeIn", overshoot: 10 }]);
  assert.equal(tracks[0].keys.length, 2);
});

test("overshoot exagerado vira aviso, não erro", () => {
  const { warnings } = um([{ layer: "a", preset: "popIn", overshoot: 40 }]);
  assert.match(warnings.join(" "), /cartoon/);
});

// ---------------------------------------------------------------- avisos de ritmo

test("duração longa demais para uma entrada vira aviso", () => {
  const { warnings } = um([{ layer: "Título", preset: "fadeIn", durationFrames: 60 }]);
  assert.match(warnings.join(" "), /arrasta/);
  assert.match(warnings.join(" "), /Título/);
});

test("duração curta demais para o easing ser percebido vira aviso", () => {
  const { warnings } = um([{ layer: "a", preset: "fadeIn", durationFrames: 2 }]);
  assert.match(warnings.join(" "), /corte/);
});

test("duração dentro da faixa não gera aviso nenhum", () => {
  const { warnings } = um([{ layer: "a", preset: "fadeIn", durationFrames: 12 }]);
  assert.deepEqual(warnings, []);
});

test("duração padrão é 10 frames, independente do fps", () => {
  // Calibrado por quem usa. Dez frames dá 0,42s a 24fps e 0,33s a 30fps, ambos na
  // faixa que funciona — e é número redondo de arrastar na timeline.
  for (const fps of [24, 25, 30, 60]) {
    const { tracks, warnings } = resolveAnimation({ fps, targets: [{ layer: "a", preset: "fadeIn" }] });
    const duracao = tracks[0].keys.at(-1).frame - tracks[0].keys[0].frame;

    assert.equal(duracao, DEFAULT_DURATION_FRAMES, `a ${fps}fps`);
    assert.deepEqual(warnings, [], `a ${fps}fps`);
  }
});

// ---------------------------------------------------------------- queda e rotação

test("dropIn cai de cima, bate, quica e assenta", () => {
  const { tracks } = um([
    { layer: "Moeda", preset: "dropIn", distance: 200, bounce: 20, durationFrames: 20 },
  ]);

  const keys = tracks[0].keys;
  assert.equal(tracks[0].property, "position");
  assert.equal(tracks[0].mode, "offset");
  assert.equal(keys.length, 4, "início, impacto, pico do quique, assentamento");

  assert.deepEqual(keys[0].value, [0, -200], "começa acima: Y cresce para baixo");
  assert.deepEqual(keys[1].value, [0, 0], "o impacto é na posição final");
  assert.equal(keys[2].value[1], -40, "quica 20% dos 200px");
  assert.deepEqual(keys[3].value, [0, 0], "volta e fica");
});

test("dropIn põe o impacto antes da metade final — queda tem peso", () => {
  const { tracks } = um([{ layer: "Moeda", preset: "dropIn", durationFrames: 20 }]);
  const keys = tracks[0].keys;

  const impacto = keys[1].frame;
  assert.ok(impacto > 10 && impacto < 20, `impacto no frame ${impacto}`);
  // Distribuir igualmente faria a queda parecer flutuante.
  assert.ok(keys[2].frame > impacto, "o quique vem depois do impacto");
});

test("dropIn acelera na queda em vez de desacelerar", () => {
  const { tracks } = um([{ layer: "a", preset: "dropIn", durationFrames: 20 }]);
  const keys = tracks[0].keys;

  // Ease alto na chegada suavizaria o impacto, que é o oposto do que uma queda pede.
  assert.ok(keys[1].easeIn < 10, "chega batendo");
});

test("dropIn sem quique termina no impacto", () => {
  const { tracks } = um([{ layer: "a", preset: "dropIn", bounce: 0, durationFrames: 12 }]);
  const keys = tracks[0].keys;

  assert.equal(keys.length, 2);
  assert.equal(keys.at(-1).frame, 12);
  assert.deepEqual(keys.at(-1).value, [0, 0]);
});

test("spin é linear — easing criaria começo e fim perceptíveis", () => {
  const { tracks } = um([{ layer: "Ponteiro", preset: "spin", turns: 2, durationFrames: 48 }]);
  const keys = tracks[0].keys;

  assert.equal(tracks[0].property, "rotation");
  assert.equal(tracks[0].mode, "offset");
  assert.deepEqual(keys.map((k) => k.value), [[0], [720]]);

  for (const k of keys) {
    assert.ok(k.easeIn < 1 && k.easeOut < 1, "rotação contínua não leva easing");
  }
});

test("spin aceita graus direto quando não é volta inteira", () => {
  const { tracks } = um([{ layer: "Ponteiro", preset: "spin", degrees: 90 }]);
  assert.deepEqual(tracks[0].keys.at(-1).value, [90]);
});

test("swing vai e volta ao ponto de partida", () => {
  const { tracks } = um([{ layer: "Seletor", preset: "swing", degrees: 20, durationFrames: 16 }]);
  const keys = tracks[0].keys;

  assert.equal(keys.length, 3);
  assert.deepEqual(keys[0].value, [0]);
  assert.deepEqual(keys[1].value, [20]);
  assert.deepEqual(keys[2].value, [0], "termina onde começou");
  assert.equal(keys[1].frame, 8, "o pico fica no meio");
});

test("swing negativo recua em vez de avançar", () => {
  const { tracks } = um([{ layer: "Seletor", preset: "swing", degrees: -20 }]);
  assert.deepEqual(tracks[0].keys[1].value, [-20]);
});
