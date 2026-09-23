// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { sessionsStore } from './sessionsStore.svelte';
import { getIdentificador } from './peers';
import { configureDiag, estaDesligado, registrarFalha, registrarSucesso, _limparEsfriamentoParaTestes } from '@hangar/core';

const streams = vi.hoisted(() => new Map<string, Map<string, (event: { data: string }) => void>>());
const objetos = vi.hoisted(() => new Map<string, { onerror?: () => void; close: unknown; addEventListener: unknown }>());
const connectionIds = vi.hoisted(() => new Map<string, string | undefined>());
const navListener = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('./auth', () => ({
  listServers: () => ['lan', 'vpn'].map(id => ({ id, label: id, baseUrl: `http://${id}`, token: 'test' })),
  onServersChanged: () => () => {},
  getActiveId: () => 'lan',
}));
vi.mock('./navPelaLista', () => ({ navPelaLista: vi.fn() }));
vi.mock('./peers', () => ({ getIdentificador: vi.fn(async (server: { id: string }) => ({ identificador: `backend-${server.id}` })) }));
vi.mock('./navegadorPanel.svelte', () => ({
  podarNavMortos: vi.fn(),
  ouvirFechamentoNav: () => { navListener.start(); return navListener.stop; },
}));
vi.mock('@hangar/core', async original => ({
  ...await original<typeof import('@hangar/core')>(),
  openSessionsStream: (server: { id: string }, req?: string) => {
    connectionIds.set(server.id, req);
    const handlers = new Map();
    streams.set(server.id, handlers);
    const obj = { close: vi.fn(), addEventListener: (name: string, fn: unknown) => handlers.set(name, fn) };
    objetos.set(server.id, obj);
    return obj;
  },
}));
afterEach(() => { sessionsStore.release(); streams.clear(); objetos.clear(); connectionIds.clear(); vi.clearAllTimers(); vi.useRealTimers();
  configureDiag({ registrar: () => {}, novoReq: () => '' }); _limparEsfriamentoParaTestes(); });

it('falha real marca também o servidor ativo; erro do produtor não é queda de rede', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  objetos.get('lan')!.onerror!();
  objetos.get('vpn')!.onerror!();
  expect(estaDesligado('lan')).toBe(true);
  expect(estaDesligado('vpn')).toBe(true);
  sessionsStore.buscarAgora('vpn');
  streams.get('vpn')!.get('list_error')!({ data: '' });
  expect(estaDesligado('vpn')).toBe(false);   // a máquina respondeu: não é rede
});

it('resposta recebida fora da lista retoma o stream e atualiza as sessões antigas', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  const first = { name: 'hangar', jsonl: '/hangar.jsonl', state: 'idle' };
  streams.get('vpn')!.get('sessions')!({ data: JSON.stringify([first]) });
  previous!.onerror!();
  expect(estaDesligado('vpn')).toBe(true);
  expect(sessionsStore.sessionsForServer('vpn')).toEqual([first]);

  vi.advanceTimersByTime(29000);
  expect(objetos.get('vpn')).toBe(previous);
  const lan = objetos.get('lan');
  registrarSucesso('vpn');
  const recovered = objetos.get('vpn');
  expect(recovered).not.toBe(previous);
  expect(estaDesligado('vpn')).toBe(false);
  streams.get('vpn')!.get('sessions')!({ data: JSON.stringify([first,
    { name: 'setup-vm', jsonl: '/setup-vm.jsonl', state: 'working' }]) });
  expect(sessionsStore.sessionsForServer('vpn').map(s => s.name)).toEqual(['hangar', 'setup-vm']);
  registrarSucesso('vpn');
  expect(objetos.get('vpn')).toBe(recovered);
  expect(objetos.get('lan')).toBe(lan);
});

it('servidor desligado antes da montagem aguarda o prazo; reconexão explícita tenta agora', () => {
  registrarFalha('vpn');
  sessionsStore.retain();
  expect(objetos.has('vpn')).toBe(false);
  expect(sessionsStore.byServer.find(s => s.server.id === 'vpn')?.error).toBe('offline');
  sessionsStore.refreshServers();
  expect(estaDesligado('vpn')).toBe(true);
  expect(objetos.has('vpn')).toBe(false);
  sessionsStore.reconnect();
  expect(estaDesligado('vpn')).toBe(false);
  expect(objetos.has('vpn')).toBe(true);
});

it('descobre a identidade apenas após quadro válido com pareamento remoto, uma vez por conexão', async () => {
  vi.mocked(getIdentificador).mockClear();
  registrarFalha('vpn');
  sessionsStore.retain();
  expect(getIdentificador).not.toHaveBeenCalled();
  const publish = streams.get('lan')!.get('sessions')!;
  publish({ data: '[]' });
  expect(getIdentificador).not.toHaveBeenCalled();
  const data = JSON.stringify([{ name: 'a', jsonl: '/a', pair_peers: ['backend-vpn::b'] }]);
  publish({ data });
  publish({ data });
  await vi.waitFor(() => expect(sessionsStore.identities.get('lan')).toBe('backend-lan'));
  expect(getIdentificador).toHaveBeenCalledTimes(1);
  expect(estaDesligado('vpn')).toBe(true);
});

