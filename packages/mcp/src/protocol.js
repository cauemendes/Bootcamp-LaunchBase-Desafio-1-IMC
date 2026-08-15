/**
 * Protocolo da ponte com o After Effects.
 *
 * ── Por que arquivos ──────────────────────────────────────────────────────────
 * O After Effects não tem servidor de scripting. Nenhum processo externo consegue
 * chamar o AE — alguma coisa precisa rodar *dentro* dele. A ponte é um painel
 * ScriptUI aberto no AE que fica lendo uma pasta compartilhada.
 *
 *   servidor MCP  →  escreve  cmd/<id>.json   →  painel lê, executa
 *   servidor MCP  ←  lê       res/<id>.json   ←  painel escreve
 *
 * ── Escrita atômica ───────────────────────────────────────────────────────────
 * Os dois lados escrevem num arquivo `.tmp` e só então renomeiam para o nome final.
 * Sem isso, o leitor pode pegar um JSON pela metade — o polling não tem como saber
 * que a escrita ainda está acontecendo, e o erro seria intermitente e confuso.
 *
 * ── ID por comando ────────────────────────────────────────────────────────────
 * Cada comando tem id próprio e o resultado usa o mesmo id. Isso evita ler
 * resultado velho de um comando anterior, que é a falha clássica desse tipo de
 * ponte: o servidor pergunta de novo e recebe a resposta da pergunta passada.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const CMD_DIR = "cmd";
export const RES_DIR = "res";

/**
 * Pasta da ponte.
 *
 * Espelha o que `Folder.userData` devolve no ExtendScript, para que os dois lados
 * cheguem no mesmo lugar sem precisar combinar nada. A variável de ambiente existe
 * para testes e para quem quiser apontar pra outro disco.
 */
export function resolveBridgeDir(env = process.env) {
  if (env.VECTORIZE_AE_BRIDGE_DIR) return env.VECTORIZE_AE_BRIDGE_DIR;

  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : path.join(os.homedir(), ".local", "share");

  return path.join(base, "vectorize-ae", "bridge");
}

export function ensureBridgeDirs(dir) {
  fs.mkdirSync(path.join(dir, CMD_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, RES_DIR), { recursive: true });
  return dir;
}

/** Id curto, ordenável por tempo — ajuda a depurar olhando a pasta. */
export function newCommandId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export function commandPath(dir, id) {
  return path.join(dir, CMD_DIR, `${id}.json`);
}

export function resultPath(dir, id) {
  return path.join(dir, RES_DIR, `${id}.json`);
}

/** Escreve JSON de forma atômica: `.tmp` e depois rename. */
export function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Lê e apaga um JSON, se existir.
 *
 * `null` quando o arquivo não existe ainda — que é o caso normal durante o polling,
 * não um erro. Um JSON ilegível, por outro lado, é erro: significa que a escrita
 * atômica falhou em algum lugar e é melhor saber do que engolir.
 */
export function consumeJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Arquivo da ponte ilegível em ${filePath}: ${err.message}`);
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Já removido por outro leitor — não é problema.
    }
  }
}

/**
 * Remove comandos e resultados antigos.
 *
 * Se o painel estiver fechado, os comandos se acumulam e o próximo `start` do
 * painel executaria uma fila de pedidos que ninguém está mais esperando. Rodar isso
 * no início de cada sessão evita ações fantasma no projeto do usuário.
 */
export function clearStale(dir, maxAgeMs = 60_000) {
  const now = Date.now();
  let removed = 0;

  for (const sub of [CMD_DIR, RES_DIR]) {
    const full = path.join(dir, sub);
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }

    for (const name of entries) {
      const file = path.join(full, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        // Sumiu no meio do caminho — segue.
      }
    }
  }

  return removed;
}
