/**
 * Onde os perfis de marca ficam guardados.
 *
 * Um perfil por cliente, um deles ativo. A separação existe porque um motion designer
 * troca de cliente entre projetos, não entre camadas: obrigar a passar a paleta em
 * toda chamada seria repetir a mesma informação dezenas de vezes por sessão, e é
 * justamente aí que erro de cor entra.
 *
 *   <dados>/brands/<slug>/brand.json     o perfil
 *   <dados>/brands/<slug>/assets/…        logos e imagens do cliente
 *   <dados>/brand-active.json             qual está ativo
 *
 * Fica ao lado da pasta da ponte, não dentro do repositório: identidade de cliente é
 * dado de trabalho, não código, e não deve acabar num commit por acidente.
 *
 * ── Uma pasta por cliente, com os arquivos dentro ─────────────────────────────
 * Os logos eram guardados como caminho absoluto para onde estivessem — Dropbox, Desktop,
 * a pasta do projeto. Funciona numa máquina só e não sobrevive a ser compartilhado: o
 * colega recebe o perfil, os caminhos não existem na máquina dele, e o erro aparece na
 * hora de construir uma cena, longe de onde a causa está.
 *
 * Com os arquivos dentro da pasta do cliente, o perfil é autocontido: zipar a pasta e
 * mandar é tudo o que precisa acontecer. O formato antigo (um `<slug>.json` solto)
 * continua sendo lido, e a próxima gravação migra para o novo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateBrand } from "@vectorize-ae/core";

export function resolveBrandDir(env = process.env) {
  if (env.VECTORIZE_AE_BRAND_DIR) return env.VECTORIZE_AE_BRAND_DIR;
  return resolveLocalDataDir(env);
}

/**
 * Pasta de dados desta máquina, ignorando qualquer redirecionamento.
 *
 * ── Por que o perfil ativo não pode ser compartilhado ─────────────────────────
 * `VECTORIZE_AE_BRAND_DIR` existe para uma equipe apontar os perfis para uma pasta
 * sincronizada — Dropbox, Drive — e todo mundo ter as marcas de todos os clientes sem
 * copiar arquivo à mão. Isso funciona para os perfis, que são um catálogo.
 *
 * Não funciona para `brand-active.json`, que é a resposta a "em qual cliente EU estou
 * trabalhando agora". Compartilhado, ele vira a pior classe de erro deste projeto: um
 * colega troca de cliente do outro lado da cidade, sua próxima cena sai com a paleta
 * errada, e nada na sua tela sugere o motivo — as cores estão lá, são de uma marca de
 * verdade, e a construção não falha.
 *
 * Então o catálogo pode viajar e o ponteiro fica em casa.
 */
export function resolveLocalDataDir(env = process.env) {
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
        : path.join(os.homedir(), ".local", "share");

  return path.join(base, "vectorize-ae");
}

/** Nome de arquivo previsível a partir do nome do cliente. */
export function slugify(name) {
  const slug = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "marca";
}

export class BrandStore {
  constructor({ dir, localDir } = {}) {
    this.dir = dir ?? resolveBrandDir();
    this.brandsDir = path.join(this.dir, "brands");

    // Sem redirecionamento os dois caminhos são o mesmo, e nada muda. Com
    // redirecionamento, o catálogo vai para a pasta compartilhada e o ponteiro fica
    // aqui — ver `resolveLocalDataDir`.
    this.localDir = localDir ?? dir ?? resolveLocalDataDir();
    this.activeFile = path.join(this.localDir, "brand-active.json");
  }

