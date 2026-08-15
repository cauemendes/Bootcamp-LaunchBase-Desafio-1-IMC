#!/usr/bin/env node
/**
 * Analisa uma imagem pela linha de comando e escreve o SceneSpec.
 *
 * Serve para iterar no prompt e no schema sem abrir o After Effects, e para gerar
 * cenas de referência que podem ser versionadas e comparadas entre mudanças.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… node scripts/analyze.mjs poster.png --out cena.json
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  analyzeImage,
  createClient,
  normalizeScene,
  readImageInfo,
  toBase64,
  AnalysisError,
  DEFAULT_MODEL,
} from "../packages/core/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    hints: { type: "string", short: "h" },
    model: { type: "string", short: "m", default: DEFAULT_MODEL },
    effort: { type: "string", short: "e", default: "high" },
    normalized: { type: "boolean", default: false },
  },
});

const imagePath = positionals[0];

if (!imagePath) {
  console.error(`Uso: node scripts/analyze.mjs <imagem> [opções]

  -o, --out <arquivo>    onde escrever o JSON (padrão: stdout)
  -h, --hints <texto>    instruções extras para o modelo
  -m, --model <id>       modelo (padrão: ${DEFAULT_MODEL})
  -e, --effort <nível>   low | medium | high | xhigh | max (padrão: high)
      --normalized       escreve a forma aninhada, a que o ExtendScript consome
`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY não está definida no ambiente.");
  process.exit(1);
}

const bytes = new Uint8Array(fs.readFileSync(imagePath));
const info = readImageInfo(bytes);

console.error(`Analisando ${path.basename(imagePath)} (${info.width}×${info.height}) com ${values.model}…`);

let result;
try {
  result = await analyzeImage({
    client: createClient({ apiKey }),
    imageBase64: toBase64(bytes),
    mediaType: info.mediaType,
    width: info.width,
    height: info.height,
    hints: values.hints,
    model: values.model,
    effort: values.effort,
  });
} catch (err) {
  console.error(err instanceof AnalysisError ? `\n${err.message}` : err);
  process.exit(1);
}

const { scene, validation, usage } = result;

// Relatório vai pro stderr para que `> arquivo.json` continue funcionando.
console.error(
  `\n${scene.elements.length} elementos · ${scene.palette.length} cores · ` +
    `${usage.input_tokens} tokens de entrada, ${usage.output_tokens} de saída`
);

for (const e of validation.errors) console.error(`  ERRO   ${e}`);
for (const w of validation.warnings) console.error(`  aviso  ${w}`);

const output = values.normalized ? normalizeScene(scene) : scene;
const json = JSON.stringify(output, null, 2);

if (values.out) {
  fs.writeFileSync(values.out, json + "\n", "utf8");
  console.error(`\nEscrito em ${values.out}`);
} else {
  process.stdout.write(json + "\n");
}

// Sai com código de erro se a cena não é construível — assim dá pra usar em script.
process.exit(validation.ok ? 0 : 2);