it('repete a identidade após falha transitória, com intervalo e sem reabrir o stream', async () => {
  vi.useFakeTimers();
  vi.mocked(getIdentificador).mockClear();
  vi.mocked(getIdentificador).mockRejectedValueOnce(new Error('timeout'));
  const registrar = vi.fn();
  configureDiag({ registrar, novoReq: () => 'identity-retry' });
  sessionsStore.retain();
  const original = objetos.get('lan');
  const publish = streams.get('lan')!.get('sessions')!;
  const data = JSON.stringify([{ name: 'a', jsonl: '/a', pair_peers: ['backend-vpn::b'] }]);
  publish({ data });
  await vi.waitFor(() => expect(registrar).toHaveBeenCalledWith(
    expect.objectContaining({ evento: 'lista.identificador_falhou' }), 'http://lan'));
  publish({ data });
  expect(getIdentificador).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 30000);
  streams.get('lan')!.get('ping')!({ data: '' });
  await vi.waitFor(() => expect(sessionsStore.identities.get('lan')).toBe('backend-lan'));
  expect(getIdentificador).toHaveBeenCalledTimes(2);
  expect(objetos.get('lan')).toBe(original);
  expect(original!.close).not.toHaveBeenCalled();
});

it('não reabre conexões quando a lista já foi desmontada', () => {
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  previous!.onerror!();
  sessionsStore.release();
  registrarSucesso('vpn');
  expect(objetos.get('vpn')).toBe(previous);
});

it('retentar um remoto não cancela a recuperação já pendente do servidor ativo', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  const lan = objetos.get('lan');
  lan!.onerror!();
  objetos.get('vpn')!.onerror!();
  sessionsStore.buscarAgora('vpn');
  expect(objetos.get('lan')).toBe(lan);
  vi.advanceTimersByTime(30000);
  expect(objetos.get('lan')).not.toBe(lan);
});

it.each(['vpn', undefined])('buscarAgora(%s) reabre o produtor com erro sem interromper o servidor saudável', (id) => {
  sessionsStore.retain();
  const healthy = objetos.get('lan');
  const failed = objetos.get('vpn');
  streams.get('vpn')!.get('list_error')!({ data: '' });
  expect(estaDesligado('vpn')).toBe(false);
  expect(sessionsStore.byServer.find(s => s.server.id === 'vpn')?.error).toBeTruthy();

  sessionsStore.buscarAgora(id);
  expect(failed!.close).toHaveBeenCalledOnce();
  expect(objetos.get('vpn')).not.toBe(failed);
  expect(objetos.get('lan')).toBe(healthy);
  expect(healthy!.close).not.toHaveBeenCalled();
  failed!.onerror!();
  expect(estaDesligado('vpn')).toBe(false);
  streams.get('vpn')!.get('sessions')!({ data: JSON.stringify([{ name: 'recovered', jsonl: '/r' }]) });
  expect(sessionsStore.byServer.find(s => s.server.id === 'vpn')?.error).toBeNull();
  expect(sessionsStore.rows.some(s => s.name === 'recovered')).toBe(true);
});

it('voltar do segundo plano reconecta na hora quem estava no ar; quem já caíra espera o prazo', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  streams.get('lan')!.get('sessions')!({ data: '[]' });
  objetos.get('vpn')!.onerror!();   // já estava caído antes de esconder
  const vpnCaido = objetos.get('vpn');
  const visibilidade = vi.spyOn(document, 'visibilityState', 'get');
  visibilidade.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  const lanAntigo = objetos.get('lan');
  lanAntigo!.onerror!();            // a suspensão matou o socket
  expect(estaDesligado('lan')).toBe(true);
  visibilidade.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(estaDesligado('lan')).toBe(false);
  expect(objetos.get('lan')).not.toBe(lanAntigo);
  expect(estaDesligado('vpn')).toBe(true);
  expect(objetos.get('vpn')).toBe(vpnCaido);
  visibilidade.mockRestore();
});

it('retoma automaticamente após o prazo, mantendo offline até uma resposta válida', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  previous!.onerror!();
  vi.advanceTimersByTime(30000);
  expect(objetos.get('vpn')).not.toBe(previous);
  expect(estaDesligado('vpn')).toBe(true);
  streams.get('vpn')!.get('sessions')!({ data: JSON.stringify([{ name: 'voltou', jsonl: '/v' }]) });
  expect(estaDesligado('vpn')).toBe(false);
  expect(sessionsStore.rows.some(s => s.name === 'voltou')).toBe(true);
});

