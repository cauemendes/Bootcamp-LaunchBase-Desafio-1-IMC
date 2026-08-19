import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Bridge, BridgeError } from "../src/bridge.js";
import {
  CMD_DIR,
  PANEL_BUILD_ESPERADO,
  RES_DIR,
  clearStale,
  commandPath,
  consumeJson,
  ensureBridgeDirs,
  newCommandId,
  resolveBridgeDir,
  writeJsonAtomic,
} from "../src/protocol.js";

function tempDir() {
  return ensureBridgeDirs(fs.mkdtempSync(path.join(os.tmpdir(), "vec-bridge-test-")));
}

/**
 * Painel falso: faz o que o bridge-panel.jsx faz dentro do After Effects — lê
 * comandos da pasta, executa, escreve o resultado.
 *
 * Sem isso não haveria como testar o protocolo sem abrir o AE, e o protocolo é
 * justamente a parte onde erro de sincronia aparece de forma intermitente.
 */
function startFakePanel(dir, handlers, { intervalMs = 10 } = {}) {
  const timer = setInterval(() => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, CMD_DIR));
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name.endsWith(".json")) continue; // ignora .tmp em escrita

      const command = consumeJson(path.join(dir, CMD_DIR, name));
      if (!command) continue;

      const handler = handlers[command.tool];
      let payload;

      if (!handler) {
        payload = { id: command.id, ok: false, error: `ferramenta desconhecida: ${command.tool}` };
      } else {
        try {
          payload = { id: command.id, ok: true, result: handler(command.args) };
        } catch (err) {
          payload = { id: command.id, ok: false, error: err.message };
        }
      }

      writeJsonAtomic(path.join(dir, RES_DIR, `${command.id}.json`), payload);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- protocolo

test("resolveBridgeDir respeita a variável de ambiente", () => {
  assert.equal(resolveBridgeDir({ VECTORIZE_AE_BRIDGE_DIR: "/tmp/x" }), "/tmp/x");
});

test("resolveBridgeDir cai num caminho por plataforma quando não há override", () => {
  const dir = resolveBridgeDir({});
  assert.ok(dir.includes("vectorize-ae"), dir);
  assert.ok(path.isAbsolute(dir), dir);
});

test("writeJsonAtomic não deixa arquivo parcial visível", () => {
  const dir = tempDir();
  const target = path.join(dir, CMD_DIR, "x.json");

  writeJsonAtomic(target, { a: 1 });

  // O leitor faz polling por *.json; um .tmp deixado pra trás seria lido como
  // comando e executaria algo pela metade.
  const restos = fs.readdirSync(path.join(dir, CMD_DIR));
  assert.deepEqual(restos, ["x.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 1 });
});

test("consumeJson devolve null para arquivo ausente e apaga o que leu", () => {
  const dir = tempDir();
  const target = path.join(dir, RES_DIR, "y.json");

  assert.equal(consumeJson(target), null);

  writeJsonAtomic(target, { ok: true });
  assert.deepEqual(consumeJson(target), { ok: true });
  assert.equal(fs.existsSync(target), false, "precisa apagar após ler");
});

test("consumeJson trata JSON corrompido como erro, não como ausência", () => {
  const dir = tempDir();
  const target = path.join(dir, RES_DIR, "z.json");
  fs.writeFileSync(target, "{ isto não é json", "utf8");

  assert.throws(() => consumeJson(target), /ilegível/);
  // Mesmo com erro, remove — senão travaria toda leitura seguinte no mesmo id.
  assert.equal(fs.existsSync(target), false);
});

test("consumeJson com tolerateIncomplete trata JSON quebrado como 'ainda não chegou'", () => {
  const dir = tempDir();
  const target = path.join(dir, RES_DIR, "parcial.json");

  // O painel escreve direto no arquivo final — não dá pra contar com rename dentro
  // de res/ no AE 2026 — então quem faz polling pode chegar no meio da escrita.
  fs.writeFileSync(target, '{"id":"abc","ok":true,"resu', "utf8");

  assert.equal(consumeJson(target, { tolerateIncomplete: true }), null);
  assert.equal(fs.existsSync(target), true, "precisa sobrar para a próxima tentativa");

  fs.writeFileSync(target, '{"id":"abc","ok":true}', "utf8");
  assert.deepEqual(consumeJson(target, { tolerateIncomplete: true }), { id: "abc", ok: true });
});

test("a ponte aceita resposta escrita na raiz quando res/ recusa a escrita", async () => {
  const dir = tempDir();

  // Painel falso que só consegue escrever na raiz — é o comportamento observado no
  // After Effects 2026 do macOS, onde a gravação dentro de res/ falha em silêncio.
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(path.join(dir, CMD_DIR))) {
      if (!name.endsWith(".json")) continue;
      const command = consumeJson(path.join(dir, CMD_DIR, name));
      if (!command) continue;
      writeJsonAtomic(path.join(dir, `res-${command.id}.json`), {
        id: command.id,
        ok: true,
        result: { afterEffects: "26.3x87" },
      });
    }
  }, 10);

  try {
    const bridge = new Bridge({ dir, timeoutMs: 2000 });
    const { result } = await bridge.call("ping");
    assert.deepEqual(result, { afterEffects: "26.3x87" });
    assert.equal(fs.existsSync(path.join(dir, "res-")), false);
  } finally {
    clearInterval(timer);
  }
});