  #ensure() {
    fs.mkdirSync(this.brandsDir, { recursive: true });
    fs.mkdirSync(this.localDir, { recursive: true });
  }

  /** Pasta do cliente. É ela que se zipa para mandar a marca a outra pessoa. */
  folderFor(slug) {
    return path.join(this.brandsDir, slug);
  }

  /** Onde o perfil está: pasta nova se existir, arquivo solto se for de antes. */
  #fileFor(slug) {
    const naPasta = path.join(this.folderFor(slug), "brand.json");
    if (fs.existsSync(naPasta)) return naPasta;

    const solto = path.join(this.brandsDir, `${slug}.json`);
    if (fs.existsSync(solto)) return solto;

    return naPasta;
  }

  /**
   * Traz os arquivos de asset para dentro da pasta do cliente.
   *
   * Guarda o caminho relativo, e não o de origem: é isso que faz o perfil funcionar na
   * máquina de quem recebe. Um asset que já está dentro da pasta, ou cujo arquivo não
   * existe, passa intacto — o segundo caso já é apanhado pela validação, e sumir com o
   * caminho aqui esconderia o que a pessoa digitou errado.
   */
  #absorverAssets(brand, slug) {
    const assets = brand.assets;
    if (assets == null || typeof assets !== "object" || Array.isArray(assets)) return brand;

    const pasta = this.folderFor(slug);
    const destino = path.join(pasta, "assets");
    const copiados = {};
    let mexeu = false;

    for (const [token, caminho] of Object.entries(assets)) {
      if (typeof caminho !== "string" || caminho === "") {
        copiados[token] = caminho;
        continue;
      }

      const absoluto = path.isAbsolute(caminho) ? caminho : path.join(pasta, caminho);

      // Já mora aqui: veio de uma gravação anterior, não há o que fazer.
      if (path.resolve(absoluto).startsWith(path.resolve(destino) + path.sep)) {
        copiados[token] = path.relative(pasta, absoluto);
        continue;
      }

      if (!fs.existsSync(absoluto)) {
        copiados[token] = caminho;
        continue;
      }

      // O nome vem do token, não do arquivo de origem: dois clientes com "logo.png" não
      // podem se atropelar, e o nome do token é o que a pessoa já usa nas cenas.
      const nome = slugify(token) + path.extname(absoluto).toLowerCase();
      fs.mkdirSync(destino, { recursive: true });
      fs.copyFileSync(absoluto, path.join(destino, nome));

      copiados[token] = path.join("assets", nome);
      mexeu = true;
    }

    return mexeu || Object.keys(copiados).length ? { ...brand, assets: copiados } : brand;
  }

  /**
   * Devolve os caminhos de asset absolutos.
   *
   * Guardado é relativo, para viajar. Quem consome — a resolução de marca, o
   * ExtendScript — precisa de caminho absoluto, e converter aqui evita espalhar essa
   * conversão por cada lugar que lê um asset.
   */
  #comAssetsAbsolutos(brand, slug) {
    if (!brand?.assets || typeof brand.assets !== "object") return brand;

    const pasta = this.folderFor(slug);
    const resolvidos = {};

    for (const [token, caminho] of Object.entries(brand.assets)) {
      resolvidos[token] =
        typeof caminho === "string" && caminho !== "" && !path.isAbsolute(caminho)
          ? path.join(pasta, caminho)
          : caminho;
    }

    return { ...brand, assets: resolvidos };
  }

  /** Perfis salvos, por slug. */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.brandsDir);
    } catch {
      return [];
    }

    // Os dois formatos convivem: pasta por cliente (novo) e `<slug>.json` solto (antigo).
    const slugs = new Set();

    for (const entrada of entries) {
      if (entrada.endsWith(".json")) slugs.add(entrada.replace(/\.json$/, ""));
      else if (fs.existsSync(path.join(this.brandsDir, entrada, "brand.json"))) slugs.add(entrada);
    }

    return [...slugs].map((slug) => {
      const brand = this.#read(this.#fileFor(slug));
      return { slug, name: brand?.name ?? slug };
    });
  }

  #read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * O perfil ativo, ou `null`.
   *
   * `null` é uma resposta legítima e importante: é o que faz o servidor pedir a marca
   * ao operador em vez de inventar uma paleta.
   */
  active() {
    const ponteiro = this.#read(this.activeFile);
    if (!ponteiro?.slug) return null;

    const brand = this.#read(this.#fileFor(ponteiro.slug));
    if (!brand) return null;

    return { slug: ponteiro.slug, brand: this.#comAssetsAbsolutos(brand, ponteiro.slug) };
  }

  /** Salva um perfil e o torna ativo. Recusa perfil inválido. */
  save(brand, { activate = true } = {}) {
    const validation = validateBrand(brand);
    if (!validation.ok) return { ok: false, errors: validation.errors };

    this.#ensure();
    const slug = slugify(brand.name ?? "marca");
    const pasta = this.folderFor(slug);
    fs.mkdirSync(pasta, { recursive: true });

    const guardado = this.#absorverAssets(brand, slug);
    const file = path.join(pasta, "brand.json");

    fs.writeFileSync(file, `${JSON.stringify(guardado, null, 2)}\n`, "utf8");

    // Migração do formato antigo: com o perfil já gravado na pasta, o arquivo solto só
    // teria como confundir quem for procurar depois.
    try {
      fs.unlinkSync(path.join(this.brandsDir, `${slug}.json`));
    } catch {
      // Não existia — é o caso normal.
    }

    if (activate) this.activate(slug);

    return { ok: true, slug, file, warnings: validation.warnings };
  }

  activate(slug) {
    this.#ensure();
    fs.writeFileSync(this.activeFile, `${JSON.stringify({ slug }, null, 2)}\n`, "utf8");
    return this.active();
  }

  /** Volta ao comportamento sem marca — texto em Arial, cores como vieram. */
  clear() {
    try {
      fs.unlinkSync(this.activeFile);
    } catch {
      // Já não havia marca ativa.
    }
  }
}
