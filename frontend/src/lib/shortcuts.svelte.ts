// DONO da lista de atalhos da fileira, por servidor. Mora fora do Chat porque três superfícies
// consomem a mesma lista (fileira do painel, "⋯" da NavBar, command palette) e o editor da
// config grava nela — uma busca por montagem de Chat viraria três GETs e três verdades.
import {
  defaultShortcuts, getConfig, getConfigForServer, patchConfig, patchConfigForServer,
  resolveShortcuts, serializeShortcuts, type Shortcut,
} from '@hangar/core';
import { getActiveId, listServers } from './auth';

const listas = $state<Record<string, Shortcut[]>>({});
// Promessa, não flag: quem chega com a busca em voo tem de esperar a lista real, senão o editor
// abre com o conjunto nativo e salvar apagaria a config da pessoa.
const inFlight = new Map<string, Promise<void>>();

function chaveDe(serverId?: string | null): string {
  return serverId || getActiveId() || '';
}

/** Lista renderizável do servidor (default nativo enquanto não carregou). Pura: quem monta
 * chama `carregar` num $effect/onMount — side-effect dentro de $derived travaria o Svelte. */
export function shortcutsDe(serverId?: string | null): Shortcut[] {
  return listas[chaveDe(serverId)] ?? defaultShortcuts();
}

/** Falha rejeita: enquanto isso a fileira segue no default nativo, e quem chama decide como
 * mostrar o erro. Não cacheia a falha — a próxima chamada tenta de novo. */
export function carregarShortcuts(serverId?: string | null): Promise<void> {
  const k = chaveDe(serverId);
  if (!k || k in listas) return Promise.resolve();
  const pending = inFlight.get(k);
  if (pending) return pending;
  const load = (async () => {
    const s = serverId && serverId !== getActiveId()
      ? listServers().find((x) => x.id === serverId)
      : null;
    const c = s ? await getConfigForServer(s) : await getConfig();
    listas[k] = resolveShortcuts(String(c.campos.shortcuts?.valor ?? ''));
  })().finally(() => inFlight.delete(k));
  inFlight.set(k, load);
  return load;
}

/** Grava a lista no servidor e atualiza o cache. `null` = remover o override (volta ao nativo). */
export async function salvarShortcuts(lista: Shortcut[] | null, serverId?: string | null): Promise<void> {
  const k = chaveDe(serverId);
  const s = serverId && serverId !== getActiveId()
    ? listServers().find((x) => x.id === serverId)
    : null;
  const valor = lista === null ? null : serializeShortcuts(lista);
  if (s) await patchConfigForServer(s, { shortcuts: valor });
  else await patchConfig({ shortcuts: valor });
  listas[k] = lista === null ? defaultShortcuts() : lista;
}
