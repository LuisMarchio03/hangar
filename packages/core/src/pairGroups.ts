import type { AggSession } from './types';

const sessionKey = (session: AggSession) => `${session.serverId}::${session.name}`;

export function groupRemotePairs(rows: AggSession[], identities: ReadonlyMap<string, string>) {
  const servers = new Map<string, string | null>();
  for (const [serverId, identity] of identities) {
    if (identity) servers.set(identity, servers.has(identity) ? null : serverId);
  }
  const sessions = new Map<string, AggSession | null>();
  for (const row of rows) {
    const key = sessionKey(row);
    sessions.set(key, sessions.has(key) ? null : row);
  }

  function peerOf(session: AggSession): AggSession | null {
    if (session.pair_peers?.length !== 1) return null;
    const address = session.pair_peers[0];
    const separator = address.indexOf('::');
    if (separator <= 0) return null;
    const serverId = servers.get(address.slice(0, separator));
    const name = address.slice(separator + 2);
    if (!serverId || serverId === session.serverId || !name) return null;
    return sessions.get(`${serverId}::${name}`) ?? null;
  }

  const groups: Array<{ id: string; label: string; sessions: AggSession[] }> = [];
  const grouped = new Set<AggSession>();
  for (const row of rows) {
    if (grouped.has(row)) continue;
    const peer = peerOf(row);
    if (!peer || peerOf(peer) !== row) continue;
    const members = [row, peer];
    groups.push({
      id: `remote:${JSON.stringify(members.map(sessionKey).sort())}`,
      label: members.map(s => s.pair_task?.trim()).find(Boolean) || members.map(s => s.name).join(', '),
      sessions: members,
    });
    members.forEach(s => grouped.add(s));
  }
  return { groups, unpaired: rows.filter(s => !grouped.has(s)) };
}
