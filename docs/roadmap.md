# Roadmap

## Estado atual

| Peça | Situação |
|---|---|
| SceneSpec + validação | ✅ pronto, 64 testes |
| Parser de path SVG → bezier do AE | ✅ pronto e testado |
| Conversão de cor, quantização de paleta | ✅ pronto e testado |
| Leitura de dimensão de imagem (PNG/JPEG/GIF/WebP) | ✅ pronto e testado |
| Prompt + schema de structured output | ✅ escrito, precisa de calibragem com imagens reais |
| Cliente da API do Claude | ✅ escrito, não exercitado contra a API nesta sessão |
| Geometria do construtor (shapes, paths, fill, stroke, coordenadas) | ✅ verificado no AE 2026 (26.3) |
| Construtor — texto | ❌ `fontFamily` é somente leitura no 26.3; precisa usar `doc.font` + `app.fonts` |
| Gradientes | ❌ confirmado não-scriptável (`Grad Colors` é `NO_VALUE`) |
| Painel CEP | ⚠️ escrito, ainda não aberto dentro do AE |

### O que o autoteste confirmou (AE 2026 26.3, macOS)

30 verificações passaram, 4 falharam. `packages/jsx/selftest.jsx` reproduz.

Confirmado funcionando: retângulo, elipse, estrela e polígono regular, paths bezier
(inclusive dois subpaths no mesmo grupo, para ícone com furo), fill, stroke completo
com cap e join, transform de grupo, leitura recursiva de Contents, e o AE recusando
raio interno em polígono regular como esperado.

**A suposição de coordenadas está correta**: com âncora e posição em `(0,0)`, o
espaço da camada coincide com o da comp e `sourceRectAtTime` devolve exatamente as
coordenadas de canvas. Todo o posicionamento do projeto dependia disso.

Descobertas que corrigiram o código:

- `ADBE Vector Star Outer Roundess` — a grafia **com** o erro de digitação é a válida;
  a correta devolve `null`.
- `textDocument.fontFamily` e `fontStyle` são **somente leitura**. O caminho é
  `textDocument.font` com o nome PostScript, resolvido via `app.fonts`.
- `ADBE Vector Grad Colors` tem `propertyValueType` igual a `NO_VALUE` — não há valor
  para ler nem escrever. Gradiente não é questão de achar o formato certo.

---

## Próximo passo

1. **Corrigir a resolução de fonte** — `packages/jsx/selftest-fonts.jsx` levanta a
   forma exata de `app.fonts` no 26.3; a correção vem em cima disso.
2. **Abrir o painel dentro do AE.** `scripts/install-dev.sh`, reiniciar, conferir em
   Window → Extensions.
3. **Construir uma cena escrita à mão** pelo console do painel, antes de gastar
   chamada de API.
4. **Começar a camada de ferramentas**, pelas de leitura.

---

## O objetivo real: Claude operando dentro do After Effects

Reconstruir imagem em shapes é **a primeira tarefa**, não o produto. O produto é ter
o Claude dentro do After Effects executando várias tarefas de motion graphics, com o
designer no comando.

Isso muda a forma do software. Uma transformação de mão única (imagem entra, camadas
saem) é linear. Um assistente é um **laço**: ler o estado do projeto → decidir → agir
→ ver o resultado → decidir de novo.

A consequência prática é que a peça central a construir não é interface, e não é a
escolha entre CEP e UXP. É uma **camada de ferramentas** — operações sobre o After
Effects que o modelo possa chamar, cada uma com schema declarado:

```
ler_comp_ativa      criar_camada         aplicar_expressao
listar_camadas      setar_propriedade    renderizar_frame
ler_camada          adicionar_keyframe   agrupar_em_precomp
```

Com essa camada existindo, o painel vira só um cliente dela. Um servidor MCP vira
outro cliente, sem código novo. E a migração CEP → UXP toca só o transporte.

A ordem de construção, por dependência:

1. **Ferramentas de leitura primeiro.** Sem enxergar o projeto, o modelo só consegue
   criar do zero — nunca ajudar no que já existe, que é onde está o tempo do dia a dia.
2. **Ferramentas de escrita**, reaproveitando o construtor que já existe.
3. **O laço** — painel de conversa, histórico, execução de ferramenta, e o modelo
   vendo o resultado de cada ação antes da próxima.
4. **Renderizar frame para o modelo ver.** É o que fecha o laço de verdade e o mais
   difícil de fazer bem.

### Essential Graphics: adiado por decisão

A ideia de amarrar todas as cores a uma paleta central via expressões (e exportar
`.mogrt`) foi avaliada e **adiada a pedido**. O uso real hoje é um projeto complexo,
com muitas cores, montado inteiramente no After Effects, onde controle independente
por camada vale mais que controle centralizado.

Continua fazendo sentido como modo opcional — especialmente para projeto que precisa
seguir paleta de cliente. Fica como opção do construtor, não como padrão.

## Backlog, por ordem de valor

### Gradientes
O maior buraco do formato hoje — muito design 2D tem gradiente, e a ferramenta
achata para cor sólida. Escrever paradas de gradiente por script no AE é
notoriamente instável: a propriedade `ADBE Vector Grad Colors` guarda as paradas
num array numérico achatado, sem API declarada. Precisa de experimentação dentro do
AE antes de virar contrato. Deve entrar com fallback para cor sólida quando a
escrita falhar.

### Vetorização local como complemento da IA
Hoje a geometria vem inteira do modelo, que é bom em semântica (o que é isso, como
se chama, o que agrupa com o quê) e mediano em precisão de contorno. Um passo de
quantização de cor + traçado de contorno rodando localmente daria geometria exata
para as formas orgânicas, com a IA cuidando de nomes, agrupamento e detecção de
primitivas. É o caminho para fidelidade real em ilustrações complexas.

### Precisão de texto
Estimar corpo de fonte por altura de maiúscula é grosseiro, e identificar família
por aparência é chute. Melhorias possíveis: comparar o texto renderizado com o
recorte da imagem e ajustar corpo/tracking iterativamente; listar as fontes
instaladas via `app.fonts` e mandar essa lista pro modelo escolher entre o que
existe na máquina, em vez de inventar.

### Empacotamento .zxp
Hoje só dá pra instalar em modo de desenvolvimento. Distribuir para outras pessoas
exige assinar com o ZXPSignCmd da Adobe e um certificado.

### Tema do painel
O painel usa cores fixas próximas ao cinza médio do AE. Sincronizar de verdade exige
ouvir `com.adobe.csxs.events.ThemeColorChanged` e reagir.

### Servidor MCP
Um servidor MCP local expondo "construir cena", "ler comp atual", "aplicar preset"
deixaria o Claude Code dirigir o After Effects de forma agêntica, além do painel.
A arquitetura já suporta: seria mais um consumidor do mesmo SceneSpec. Fica para
depois de o caminho do painel estar validado.

### Além do Image → Shapes
O que a arquitetura destrava sem grande esforço adicional, já que tudo é SceneSpec
mais um construtor:
- Presets de animação sobre a cena reconstruída (stagger de entrada, trim paths nos
  strokes, escala com overshoot).
- Import de SVG direto, sem passar pela IA — o parser já existe e é o mesmo.
- Renomear e organizar camadas de uma comp existente com ajuda do modelo.
