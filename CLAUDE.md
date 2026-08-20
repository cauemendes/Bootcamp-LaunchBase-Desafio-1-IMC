# Vectorize AE — contexto para o Claude Code

Ferramentas de automação para After Effects. O módulo atual reconstrói imagens de
design 2D como shape layers editáveis.

## Onde as coisas ficam

| Pasta | O que é | Regra |
|---|---|---|
| `packages/core` | JS puro (ESM), com testes | **Nunca** importar nada de CEP, ExtendScript ou DOM aqui |
| `packages/jsx` | ExtendScript (ES3) | Só o que precisa mesmo do DOM do After Effects |
| `packages/cep` | Painel HTML/JS | UI e a ponte `evalScript` |
| `docs/` | Arquitetura, SceneSpec, roadmap | Ler antes de mexer no formato |
| `.claude/skills/` | Conhecimento acumulado de AE | Registrar aqui o que for descoberto sobre a API |

## Quem usa a ferramenta não mexe na ferramenta

Há dois papéis, e misturá-los já custou tempo. Uma conversa **desenvolve** o Vectorize AE;
outras **usam** o servidor MCP para trabalhar no After Effects.

Se você está usando as ferramentas e faltou algo — uma opção, um caso não tratado, uma
mensagem que não ajuda —, **relate em vez de implementar.** Não edite `packages/`,
`scripts/` nem a documentação.

Não é burocracia. Uma edição feita de fora chega sem teste, sem entrar no `dist/`
versionado, e trava o `git pull` seguinte com "your local changes would be overwritten" —
e aí o instalador roda na linha de baixo e reinstala a versão antiga com um "✓" no fim.
Já aconteceu: o `save_frame` ficou dois dias parecendo defeituoso porque uma correção
existia no repositório e não estava rodando.

O que relatar vale ouro e não se perde: descreva o caso que não deu, o que você esperava e
o que aconteceu. É assim que a maioria das melhorias deste projeto apareceu.

## Regras que valem sempre

**Lógica nova vai no core, com teste.** Se algo pode ser calculado sem o After
Effects — geometria, cor, parsing, validação — não pertence ao ExtendScript. O
adapter deve ficar burro e mecânico; foi assim que o parser de path SVG acabou no
core, com 20 testes, em vez de ser reescrito em ES3.

**ExtendScript é ECMAScript 3.** Nada de `const`/`let`, arrow function, template
literal, `JSON`, `Array.prototype.map/forEach/indexOf`, `String.prototype.trim`,
`Array.isArray`. O que o projeto usa além do ES3 está em `packages/jsx/lib/util.jsx`.

**Coordenadas são sempre canvas: origem no canto superior esquerdo.** A conversão
para o espaço do AE acontece num lugar só — as layers são criadas com âncora e
posição em `(0,0)`. Não espalhe conversão de coordenada pelo código.

**Primitiva continua primitiva.** `rect`, `ellipse` e `star` viram primitivas nativas
do AE, com parâmetros animáveis. Convertê-las para path de vértices destrói exatamente
a editabilidade que a ferramenta existe para entregar — há teste travando isso.

**O schema exposto ao modelo não pode ser recursivo.** Structured outputs não suporta.
Por isso o formato da IA é uma lista plana com rótulo de grupo, e `normalizeScene()`
remonta a hierarquia. Ver `packages/core/src/ai/schema.js`.

**Erro de camada não derruba a cena.** Se um elemento falha, registre um aviso e siga
com os outros. Um designer prefere 19 camadas certas e um aviso a zero camadas e um
stack trace.

## Rodando

```bash
npm test                                     # testes do core
npm run build --prefix packages/cep          # bundle do painel
node scripts/analyze.mjs img.png --out c.json  # análise sem abrir o AE
```

## Ao trabalhar com a API do Claude

Este projeto usa `@anthropic-ai/sdk` com `claude-opus-5`, visão e structured outputs.
Antes de mexer em `packages/core/src/ai/`, carregue a skill `claude-api` — os
parâmetros da API mudaram bastante e escrever de memória gera erro 400.

## O que ainda não foi validado dentro do AE

`packages/jsx` foi escrito contra os matchnames documentados, mas **ainda não rodou
num After Effects real**. Ao validar, confira e corrija os matchnames em
`.claude/skills/ae-shape-layers/SKILL.md` — é lá que a lista canônica deve viver.
