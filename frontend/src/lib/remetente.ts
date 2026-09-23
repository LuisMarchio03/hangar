import type { Server } from './auth';

export interface DestinoRemetente { serverId: string | null; name: string }

/** Onde abrir a sessão que mandou um recado. `null` = o servidor dela não está neste aparelho.
 *
 *  Recado de outro servidor chega como `servidor::sessao`, e `servidor` é o CP_SERVER_ID do backend
 *  dele, não o id da entrada no aparelho: só se descobre qual entrada é perguntando a cada uma.
 *  O servidor ativo ganha no empate, porque é dele que vem o recado com o próprio nome qualificado. */
export async function destinoDoRemetente(
  from: string,
  servers: Server[],
  ativo: string | null,
  identificadorDe: (s: Server) => Promise<string>,
): Promise<DestinoRemetente | null> {
  const i = from.indexOf('::');
  if (i < 0) return { serverId: null, name: from };
  const id = from.slice(0, i);
  const name = from.slice(i + 2);
  // Servidor fora do ar não responde o identificador; não é ele, e não derruba os outros.
  const ids = await Promise.all(servers.map((s) => identificadorDe(s).catch(() => '')));
  const achados = servers.filter((_, k) => ids[k] === id);
  const dono = achados.find((s) => s.id === ativo) ?? achados[0];
  return dono ? { serverId: dono.id, name } : null;
}
