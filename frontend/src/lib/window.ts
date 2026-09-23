// Janela de render do chat: monta SO os ultimos N eventos (a cauda), nunca o transcript inteiro.
// Contagem-A-PARTIR-DO-FIM (relativa): um prepend futuro (paginacao backend / fix B) nao corrompe a
// janela, porque ela e sempre medida do fim.

/** Indice inicial (inclusivo) da fatia visivel, dado o fim da janela e o tamanho. Clampa em 0. */
export function windowStartFor(windowEnd: number, size: number): number {
  return Math.max(0, windowEnd - size);
}

/** Proximo fim de janela:
 *  - encolheu (reset / /clear) -> re-ancora na cauda nova (senao a slice fica fora do array = chat em branco);
 *  - colado no fim -> acompanha a cauda (remonta o topo SO com o usuario no fundo = sem pulo);
 *  - rolado pra cima -> congela. */
export function nextWindowEnd(atBottom: boolean, len: number, windowEnd: number): number {
  if (windowEnd > len) return len;   // transcript encolheu: clampa
  if (atBottom) return len;          // gruda no fim: janela segue a cauda
  return windowEnd;                  // lendo historico: congela
}

/** Mostrar a saída "ir pro fim"?
 *
 * Duas razões, e a segunda existe por um defeito medido em 25/08/2026. `atBottom` (folga < 64px)
 * decide se a janela ACOMPANHA a cauda; `scrolledUp` (mais de UMA TELA do fim) decidia sozinho se a
 * saída aparecia. Entre os dois havia faixa morta: rolado 100px pra cima, a janela congelava e o
 * botão continuava escondido — o chat parava de atualizar sem nada na tela dizendo isso, e a única
 * saída era sair da conversa e voltar. Relatado com a prévia do turno ainda correndo, ou seja:
 * conexão boa, lista muda.
 *
 * `windowEnd < len` é o fato que importa — existe evento que a janela congelada não mostra —, e não
 * a distância que a pessoa rolou.
 */
export function mostrarIrPraoFim(scrolledUp: boolean, windowEnd: number, len: number): boolean {
  return scrolledUp || windowEnd < len;
}

/** A lista segue colada no fim depois deste evento de scroll?
 *
 * Subir solta NA HORA, por menor que seja o passo. Com a folga de 64px valendo também pra soltar, a
 * prévia (que cresce várias vezes por segundo) puxava de volta toda rolada curta e a pessoa tinha
 * que brigar com a lista. `gap > 1` separa quem sobe do scrollTop que diminui sozinho quando o
 * conteúdo encolhe com a lista colada: ali o navegador prende no fim e a folga segue 0 (mais o
 * meio pixel do arredondamento). O corte fica em 1 e não mais alto porque a rolagem suave começa
 * em passos de 1 a 3px, e o primeiro deles já tem que soltar.
 * Quem solta a lista é o GESTO da pessoa, não a distância: a resposta em streaming abre a folga
 * sozinha (um resultado de ferramenta longo passa de 64px entre um quadro e outro), e soltar por
 * distância fazia a lista parar de acompanhar justo quem estava no fim lendo a resposta nascer.
 * Sem gesto, a folga só REENCOSTA (chegou a menos de 64px do fim), nunca solta. */
/** Janela do gesto, renovada enquanto os eventos de scroll continuam chegando dentro dela.
 *
 *  Sem renovar, um arraste lento da barra passa dos 400ms do toque inicial e volta a contar como
 *  crescimento de conteúdo no meio do movimento: aí basta a folga roçar os 64px uma vez (o
 *  repique perto do fim) para a lista se declarar colada e puxar a pessoa de volta no próximo
 *  pedaço da resposta — o bug de origem, na direção contrária. */
export function renovarGesto(agora: number, ate: number, janela = 400): number {
  return agora < ate ? agora + janela : ate;
}

export function nextAtBottom(atBottom: boolean, top: number, lastTop: number, gap: number, gesto: boolean): boolean {
  if (gesto && top < lastTop - 1 && gap > 1) return false;   // subiu de verdade
  if (gap < 64) return true;                                  // encostou no fim
  return gesto ? false : atBottom;                            // longe: só o gesto solta
}

/** A janela cabe INTEIRA na tela e ainda ha evento antigo fora dela?
 *
 * A janela conta EVENTOS CRUS, mas quem enche a tela sao as LINHAS renderizadas — e as duas contas
 * divergem muito: tool_result e filtrado e uma rajada de >=3 tool_use vira UMA linha de grupo, entao
 * uma sessao que so chama ferramenta cabe em ~20 linhas com os 120 eventos montados. Sem rolagem o
 * `onscroll` nunca dispara, e ele e o unico gatilho da paginacao pra cima: o chat fica parado
 * PARECENDO que nao ha nada acima, com milhares de eventos ali. Medido em 12/08/2026 numa sessao Pi.
 * 64px = a mesma folga do "esta no fim" (rolagem menor que isso nao da pra usar). */
export function precisaPreencher(scrollHeight: number, clientHeight: number,
                                 hasOlder: boolean): boolean {
  return hasOlder && scrollHeight - clientHeight <= 64;
}