test("clearStale limpa respostas de fallback na raiz, mas nunca o heartbeat", () => {
  const dir = tempDir();
  const velhoNaRaiz = path.join(dir, "res-antigo.json");
  const heartbeat = path.join(dir, "heartbeat.json");
  const antigo = new Date(Date.now() - 600_000);

  writeJsonAtomic(velhoNaRaiz, { a: 1 });
  writeJsonAtomic(heartbeat, { at: 1 });
  fs.utimesSync(velhoNaRaiz, antigo, antigo);
  fs.utimesSync(heartbeat, antigo, antigo);

  assert.equal(clearStale(dir, 60_000), 1);
  assert.equal(fs.existsSync(velhoNaRaiz), false);
  // Apagar o heartbeat cegaria o diagnóstico de "o painel está vivo?".
  assert.equal(fs.existsSync(heartbeat), true);
});

test("clearStale remove só o que passou da idade máxima", () => {
  const dir = tempDir();
  const novo = path.join(dir, CMD_DIR, "novo.json");
  const velho = path.join(dir, CMD_DIR, "velho.json");

  writeJsonAtomic(novo, { a: 1 });
  writeJsonAtomic(velho, { a: 2 });
  fs.utimesSync(velho, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));

  assert.equal(clearStale(dir, 60_000), 1);
  assert.equal(fs.existsSync(novo), true);
  assert.equal(fs.existsSync(velho), false);
});

test("ids de comando são únicos", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(newCommandId());
  assert.equal(ids.size, 500);
});

// ---------------------------------------------------------------- ponte

test("ida e volta: comando executado devolve o resultado", async () => {
  const dir = tempDir();
  const stop = startFakePanel(dir, {
    ping: () => ({ afterEffects: "26.3x87" }),
  });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 3000 });
    const { result } = await bridge.call("ping");
    assert.deepEqual(result, { afterEffects: "26.3x87" });
  } finally {
    stop();
  }
});

test("argumentos chegam intactos no outro lado", async () => {
  const dir = tempDir();
  const stop = startFakePanel(dir, {
    describe_comp: (args) => ({ recebido: args }),
  });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 3000 });
    const { result } = await bridge.call("describe_comp", { compName: "Comp 1", selectedOnly: true });
    assert.deepEqual(result.recebido, { compName: "Comp 1", selectedOnly: true });
  } finally {
    stop();
  }
});

test("erro do painel vira BridgeError com a mensagem original", async () => {
  const dir = tempDir();
  const stop = startFakePanel(dir, {
    describe_layer: () => {
      throw new Error("Não encontrei a camada \"Título\".");
    },
  });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 3000 });
    await assert.rejects(
      () => bridge.call("describe_layer", { layerName: "Título" }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.kind, "tool-error");
        assert.match(err.message, /Não encontrei a camada/);
        return true;
      }
    );
  } finally {
    stop();
  }
});

test("sem painel, o timeout explica o que verificar em vez de só falhar", async () => {
  const dir = tempDir();
  const bridge = new Bridge({ dir, timeoutMs: 300 });

  await assert.rejects(
    () => bridge.call("ping"),
    (err) => {
      assert.equal(err.kind, "timeout");
      assert.match(err.message, /Window → Vectorize AE Bridge/);
      return true;
    }
  );
});

