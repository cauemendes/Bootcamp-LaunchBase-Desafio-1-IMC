# Instalar o Vectorize AE

Guia para quem vai usar a ferramenta, não para quem desenvolve. Leva uns dez minutos,
e só precisa ser feito uma vez por máquina.

## O que é

Uma ponte entre o Claude e o After Effects. Você conversa com o Claude no terminal ou
no aplicativo; um painel silencioso dentro do After Effects executa o que ele pede —
reconstruir uma arte como shape layers editáveis, animar, montar uma comp master.

O painel não é um chat. Ele não tem campo de texto porque não é com ele que você fala.

## Antes de começar

- **macOS ou Windows** com After Effects instalado (validado no 2026 / 26.3).
- **Node.js 20 ou mais novo.** Confira com `node --version`.
- **Claude Code**, no terminal ou no aplicativo.

## 1. Pegar o projeto

```bash
git clone <url-do-repositorio> ~/Documents/vectorize-ae
cd ~/Documents/vectorize-ae
npm install
```

## 2. Instalar o painel

```bash
bash scripts/install-bridge.sh
```

Vai pedir sua senha de administrador: o painel é copiado para dentro do pacote do
After Effects, em `Scripts/ScriptUI Panels`, que é a pasta que popula o menu Window com
painel encaixável.

Isso não se perde quando o After Effects atualiza — ao instalar uma versão nova, ele
pergunta se você quer migrar as configurações da anterior, e os scripts vêm junto.

No fim ele imprime **onde instalou e qual build**. Guarde esse número — é com ele que
você confere, daqui a pouco, que o After Effects está rodando o código certo.

## 3. A permissão que todo mundo esquece

**After Effects → Settings → Scripting & Expressions → marque
"Allow Scripts to Write Files and Access Network".**

Sem isso o painel não consegue escrever a resposta, e todo comando dá timeout sem
explicar o motivo. É a causa nº 1 de "instalei e não funciona".

## 4. Registrar o servidor no Claude

```bash
claude mcp add vectorize-ae --scope user -- node ~/Documents/vectorize-ae/packages/mcp/bin/vectorize-ae-mcp.mjs
```

Use o caminho absoluto — o Claude sobe o processo a partir de outra pasta. O
`--scope user` faz o servidor aparecer em qualquer conversa, no terminal ou no
aplicativo, sem precisar estar dentro da pasta do projeto.

## 5. Abrir e conferir

Reinicie o After Effects e abra **Window → bridge-panel.jsx**.

A primeira linha do log diz `painel carregado — build N`. **Confira que esse N é o
mesmo que o instalador imprimiu.** Se for diferente, o After Effects está carregando
outra cópia — rode `bash scripts/install-bridge.sh --doctor`, que mostra todas.

O painel nasce parado. Clique em **Iniciar** quando for usar; ele lembra a escolha nas
próximas vezes que você abrir o After Effects.

Para testar, peça ao Claude: *"confira a ponte com o After Effects"*.

## Marcas de cliente, e como compartilhar com a equipe

Cada cliente tem um perfil com cores, fontes e logos. Você configura uma vez, com
`set_brand`, e daí em diante pede as cenas usando nomes — `"primary"`, `"heading"` — em
vez de hexadecimal. Isso não é conforto: é o que impede vinte camadas saírem com vinte
laranjas ligeiramente diferentes.

Os perfis ficam **fora do repositório**, em
`~/Library/Application Support/vectorize-ae/brands/`. Identidade de cliente é dado de
trabalho, não código, e paleta de cliente costuma vir marcada como confidencial — não
pode acabar num commit por acidente.

Cada cliente tem uma pasta própria, e os logos ficam dentro dela:

```
brands/amazon-ads/brand.json
brands/amazon-ads/assets/logo-principal.png
```

Você aponta o logo de onde ele estiver — Dropbox, Desktop, a pasta do projeto — e o
`set_brand` traz uma cópia para dentro. Isso é o que torna a pasta autocontida.

**Para mandar uma marca a alguém: zipe a pasta do cliente e mande.** Quem recebe
descompacta dentro de `brands/` e roda `set_brand` com `activateSlug`. Nada de caminho
quebrado, porque nenhum caminho aponta para fora.

Se preferir um catálogo compartilhado em vez de mandar arquivo, aponte a pasta inteira
para um lugar sincronizado:

```bash
export VECTORIZE_AE_BRAND_DIR="/Users/voce/Dropbox/.../vectorize-ae-marcas"
```

O perfil **ativo** não é compartilhado em nenhum dos dois casos, de propósito: ele fica
sempre nesta máquina. Ele responde "em qual cliente eu estou trabalhando agora", e
compartilhado viraria a pior classe de erro possível — um colega troca de cliente do
outro lado da cidade e a sua próxima cena sai com a paleta errada, sem nada na tela
sugerindo o motivo.

## Atualizar para uma versão nova

```bash
cd ~/Documents/vectorize-ae
git pull
npm install
bash scripts/install-bridge.sh
```

Depois **reinicie o After Effects**. Isso não é zelo: a engine de scripting do AE só
relê o arquivo do painel quando o aplicativo sobe. Copiar o arquivo novo com o AE
aberto não troca o código em execução, e o sintoma é cruel — o defeito que a versão
nova corrige continua acontecendo, e nada indica o motivo.

O servidor também precisa reiniciar: feche e reabra a conversa do Claude.

Se você esquecer alguma das duas coisas, a ferramenta avisa. O painel manda o número de
build junto com cada sinal de vida, e o servidor compara com o que espera — quando não
bate, ele diz para reinstalar e reiniciar em vez de deixar você investigar um defeito
que já está corrigido.

## Quando algo não funciona

**Comece por aqui:**

```bash
bash scripts/install-bridge.sh --doctor
```

Ele lista todas as cópias do painel instaladas e o build de cada uma, sem instalar
nada. Duas cópias com builds diferentes explicam quase todo comportamento inexplicável.

**No After Effects**, o painel tem um botão **Diagnóstico**. Ele escreve no log o
estado real da ponte: ligada ou não, quantos ciclos rodou, quantos painéis estão
abertos, e se o polling parou. Funciona até quando o resto está travado, porque roda no
clique e não numa tarefa agendada.

**Sintomas comuns:**

| O que acontece | O que é |
|---|---|
| Todo comando dá timeout | Falta a permissão do passo 3 |
| O painel não aparece no menu Window | Instalou e não reiniciou o After Effects |
| Um defeito corrigido continua acontecendo | Duas cópias instaladas, ou AE não reiniciado |
| "Cannot run a script while a modal dialog is waiting" | Há uma janela do AE esperando resposta, às vezes atrás da principal |
| A ponte se pausou sozinha | Ela detectou que você está usando o AE e saiu da frente. Clique em Iniciar quando quiser de volta |

**Usando outro script com janela própria** (Motion, Ease and Wizz): clique em **Parar**
no painel antes. Enquanto a ponte escuta, o After Effects recusa rodar script com
diálogo na tela, e cada verificação dela vira um erro na sua tela. A ponte detecta isso
e se pausa depois de três, mas parar antes evita os três.
