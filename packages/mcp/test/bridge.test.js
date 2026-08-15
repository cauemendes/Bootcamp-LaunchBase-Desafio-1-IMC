import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Bridge, BridgeError } from "../src/bridge.js";
import {
  CMD_DIR,
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
