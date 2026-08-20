/**
 * Chama as ferramentas do servidor de verdade, por cima do protocolo MCP.
 *
 * ── Por que isto passou a existir ─────────────────────────────────────────────
 * O servidor não tinha teste nenhum, e o preço apareceu: uma variável usada e nunca
 * declarada dentro do handler de `save_frame` passou por revisão, passou por "o módulo
 * carrega", e só estourou na mão de quem estava usando — `recuperado is not defined`, em
 * toda chamada, bloqueando o trabalho.
 *
 * Módulo ES é strict, então identificador não declarado só falha em tempo de execução.
 * Nenhuma checagem de sintaxe pega isso. O que pega é chamar.
 *
 * A ponte é falsa: o objetivo aqui não é o After Effects, é o caminho que vai da chamada
 * da ferramenta até a resposta — que é onde esse defeito morava.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { encodePng } from "../../core/src/png-encode.js";
import { BrandStore } from "../src/brand-store.js";
import { createServer } from "../src/server.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vec-server-test-"));

/** PNG de verdade em disco, para as ferramentas que leem arquivo. */
function gravarPng(destino, width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = pixel(x, y);
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }

  fs.writeFileSync(
    destino,
    encodePng({ width, height, data }, (b) => new Uint8Array(zlib.deflateSync(Buffer.from(b))))
  );

  return destino;
}

/**
 * Sobe o servidor com uma ponte falsa e devolve um cliente MCP conectado.
 *
 * `respostas` mapeia nome de ferramenta da ponte para uma função que devolve o result —
 * é o que permite simular o After Effects sem ter um.
 */
async function conectar(respostas = {}) {
  const chamadas = [];

  const bridge = {
    dir: tempDir(),
    async call(tool, args) {
      chamadas.push({ tool, args });
      const responder = respostas[tool];
      if (!responder) throw new Error(`ponte falsa não sabe responder "${tool}"`);
      return { result: await responder(args, chamadas), warnings: [] };
    },
    diagnose: () => ({ state: "vivo", message: "ponte falsa", heartbeat: null }),
  };

  const server = createServer({ bridge, brands: new BrandStore({ dir: tempDir() }) });
  const client = new Client({ name: "teste", version: "0" });

  const [aqui, ali] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ali), client.connect(aqui)]);

  return { client, chamadas };
}

test("save_frame responde com a imagem e o caminho do arquivo", async () => {
  // O caminho na resposta é o que permite medir e recortar em cima do frame. Sem ele,
  // quem está do outro lado pede um print à pessoa.
  const dir = tempDir();
  const frame = gravarPng(path.join(dir, "frame.png"), 40, 30, (x) => (x < 20 ? [10, 20, 30] : [240, 240, 240]));

  const { client } = await conectar({
    save_frame: () => ({ path: frame, method: "saveFrameToPng", time: 1.5, comp: "Cena 1", width: 40, height: 30 }),
  });

  const r = await client.callTool({ name: "save_frame", arguments: {} });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));

  const texto = r.content.find((c) => c.type === "text").text;
  assert.match(texto, /Cena 1/);
  assert.match(texto, /40×30/);
  assert.match(texto, new RegExp(frame.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.ok(r.content.some((c) => c.type === "image"), "a imagem vem junto");
});

test("frame preto da fila faz o servidor tentar a API direta", async () => {
  // ── O comportamento que este teste tranca ────────────────────────────────────
  // A fila de render entrega preto sólido em projeto com footage de vídeo offline, e
  // preto sólido passa por frame: quem medir cor nele recebe respostas coerentes e a cena
  // sai inteira escura. Já que os dois caminhos falham em situações diferentes, receber
  // preto de um é motivo para tentar o outro.
  const dir = tempDir();
  const preto = gravarPng(path.join(dir, "preto.png"), 20, 20, () => [0, 0, 0]);
  const bom = gravarPng(path.join(dir, "bom.png"), 20, 20, (x, y) => [x * 10, y * 10, 90]);

  const { client, chamadas } = await conectar({
    save_frame: (args) =>
      args.method === "direct"
        ? { path: bom, method: "saveFrameToPng", time: 0, comp: "C", width: 20, height: 20 }
        : { path: preto, method: "renderQueue", time: 0, comp: "C", width: 20, height: 20 },
  });

  const r = await client.callTool({ name: "save_frame", arguments: {} });
  const texto = r.content.find((c) => c.type === "text").text;

  assert.equal(chamadas.length, 2, "tentou os dois caminhos");
  assert.equal(chamadas[1].args.method, "direct");
  assert.match(texto, /frame vazio/);
  assert.doesNotMatch(texto, /ATENÇÃO: o frame saiu/, "o segundo caminho resolveu");
});

test("frame preto nos dois caminhos avisa em vez de deixar passar", async () => {
  const dir = tempDir();
  const preto = gravarPng(path.join(dir, "p.png"), 16, 16, () => [0, 0, 0]);

  const { client } = await conectar({
    save_frame: () => ({ path: preto, method: "renderQueue", time: 0, comp: "C", width: 16, height: 16 }),
  });

  const texto = (await client.callTool({ name: "save_frame", arguments: {} })).content.find(
    (c) => c.type === "text"
  ).text;

  assert.match(texto, /ATENÇÃO: o frame saiu/);
  assert.match(texto, /NÃO meça nada aqui/);
});

