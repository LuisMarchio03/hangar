// Store ÚNICO da agregação SSE multi-servidor (substitui as 3 cópias de slots/recompute/connect —
// docs/polish-backlog.md § Structural debt). Singleton com refcount: Sidebar + Board/Canvas montados
// ao mesmo tempo compartilham 1 EventSource por servidor (limite ~6 SSE/host do navegador).
// Estratégia de stream = a do Board (a mais robusta das cópias): try/catch no parse + onServersChanged.
// Nota (architect): nas trocas board↔canvas↔chat do desktop o refcount nunca toca 0 porque a Sidebar
// fica montada o tempo todo segurando 1 retain — não há fecha-e-reabre de streams. Se um dia nenhum
// consumidor ficar permanentemente montado, considerar um keep-alive com delay no release.
import * as m from '../paraglide/messages';
import type { EventSourceLike } from '@hangar/core';
import { openSessionsStream, registrarDiag, novoReqDiag } from '@hangar/core';
import { listServers, onServersChanged, type Server } from './auth';
import { navPelaLista } from './navPelaLista';
import { getIdentificador } from './peers';
import { ouvirFechamentoNav, podarNavMortos } from './navegadorPanel.svelte';
import { aggregateSessions, epocasDeRecriacao, jsonlDaSessao, sweepHidden, type Slot, type Aggregate, type Epocas } from '@hangar/core';
import { avisarSemArmazem, definirArmazem, definirProtegido, estaDesligado, esquecerServidor, onServerRecovered, registrarFalha, registrarSucesso, retentarAgora, retryAfterMs } from '@hangar/core';

