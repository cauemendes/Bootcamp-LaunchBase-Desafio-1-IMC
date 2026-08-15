#!/usr/bin/env node
/**
 * Junta um .jsx e tudo que ele inclui num arquivo só.
 *
 * ── Por que não confiar no //@include ────────────────────────────────────────
 * O preprocessador do ExtendScript resolve includes relativos ao arquivo que os
 * contém — em teoria. Na prática, o comportamento varia entre versões do After
 * Effects, entre `#include` e `//@include`, e muda quando o script é copiado para
 * dentro do pacote do aplicativo, que é exatamente o que a instalação faz.
 *
 * Quando falha, falha em silêncio: o painel abre, a interface aparece, e só na
 * primeira chamada é que se descobre que `vec.runTool` não existe. O sintoma fica
 * longe da causa.
 *
 * Resolvendo os includes aqui, a instalação passa a ser um arquivo único sem
 * dependência nenhuma — e some uma classe inteira de erro.
 *
 *   node scripts/bundle-jsx.mjs packages/jsx/bridge-panel.jsx dist/bridge-panel.jsx
 */

import fs from "node:fs";
import path from "node:path";

const INCLUDE_RE = /^\s*(?:\/\/@include|#include)\s+["']([^"']+)["']\s*;?\s*$/;
const TARGETENGINE_RE = /^\s*#targetengine\s+["']([^"']+)["']\s*;?\s*$/;

/**
 * @param {string} entry   arquivo de entrada
 * @returns {{ code: string, files: string[] }}
 */
export function bundleJsx(entry) {
  const included = new Set();
  const files = [];
  let targetEngine = null;

  function resolve(file) {
    const absolute = path.resolve(file);

    // Um arquivo incluído duas vezes (util.jsx é incluído por vários) redefiniria
    // tudo. Inofensivo aqui, mas dobra o tamanho e confunde números de linha no erro.
    if (included.has(absolute)) return "";
    included.add(absolute);
    files.push(absolute);

    const dir = path.dirname(absolute);
    let source;

    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch (err) {
      throw new Error(`Não consegui ler o include ${absolute}: ${err.message}`);
    }

    const out = [];

    for (const line of source.split("\n")) {
      const engine = TARGETENGINE_RE.exec(line);
      if (engine) {
        // #targetengine precisa ser a primeira linha do arquivo final; guardamos
        // e reemitimos no topo.
        targetEngine = engine[1];
        continue;
      }

      const include = INCLUDE_RE.exec(line);
      if (include) {
        out.push(`// ── ${include[1]} ──`);
        out.push(resolve(path.join(dir, include[1])));
        continue;
      }

      out.push(line);
    }

    return out.join("\n");
  }

  const body = resolve(entry);

  const header = [
    "/*",
    " * GERADO AUTOMATICAMENTE — não edite este arquivo.",
    " *",
    " * Produzido por scripts/bundle-jsx.mjs a partir de:",
    ...files.map((f) => ` *   ${path.relative(process.cwd(), f)}`),
    " *",
    " * Edite os originais em packages/jsx/ e rode a instalação de novo.",
    " */",
    "",
  ];

  if (targetEngine) {
    // Precisa vir antes de tudo, inclusive do comentário — o preprocessador só
    // reconhece #targetengine no começo do arquivo.
    header.unshift(`#targetengine "${targetEngine}"`, "");
  }

  return { code: header.join("\n") + body + "\n", files };
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const [entry, output] = process.argv.slice(2);

  if (!entry) {
    console.error("Uso: node scripts/bundle-jsx.mjs <entrada.jsx> [saida.jsx]");
    process.exit(1);
  }

  const { code, files } = bundleJsx(entry);

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, code, "utf8");
    console.error(`${files.length} arquivo(s) → ${output} (${(code.length / 1024).toFixed(1)} kB)`);
  } else {
    process.stdout.write(code);
  }
}
