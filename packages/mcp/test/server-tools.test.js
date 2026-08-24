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

  assert.match(texto, /Estrutura: /);
  assert.match(texto, /Área: /);
  assert.match(texto, /Onde a diferença se concentra/);
  assert.match(texto, /em 0,0/);

  // A leitura vem junto do número: sem ela, área alta parece o problema principal —
  // que foi exatamente a conclusão errada tirada de uma comparação real.
  assert.match(texto, /ESTRUTURA ALTA|DESENHO bate|reconstrução bate/);
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

test("crop_image sem retângulo isola pela semente e não corta a ilustração", () => {
  // ── Por que o retângulo virou opcional ───────────────────────────────────────
  // Medir o retângulo de uma ilustração olhando um frame é chute com régua, e errar para
  // dentro corta o desenho — foi o defeito que mais voltou, inclusive num braço robótico
  // cortado na parte de baixo. Com isolate, errar para FORA deixou de custar: o vizinho é
  // descartado por conectividade. Então a imagem inteira pode entrar, e a própria
  // ilustração define os limites.
  return conectar().then(async ({ client }) => {
    const dir = tempDir();

    // Ilustração à esquerda, vizinho da mesma cor à direita, os dois longe da borda.
    const origem = gravarPng(path.join(dir, "cena.png"), 80, 40, (x, y) => {
      const faixa = y >= 10 && y <= 30;
      if (faixa && x >= 6 && x <= 24) return [20, 20, 30];
      if (faixa && x >= 55 && x <= 72) return [20, 20, 30];
      return [247, 245, 240];
    });

    const r = await client.callTool({
      name: "crop_image",
      arguments: { path: origem, removeBackground: true, trim: true, isolate: { x: 15, y: 20 } },
    });

    assert.equal(r.isError, undefined, JSON.stringify(r.content));
    const texto = r.content.find((c) => c.type === "text").text;

    // As coordenadas devolvidas são as da ilustração, não de um retângulo pedido.
    assert.match(texto, /"x": 6/);
    assert.match(texto, /"w": 19/);

    // E nada encostando na borda: sem retângulo, não há como cortar.
    assert.doesNotMatch(texto, /ATENÇÃO: sobrou desenho/);
  });
});

test("sem retângulo e sem semente, a ferramenta recusa e explica o caminho bom", () => {
  return conectar().then(async ({ client }) => {
    const dir = tempDir();
    const origem = gravarPng(path.join(dir, "x.png"), 20, 20, () => [247, 245, 240]);

    const r = await client.callTool({ name: "crop_image", arguments: { path: origem } });

    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /caminho preferido/);
  });
});

// ── Arrumação de projeto ──────────────────────────────────────────────────────
// Renomear em lote e mudar duração são as tarefas em que o assistente é mais confiável, e
// por isso mesmo as que ninguém confere. Os testes abaixo travam o que faz a resposta ser
// conferível: a lista de antes → depois, e o aviso de camada fora do intervalo.

test("rename_items mostra o antes e o depois de cada item", async () => {
  const { client, chamadas } = await conectar({
    rename_items: (args) => ({
      count: args.items.length + args.layers.length,
      renamed: [
        { kind: "item", id: 12, from: "Comp 1", to: "SC01" },
        { kind: "layer", comp: "SC01", index: 3, from: "Shape Layer 1", to: "bg" },
      ],
      warnings: [],
    }),
  });

  const r = await client.callTool({
    name: "rename_items",
    arguments: {
      items: [{ id: 12, name: "SC01" }],
      layers: [{ compName: "SC01", layerIndex: 3, name: "bg" }],
    },
  });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  const texto = r.content[0].text;

  // A lista é o ponto: "renomeei 2 itens" não deixa ninguém conferir.
  assert.match(texto, /“Comp 1” → “SC01”/);
  assert.match(texto, /SC01 · camada 3: “Shape Layer 1” → “bg”/);

  // E os ids chegam intactos na ponte — agir por nome renomearia a comp errada.
  assert.deepEqual(chamadas[0].args.items, [{ id: 12, name: "SC01" }]);
});

test("rename_items recusa lote vazio sem incomodar o After Effects", async () => {
  const { client, chamadas } = await conectar({});
  const r = await client.callTool({ name: "rename_items", arguments: {} });

  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /describe_project/);
  assert.equal(chamadas.length, 0);
});