function createSessionsStore() {
  let servers = $state<Server[]>([]);
  let identities = $state.raw<ReadonlyMap<string, string>>(new Map());
  // $state.raw: agg é SUBSTITUÍDO inteiro a cada recompute e nunca mutado — o proxy profundo do
  // $state só custava, e embrulhar as rows em proxy quebrava a identidade que o memo do
  // aggregateSessions preserva (rows de servidor que não emitiu = mesmo objeto -> keyed each das
  // views não re-renderiza os cards dos outros servidores).
  let agg = $state.raw<Aggregate>({ rows: [], byServer: [], loading: false });
  const slots = new Map<string, Slot>();
  const streams = new Map<string, EventSourceLike>();
  let leavingPage = false;
  // Watchdog por stream (mesmo padrão do Chat): o backend emite `ping` a cada ~10s no stream de
  // lista justamente pra isto — suspend/VPN flap deixa a conexão MEIO-ABERTA sem onerror e as 4
  // views congelavam em silêncio até um reconnect manual. Sem sinal por 25s -> fecha e reabre.
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const WATCHDOG_MS = 25_000;
  // Prazo só do PRIMEIRO quadro (ver o comentário no connect). 10s e não 3s porque a medição de
  // 06/09/2026 achou 1,8s de p90 no caminho do celular quando o túnel está perdendo pacote —
  // apertar demais esconderia da lista um servidor que está no ar, e isso é pior que mostrar um
  // morto por mais alguns segundos.
  const PRIMEIRO_QUADRO_MS = 10_000;
  const primeiros = new Map<string, ReturnType<typeof setTimeout>>();
  // ms até o primeiro quadro de cada servidor — ver o comentário no `chegou` do connect().
  // `$state.raw` porque o Map é SUBSTITUÍDO inteiro a cada medição (mesma escolha do `agg` acima):
  // sem ser estado reativo, a reatribuição não chegaria em quem lê num `$derived`.
  let latencias = $state.raw(new Map<string, number>());
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const quedas = new Map<string, number>();
  const tentativas = new Map<string, number>();
  // Quando cada stream deu o último sinal de vida (qualquer evento, inclusive o `ping` de 10s).
  // É o que distingue stream vivo de stream ZUMBI na volta do segundo plano.
  const ultimoSinal = new Map<string, number>();
  const SEM_SINAL_MS = 20_000;
  definirProtegido(() => leavingPage);
  // O core não toca DOM: o `localStorage` (que faz a marca sobreviver ao recarregamento do PWA)
  // entra por aqui. Indisponível (modo privado), fica só em memória — o core avisa no diário.
  try {
    definirArmazem(globalThis.localStorage ?? null);
  } catch (e) {
    definirArmazem(null);
    avisarSemArmazem(e);
  }

  function scheduleRetry(id: string) {
    if (leavingPage || refs === 0) return;
    const delay = Math.max(1000, retryAfterMs(id));
    const servidor = servers.find((s) => s.id === id);
    if (servidor) registrarDiag({ evento: 'lista.retentativa', tela: 'lista',
      espera_ms: delay, tentativa: tentativas.get(id) ?? 1 }, servidor.baseUrl);
    clearTimeout(retryTimers.get(id));
    retryTimers.set(id, setTimeout(() => {
      retryTimers.delete(id);
      if (refs > 0 && servers.some((x) => x.id === id)) connect(servers, id);
    }, delay));
  }
  let refs = 0;
  let offChanged: (() => void) | null = null;
  let offRecovered: (() => void) | null = null;
  let offNavFechado: (() => void) | null = null;
  // Exclusão otimista: chaves `serverId::name` escondidas da lista enquanto o delete está em voo.
  // A faxina roda a cada recompute — quando o SSE confirma o sumiço, a marca sai sozinha.
  let hidden = new Map<string, string | null>();
  // Época de recriação por `serverId::name` (ver epocasDeRecriacao). `$state.raw` e o Map
  // SUBSTITUÍDO quando muda, como `latencias`: é o que acorda o `{#key}` do Chat no desktop.
  let epocas: Epocas = { vistas: new Map(), sumidas: new Map(), epochs: new Map() };
  let epochs = $state.raw<ReadonlyMap<string, number>>(epocas.epochs);

  function recompute() {
    hidden = sweepHidden(hidden, slots);
    agg = aggregateSessions(servers, slots, hidden);
    epocas = epocasDeRecriacao(epocas, slots);
    if (epocas.epochs !== epochs) epochs = epocas.epochs;
    const vivos = new Map<string, Map<string, string | null>>();
    for (const [id, slot] of slots) {
      if (slot.sessions && !slot.error) vivos.set(id, new Map(slot.sessions.map((s) => [s.name, s.jsonl ?? null])));
    }
    podarNavMortos(vivos);
  }

  // Reconcilia streams com a lista: fecha o que sumiu, abre o que entrou, mantém o resto.
  function connect(list: Server[], onlyId?: string) {
    if (leavingPage || refs === 0) return;
    for (const id of identities.keys()) {
      if (!list.some(s => s.id === id)) { const next = new Map(identities); next.delete(id); identities = next; }
    }
    for (const [id, es] of streams) {
      if (!list.some((s) => s.id === id)) {
        es.close(); streams.delete(id); slots.delete(id); ultimoSinal.delete(id);
        clearTimeout(watchdogs.get(id)); watchdogs.delete(id);
        clearTimeout(primeiros.get(id)); primeiros.delete(id);
        clearTimeout(retryTimers.get(id)); retryTimers.delete(id);
        quedas.delete(id); tentativas.delete(id); esquecerServidor(id);
        if (latencias.has(id)) { latencias = new Map(latencias); latencias.delete(id); }
      }
    }
    for (const s of list) {
      if (onlyId !== undefined && s.id !== onlyId) continue;
      if (streams.has(s.id)) continue;
      if (retryAfterMs(s.id) > 0) {
        slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
        scheduleRetry(s.id);
        continue;
      }
      clearTimeout(retryTimers.get(s.id)); retryTimers.delete(s.id);
      if (estaDesligado(s.id)) slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
      const req = novoReqDiag();
      const es = openSessionsStream(s, req);
      streams.set(s.id, es);
      const isCurrent = () => !leavingPage && refs > 0 && streams.get(s.id) === es;
      let identityRequested = false;
      let identityRetryAt = 0;
      let identityNeeded = false;
      const loadIdentity = () => {
        if (!isCurrent() || !identityNeeded || identityRequested || Date.now() < identityRetryAt) return;
        identityRequested = true;
        void getIdentificador(s).then(({ identificador }) => {
          if (!isCurrent() || !identificador) return;
          identities = new Map(identities).set(s.id, identificador);
        }).catch((error: unknown) => {
          if (!isCurrent()) return;
          identityRequested = false;
          identityRetryAt = Date.now() + 30_000;
          registrarDiag({ evento: 'lista.identificador_falhou', nivel: 'aviso',
            codigo: error instanceof Error ? error.name : 'erro' }, s.baseUrl);
        });
      };
      if (identities.has(s.id)) { const next = new Map(identities); next.delete(s.id); identities = next; }
      const tentativa = (tentativas.get(s.id) ?? 0) + 1;
      tentativas.set(s.id, tentativa);
      registrarDiag({ evento: 'lista.abrir', tela: 'lista', req, tentativa }, s.baseUrl);
      let primeiroValido = true;
      // Uma falha por CONEXÃO, não por sintoma: prazo do primeiro quadro e watchdog disparam os
      // dois na mesma tentativa presa, e contar duas vezes esfriaria no dobro da velocidade.
      let jaContou = false;
      const falhou = (codigo: string, espera_ms?: number) => {
        if (!quedas.has(s.id)) quedas.set(s.id, Date.now());
        registrarDiag({ evento: 'lista.falhou', nivel: 'aviso', tela: 'lista', req,
          codigo, tentativa, espera_ms }, s.baseUrl);
        if (!jaContou) { jaContou = true; registrarFalha(s.id); }
      };
      const arm = () => {
        if (!isCurrent()) return;
        ultimoSinal.set(s.id, Date.now());
        clearTimeout(watchdogs.get(s.id));
        watchdogs.set(s.id, setTimeout(() => {
          if (!isCurrent()) return;
          falhou('silencio', WATCHDOG_MS);
          // es.close() num stream já fechado é noop; connect() reabre só este servidor (os outros
          // seguem em streams). O arm() do stream novo substitui este timer no mesmo id.
          es.close();
          streams.delete(s.id);
          watchdogs.delete(s.id);
          cancelarPrazo();   // o stream acabou; NÃO mede — silêncio não é latência
          // Mesmo tratamento do onerror: o slot que motivou o watchdog está potencialmente velho —
          // marca offline (mantendo a última lista boa) em vez de segui-lo servindo como bom.
          slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
          recompute();
          scheduleRetry(s.id);
        }, WATCHDOG_MS));
      };
      // Prazo do PRIMEIRO quadro, separado do watchdog. O slot só nasce quando chega evento, então
      // até lá o servidor tem `error` nulo e passa por vivo em quem filtra offline — com o watchdog
      // de 25s isso era meio minuto oferecendo máquina desligada na folha de "Nova sessão". O
      // stream da lista manda `sessions` na conexão (medido em 5ms daqui), então silêncio longo
      // aqui encerra a tentativa e agenda outra conforme o prazo persistido.
      // Sem guarda de "o slot já existe": `reconnect()` (botão Atualizar) e `onVisibleKick` (celular
      // acordando) reabrem o stream MANTENDO o slot antigo, e ali a guarda fazia o prazo virar
      // no-op — o celular acordando é justamente quando isto precisa valer. O timer chegar a
      // disparar já prova o que interessa: nenhum quadro nesta conexão. Preserva a última lista boa
      // (mesmo tratamento do watchdog): "offline com dado velho" é diferente de "nunca respondeu",
      // e o banner de erro depende dessa distinção.
      const tPrimeiro = setTimeout(() => {
        if (!isCurrent()) return;
        falhou('primeiro_quadro_timeout', PRIMEIRO_QUADRO_MS);
        if (primeiros.get(s.id) === tPrimeiro) primeiros.delete(s.id);
        slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
        recompute();
        // Conexão que nunca entregou quadro é o caso da máquina morta atrás da VPN: o socket fica
        // pendurado, o `onerror` nunca vem, e o EventSource reabre sozinho a cada ~3s pra sempre.
        // O `falhou` acima já marcou como desligado; aqui só se fecha o que ficou aberto.
        if (estaDesligado(s.id)) {
          es.close();
          streams.delete(s.id);
          clearTimeout(watchdogs.get(s.id)); watchdogs.delete(s.id);
          scheduleRetry(s.id);
        }
      }, PRIMEIRO_QUADRO_MS);
      primeiros.set(s.id, tPrimeiro);
      // `delete` só se a entrada ainda for ESTE timer: um timer fantasma de tentativa anterior
      // apagaria do Map o timer da tentativa atual, e aí ninguém mais conseguiria cancelá-lo.
      // Custo da ROTA até esta máquina. A mesma máquina costuma estar cadastrada duas vezes, por
      // dois caminhos (Tailscale direto e o desvio pela VPS), e com as duas no ar não havia como
      // saber qual escolher: medido em 06/09/2026, 45ms contra 134ms pro mesmo backend. O tempo até
      // o primeiro quadro já inclui conexão e TLS, que é exatamente o que separa as rotas.
      // Mede a cada CONEXÃO, não só a primeira: ligar ou desligar a VPN troca a rota, e é
      // justamente aí que o número velho enganaria. `medido` é por conexão porque `chegou` também
      // roda nos pings seguintes, e ali o relógio já não mede abertura nenhuma.
      const abriuEm = performance.now();
      let medido = false;
      // CANCELAR o prazo e MEDIR são coisas separadas, e misturá-las inverte o sentido do número:
      // o watchdog e o `onerror` também precisam cancelar, e uma conexão RECUSADA na hora falha em
      // poucos ms — gravada como latência, a rota morta viraria "a mais rápida", em verde, que é
      // exatamente a escolha errada que este número existe pra evitar. Só quadro de verdade mede.
      const cancelarPrazo = () => {
        clearTimeout(tPrimeiro);
        if (primeiros.get(s.id) === tPrimeiro) primeiros.delete(s.id);
      };
      const chegou = () => {
        if (!isCurrent()) return;
        if (!medido) {
          medido = true;
          // Map NOVO, não `.set` no mesmo: quem lê isto num `$derived` acompanha a REFERÊNCIA —
          // mutar em lugar não avisa ninguém e o número nunca apareceria na tela.
          latencias = new Map(latencias).set(s.id, Math.round(performance.now() - abriuEm));
          recompute();
        }
        cancelarPrazo();
      };
      arm();
      // O ping é prova de vida (cancela o prazo), mas NÃO mede: ele só sai de 8 em 8 segundos, e
      // com o refresher do backend frio ele é o PRIMEIRO evento a chegar — a "latência da rota"
      // viraria ~8000ms de espera do servidor. Quem mede é o quadro de dados.
      es.addEventListener('ping', () => {
        if (!isCurrent()) return;
        cancelarPrazo();
        registrarSucesso(s.id);
        arm();
        loadIdentity();
      });
      es.addEventListener('sessions', (e) => {
        if (!isCurrent()) return;
        chegou();
        arm();
        registrarSucesso(s.id);     // e o esfriamento sai de cena inteiro
        try {
          const sessions = JSON.parse(e.data);
          if (!Array.isArray(sessions)) throw new Error('sessions frame must be an array');
          slots.set(s.id, { sessions, error: null });
          identityNeeded = sessions.some((session: { pair_peers?: string[] }) =>
            session.pair_peers?.some(peer => peer.includes('::')));
          loadIdentity();
          const caiuEm = quedas.get(s.id);
          if (primeiroValido || caiuEm !== undefined) {
            registrarDiag({ evento: caiuEm === undefined ? 'lista.conectou' : 'lista.voltou',
              tela: 'lista', req, tentativa,
              ms: caiuEm === undefined ? Math.round(performance.now() - abriuEm) : Date.now() - caiuEm }, s.baseUrl);
            primeiroValido = false;
            quedas.delete(s.id);
            tentativas.delete(s.id);
          }
        } catch {
          registrarDiag({ evento: 'lista.falhou', nivel: 'aviso', tela: 'lista', req,
            codigo: 'json_invalido', tentativa }, s.baseUrl);
          // Frame malformado: sem isto o throw sobe no dispatch do EventSource e o slot congela em
          // silêncio (onerror não dispara pra erro de parse). Mantém a última lista boa e avisa.
          slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: m.sessao_erro_servidor() });
        }
        recompute();
      });
      // O agente abriu o navegador embutido de uma sessão (possivelmente fora da tela) — ver
      // navPelaLista. Vai pelo stream da lista porque é o único que o desktop mantém sempre aberto.
      es.addEventListener('nav', (e) => {
        if (!isCurrent()) return;
        arm();
        void navPelaLista(s, (e as MessageEvent).data);
      });
      // Refresher do backend falhou (achado do hunter): sem isto, lista vazia por erro interno era
      // indistinguível de zero sessões. Mantém a última lista boa; o erro aparece distinto de offline.
      es.addEventListener('list_error', () => {
        if (!isCurrent()) return;
        // A máquina RESPONDEU (o SSE está aberto): não é falha de rede, então não esfria — marcar
        // desligado aqui confundia bug do refresher com máquina fora do ar.
        registrarDiag({ evento: 'lista.falhou', nivel: 'aviso', tela: 'lista', req,
          codigo: 'produtor_falhou', tentativa }, s.baseUrl);
        registrarSucesso(s.id);
        cancelarPrazo();
        arm();   // conexão está viva — só o produtor de dados falhou
        slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: m.sessao_erro_servidor() });
        recompute();
      });
      es.onerror = () => {
        if (!isCurrent()) return;
        falhou(es.readyState === 2 ? 'stream_fechado' : 'stream_interrompido');
        slots.set(s.id, { sessions: slots.get(s.id)?.sessions ?? null, error: 'offline' });
        recompute();
        // Assume o controle do retry (o nativo martela): fecha e reagenda com backoff.
        es.close();
        streams.delete(s.id);
        clearTimeout(watchdogs.get(s.id)); watchdogs.delete(s.id);
        cancelarPrazo();   // o stream falhou; NÃO mede — falhar rápido não é ser rápido
        scheduleRetry(s.id);
      };
    }
    recompute();
  }

  // Wake do aparelho (iOS congela timers em background): zera o backoff e reconecta os caidos NA
  // HORA — sem isto, o retry agendado pre-sleep deixava a lista "offline" por ate 60s com rede boa.
  function onVisibleKick() {
    if (leavingPage || document.visibilityState !== 'visible' || refs === 0) return;
    // Stream ZUMBI: o iOS suspende o PWA, o socket morre sem `onerror` e o EventSource continua no
    // mapa — como o `connect` só abre quem NÃO tem stream, ninguém o reabria, e o watchdog que
    // pegaria isso não roda em segundo plano. O app ficava mudo com a rede perfeita até a pessoa
    // religar a VPN (o que derruba o socket e finalmente dispara o erro). Medido em 16/09/2026:
    // rota direta, ping respondendo, e zero pedido do celular ao backend por minutos.
    const agora = Date.now();
    for (const [id, es] of [...streams]) {
      if (agora - (ultimoSinal.get(id) ?? 0) < SEM_SINAL_MS) continue;
      const servidor = servers.find((x) => x.id === id);
      if (servidor) registrarDiag({ evento: 'lista.reconectar', tela: 'lista',
        codigo: 'stream_mudo' }, servidor.baseUrl);
      es.close();
      streams.delete(id);
      clearTimeout(watchdogs.get(id)); watchdogs.delete(id);
      clearTimeout(primeiros.get(id)); primeiros.delete(id);
    }
    for (const s of servers) if (!streams.has(s.id)) registrarDiag({
      evento: 'lista.reconectar', tela: 'lista', codigo: 'app_visivel' }, s.baseUrl);
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    connect(servers);
  }

  function disconnect() {
    for (const timers of [watchdogs, primeiros, retryTimers]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
    const previous = [...streams.values()];
    streams.clear();
    for (const es of previous) es.close();
  }

  function onPageExit() {
    // O navegador dispara onerror ao recarregar, antes mesmo do pagehide.
    leavingPage = true;
    disconnect();
  }

  function onPageShow() {
    leavingPage = false;
    connect(servers);
  }

  function start() {
    leavingPage = false;
    window.addEventListener('beforeunload', onPageExit);
    window.addEventListener('pagehide', onPageExit);
    window.addEventListener('pageshow', onPageShow);
    servers = listServers();
    offNavFechado = ouvirFechamentoNav();
    offRecovered = onServerRecovered((id) => {
      if (refs > 0 && servers.some((s) => s.id === id) && !streams.has(id)) connect(servers, id);
    });
    connect(servers);
    offChanged = onServersChanged(() => { servers = listServers(); connect(servers); });
    document.addEventListener('visibilitychange', onVisibleKick);
  }
  function stop() {
    offChanged?.();
    offChanged = null;
    offRecovered?.();
    offRecovered = null;
    offNavFechado?.();
    offNavFechado = null;
    document.removeEventListener('visibilitychange', onVisibleKick);
    window.removeEventListener('beforeunload', onPageExit);
    window.removeEventListener('pagehide', onPageExit);
    window.removeEventListener('pageshow', onPageShow);
    disconnect();
    // A poda por servidor removido mora no laço do `connect()`, que compara com `streams` — e aqui
    // `streams` já foi esvaziado. Sem zerar, um servidor apagado enquanto ninguém segurava o store
    // voltaria exibindo a latência de outra época, que ninguém mais vai corrigir.
    latencias = new Map();
    identities = new Map();
    slots.clear();
    quedas.clear(); tentativas.clear();
    // Parar não é sumiço: sem isto, o próximo retain() (o próprio DesktopShell, ao remontar)
    // veria todo nome "voltar" e subiria a época de todas as sessões — remontando chats vivos.
    epocas = { vistas: new Map(), sumidas: new Map(), epochs: epocas.epochs };
    recompute();
  }

  return {
    sessionsForServer(serverId: string) {
      void agg; // A publicação da lista também invalida a leitura do slot original.
      return slots.get(serverId)?.sessions ?? [];
    },
    get rows() { return agg.rows; },
    get byServer() { return agg.byServer; },
    get latencias() { return latencias; },
    // Quantas vezes uma sessão com este nome já foi recriada nesta aba — entra na `{#key}` do Chat.
    epoca(serverId: string, name: string): number { return epochs.get(`${serverId}::${name}`) ?? 0; },
    get loading() { return agg.loading; },
    get servers() { return servers; },
    get identities() { return identities; },
    retain() { if (++refs === 1) start(); },
    // Guarda contra consumidor futuro desbalanceado: um release a mais deixaria refs negativo e o
    // singleton nunca mais reconectaria (nenhum retain voltaria a bater 1). Piso em 0.
    release() { if (refs > 0 && --refs === 0) stop(); },
    /** Tentativa explicitamente pedida pela pessoa, nunca ao expandir o resumo dos offline. */
    buscarAgora(id?: string) {
      retentarAgora(id);
      if (refs === 0) return;
      for (const [key, timer] of retryTimers) {
        if (id !== undefined && key !== id) continue;
        clearTimeout(timer); retryTimers.delete(key);
      }
      for (const [key, es] of streams) {
        if (id !== undefined ? key !== id : !slots.get(key)?.error) continue;
        streams.delete(key);
        es.close();
        for (const timers of [watchdogs, primeiros]) {
          clearTimeout(timers.get(key)); timers.delete(key);
        }
      }
      connect(servers, id);
    },
    reconnect() {
      // Resgata streams meio-abertos sem recarregar a página (o "Atualizar" dos menus).
      // refs=0 => ninguém consome o store (ex: Configurações aberta sobre Archive/Costs, onde a
      // lista não está montada): reconectar abriria SSE órfão — não faz nada.
      if (refs === 0) return;
      for (const s of servers) registrarDiag({ evento: 'lista.reconectar',
        tela: 'lista', codigo: 'manual' }, s.baseUrl);
      disconnect();
      retentarAgora();
      connect(servers);
    },
    refreshServers() {
      servers = listServers();
      // Mesma guarda: com refs=0 a lista nova fica pronta pro próximo retain sem abrir stream.
      if (refs > 0) connect(servers);
    },
    // Exclusão otimista: a view marca antes do await (linha some na hora) e desmarca no catch
    // (linha REAPARECE = rollback visual). No sucesso ninguém desmarca — a faxina do recompute
    // remove a marca quando o SSE re-emitir a lista sem a sessão.
    markDeleting(serverId: string, name: string) {
      hidden.set(`${serverId}::${name}`, jsonlDaSessao(slots, serverId, name));
      recompute();
    },
    unmarkDeleting(serverId: string, name: string) { hidden.delete(`${serverId}::${name}`); recompute(); },
  };
}

export const sessionsStore = createSessionsStore();
