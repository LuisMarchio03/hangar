// As duas listas de máquinas — a do navegador (este aparelho acompanha) e a do servidor (peers,
// os servidores se falam) — são donos diferentes e continuam separadas. A tela mostra UMA linha
// por máquina, casando as duas pelo identificador: pela URL viravam duas, porque o celular
// conhece a máquina pelo IP da rede local e o servidor pelo Tailscale.
import type { Server } from './auth';
import type { PeerView } from './peers';
import type { LadoState } from './registrarPeerDoisLados';

// Por que o identificador do servidor não chegou. Sem isto "não responde" e "responde, mas está
// sem nome" viravam a MESMA frase, e as duas se consertam de jeito diferente: uma é a máquina
// fora do ar, a outra é um campo para preencher.
export type MotivoSemId = 'vazio' | 'sem_resposta' | 'token';

export interface LinhaMaquina {
  chave: string;
  nome: string;
  identificador: string | null;
  // Só vale quando há `navegador` e falta `identificador`. Ausente = não se perguntou.
  motivoId?: MotivoSemId;
  navegador: Server | null;
  peer: PeerView | null;
  estaMaquina: boolean;
}

export function unirMaquinas(
  servidores: Server[],
  ids: Record<string, string | null>,
  peers: PeerView[],
  escolhidoId: string | null,
  motivos: Record<string, MotivoSemId> = {},
): LinhaMaquina[] {
  const porId = new Map(peers.map((p) => [p.id, p]));
  const porHost = new Map(peers.map((p) => [hostDe(p.base_url), p]));
  const usados = new Set<string>();
  // Dois servidores do navegador (LAN + Tailscale da mesma máquina) podem ter o MESMO
  // identificador: o segundo a casar fica sem peer, senão duas linhas renderizam o mesmo `corrige`.
  const idsCasados = new Set<string>();
  const linhas: LinhaMaquina[] = servidores.map((s) => {
    let identificador = ids[s.id] ?? null;
    let peer = identificador && !idsCasados.has(identificador) ? porId.get(identificador) ?? null : null;
    // Sem identificador a máquina está fora do ar (é ela quem o informa). Aí o endereço igual é a
    // única pista, e sem ele a mesma máquina desligada virava duas linhas.
    if (!identificador) {
      const porUrl = porHost.get(hostDe(s.baseUrl));
      if (porUrl && !usados.has(porUrl.id)) { peer = porUrl; identificador = porUrl.id; }
    }
    if (peer) { usados.add(peer.id); idsCasados.add(identificador!); }
    return {
      chave: `srv:${s.id}`,
      nome: s.label,
      identificador,
      motivoId: motivos[s.id] ?? 'vazio',
      navegador: s,
      peer,
      estaMaquina: s.id === escolhidoId,
    };
  });
  for (const p of peers) {
    if (usados.has(p.id)) continue;
    linhas.push({ chave: `peer:${p.id}`, nome: p.id, identificador: p.id, navegador: null, peer: p, estaMaquina: false });
  }
  return linhas.sort((a, b) => Number(b.estaMaquina) - Number(a.estaMaquina) || a.nome.localeCompare(b.nome));
}

export interface EstadoPeer { lados: LadoState[]; ok: boolean; testando?: boolean }

export type TipoEstado =
  | 'desligada' | 'sem_identificador' | 'nao_responde' | 'token_aparelho_recusado'
  | 'testando' | 'token_recusado' | 'ida_outra_maquina' | 'volta_outra_maquina' | 'parcial'
  | 'volta_sem_medir' | 'volta_sem_registro' | 'ok' | 'neutro';

export interface EstadoDaLinha {
  farol: 'ok' | 'nao' | 'test' | 'neutro';
  tipo: TipoEstado;
  ida?: LadoState;
  volta?: LadoState;
}

const FALHA: LadoState['estado'][] = ['falhou', 'recusou', 'estranho'];

const SEM_ID: Record<MotivoSemId, TipoEstado> = {
  vazio: 'sem_identificador',
  sem_resposta: 'nao_responde',
  token: 'token_aparelho_recusado',
};

// Uma decisão só para a linha curta da lista e para o detalhe: se cada um derivasse o estado,
// a lista podia dizer "Tudo certo" com o detalhe mostrando a volta falhando.
export function estadoDaLinha(linha: LinhaMaquina, st: EstadoPeer | undefined): EstadoDaLinha {
  const ida = st?.lados.find((l) => l.lado === 'ida');
  const volta = st?.lados.find((l) => l.lado === 'volta');
  const falhaReal = !!st && !st.ok && [ida, volta].some((l) => !!l && FALHA.includes(l.estado));
  const desligada = linha.peer?.enabled === false;
  let farol: EstadoDaLinha['farol'];
  if (desligada) farol = 'neutro';
  else if (st?.testando) farol = 'test';
  else if (!linha.peer && !st) farol = 'neutro';   // só navegador: nada para testar
  else if (!st) farol = 'test';
  else if (st.ok) farol = 'ok';
  else farol = falhaReal ? 'nao' : 'test';       // nao_configurado não é falha
  let tipo: TipoEstado;
  if (desligada) tipo = 'desligada';
  else if (linha.navegador && !linha.identificador) tipo = SEM_ID[linha.motivoId ?? 'vazio'];
  else if (st?.testando) tipo = 'testando';
  else if (volta?.estado === 'recusou' && volta.motivo === 'credencial') tipo = 'token_recusado';
  // `estranho` é o endereço guardado respondendo como OUTRA máquina — o único modo de falha que
  // se conserta trocando o endereço, e não esperando a máquina voltar. Vem antes do `parcial`,
  // que é o balde genérico: senão ele o engole e a tela só diz "só de ida".
  else if (volta?.estado === 'estranho') tipo = 'volta_outra_maquina';
  else if (ida?.estado === 'estranho') tipo = 'ida_outra_maquina';
  else if (falhaReal) tipo = 'parcial';
  else if (volta?.estado === 'nao_configurado' && volta.motivo === 'token') tipo = 'volta_sem_medir';
  else if (volta?.estado === 'nao_configurado' && volta.motivo === 'registro') tipo = 'volta_sem_registro';
  else if (st?.ok) tipo = 'ok';
  else tipo = 'neutro';
  // Máquina que este aparelho segue e não responde (ou recusa o token dele) é falha, não espera:
  // sem `peer` não há medição nenhuma, e o farol neutro dizia "nada a relatar".
  if (tipo === 'nao_responde' || tipo === 'token_aparelho_recusado') farol = 'nao';
  return { farol, tipo, ida, volta };
}

function hostDe(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return url.trim().toLowerCase(); }
}
