/**
 * Onde os perfis de marca ficam guardados.
 *
 * Um perfil por cliente, um deles ativo. A separação existe porque um motion designer
 * troca de cliente entre projetos, não entre camadas: obrigar a passar a paleta em
 * toda chamada seria repetir a mesma informação dezenas de vezes por sessão, e é
 * justamente aí que erro de cor entra.
 *
 *   <dados>/brands/<slug>.json   perfis salvos
 *   <dados>/brand-active.json    qual está ativo
 *
 * Fica ao lado da pasta da ponte, não dentro do repositório: identidade de cliente é
 * dado de trabalho, não código, e não deve acabar num commit por acidente.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateBrand } from "@vectorize-ae/core";

export function resolveBrandDir(env = process.env) {
  if (env.VECTORIZE_AE_BRAND_DIR) return env.VECTORIZE_AE_BRAND_DIR;

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
  constructor({ dir } = {}) {
    this.dir = dir ?? resolveBrandDir();
    this.brandsDir = path.join(this.dir, "brands");
    this.activeFile = path.join(this.dir, "brand-active.json");
  }

  #ensure() {
    fs.mkdirSync(this.brandsDir, { recursive: true });
  }

  /** Perfis salvos, por slug. */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.brandsDir);
    } catch {
      return [];
    }

    return entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const slug = f.replace(/\.json$/, "");
        const brand = this.#read(path.join(this.brandsDir, f));
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

    const brand = this.#read(path.join(this.brandsDir, `${ponteiro.slug}.json`));
    return brand ? { slug: ponteiro.slug, brand } : null;
  }

  /** Salva um perfil e o torna ativo. Recusa perfil inválido. */
  save(brand, { activate = true } = {}) {
    const validation = validateBrand(brand);
    if (!validation.ok) return { ok: false, errors: validation.errors };

    this.#ensure();
    const slug = slugify(brand.name ?? "marca");
    const file = path.join(this.brandsDir, `${slug}.json`);

    fs.writeFileSync(file, `${JSON.stringify(brand, null, 2)}\n`, "utf8");
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
