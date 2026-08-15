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
| Construtor ExtendScript | ⚠️ escrito, **não validado dentro do AE** |
| Painel CEP | ⚠️ escrito, **não validado dentro do AE** |

O que está marcado com ⚠️ foi escrito a partir da documentação de matchnames e do
comportamento conhecido do CEP, mas não rodou num After Effects de verdade — não
havia AE neste ambiente. Antes de confiar, é preciso a passada de validação abaixo.

---

## Próximo passo: validar no AE

Ordem sugerida, do menor risco pro maior:

1. **Instalar e abrir o painel.** `scripts/install-dev.sh`, reiniciar o AE, conferir
   que aparece em Window → Extensions. Se não aparecer, é quase sempre
   PlayerDebugMode ou versão do CSXS no manifesto.
2. **Construir uma cena escrita à mão.** Montar um `scene.json` com um retângulo, um
   círculo e um texto, e chamar `vecBuildSceneFromFile` pelo console do painel
   (localhost:8088). Isso isola o adapter da IA.
3. **Conferir cada matchname.** Os mais prováveis de estarem errados:
   `ADBE Vector Star Inner Radius` (o AE tem propriedades com "Roundess" escrito
   errado no matchname real), e as constantes de line cap/join. Corrigir e registrar
   em `.claude/skills/ae-shape-layers/SKILL.md`.
4. **Validar `recenterAnchor`.** Depende de `sourceRectAtTime` devolver coordenadas
   no espaço que assumimos. Se as camadas pularem de lugar ao centralizar âncora, é
   aqui.
5. **Rodar o fluxo completo** com uma imagem de verdade.

---

## Direção definida: a cena reconstruída é um template, não um desenho

O uso real é motion 2D chapado com animação simples, mas com **controle de cores,
formas e textos para ajustes futuros e traduções**. Isso não é um requisito de
acabamento — muda o que o construtor deve produzir.

Uma cena montada como camadas soltas exige mergulhar na timeline para trocar uma cor
ou um texto. Uma cena montada como **template** expõe esses controles num lugar só.
O padrão que os motion designers usam para isso:

1. Uma camada nula `CONTROLES` com efeitos **Color Control** (um por cor da paleta) e
   **Slider/Checkbox Control** para o que for paramétrico.
2. Todo fill referencia a paleta por expressão, em vez de ter a cor gravada:
   `thisComp.layer("CONTROLES").effect("Brand / Primary")("Color")`
3. Textos com o mesmo tratamento, ou expostos direto.
4. As propriedades relevantes vão para o **Essential Graphics**, e a comp pode ser
   exportada como **.mogrt**.

Duas consequências práticas:

- **O campo `palette` do SceneSpec deixa de ser informativo e passa a ser
  estrutural** — é ele que gera os Color Controls. Já existe no formato.
- **Compartilhar com a equipe pode não exigir a extensão.** Um `.mogrt` abre no
  After Effects e no Premiere de qualquer pessoa, sem instalar nada. A extensão fica
  sendo a ferramenta de autoria; o template é o entregável.

Isso vira o próximo bloco de trabalho depois da validação do adapter, antes de
qualquer coisa agêntica.

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
