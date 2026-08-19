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

/**
 * Build do painel que este servidor espera encontrar instalado.
 *
 * ── Por que um número, e por que ele importa tanto ────────────────────────────
 * O painel é um arquivo copiado à mão para dentro do After Effects, e a engine
 * `vectorizeAE` só relê esse arquivo quando o aplicativo sobe. Ou seja: dá para
 * corrigir um defeito, commitar, copiar o arquivo — e continuar rodando o código
 * antigo, porque o AE não foi reiniciado.
 *
 * Isso já custou uma rodada inteira de diagnóstico: um aviso da fila de render que
 * havia sido corrigido reapareceu, e a conclusão natural — "a correção está errada" —
 * era falsa. A correção estava certa e não estava rodando.
 *
 * Suba este número junto com qualquer mudança no painel que o servidor precise
 * enxergar. Divergência passa a ser um fato observável, não uma hipótese.
 */
export const PANEL_BUILD_ESPERADO = 5;

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

/**
 * Onde o painel responde quando a subpasta `res/` não aceita a escrita.
 *
 * No After Effects 2026 do macOS, gravar dentro de `res/` falhou em silêncio —
 * arquivos de zero byte, `rename()` devolvendo false — enquanto a raiz da pasta da
 * ponte funcionou normalmente. O painel tenta o caminho normal primeiro e só cai
 * para cá quando confere o que gravou e vê que não colou.
 */
export function fallbackResultPath(dir, id) {
  return path.join(dir, `res-${id}.json`);
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
 * falhou em algum lugar e é melhor saber do que engolir.
 *
 * `tolerateIncomplete` inverte essa escolha para quem está fazendo polling. O painel
 * escreve o resultado direto no arquivo final (o par `.tmp`+rename não funciona
 * dentro de `res/` no AE 2026), então existe uma janela em que o leitor pode chegar
 * no meio da escrita. Nesse contexto, JSON quebrado quase sempre significa "ainda
 * não terminou de chegar", e a resposta certa é tentar de novo no próximo ciclo —
 * não estourar. O arquivo fica onde está para a próxima tentativa.
 */
export function consumeJson(filePath, { tolerateIncomplete = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (tolerateIncomplete) return null;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Já removido por outro leitor — não é problema.
    }
    throw new Error(`Arquivo da ponte ilegível em ${filePath}: ${err.message}`);
  }

  try {
    fs.unlinkSync(filePath);
  } catch {
    // Já removido por outro leitor — não é problema.
  }

  return parsed;
}

/**
 * Apaga PNGs de frame que ninguém mais vai ler.
 *
 * ── Por que não apagar tudo ───────────────────────────────────────────────────
 * O frame não pode ser apagado assim que é lido: `measure_image` abre o mesmo arquivo
 * em seguida, e é dele que saem todas as medidas. Então ele sobrevive alguns minutos —
 * e sobreviver é o que enche a pasta de quem usa a ferramenta um dia inteiro.
 *
 * Limpar no início de cada sessão fecha a conta. Com uma ressalva: pode haver outra
 * sessão rodando ao mesmo tempo, em outra conversa, com um frame recém-renderizado
 * esperando para ser medido. Apagar a pasta inteira arrancaria o chão dela. Por isso
 * a idade mínima, curta o bastante para não deixar lixo e longa o bastante para não
 * atropelar vizinho.
 *
 * @returns {number} quantos arquivos foram removidos
 */
export function clearFrames(dir, maxAgeMs = 120_000) {
  const pasta = path.join(dir, "frames");
  const now = Date.now();
  let removed = 0;

  let entries;
  try {
    entries = fs.readdirSync(pasta);
  } catch {
    return 0;
  }

  for (const name of entries) {
    const file = path.join(pasta, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      // Sumiu no meio do caminho — segue.
    }
  }

  return removed;
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

  // A raiz entra na varredura por causa das respostas de fallback (`res-<id>.json`),
  // que não moram em nenhuma das subpastas. Só elas: `heartbeat.json` fica na raiz
  // também e apagá-lo cegaria o diagnóstico de "o painel está vivo?".
  for (const sub of [CMD_DIR, RES_DIR, "."]) {
    const full = path.join(dir, sub);
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (sub === "." && !name.startsWith("res-")) continue;

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