test("set_comp_settings avisa quando encurtar a duração esconde camadas", async () => {
  // Encurtar não apaga nada, e é aí que mora o susto: as camadas continuam lá, fora do
  // intervalo visível, e a comp parece ter perdido conteúdo sem nenhum aviso do AE.
  const { client } = await conectar({
    set_comp_settings: () => ({
      comp: "SC01",
      id: 12,
      changed: ["duration"],
      before: { name: "SC01", duration: 10, frameRate: 25, width: 1920, height: 1080 },
      after: { name: "SC01", duration: 4, frameRate: 25, width: 1920, height: 1080 },
      layersOutOfRange: 2,
    }),
  });

  const r = await client.callTool({
    name: "set_comp_settings",
    arguments: { id: 12, durationSeconds: 4 },
  });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  const texto = r.content[0].text;

  assert.match(texto, /"duration": 10/);
  assert.match(texto, /"duration": 4/);
  assert.match(texto, /2 camada\(s\) começam depois do fim da comp/);
});

test("set_comp_settings sem camadas escondidas não inventa aviso", async () => {
  const { client } = await conectar({
    set_comp_settings: () => ({
      comp: "SC01",
      id: 12,
      changed: ["name"],
      before: { name: "Comp 1", duration: 4, frameRate: 25, width: 1920, height: 1080 },
      after: { name: "SC01", duration: 4, frameRate: 25, width: 1920, height: 1080 },
      layersOutOfRange: 0,
    }),
  });

  const r = await client.callTool({
    name: "set_comp_settings",
    arguments: { compName: "Comp 1", name: "SC01" },
  });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  assert.doesNotMatch(r.content[0].text, /camadasForaDoIntervalo/);
});

test("move_to_folder diz de onde cada item saiu e se a pasta nasceu agora", async () => {
  const { client } = await conectar({
    move_to_folder: (args) => ({
      folder: args.folderName,
      folderId: 99,
      created: true,
      moved: [
        { id: 12, name: "SC01", from: null },
        { id: 13, name: "SC02", from: "old" },
      ],
      count: 2,
      warnings: [],
    }),
  });

  const r = await client.callTool({
    name: "move_to_folder",
    arguments: { folderName: "scenes", itemIds: [12, 13] },
  });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));
  const texto = r.content[0].text;

  assert.match(texto, /SC01 \(de raiz do projeto\)/);
  assert.match(texto, /SC02 \(de old\)/);

  // "A pasta foi criada agora" é o que explica um destino com erro de digitação.
  assert.match(texto, /"pastaCriadaAgora": true/);
});

test("move_to_folder sem ids recusa antes de criar pasta nenhuma", async () => {
  const { client, chamadas } = await conectar({});
  const r = await client.callTool({
    name: "move_to_folder",
    arguments: { folderName: "scenes", itemIds: [] },
  });

  assert.equal(r.isError, true);
  assert.equal(chamadas.length, 0);
});

test("animate_layers manda a máscara junto, não só os keyframes", async () => {
  // A máscara do revealIn precisa existir ANTES do primeiro keyframe: ela é medida com
  // o texto parado. Se o servidor esquecesse `setups` no caminho, a animação chegaria
  // inteira e o texto deslizaria à vista de todos, sem nenhum erro para explicar.
  const { client, chamadas } = await conectar({
    animate: () => ({ ok: true, compName: "SC01", applied: 1, keyframes: 2, masks: 1, warnings: [] }),
  });

  const r = await client.callTool({
    name: "animate_layers",
    arguments: {
      animJson: JSON.stringify({ fps: 25, targets: [{ layer: "Título", preset: "revealIn" }] }),
      compName: "SC01",
    },
  });

  assert.equal(r.isError, undefined, JSON.stringify(r.content));

  const enviado = chamadas[0].args;
  assert.deepEqual(enviado.setups, [
    { layer: "Título", kind: "revealMask", from: "bottom", padding: 2 },
  ]);
  assert.equal(enviado.tracks[0].property, "textPosition");
  assert.equal(enviado.tracks[0].unit, "layerHeight");

  assert.match(r.content[0].text, /"mascaras": 1/);
});