test("frame menor que a comp vira aviso de não medir", async () => {
  // Resolução da composição em Half: as medidas sairiam coerentes entre si e erradas
  // pelo mesmo fator, sem nada falhar.
  const dir = tempDir();
  const metade = gravarPng(path.join(dir, "m.png"), 30, 20, (x, y) => [x, y, 100]);

  const { client } = await conectar({
    save_frame: () => ({ path: metade, method: "saveFrameToPng", time: 0, comp: "C", width: 60, height: 40 }),
  });

  const texto = (await client.callTool({ name: "save_frame", arguments: {} })).content.find(
    (c) => c.type === "text"
  ).text;

  assert.match(texto, /30×20/);
  assert.match(texto, /NÃO meça nada neste frame/);
});

test("compare_images aponta onde a diferença se concentra", async () => {
  const dir = tempDir();
  const ref = gravarPng(path.join(dir, "ref.png"), 60, 60, () => [240, 240, 240]);
  const res = gravarPng(path.join(dir, "res.png"), 60, 60, (x, y) =>
    x < 15 && y < 15 ? [10, 10, 10] : [240, 240, 240]
  );

  const { client } = await conectar();
  const r = await client.callTool({
    name: "compare_images",
    arguments: { reference: ref, result: res, diffOut: path.join(dir, "diff.png") },
  });

  const texto = r.content.find((c) => c.type === "text").text;

  assert.match(texto, /% dos pixels diferem/);
  assert.match(texto, /Onde a diferença se concentra/);
  assert.match(texto, /em 0,0/);
  assert.ok(fs.existsSync(path.join(dir, "diff.png")), "gravou a imagem de diferença");
});

test("compare_images recusa tamanhos diferentes explicando a causa", async () => {
  const dir = tempDir();
  const a = gravarPng(path.join(dir, "a.png"), 10, 10, () => [1, 2, 3]);
  const b = gravarPng(path.join(dir, "b.png"), 20, 20, () => [1, 2, 3]);

  const { client } = await conectar();
  const r = await client.callTool({ name: "compare_images", arguments: { reference: a, result: b } });

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Half/);
});

test("crop_image recorta, tira o fundo e devolve as coordenadas de uso", async () => {
  const dir = tempDir();
  // Fundo chapado com uma forma no meio.
  const origem = gravarPng(path.join(dir, "src.png"), 40, 40, (x, y) =>
    x >= 10 && x <= 25 && y >= 10 && y <= 25 ? [20, 20, 30] : [247, 245, 240]
  );

  const { client } = await conectar();
  const r = await client.callTool({
    name: "crop_image",
    arguments: { path: origem, x: 5, y: 5, width: 30, height: 30, removeBackground: true, trim: true },
  });

  const texto = r.content.find((c) => c.type === "text").text;

  assert.match(texto, /Fundo #f7f5f0 removido/);
  assert.match(texto, /"type": "image"/);
  // Com trim, as coordenadas devolvidas são as da forma, não as pedidas.
  assert.match(texto, /"x": 10/);
  assert.match(texto, /"w": 16/);
});

test("crop_image avisa quando o recorte cortou a ilustração", async () => {
  const dir = tempDir();
  // Forma indo até a borda direita da imagem: qualquer recorte ali corta o desenho.
  const origem = gravarPng(path.join(dir, "src2.png"), 40, 40, (x, y) =>
    x >= 20 && y >= 10 && y <= 25 ? [20, 20, 30] : [247, 245, 240]
  );

  const { client } = await conectar();
  const r = await client.callTool({
    name: "crop_image",
    arguments: { path: origem, x: 15, y: 5, width: 15, height: 30, removeBackground: true },
  });

  assert.match(r.content.find((c) => c.type === "text").text, /ATENÇÃO: sobrou desenho/);
});

test("isolate descarta o vizinho e a semente é em coordenada da origem", async () => {
  const dir = tempDir();
  // Duas formas da mesma cor, separadas por fundo.
  const origem = gravarPng(path.join(dir, "src3.png"), 60, 30, (x, y) => {
    const dentro = y >= 8 && y <= 20;
    if (dentro && x >= 5 && x <= 18) return [20, 20, 30];
    if (dentro && x >= 40 && x <= 52) return [20, 20, 30];
    return [247, 245, 240];
  });

  const { client } = await conectar();
  const r = await client.callTool({
    name: "crop_image",
    arguments: {
      path: origem,
      x: 0,
      y: 0,
      width: 60,
      height: 30,
      removeBackground: true,
      isolate: { x: 10, y: 14 },
    },
  });

  const texto = r.content.find((c) => c.type === "text").text;
  assert.match(texto, /Isolamento:/);
  assert.match(texto, /descartados/);
});

test("semente fora da ilustração vira erro que diz o espaço de coordenadas", async () => {
  const dir = tempDir();
  const origem = gravarPng(path.join(dir, "src4.png"), 30, 30, (x, y) =>
    x >= 10 && x <= 20 && y >= 10 && y <= 20 ? [20, 20, 30] : [247, 245, 240]
  );

  const { client } = await conectar();
  const r = await client.callTool({
    name: "crop_image",
    arguments: {
      path: origem,
      x: 0,
      y: 0,
      width: 30,
      height: 30,
      removeBackground: true,
      isolate: { x: 2, y: 2 },
    },
  });

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /IMAGEM DE ORIGEM/);
});

test("check_bridge devolve o diagnóstico quando a ponte não responde", async () => {
  const { client } = await conectar({});
  const r = await client.callTool({ name: "check_bridge", arguments: {} });

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /DIAGNÓSTICO/);
});
