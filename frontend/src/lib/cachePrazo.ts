import * as m from '../paraglide/messages';

export interface UltimoCache { ts: number; ttl: number; read: number }

// O cache do Claude expira num prazo fixo a partir do ultimo turno. `ts` e do servidor e `agoraMs`
// e do aparelho: com o relogio adiantado a conta desanda, entao o que resta nunca passa da janela.
export function cachePrazo(c: UltimoCache | null | undefined, agoraMs: number) {
  const restaS = c ? Math.min(c.ttl, Math.round(c.ts + c.ttl - agoraMs / 1000)) : 0;
  const ativo = !!c && restaS > 0;
  // Ultimo quinto do prazo: fixo em 300s, a janela de 5min nascia ja em ambar.
  const acabando = ativo && !!c && restaS <= Math.max(60, c.ttl * 0.2);
  const min = Math.ceil(restaS / 60);
  const label = !ativo
    ? m.composer_expirou()
    : min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}min`;
  return { restaS, ativo, acabando, label };
}
