# Claude Code operando o After Effects

Este é o caminho principal do projeto: o Claude Code no seu terminal enxerga e opera
o After Effects através de um servidor MCP.

```
Claude Code  ──stdio/MCP──►  servidor  ──arquivos──►  painel no After Effects
```

Não precisa de chave de API. O modelo que enxerga imagem e decide o que fazer é o
próprio Claude Code — este servidor só dá a ele mãos dentro do AE.

---

## Instalação

### 1. Dependências

```bash
npm install
```

### 2. Painel da ponte

```bash
bash scripts/install-bridge.sh
```

Ele copia `bridge-panel.jsx` e a pasta `lib/` para a pasta ScriptUI Panels do After
Effects. Pede senha de administrador, porque essa pasta fica dentro do aplicativo.

### 3. A permissão que todo mundo esquece

**After Effects → Settings → Scripting & Expressions → marque
"Allow Scripts to Write Files and Access Network".**

Sem isso o painel não consegue escrever o arquivo de resposta, e todo comando dá
timeout sem dizer o porquê. É a causa nº 1 de "instalei e não funciona".

### 4. Abrir o painel

Reinicie o After Effects e abra **Window → bridge-panel.jsx**. Ele inicia sozinho e
deve mostrar **"ouvindo"**. Deixe aberto (pode encaixar em qualquer lugar da
interface — ele é pequeno).

### 5. Registrar o servidor no Claude Code

```bash
claude mcp add vectorize-ae -- node /caminho/absoluto/para/o/repo/packages/mcp/bin/vectorize-ae-mcp.mjs
```

Use o caminho absoluto — o Claude Code sobe o processo a partir de outra pasta.

Confira com `/mcp` dentro do Claude Code: `vectorize-ae` deve aparecer conectado.

---

## Primeiro teste

No Claude Code, com o After Effects aberto:

> Verifique a ponte com o After Effects e me diga o que tem no projeto.

Ele deve chamar `check_bridge` e `describe_project`. Se responder com a versão do AE
e a lista de comps, está tudo ligado.

---

## As ferramentas

| Ferramenta | O que faz |
|---|---|
| `check_bridge` | Confirma que o AE está aberto e o painel ouvindo |
| `describe_project` | Lista as composições do projeto |
| `describe_comp` | Resume uma comp e suas camadas |
| `describe_layer` | Detalha uma camada: transform, keyframes, efeitos, shapes, texto |
| `list_fonts` | Fontes instaladas nesta máquina |
| `save_frame` | Renderiza um frame **e devolve a imagem**, para o Claude ver o resultado |
| `describe_scene_format` | Explica o formato do SceneSpec |
| `build_scene` | Constrói camadas vetoriais a partir de um SceneSpec |
| `execute_script` | ExtendScript arbitrário — o escape hatch |

São nove, e isso é uma decisão. Cada ferramenta ocupa contexto em toda conversa; um
conjunto grande piora a escolha do modelo em vez de melhorar. O que não couber vai
por `execute_script`, e só vira ferramenta dedicada quando houver motivo — uma
operação destrutiva que precisa de confirmação, um resultado que precisa de
formatação própria, ou algo que o modelo erra fazendo à mão.

### `save_frame` é o que fecha o laço

Sem ver o resultado, o modelo aplica uma animação e conclui que funcionou porque
nenhuma chamada deu erro — o que não é a mesma coisa que ter ficado bom. Com
`save_frame` ele renderiza, olha, e corrige.

Usa `comp.saveFrameToPng()`, que é nativo do After Effects: sem fila de render, sem
plugin, sem snapshot manual.

---

## Como isso funciona por dentro

O After Effects não tem servidor de scripting — nenhum processo de fora consegue
chamá-lo. Alguma coisa precisa rodar *dentro* dele, e é o painel.

```
servidor  →  escreve  <pasta>/cmd/<id>.json   →  painel lê, executa no AE
servidor  ←  lê       <pasta>/res/<id>.json   ←  painel escreve a resposta
```

A pasta fica em `~/Library/Application Support/vectorize-ae/bridge` no macOS
(`Folder.userData` no ExtendScript resolve no mesmo lugar, então os dois lados se
encontram sem configuração). Dá pra mudar com `VECTORIZE_AE_BRIDGE_DIR`.

Dois detalhes que evitam falhas intermitentes:

- **Escrita atômica.** Os dois lados escrevem num `.tmp` e só então renomeiam. Sem
  isso, quem faz polling pode ler um JSON pela metade.
- **Id por comando.** O resultado carrega o id do comando. É o que impede o servidor
  de ler a resposta da pergunta anterior — a falha clássica desse tipo de ponte.

O painel também descarta comandos de sessões antigas ao iniciar. Um comando que
ficou para trás seria executado quando o painel abrisse, mexendo no projeto sem
ninguém ter pedido nada naquele momento.

---

## Quando algo não funciona

**"A ponte não respondeu"** — na ordem: o After Effects está aberto? O painel está
aberto em Window → bridge-panel.jsx? Mostra "ouvindo"? A permissão de escrita está
marcada nas preferências?

**O painel não aparece no menu Window** — reinicie o After Effects depois de
instalar. O AE só varre a pasta de painéis na inicialização.

**Comandos dão timeout depois de funcionar por um tempo** — o painel foi fechado, ou
o After Effects está com um diálogo modal aberto. O polling não roda enquanto há
diálogo na frente.

**O log do painel mostra o erro real.** É o primeiro lugar a olhar, antes de
qualquer outra coisa.