test("comando que estourou o tempo é retirado da fila", async () => {
  const dir = tempDir();
  const bridge = new Bridge({ dir, timeoutMs: 200 });

  await assert.rejects(() => bridge.call("ping"));

  // Deixar o comando na pasta faria o painel executá-lo quando abrisse, mexendo no
  // projeto sem que ninguém estivesse esperando por isso.
  assert.deepEqual(fs.readdirSync(path.join(dir, CMD_DIR)), []);
});

test("isAlive devolve false em vez de lançar quando não há painel", async () => {
  const dir = tempDir();
  const bridge = new Bridge({ dir });
  assert.equal(await bridge.isAlive({ timeoutMs: 200 }), false);
});

test("comandos simultâneos não trocam de resposta entre si", async () => {
  // O modo de falha clássico dessa ponte: dois comandos em voo, e o segundo lê o
  // resultado do primeiro. É o que o id por comando existe para impedir.
  const dir = tempDir();
  const stop = startFakePanel(dir, {
    eco: (args) => ({ valor: args.valor }),
  });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 5000 });
    const respostas = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => bridge.call("eco", { valor: n }))
    );
    assert.deepEqual(respostas.map((r) => r.result.valor), [1, 2, 3, 4, 5]);
  } finally {
    stop();
  }
});

test("um resultado velho na pasta não é entregue como resposta nova", async () => {
  const dir = tempDir();

  // Simula o cenário: sessão anterior deixou um resultado órfão.
  writeJsonAtomic(path.join(dir, RES_DIR, "antigo.json"), { id: "antigo", ok: true, result: "lixo" });

  const stop = startFakePanel(dir, { ping: () => "novo" });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 3000 });
    const { result } = await bridge.call("ping");
    assert.equal(result, "novo");
  } finally {
    stop();
  }
});