it('remontar respeita o restante do prazo e o timeout também agenda outra tentativa', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  objetos.get('vpn')!.onerror!();
  vi.advanceTimersByTime(20000);
  sessionsStore.release();
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  vi.advanceTimersByTime(9999);
  expect(objetos.get('vpn')).toBe(previous);
  vi.advanceTimersByTime(1);
  const silent = objetos.get('vpn');
  expect(silent).not.toBe(previous);
  vi.advanceTimersByTime(10000);
  expect(silent!.close).toHaveBeenCalled();
  vi.advanceTimersByTime(60000);
  expect(objetos.get('vpn')).not.toBe(silent);
});

it('Ctrl+R não grava offline quando o navegador cancela as conexões da página antiga', () => {
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  streams.get('vpn')!.get('sessions')!({ data: '[]' });
  window.dispatchEvent(new Event('beforeunload'));
  previous!.onerror!();
  registrarFalha('vpn'); // fetch cancelado pela navegação também não é queda da máquina
  expect(estaDesligado('vpn')).toBe(false);
  window.dispatchEvent(new Event('pagehide'));
  window.dispatchEvent(new Event('pageshow'));
  expect(objetos.get('vpn')).not.toBe(previous);
  expect(estaDesligado('vpn')).toBe(false);
});

it('erro e timer da conexão descartada não derrubam a conexão nova', () => {
  vi.useFakeTimers();
  sessionsStore.retain();
  const previous = objetos.get('vpn');
  vi.advanceTimersByTime(5000);
  sessionsStore.reconnect();
  const current = objetos.get('vpn');
  streams.get('vpn')!.get('sessions')!({ data: '[]' });
  previous!.onerror!();
  vi.advanceTimersByTime(5000);
  expect(estaDesligado('vpn')).toBe(false);
  expect(current!.close).not.toHaveBeenCalled();
  expect(objetos.get('vpn')).toBe(current);
});

it('passa à abertura da lista o mesmo ID registrado em cada servidor', () => {
  vi.useFakeTimers();
  const registrar = vi.fn();
  let sequence = 0;
  configureDiag({ registrar, novoReq: () => `lista-${++sequence}` });
  sessionsStore.retain();
  expect(new Set(connectionIds.values()).size).toBe(2);
  for (const [server, req] of connectionIds) {
    expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'lista.abrir', req }), `http://${server}`);
  }
});

it('ouve fechamento externo do navegador enquanto a lista está viva', () => {
  const starts = navListener.start.mock.calls.length;
  const stops = navListener.stop.mock.calls.length;
  sessionsStore.retain();
  expect(navListener.start).toHaveBeenCalledTimes(starts + 1);
  sessionsStore.release();
  expect(navListener.stop).toHaveBeenCalledTimes(stops + 1);
});

it('preserva a sessão da VPN quando a LAN assume a duplicata na lista visual', () => {
  sessionsStore.retain();
  const session = { name: 'hangar-6', jsonl: '/same.jsonl', provider: 'codex', tracked: true, state: 'working' };
  const publish = (id: string) => streams.get(id)!.get('sessions')!({ data: JSON.stringify([session]) });
  publish('vpn');
  expect(sessionsStore.sessionsForServer('vpn')).toEqual([session]);
  publish('lan');
  expect(sessionsStore.rows.map(s => s.serverId)).toEqual(['lan']);
  expect(sessionsStore.sessionsForServer('vpn')).toEqual([session]);
});

it('registra primeiro quadro, parse inválido, silêncio e volta sem copiar quadros ou URLs', async () => {
  vi.useFakeTimers();
  const registrar = vi.fn();
  configureDiag({ registrar, novoReq: () => 'conexao' });
  sessionsStore.retain();
  const publicar = (data: string) => streams.get('lan')!.get('sessions')!({ data });
  publicar('[]');
  publicar('[]');
  expect(registrar.mock.calls.filter(([e, destino]) => e.evento === 'lista.conectou' && destino === 'http://lan')).toHaveLength(1);
  publicar('segredo conversa token');
  publicar('[]');
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ codigo: 'json_invalido' }), 'http://lan');
  expect(estaDesligado('lan')).toBe(false);
  await vi.advanceTimersByTimeAsync(25000);
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ codigo: 'silencio', espera_ms: 25000 }), 'http://lan');
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'lista.retentativa', espera_ms: 30000 }), 'http://lan');
  await vi.advanceTimersByTimeAsync(30000);
  publicar('[]');
  expect(registrar).toHaveBeenCalledWith(expect.objectContaining({ evento: 'lista.voltou' }), 'http://lan');
  expect(JSON.stringify(registrar.mock.calls.map(([e]) => e))).not.toMatch(/segredo|conversa|token|http:/);
});
