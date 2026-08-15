---
name: motion-graphics
description: Princípios de animação e timing para motion graphics — curvas de easing, duração, stagger, overshoot, antecipação, animação de shape layers com trim paths e repeater, e as expressões mais usadas no After Effects. Use ao gerar presets de animação, ao escolher timing ou easing por código, ao escrever expressões, ou ao decidir como uma cena reconstruída deve entrar em cena.
---

# Motion graphics: timing, easing e expressões

Referência para quando o código precisa **decidir** valores de animação — presets,
geração automática, expressões escritas por script.

## Duração

Animação de UI e motion graphics é mais rápida do que a intuição sugere. Faixas que
funcionam, a 30 fps:

| O quê | Duração | Frames |
|---|---|---|
| Micro-interação (hover, toggle) | 0,1 – 0,2 s | 3 – 6 |
| Entrada de elemento (fade, slide) | 0,3 – 0,5 s | 9 – 15 |
| Transição entre estados | 0,4 – 0,7 s | 12 – 21 |
| Movimento amplo na tela | 0,6 – 1,0 s | 18 – 30 |
| Beat de storytelling | 1,0 – 2,0 s | 30 – 60 |

Distância importa: um elemento que atravessa a tela precisa de mais tempo que um que
anda 40 px. Duração constante para distâncias diferentes é o que faz uma sequência
parecer "sem ritmo".

## Easing

A regra que resolve a maioria dos casos: **desacelere na chegada**. O olho perdoa uma
partida abrupta, não uma parada abrupta.

| Situação | Curva | Por quê |
|---|---|---|
| Elemento entrando | ease-out (rápido → lento) | chega e assenta |
| Elemento saindo | ease-in (lento → rápido) | some sem pedir atenção |
| Movendo entre dois pontos visíveis | ease-in-out | tem começo e fim na tela |
| Elemento seguindo outro | linear + delay | mantém a relação legível |

Linear puro parece mecânico em quase tudo — exceto rotação contínua, marquee e
qualquer coisa que não deva ter início nem fim perceptíveis.

No After Effects, `KeyframeEase(speed, influence)`: `influence` de 0,1 a 100 é o que
molda a curva. Ease padrão do AE é 33; **75 é o valor que dá aquele "snap" de motion
design moderno**; acima de 85 fica lento demais na chegada.

```javascript
var suave = new KeyframeEase(0, 75);
prop.setTemporalEaseAtKey(2, [suave, suave], [suave, suave]);
```

## Stagger

Vários elementos entrando juntos viram uma massa. Escalonados, viram sequência.

- **2 a 4 frames** entre elementos é a faixa que funciona a 30 fps.
- Mais de 5 frames com muitos itens faz a sequência arrastar — nesse caso reduza o
  delay em vez de encurtar cada animação.
- A ordem deve seguir a leitura do design: de cima pra baixo, do foco pra periferia.
  Escalonar por índice de camada dá resultado aleatório e parece erro.

```javascript
var delayPorItem = 3 / comp.frameRate;
var inicio = i * delayPorItem;
```

## Overshoot e antecipação

**Overshoot** — passar do alvo e voltar — dá peso e é o que separa "animado" de
"animado bem". Faixa: 5% a 15% além do valor final. Mais que isso vira cartoon.

**Antecipação** — recuar antes de avançar — funciona em movimento com intenção
(um botão que salta, um elemento que dispara). Em fade e entrada suave, atrapalha.

Ambos são desnecessários em interface funcional e essenciais em identidade de marca.
A decisão é de tom, não técnica.

## Animando o que este projeto reconstrói

A cena vem em shape layers, o que abre caminhos que camada de imagem não tem:

**Stroke desenhando** — `Trim Paths` (`ADBE Vector Filter - Trim`) com `End` de 0 a
100%. É a animação clássica de contorno se desenhando. Adicione o Trim depois do path
no mesmo grupo.

**Scale com âncora certa** — só funciona se a âncora estiver no centro do conteúdo.
Por isso `recenterAnchor` existe no construtor; sem ela, escalar joga o elemento pro
canto.

**Escala não uniforme** para peso: `[0, 100]` → `[100, 100]` cresce na horizontal, o
que lê como "revelar" em vez de "aparecer".

**Grupos animam separado da camada.** A transform do grupo
(`ADBE Vector Transform Group`) permite animar uma peça do logo sem tocar na camada
inteira. É por isso que o modo "uma camada por grupo" é o padrão do painel.

**Repeater** (`ADBE Vector Filter - Repeater`) tem `Offset` animável — dá cascata sem
duplicar camada.

## Expressões que valem escrever por script

**Inércia depois do último keyframe** — o overshoot que a maioria dos motion
designers usa:

```javascript
n = 0;
if (numKeys > 0) {
  n = nearestKey(time).index;
  if (key(n).time > time) n--;
}
if (n > 0) {
  t = time - key(n).time;
  amp = 0.08; freq = 3.0; decay = 5.0;
  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);
  value + v * (amp / freq) * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t);
} else {
  value;
}
```

**Loop de saída** para ciclos:
```javascript
loopOut("cycle");   // ou "pingpong", "offset", "continue"
```

**Delay em cadeia** (elemento seguindo o de cima, sem keyframe próprio):
```javascript
delay = 0.1;
thisComp.layer(index - 1).transform.position.valueAtTime(time - delay);
```

**Wiggle contido em um eixo:**
```javascript
w = wiggle(2, 30);
[value[0], w[1]];
```

Ao gravar expressão por script: `prop.expression = "..."`. Cheque
`prop.canSetExpression` antes, e lembre que expressão **bloqueia `setValue`** — limpe
com `prop.expression = ""` se precisar escrever valor depois.

## Erros comuns

- **Tudo com a mesma duração.** Hierarquia visual precisa de hierarquia temporal.
- **Ease em tudo, inclusive no que devia ser instantâneo.** Nem toda mudança de estado
  merece transição.
- **Animar por animar.** Movimento sem função cansa em segundos numa peça que vai ao ar.
- **Âncora esquecida no canto.** Estraga scale e rotation e é o bug mais frequente em
  camada gerada por script.
- **Escalonar por índice de camada em vez de por leitura visual.** Parece bug, não ritmo.
