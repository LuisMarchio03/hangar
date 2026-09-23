import { describe, expect, it } from 'vitest';
import { groupRemotePairs } from './pairGroups';
import type { AggSession } from './types';

const session = (serverId: string, name: string, peers: string[], extra: Partial<AggSession> = {}): AggSession => ({
  serverId, name, serverLabel: serverId, serverColor: '#123', state: 'idle', pair_peers: peers, ...extra,
});
const identities = new Map([['srv-a', 'notebook-jefferson'], ['srv-b', 'delphi-02']]);
const local = session('srv-a', 'jefferson-2', ['delphi-02::setup-vm'], { pair_gid: 'b745f21b', pair_task: '  Ajustar VM  ' });
const remote = session('srv-b', 'setup-vm', ['notebook-jefferson::jefferson-2'], { pair_gid: '3881e52a' });

describe('groupRemotePairs', () => {
  it('une pares recíprocos com gids diferentes sem alterar as sessões', () => {
    const result = groupRemotePairs([local, remote], identities);
    expect(result.groups).toEqual([{
      id: 'remote:["srv-a::jefferson-2","srv-b::setup-vm"]', label: 'Ajustar VM', sessions: [local, remote],
    }]);
    expect(result.unpaired).toEqual([]);
    expect(result.groups[0].sessions[0]).toBe(local);
    expect(local.pair_gid).toBe('b745f21b');
    expect(remote.pair_gid).toBe('3881e52a');
    expect(groupRemotePairs([remote, local], identities).groups[0].id).toBe(result.groups[0].id);
  });

  it('mantém a homônima de outro servidor fora do par', () => {
    const other = session('srv-c', 'setup-vm', ['notebook-jefferson::jefferson-2']);
    const result = groupRemotePairs([other, local, remote], new Map([...identities, ['srv-c', 'outro']]));
    expect(result.groups[0].sessions).toEqual([local, remote]);
    expect(result.unpaired).toEqual([other]);
  });

  it.each([
    new Map([['srv-a', 'notebook-jefferson']]),
    new Map([['srv-b', 'delphi-02']]),
    new Map([...identities, ['srv-c', 'delphi-02']]),
    new Map([...identities, ['srv-c', 'notebook-jefferson']]),
  ])('não adivinha identidade ausente ou ambígua', (known) => {
    expect(groupRemotePairs([local, remote], known)).toEqual({ groups: [], unpaired: [local, remote] });
  });

  it('mantém membro remoto ausente na lista original', () => {
    expect(groupRemotePairs([local], identities)).toEqual({ groups: [], unpaired: [local] });
  });

  it.each([[], ['notebook-jefferson::outra'], ['notebook-jefferson::jefferson-2', 'mais-um']].map(peers => ({ peers })))(
    'recusa vínculo não recíproco ou que não seja 1:1', ({ peers }) => {
      const other = { ...remote, pair_peers: peers };
      expect(groupRemotePairs([local, other], identities)).toEqual({ groups: [], unpaired: [local, other] });
    },
  );

  it('não agrupa pares locais nem usa gid igual para unir servidores', () => {
    const rows = [
      session('srv-a', 'front', ['back'], { pair_gid: 'same' }),
      session('srv-a', 'back', ['front'], { pair_gid: 'same' }),
      session('srv-b', 'front', ['back'], { pair_gid: 'same' }),
    ];
    expect(groupRemotePairs(rows, identities)).toEqual({ groups: [], unpaired: rows });
  });

  it('recusa sessões duplicadas no destino', () => {
    const rows = [local, remote, { ...remote }];
    expect(groupRemotePairs(rows, identities)).toEqual({ groups: [], unpaired: rows });
  });

  it('usa a primeira tarefa preenchida ou os nomes quando não há tarefa', () => {
    const first = { ...local, pair_task: ' ' };
    expect(groupRemotePairs([first, { ...remote, pair_task: '  VM  ' }], identities).groups[0].label).toBe('VM');
    expect(groupRemotePairs([first, remote], identities).groups[0].label).toBe('jefferson-2, setup-vm');
  });
});