test("o painel só lê arquivos .json completos, nunca os .tmp", async () => {
  const dir = tempDir();

  // Um .tmp parado na pasta simula uma escrita interrompida.
  fs.writeFileSync(path.join(dir, CMD_DIR, "meio.json.tmp"), '{"id":"meio","too', "utf8");

  const stop = startFakePanel(dir, { ping: () => "ok" });

  try {
    const bridge = new Bridge({ dir, timeoutMs: 3000 });
    const { result } = await bridge.call("ping");
    assert.equal(result, "ok");
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------- diagnóstico

test("diagnose distingue painel ausente de painel que parou", () => {
  // A diferença entre estes dois estados é a diferença entre um clique e uma noite de
  // tentativas cegas. A informação existia no heartbeat e era descartada.
  const dir = tempDir();
  const bridge = new Bridge({ dir });

  const semSinal = bridge.diagnose();
  assert.equal(semSinal.state, "sem-sinal");
  assert.match(semSinal.message, /AÇÃO/);

  const heartbeat = path.join(dir, "heartbeat.json");

  writeJsonAtomic(heartbeat, { at: Date.now() - 600_000, afterEffects: "26.3x87", cycles: 4821, build: PANEL_BUILD_ESPERADO });
  const parado = bridge.diagnose();
  assert.equal(parado.state, "parado");
  assert.match(parado.message, /PAROU de escutar/);
  assert.match(parado.message, /4821 ciclos/, "quantos ciclos rodou antes de morrer");
  // Sem isto, um agente sem supervisão fica tentando para sempre.
  assert.match(parado.message, /não se resolve sozinho/);

  writeJsonAtomic(heartbeat, { at: Date.now(), afterEffects: "26.3x87", cycles: 12, revivals: 2, build: PANEL_BUILD_ESPERADO });
  const vivo = bridge.diagnose();
  assert.equal(vivo.state, "vivo");
  assert.match(vivo.message, /ESTÁ escutando/);
  assert.match(vivo.message, /2 reanimações/);
});

test("diagnose separa ponte desligada no botão de ponte travada", () => {
  // Os dois estados davam a mesma mensagem de alarme, e o conselho correto para cada
  // um é diferente: aqui basta clicar em Iniciar.
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, "heartbeat.json"), {
    at: Date.now() - 600_000,
    afterEffects: "26.3x87",
    cycles: 40,
    running: false,
    build: PANEL_BUILD_ESPERADO,
  });

  const parado = new Bridge({ dir }).diagnose();
  assert.equal(parado.state, "desligado");
  assert.match(parado.message, /PARADA no botão/);
  assert.doesNotMatch(parado.message, /diálogo/, "não é um caso de diálogo modal");
});

test("diagnose reconhece a assinatura do diálogo na subida", () => {
  // Congelar poucos segundos depois de iniciar não é uma ponte com defeito: é um
  // diálogo do After Effects bloqueando a thread principal. E enquanto ele está lá,
  // Parar → Iniciar não pode funcionar — o clique agenda uma tarefa que não roda.
  // Foi exatamente esse conselho impossível que um agente ficou repetindo.
  const dir = tempDir();
  const heartbeat = path.join(dir, "heartbeat.json");
  const base = {
    at: Date.now() - 120_000,
    afterEffects: "26.3x87",
    running: true,
    build: PANEL_BUILD_ESPERADO,
  };

  writeJsonAtomic(heartbeat, { ...base, cycles: 7, uptime: 2_400 });
  const naSubida = new Bridge({ dir }).diagnose();
  assert.equal(naSubida.state, "parado");
  assert.match(naSubida.message, /2\.4s de vida/);
  assert.match(naSubida.message, /Parar → Iniciar não resolve/);

  // Meia hora de vida antes de congelar é outro problema: não vale culpar a subida.
  writeJsonAtomic(heartbeat, { ...base, cycles: 5_000, uptime: 1_800_000 });
  const maisTarde = new Bridge({ dir }).diagnose();
  assert.equal(maisTarde.state, "parado");
  assert.doesNotMatch(maisTarde.message, /Parar → Iniciar não resolve/);
});

test("diagnose trata a pausa por bloqueio como recado, não como defeito", () => {
  // A ponte se pausa sozinha quando o After Effects está sendo usado. Mandar "clique em
  // Iniciar" aqui significaria voltar a atrapalhar quem está trabalhando.
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, "heartbeat.json"), {
    at: Date.now() - 60_000,
    afterEffects: "26.3x87",
    cycles: 120,
    running: false,
    pausadaPorBloqueio: true,
    build: PANEL_BUILD_ESPERADO,
  });

  const pausada = new Bridge({ dir }).diagnose();
  assert.equal(pausada.state, "pausada");
  assert.match(pausada.message, /PAUSOU sozinha/);
  assert.match(pausada.message, /NÃO fique tentando/);
});

test("diagnose avisa que a ponte viva pode estar só devagar", () => {
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, "heartbeat.json"), {
    at: Date.now(),
    afterEffects: "26.3x87",
    cycles: 90,
    running: true,
    intervalo: 16_000,
    build: PANEL_BUILD_ESPERADO,
  });

  const vivo = new Bridge({ dir }).diagnose();
  assert.equal(vivo.state, "vivo");
  assert.match(vivo.message, /RECUO/);
  assert.match(vivo.message, /timeout maior/);
});

test("painel desatualizado vira o diagnóstico principal, acima de tudo", () => {
  // Investigar comportamento de um painel velho é investigar código que não existe mais.
  // Já aconteceu: um aviso da fila de render corrigido reapareceu, e a leitura natural —
  // "a correção está errada" — era falsa. A correção estava certa e não estava rodando.
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, "heartbeat.json"), {
    at: Date.now(),
    afterEffects: "26.3x87",
    cycles: 40,
    running: true,
    build: PANEL_BUILD_ESPERADO - 1,
  });

  const velho = new Bridge({ dir }).diagnose();
  assert.equal(velho.state, "desatualizado");
  assert.match(velho.message, /REINICIAR o After Effects/);
  assert.match(velho.message, /NÃO investigue/);
});

test("heartbeat sem marca de build também conta como desatualizado", () => {
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, "heartbeat.json"), {
    at: Date.now(),
    afterEffects: "26.3x87",
    cycles: 40,
    running: true,
  });

  assert.equal(new Bridge({ dir }).diagnose().state, "desatualizado");
});

test("diagnose não estoura com heartbeat corrompido", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "heartbeat.json"), "{ lixo", "utf8");

  assert.equal(new Bridge({ dir }).diagnose().state, "sem-sinal");
});
