import { describe, expect, it } from 'vitest';
import type { Server } from './auth';
import { destinoDoRemetente } from './remetente';

const srv = (id: string) => ({ id, label: id, baseUrl: `https://${id}`, token: 't' }) as Server;
const ids: Record<string, string> = { a: 'servidor-a', b: 'notebook', c: 'fora' };
const identificadorDe = async (s: Server) => {
  if (s.id === 'c') throw new Error('offline');
  return ids[s.id];
};

describe('destinoDoRemetente', () => {
  it('nome sem servidor fica no servidor ativo', async () => {
    expect(await destinoDoRemetente('hangar', [srv('a')], 'a', identificadorDe))
      .toEqual({ serverId: null, name: 'hangar' });
  });

  it('servidor::sessao abre no servidor do aparelho com aquele identificador', async () => {
    expect(await destinoDoRemetente('notebook::api', [srv('a'), srv('b'), srv('c')], 'a', identificadorDe))
      .toEqual({ serverId: 'b', name: 'api' });
  });

  it('servidor que não está no aparelho devolve null', async () => {
    expect(await destinoDoRemetente('vps::x', [srv('a'), srv('c')], 'a', identificadorDe)).toBeNull();
  });
});
