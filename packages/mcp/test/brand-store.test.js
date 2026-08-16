import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrandStore, slugify } from "../src/brand-store.js";

const tempStore = () =>
  new BrandStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "vec-brand-test-")) });

const MARCA = {
  name: "Cliente X",
  colors: { primary: "#FF5A20" },
  fonts: { heading: { family: "ABC Diatype", style: "Bold" } },
};

test("slugify produz nome de arquivo previsível", () => {
  assert.equal(slugify("Cliente X"), "cliente-x");
  assert.equal(slugify("Ação & Cia."), "acao-cia");
  assert.equal(slugify("   "), "marca");
  assert.equal(slugify("!!!"), "marca");
});

test("sem marca configurada, active() devolve null", () => {
  // É a resposta que faz o servidor perguntar ao operador em vez de inventar paleta.
  assert.equal(tempStore().active(), null);
});

test("salvar ativa o perfil e ele volta inteiro", () => {
  const store = tempStore();
  const r = store.save(MARCA);

  assert.equal(r.ok, true);
  assert.equal(r.slug, "cliente-x");

  const ativa = store.active();
  assert.equal(ativa.slug, "cliente-x");
  assert.deepEqual(ativa.brand, MARCA);
});

test("perfil inválido é recusado e não vira arquivo", () => {
  const store = tempStore();
  const r = store.save({ name: "Ruim", colors: { primary: "nao-e-cor" } });

  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /colors\.primary/);
  assert.equal(store.active(), null);
  assert.deepEqual(store.list(), []);
});

test("vários clientes convivem e a troca é por slug", () => {
  const store = tempStore();
  store.save(MARCA);
  store.save({ name: "Cliente Y", colors: { primary: "#2E7D32" } });

  assert.equal(store.active().slug, "cliente-y", "o último salvo fica ativo");
  assert.deepEqual(
    store.list().map((b) => b.slug).sort(),
    ["cliente-x", "cliente-y"]
  );

  assert.equal(store.activate("cliente-x").brand.name, "Cliente X");
  assert.equal(store.active().slug, "cliente-x");
});

test("activate com slug inexistente devolve null em vez de estourar", () => {
  const store = tempStore();
  store.save(MARCA);

  assert.equal(store.activate("nao-existe"), null);
});

test("salvar sem ativar mantém a marca em uso", () => {
  const store = tempStore();
  store.save(MARCA);
  store.save({ name: "Cliente Y", colors: { primary: "#2E7D32" } }, { activate: false });

  assert.equal(store.active().slug, "cliente-x");
  assert.equal(store.list().length, 2);
});

test("clear volta ao comportamento sem marca sem apagar os perfis", () => {
  const store = tempStore();
  store.save(MARCA);
  store.clear();

  assert.equal(store.active(), null);
  assert.equal(store.list().length, 1, "os perfis salvos continuam lá");
});

test("arquivo de perfil corrompido não derruba a leitura", () => {
  const store = tempStore();
  store.save(MARCA);
  fs.writeFileSync(path.join(store.brandsDir, "cliente-x.json"), "{ isto não é json", "utf8");

  // Melhor cair para "sem marca" e perguntar do que estourar no meio de uma
  // reconstrução que o usuário já pediu.
  assert.equal(store.active(), null);
});
