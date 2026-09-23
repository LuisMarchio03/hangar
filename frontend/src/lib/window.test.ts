import { describe, it, expect } from 'vitest';
import { precisaPreencher, mostrarIrPraoFim, nextAtBottom, renovarGesto } from './window';

describe('nextAtBottom', () => {
  it('subir 20px durante o streaming solta do fim, mesmo dentro da folga de 64px', () => {
    // O bug: gap=20 < 64 mantinha a lista colada e o próximo pedaço da prévia puxava de volta.
    expect(nextAtBottom(true, 980, 1000, 20, true)).toBe(false);
  });

  it('o primeiro passo de uma rolagem suave, 2px pra cima colada no fim, já solta', () => {
    expect(nextAtBottom(true, 998, 1000, 2, true)).toBe(false);
  });

  it('conteúdo encolheu com a lista colada: scrollTop cai mas a folga segue ~0, continua colada', () => {
    expect(nextAtBottom(true, 700, 1000, 0.5, true)).toBe(true);   // meio pixel do arredondamento
    expect(nextAtBottom(true, 700, 1000, 0, true)).toBe(true);
  });

  it('a resposta crescendo abre a folga sozinha e a lista CONTINUA acompanhando', () => {
    // Sem gesto da pessoa não há o que soltar: um resultado de ferramenta longo passa de 64px
    // entre dois quadros, e soltar ali parava o chat no meio da resposta de quem estava no fim.
    expect(nextAtBottom(true, 1000, 1000, 300, false)).toBe(true);
    expect(nextAtBottom(true, 1000, 0, 3500, false)).toBe(true);
  });

  it('longe do fim, o gesto da pessoa solta em qualquer direção', () => {
    expect(nextAtBottom(true, 900, 1000, 300, true)).toBe(false);
    expect(nextAtBottom(true, 500, 400, 600, true)).toBe(false);
  });

  it('solta continua solta enquanto ninguém desce de volta', () => {
    expect(nextAtBottom(false, 1000, 1000, 300, false)).toBe(false);
  });

  it('descer até 64px do fim reencosta', () => {
    expect(nextAtBottom(false, 990, 900, 40, true)).toBe(true);
  });
});

describe('renovarGesto', () => {
  it('arraste que continua dentro da janela estica a janela', () => {
    // 1000 = toque; cada evento de scroll seguinte renova, então um arraste de barra que dura
    // segundos nunca deixa de ser gesto.
    expect(renovarGesto(1200, 1400)).toBe(1600);
    expect(renovarGesto(1550, 1600)).toBe(1950);
  });

  it('parou: depois da janela vencida nada renova', () => {
    // É o que impede o crescimento da resposta de se passar por gesto.
    expect(renovarGesto(2000, 1400)).toBe(1400);
    expect(renovarGesto(1400, 1400)).toBe(1400);
  });
});

describe('mostrarIrPraoFim', () => {
  it('a faixa morta: janela congelada com evento novo e ainda sem uma tela rolada', () => {
    // O caso relatado em 25/08/2026. Rolou pouco (scrolledUp falso, porque nao passou de uma tela)
    // mas o suficiente pra sair dos 64px do atBottom -> a janela congelou em 40 com 45 eventos.
    // Antes disto o botao ficava escondido e o chat parava calado.
    expect(mostrarIrPraoFim(false, 40, 45)).toBe(true);
  });

  it('rolou mais de uma tela: continua aparecendo mesmo sem evento novo', () => {
    expect(mostrarIrPraoFim(true, 45, 45)).toBe(true);
  });

  it('colado no fim e em dia: nao aparece', () => {
    expect(mostrarIrPraoFim(false, 45, 45)).toBe(false);
    expect(mostrarIrPraoFim(false, 0, 0)).toBe(false);
  });
});

describe('precisaPreencher', () => {
  it('lista que nao rola e tem historico acima: precisa revelar', () => {
    // O caso real: 120 eventos crus viraram ~20 linhas (rajada de tool calls colapsada em grupo),
    // scrollHeight == clientHeight -> nenhum `onscroll` nunca -> paginacao pra cima nunca dispara.
    expect(precisaPreencher(800, 800, true)).toBe(true);
  });

  it('rolagem menor que a folga de 64px conta como "nao rola"', () => {
    expect(precisaPreencher(840, 800, true)).toBe(true);
    expect(precisaPreencher(880, 800, true)).toBe(false);
  });

  it('sem historico acima nao revela nada (nao ha o que paginar)', () => {
    expect(precisaPreencher(800, 800, false)).toBe(false);
  });
});
