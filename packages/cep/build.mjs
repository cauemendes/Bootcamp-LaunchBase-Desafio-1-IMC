/**
 * Bundle do painel.
 *
 * O painel importa o core (ESM) e o SDK da Anthropic (pacote npm), e o Chromium do
 * CEP não resolve `node_modules` sozinho — daí o bundle.
 *
 * `fs`, `path` e `os` ficam de fora: quem resolve esses é o Node embutido do CEP em
 * tempo de execução, via o `require` global que `--enable-nodejs --mixed-context`
 * expõe. O `cep-bridge.js` acessa esse require através de `window` justamente para
 * que o esbuild não tente empacotá-los aqui.
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * O ExtendScript é copiado para dentro do pacote da extensão porque o `ScriptPath`
 * do manifesto precisa apontar para um caminho dentro dela. Copiar (e não linkar)
 * mantém a pasta da extensão autocontida, que é como ela vai ser empacotada num
 * .zxp mais adiante.
 */
function syncExtendScript() {
  const from = path.resolve(here, "../jsx");
  const to = path.join(here, "jsx");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`ExtendScript copiado: ${path.relative(process.cwd(), to)}`);
}

syncExtendScript();

const options = {
  entryPoints: [path.join(here, "src/main.js")],
  outfile: path.join(here, "js/panel.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  // O Chromium do CEP 11 é moderno o bastante; não vale transpilar mais que isso.
  target: "chrome99",
  external: ["fs", "path", "os"],
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Observando mudanças em src/ — Ctrl+C para sair.");
} else {
  await esbuild.build(options);
}
