# Vectorize AE

Ferramentas de automação para After Effects com IA — feitas para motion designers.

O primeiro módulo, **Image → Shapes**, pega uma imagem de design 2D (poster, card,
logo, frame de UI) e reconstrói ela dentro de uma composição do After Effects como
**shape layers nativos e editáveis** — com fills, strokes, cantos arredondados,
paths bezier, texto e camadas nomeadas e agrupadas. É a ideia do "abrir um PNG e
receber camadas editáveis" que o Canva/Higgsfield fazem, só que direto no AE e
gerando geometria que você anima depois.

> Estado: **fundação funcional em desenvolvimento**. O núcleo (schema, parser de
> path SVG, cliente de IA) tem testes e roda hoje via CLI. O painel CEP e o
> construtor ExtendScript estão escritos e precisam de validação dentro do AE real
> — veja [`docs/roadmap.md`](docs/roadmap.md) para o que já está fechado e o que falta.

---

## Como funciona

```
imagem  ──►  Claude (visão)  ──►  SceneSpec (JSON)  ──►  ExtendScript  ──►  shape layers no AE
             packages/core                              packages/jsx
```

O **SceneSpec** é o contrato no meio de tudo: um JSON que descreve a cena em
coordenadas de canvas (origem no canto superior esquerdo, igual SVG/Figma). Quem
produz o SceneSpec é intercambiável — hoje é o Claude olhando a imagem, amanhã pode
ser um vetorizador local, um import de SVG, ou você escrevendo na mão. Quem consome
também: hoje é o ExtendScript, amanhã pode ser UXP.

Detalhes do formato: [`docs/scene-spec.md`](docs/scene-spec.md).

---

## As três camadas

O projeto é dividido de propósito, para que a migração CEP → UXP no futuro custe
pouco:

| Camada | Pasta | O que é | Migra pra UXP? |
|---|---|---|---|
| **Core** | `packages/core` | JS puro, sem dependência de host. Schema, cores, parser de SVG path, prompt e cliente da API. | Roda igual — zero mudança |
| **Adapter** | `packages/jsx` | ExtendScript. A única parte que fala com o DOM do After Effects. | Reescrever (é a parte host-specific) |
| **Shell** | `packages/cep` | Painel HTML/JS, UI, ponte `evalScript`. | Trocar CSInterface pela API de UXP |

Hoje o Core é o grosso da lógica e o Adapter é fino e mecânico. Isso é intencional.

---

## Rodando agora (sem o After Effects)

O núcleo funciona standalone — dá pra gerar um SceneSpec a partir de uma imagem e
inspecionar o resultado antes de abrir o AE.

```bash
npm install
npm test                       # testes do core

export ANTHROPIC_API_KEY=sk-ant-...
node scripts/analyze.mjs caminho/da/imagem.png --out cena.json
```

O `cena.json` resultante é o mesmo arquivo que o painel manda pro AE. Dá pra editar
na mão, versionar, e reaplicar.

## Instalando o painel no After Effects

Requer After Effects 2024 ou 2025.

```bash
npm run build:cep        # instala deps do painel em packages/cep/node_modules
scripts/install-dev.sh   # cria symlink na pasta de extensões do CEP + libera unsigned
```

Depois reinicie o AE e abra **Window → Extensions → Vectorize AE**.

O `install-dev.sh` habilita o carregamento de extensões não assinadas (`PlayerDebugMode`),
que é o modo normal de desenvolvimento de CEP. Para distribuir pra outras pessoas é
preciso empacotar e assinar um `.zxp` — isso ainda não está no projeto.

---

## Skills para o Claude Code

`.claude/skills/` guarda o conhecimento de After Effects que este projeto acumula —
matchnames de shape layers, armadilhas do ExtendScript, princípios de motion design.
Elas carregam automaticamente quando você estiver trabalhando no repo com o Claude
Code, e são o lugar certo pra registrar cada coisa nova que a gente descobrir sobre
a API do AE.

---

## Licença

MIT — veja [`LICENSE`](LICENSE).
