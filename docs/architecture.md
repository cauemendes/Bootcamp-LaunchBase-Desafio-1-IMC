# Arquitetura

## Por que três camadas

A pergunta que motivou este desenho: **"depois dá pra migrar pra UXP?"**

Sim — e o custo dessa migração é decidido agora, não depois. A Adobe sinalizou UXP
como o futuro das extensões, mas o suporte a UXP no After Effects ainda é parcial:
o CEP continua totalmente funcional no AE 2025 e é o que as ferramentas comerciais
de motion usam hoje. Então: começamos em CEP, mas escrevemos o código de forma que
a maior parte dele não saiba que CEP existe.

```
┌──────────────────────────────────────────────────────────┐
│  SHELL — packages/cep                                    │
│  Painel HTML. Escolhe imagem, mostra preview, chama core, │
│  manda o resultado pro adapter via evalScript.            │
│  ⚠️  Amarrado ao CEP. É o que se reescreve em UXP.        │
└───────────────────────┬──────────────────────────────────┘
                        │  SceneSpec (JSON serializado)
┌───────────────────────▼──────────────────────────────────┐
│  CORE — packages/core                                    │
│  JS puro. Sem DOM, sem CSInterface, sem ExtendScript.     │
│  Schema + validação, conversão de cor, parser de SVG path,│
│  prompt e cliente Anthropic.                              │
│  ✅ Roda em Node, no browser, em UXP, num servidor MCP.   │
└───────────────────────┬──────────────────────────────────┘
                        │  SceneSpec (JSON serializado)
┌───────────────────────▼──────────────────────────────────┐
│  ADAPTER — packages/jsx                                   │
│  ExtendScript. Traduz SceneSpec em chamadas do DOM do AE. │
│  ⚠️  Amarrado ao AE. Em UXP vira outro adapter.           │
└──────────────────────────────────────────────────────────┘
```

O contrato entre as camadas é **um JSON**, não uma chamada de função. Isso é o que
torna a migração barata: em UXP, o Core continua idêntico, e o adapter novo consome
exatamente o mesmo SceneSpec.

### O que a migração pra UXP vai custar

| Peça | Ação |
|---|---|
| `packages/core` | Nada. É JS moderno sem dependência de host. |
| `packages/jsx` | Reescrever contra a API de scripting que o UXP expuser. A lógica (ordem de operações, conversões de coordenada) está documentada e é reaproveitável — só a sintaxe das chamadas muda. |
| `packages/cep` | Trocar `manifest.xml` por `manifest.json`, `CSInterface.evalScript` pela ponte do UXP, e o HTML por Spectrum Web Components (ou manter HTML puro). |
| SceneSpec | Nada. É o ponto fixo. |

Enquanto o UXP do AE não estiver maduro, o CEP não bloqueia nada.

---

## Sistema de coordenadas

A parte mais chata de gerar shape layers por script é o espaço de coordenadas. A
decisão aqui é explícita e vale pro projeto inteiro:

**O SceneSpec usa coordenadas de canvas: origem `(0,0)` no canto superior esquerdo,
`x` para a direita, `y` para baixo.** É o mesmo que SVG, Figma, Illustrator e HTML
canvas usam — e é o que qualquer modelo de visão naturalmente produz ao olhar uma
imagem.

Para que essas coordenadas caiam exatamente onde devem no AE, o construtor cria cada
shape layer com:

```js
layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
layer.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
```

Com âncora e posição em `(0,0)`, o espaço da layer coincide com o espaço da comp e a
origem fica no canto superior esquerdo. Um retângulo em `(120, 80)` no SceneSpec
aparece em `(120, 80)` na comp, sem nenhuma matemática de conversão.

O preço: as âncoras ficam todas no canto da comp, o que é ruim pra animar. Por isso
existe o passo opcional **"recentrar âncoras"**, que move a âncora de cada layer para
o centro do seu bounding box e compensa a posição na mesma medida — o visual não muda
e a layer fica animável. Ver `recenterAnchor()` em `packages/jsx/lib/ae-shape.jsx`.

---

## Aninhamento: por que o formato da IA é plano

O SceneSpec interno suporta grupos aninhados (grupo dentro de grupo, como o AE faz).
O formato que a IA preenche, não: ele é uma **lista plana de elementos**, cada um com
um campo `group` opcional.

Isso não é simplificação por preguiça — é uma restrição real da API:

> Structured outputs não suporta schemas recursivos.

Como o objetivo é obrigar o modelo a devolver JSON válido contra um schema (em vez de
torcer pra ele acertar o formato), o schema exposto ao modelo precisa ser não-recursivo.
A solução é achatar: o modelo devolve elementos com um rótulo de grupo, e
`normalizeScene()` no core remonta a hierarquia antes de mandar pro AE.

Ganho colateral: a lista plana é mais fácil de o modelo acertar, e o `z` explícito
(ordem de pintura) elimina ambiguidade sobre o que fica na frente.

---

## Onde mora a chave da API

No painel, guardada via `localStorage` do CEP, escopada à extensão. Não vai pro
repositório e não passa pelo ExtendScript.

O `packages/core` nunca lê variável de ambiente sozinho — quem chama passa a chave.
Isso mantém o core testável e reutilizável fora do painel (o `scripts/analyze.mjs`
lê de `ANTHROPIC_API_KEY`; o painel lê do storage).

---

## Modelo e custo

Padrão: `claude-opus-5` — $5 / $25 por milhão de tokens (entrada / saída).

Uma análise de imagem típica gasta ~2–5k tokens de entrada (a imagem domina) e
~2–8k de saída, dependendo de quantos elementos o design tem. Ordem de grandeza:
poucos centavos por imagem.

O painel expõe o seletor de esforço (`output_config.effort`). Para designs simples,
`medium` costuma dar o mesmo resultado por menos tokens; para posters densos com
muitos elementos, vale `high` ou `xhigh`. Ver `packages/core/src/ai/client.js`.
