<script lang="ts">
  import * as m from '../../paraglide/messages';
  import { tick, type Snippet } from 'svelte';
  import { getActiveId, listServers, type Server } from '../../lib/auth';
  import { parseConfig } from '../../lib/configRoute';
  import { isTimeoutError } from '@hangar/core';
  import { alcanceDoServidor, fraseDeEstado, pareamentoDoServidor, type EnderecoAlcance, type EstadoEndereco, type TipoEndereco } from '../../lib/alcance';
  import { copyText } from '../../lib/clipboard';

  // O alvo da config espelha a resolução do App (App.svelte): ?srv= explícito, senão o
  // ATIVO. O alvo também pode vir por PROP (o SettingsModal passa o resolvedServer): com o
  // seletor de servidor no painel (19/08/2026) a troca acontece SEM remontar a tela, então a
  // prop é o caminho reativo — e a resolução pela rota fica de fallback pra quem monta direto
  // (os testes).
  interface Props {
    alvo?: Server | null;
    // 'detalhe' = janela do servidor (endereços úteis + Avançado); 'parear' = janela do QR.
    parte?: 'tudo' | 'detalhe' | 'parear';
    avancado?: Snippet;
    /** Bloco que entra ENTRE os endereços e o Avançado (hoje: o reinício do serviço). */
    antesAvancado?: Snippet;
  }
  let { alvo = undefined, parte = 'tudo', avancado, antesAvancado }: Props = $props();

  function servidorAlvo(): Server | null {
    const r = parseConfig(location.hash);
    const porSrv = r?.srv ? listServers().find((s) => s.id === r.srv) ?? null : null;
    return porSrv ?? listServers().find((s) => s.id === getActiveId()) ?? null;
  }

  function servidorAtual(): Server | null {
    return alvo !== undefined ? alvo : servidorAlvo();
  }

  let carregando = $state(true);
  let erro = $state('');
  let loopback = $state(false);
  let bind = $state('');
  let enderecos = $state<EnderecoAlcance[]>([]);
  // Sinal de que a lista JÁ foi medida (resolveu ou falhou). É o que o bloco de
  // pareamento espera para poder concluir: enquanto em voo, `enderecos` é [] e
  // "lista vazia" e "lista ainda não chegou" seriam o mesmo valor (rodada 2).
  let listaMedida = $state(false);

  $effect(() => {
    const s = servidorAtual();
    if (!s) return;
    let vivo = true;
    carregando = true;
    listaMedida = false;
    // Troca de alvo com a tela MONTADA (seletor do grupo, 19/08): tudo que foi medido ou
    // revelado pro servidor anterior sai ANTES da nova medição — endereços e QR de outra
    // máquina com o seletor dizendo a nova seriam mentira (achado da revisão).
    enderecos = []; loopback = false; bind = ''; erro = '';
    parEstado = 'escondido'; parUrl = ''; parQr = ''; parErro = ''; parTipo = '';
    parGeracao++;   // mata pareamento em voo do alvo anterior
    alcanceDoServidor(s)
      .then((r) => {
        if (!vivo) return;
        loopback = r.loopback;
        bind = r.bind;
        enderecos = r.enderecos;
        erro = '';
        listaMedida = true;
      })
      .catch((e) => {
        if (!vivo) return;
        // Estado NOMEADO de falha; o detalhe é dado do servidor/rede (não vira chave).
        erro = `${m.falha_conexao()}: ${e instanceof Error ? e.message : m.erro_desconhecido()}`;
        listaMedida = true;
      })
      .finally(() => {
        if (vivo) carregando = false;
      });
    return () => {
      vivo = false;
    };
  });

  // Linhas que TODO servidor tem (rede local e público) pintam como "Testando…" enquanto a
  // resposta não chega — é o estado nomeado `testando`; as condicionais (nesta máquina,
  // Tailscale) nascem quando o backend responde.
  const LINHAS_EM_VOO: EnderecoAlcance[] = [
    { tipo: 'rede_local', url: '', estado: 'testando', tempo_ms: null },
    { tipo: 'publico', url: '', estado: 'testando', tempo_ms: null },
  ];

  // Farol e texto têm cores próprias por estado (mock estados 1 e 3): "não configurado"
  // NÃO usa a cor de erro — não estar configurado não é defeito, é neutro.
  const farolPorEstado: Record<EstadoEndereco, string> = {
    ok: 'ok', falhou: 'nao', testando: 'testando', nao_configurado: 'testando',
  };
  const glifoPorEstado: Record<EstadoEndereco, string> = {
    ok: '●', falhou: '●', testando: '◌', nao_configurado: '○',
  };
  const textoPorEstado: Record<EstadoEndereco, string> = {
    ok: 'ok', falhou: 'nao', testando: 'neutro', nao_configurado: 'neutro',
  };

  function nomeDoTipo(t: EnderecoAlcance['tipo']): string {
    switch (t) {
      case 'nesta_maquina': return m.acesso_nesta_maquina();
      case 'rede_local': return m.acesso_rede_local();
      case 'tailscale': return m.acesso_tailscale();
      case 'publico': return m.acesso_publico();
    }
  }

  // ── Pareamento (Task 6) ────────────────────────────────────────────────────────
  // Estado nomeado: `escondido` antes do toque; `carregando` enquanto a rota responde;
  // `revelado` com o par (url + qr_svg); `erro` quando a rota recusa; `sem_candidato`
  // quando nenhum endereço respondeu (aí não há o que revelar — bloqueador 2).
  let parEstado = $state<'escondido' | 'carregando' | 'revelado' | 'erro' | 'sem_candidato'>('escondido');
  let parUrl = $state('');
  let parQr = $state('');
  let parErro = $state('');
  // Vazio quando não há candidato: sem candidato não se chama a rota (bloqueador 2).
  let parTipo = $state<TipoEndereco | ''>('');
  let parGeracao = 0;

  // Endereços que podem ser EMBUTIDOS no QR: só os que responderam (estado ok) e não
  // são "nesta máquina" (o mock nunca mostra o QR apontando para 127.0.0.1 — de fora
  // ele não alcança; e o endereço de pareamento substitui o loopback pelo IP da LAN).
  let parCandidatos = $derived(
    enderecos.filter((e) => e.estado === 'ok' && e.tipo !== 'nesta_maquina'),
  );
  // Padrão: o candidato de MENOR tempo medido (empate → ordem da lista), não o primeiro
  // da ordem do backend — a frase "respondeu mais rápido" descreve a escolha AUTOMÁTICA,
  // e ela tem de ser verdade (bloqueador 3).
  let parPadrao = $derived<TipoEndereco | ''>(
    [...parCandidatos].sort((a, b) => (a.tempo_ms ?? 0) - (b.tempo_ms ?? 0))[0]?.tipo ?? '',
  );
  $effect(() => {
    const escolhidoValido = parCandidatos.some((e) => e.tipo === parTipo);
    if (!escolhidoValido && parCandidatos.length > 0) {
      // Troca o padrão (mais rápido) ou, na falta de escolha manual, o primeiro.
      const novo = parTipo === '' ? parPadrao : parCandidatos[0]!.tipo;
      parTipo = novo;
      // Se o QR já estava revelado, recarrega com o novo endereço — senão o seletor
      // diria um endereço e o QR mostraria outro (mesma família do bloqueador 3).
      if (parEstado === 'revelado') revelarPar();
    }
    // Sem candidato: estado nomeado, sem botão (bloqueador 2). Mas só depois de
    // MEDIR: enquanto a lista está em voo, `enderecos` é [] e "lista vazia" e
    // "lista ainda não chegou" seriam o mesmo valor — concluir agora é afirmar que
    // nada respondeu antes de testar (bloqueador da rodada 2). E lista que FALHOU
    // também não mediu endereço nenhum: quem não respondeu foi o servidor, não há
    // endereço a liberar (bloqueador da rodada 3).
    if (listaMedida && !erro) {
      parEstado = parCandidatos.length === 0 ? 'sem_candidato' : parEstado === 'sem_candidato' ? 'escondido' : parEstado;
    }
  });

  // Falha de transporte (teto estourado, fetch caído) não tem texto traduzível — mostra
  // só a frase da casa. Erro DA API já chega traduzido pelo errorDetail e pode aparecer
  // inteiro (bloqueador 4: "signal timed out" cru em inglês numa tela em português).
  function frasePorFalha(e: unknown): string {
    const cru = isTimeoutError(e) || e instanceof TypeError || !(e instanceof Error);
    return cru ? m.falha_conexao() : `${m.falha_conexao()}: ${e.message}`;
  }

  // Referências para o foco (bloqueador 5): revelar leva o foco ao seletor; esconder
  // devolve ao botão que abriu. Depois de `await tick()`, porque o nó de destino ainda
  // não existe no DOM no momento da transição.
  let parRef = $state<HTMLElement | null>(null);
  let mostrarRef = $state<HTMLButtonElement | null>(null);

  async function revelarPar() {
    const s = servidorAtual();
    if (!s || parTipo === '') return; // sem candidato não se chama a rota (bloqueador 2)
    parEstado = 'carregando';
    const geracao = ++parGeracao;
    try {
      const r = await pareamentoDoServidor(s, parTipo);
      if (geracao !== parGeracao) return; // uma troca de endereço veio no meio
      parUrl = r.url;
      parQr = r.qr_svg;
      parErro = '';
      parEstado = 'revelado';
      await tick();
      parRef?.focus(); // foco no primeiro controle do bloco revelado (bloqueador 5)
    } catch (e) {
      if (geracao !== parGeracao) return;
      // Estado NOMEADO de falha; o detalhe é dado do servidor/rede (não vira chave).
      parErro = frasePorFalha(e);
      parEstado = 'erro';
    }
  }

  async function trocarParTipo(tipo: TipoEndereco) {
    if (tipo === parTipo && parEstado === 'revelado') return;
    parTipo = tipo;
    if (parEstado === 'revelado' || parEstado === 'erro') {
      await revelarPar();
    }
  }

  async function esconderPar() {
    parEstado = 'escondido';
    parUrl = '';
    parQr = '';
    parErro = '';
    await tick();
    mostrarRef?.focus(); // devolve o foco ao botão que abriu (bloqueador 5)
  }

  // Copiar só faz sentido num endereço que RESPONDEU (o mock nunca mostra o botão
  // nas linhas falhou/testando/não-configurado, nem nesta máquina): endereço que
  // falhou não é pra copiar — é pra consertar.
  function mostraCopiar(e: EnderecoAlcance): boolean {
    return e.estado === 'ok' && e.tipo !== 'nesta_maquina';
  }

  // No detalhe, a mesma URL não aparece em duas linhas: com CP_PUBLIC_URL apontando para o nome
  // do Tailscale, "Tailscale" e "Endereço público" eram o mesmo endereço repetido.
  const urlTailscale = $derived(enderecos.find((e) => e.tipo === 'tailscale')?.url ?? '');
  const publicoIgual = $derived(!!urlTailscale && enderecos.some((e) => e.tipo === 'publico' && e.url === urlTailscale));
  const principal = (e: EnderecoAlcance) =>
    e.tipo === 'rede_local' || e.tipo === 'tailscale' || (e.tipo === 'publico' && !publicoIgual && e.estado !== 'nao_configurado');
  const principais = $derived(enderecos.filter(principal));
  const extras = $derived(enderecos.filter((e) => !principal(e) && !(e.tipo === 'publico' && publicoIgual)));

  // O veredito sai da MEDIÇÃO, nunca do bind. Escutar em loopback não quer dizer inalcançável:
  // com `tailscale serve` o proxy atende de fora e bate no 127.0.0.1 — e a tela mediu isso duas
  // linhas abaixo. Alarme só quando nada respondeu; caso contrário é nota, não defeito.
  // Com CP_PUBLIC_URL apontando pro nome do Tailscale, as duas linhas são o MESMO endereço: o
  // veredito tem de dizer "Tailscale", o nome do caminho, e não a variável que o repete.
  const deFora = $derived(
    [...enderecos.filter((e) => e.estado === 'ok'
      && (e.tipo === 'tailscale' || (e.tipo === 'publico' && !publicoIgual)))]
      .sort((a, b) => (a.tempo_ms ?? 0) - (b.tempo_ms ?? 0))[0] ?? null,
  );
  const naLan = $derived(enderecos.find((e) => e.tipo === 'rede_local' && e.estado === 'ok') ?? null);
  const isolada = $derived(listaMedida && !erro && !deFora && !naLan);
</script>

{#snippet linha(e: EnderecoAlcance)}
  {@const porOpcao = e.tipo === 'rede_local' && e.estado === 'falhou' && loopback}
  <li class="ac-linha">
    <span class="ac-farol {porOpcao ? 'testando' : farolPorEstado[e.estado]}" aria-hidden="true">{porOpcao ? '○' : glifoPorEstado[e.estado]}</span>
    <span class="ac-txt">
      <span class="ac-nome">{nomeDoTipo(e.tipo)}</span>
      <span class="ac-url">{e.estado === 'nao_configurado' ? m.acesso_nao_configurado() : e.url}</span>
      <span class="ac-estado {porOpcao ? 'neutro' : textoPorEstado[e.estado]}">{fraseDeEstado(e, loopback ? bind : '')}</span>
      {#if parte === 'detalhe' && e.tipo === 'tailscale' && publicoIgual}
        <span class="ac-estado neutro">{m.acesso_publico_igual()}</span>
      {/if}
    </span>
    {#if mostraCopiar(e)}
      <button class="ac-copiar" onclick={() => copyText(e.url)}>{m.acesso_copiar()}</button>
    {/if}
  </li>
{/snippet}

{#snippet veredito()}
  <div class="ac-veredito" class:ruim={isolada}>
    <p class="ac-ver-titulo">{m.acesso_veredito_titulo()}</p>
    {#if isolada}
      <p class="ac-ver-linha"><span class="ac-farol nao" aria-hidden="true">●</span>
        <span><b>{m.acesso_veredito_ninguem()}</b> {m.acesso_veredito_ninguem_porque({ endereco: bind })}</span></p>
      <p class="ac-ver-nota">{m.acesso_veredito_saida({ variavel: 'CP_LAN_BIND_IP', valor: 'auto' })}</p>
    {:else}
      <p class="ac-ver-linha"><span class="ac-farol {deFora ? 'ok' : 'neutro'}" aria-hidden="true">{deFora ? '●' : '○'}</span>
        <span>{#if deFora}<b>{m.acesso_veredito_fora_ok()}</b>
            {m.acesso_veredito_fora_como({ rede: nomeDoTipo(deFora.tipo), tempo: `${deFora.tempo_ms ?? 0} ms` })}
          {:else}<b>{m.acesso_veredito_fora_nao()}</b> {m.acesso_veredito_fora_nao_porque()}{/if}</span></p>
      <p class="ac-ver-linha"><span class="ac-farol {naLan ? 'ok' : 'neutro'}" aria-hidden="true">{naLan ? '●' : '○'}</span>
        <span>{#if naLan}<b>{m.acesso_veredito_lan_ok()}</b>
          {:else}<b>{m.acesso_veredito_lan_nao()}</b>
            {deFora ? m.acesso_veredito_lan_nao_ok({ rede: nomeDoTipo(deFora.tipo) }) : ''}{/if}</span></p>
      {#if !naLan && loopback}
        <p class="ac-ver-nota">{m.acesso_veredito_quer_lan({ variavel: 'CP_LAN_BIND_IP', valor: 'auto' })}</p>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet blocoPar()}
  {#if parEstado === 'sem_candidato'}
    <!-- Sem nenhum endereço que respondeu: estado NOMEADO, sem botão — não há o que
         revelar (bloqueador 2). A lista acima é onde se conserta. -->
    <div class="ac-oculto">
      <p>{m.acesso_par_sem_candidato()}</p>
    </div>
  {:else if parEstado === 'escondido'}
    <div class="ac-oculto">
      <p>{m.acesso_oculto_aviso()}</p>
      <button class="ac-btn primaria" bind:this={mostrarRef} onclick={() => revelarPar()} disabled={parTipo === ''}>{m.acesso_mostrar_codigo()}</button>
    </div>
  {:else}
    <div class="ac-par">
      {#if parEstado !== 'erro'}
        <!-- No erro o quadrado branco do QR não é desenhado (bloqueador 4: retângulo
             opaco de 176×176 com "Testando…" para sempre, sem saída). -->
        <div class="ac-qr" aria-hidden="true">
          {#if parQr}
            <!-- O QR é SVG pronto do backend (decisão de plano: o front só tem qr-scanner, que lê e não gera). -->
            {@html parQr}
          {:else}
            <span class="ac-qr-vazio">{m.acesso_testando()}</span>
          {/if}
        </div>
      {/if}
      <div class="ac-par-col">
        <div>
          <p class="ac-cod-rot">{m.acesso_codigo_rotulo()}</p>
          <div class="ac-cod">{parUrl}</div>
        </div>
        {#if parEstado === 'carregando'}
          <p class="ac-par-copy">{m.acesso_testando()}</p>
        {:else if parEstado === 'erro'}
          <p class="ac-par-copy aviso-erro" role="alert">{parErro}</p>
        {:else}
          <div class="ac-par-escolha">
            <label class="ac-par-label">
              <span class="ac-cod-rot">{m.acesso_selecionar_endereco()}</span>
              <select
                class="ac-select"
                bind:this={parRef}
                value={parTipo}
                onchange={(e) => trocarParTipo((e.currentTarget as HTMLSelectElement).value as TipoEndereco)}
              >
                {#each parCandidatos as c (c.tipo)}
                  <option value={c.tipo}>{nomeDoTipo(c.tipo)}</option>
                {/each}
              </select>
            </label>
            <!-- Fora do <label>: o nome acessível do seletor volta a ser só "Endereço
                 no QR", sem a frase de aviso inteira (bloqueador 5). -->
            <span class="ac-par-aviso">{m.acesso_par_trocar_aviso()}</span>
          </div>
          {#if parTipo !== '' && parTipo === parPadrao}
            <!-- Só quando a escolha é a AUTOMÁTICA (mais rápido): com escolha manual,
                 a frase "respondeu mais rápido" mentiria (bloqueador 3). -->
            <p class="ac-par-copy">{m.acesso_par_escolhido({ rede: nomeDoTipo(parTipo) })}</p>
          {/if}
        {/if}
        <!-- Esconder nos TRÊS estados revelados (carregando/erro/revelado): o erro não
             pode ser beco sem saída (bloqueador 4). Copiar endereço só no revelado. -->
        <div class="ac-acoes">
          {#if parEstado === 'revelado'}
            <button class="ac-btn" onclick={() => copyText(parUrl)}>{m.acesso_copiar_endereco()}</button>
          {/if}
          <button class="ac-btn" onclick={() => esconderPar()}>{m.acesso_esconder()}</button>
        </div>
      </div>
    </div>
  {/if}
{/snippet}

<div class="ac">
  {#if parte === 'parear'}
    <p class="ac-legenda">{m.acesso_legenda_qr()}</p>
    {@render blocoPar()}
  {:else if parte === 'detalhe'}
    {#if listaMedida && !erro}{@render veredito()}{/if}
    <p class="ac-secao">{m.acesso_secao_enderecos()}</p>
    <ul class="ac-cartao">
      {#if carregando}
        {#each LINHAS_EM_VOO as e (e.tipo)}
          {@render linha(e)}
        {/each}
      {:else if erro}
        <li class="ac-linha aviso-erro" role="alert">{erro}</li>
      {:else}
        {#each principais as e (e.tipo)}
          {@render linha(e)}
        {/each}
      {/if}
    </ul>
    <!-- Antes do Avançado de propósito: o que mora aqui (reiniciar o serviço) é ação, e abrir o
         Avançado empurrava ela pra fora da tela. -->
    {@render antesAvancado?.()}
    <details class="ac-avancado">
      <summary>{m.servidores_avancado()}</summary>
      {#if !carregando && !erro && extras.length}
        <ul class="ac-cartao">
          {#each extras as e (e.tipo)}
            {@render linha(e)}
          {/each}
        </ul>
      {/if}
      {#if !carregando && !erro && bind}
        <p class="ac-legenda">{m.acesso_escuta_em({ ip: bind })}</p>
      {/if}
      {@render avancado?.()}
    </details>
  {:else}
  {#if listaMedida && !erro}{@render veredito()}{/if}

  <p class="ac-secao">{m.acesso_secao_enderecos()}</p>
  <p class="ac-legenda">{m.acesso_legenda_enderecos()}</p>

  <ul class="ac-cartao">
    {#if carregando}
      {#each LINHAS_EM_VOO as e (e.tipo)}
        {@render linha(e)}
      {/each}
    {:else if erro}
      <li class="ac-linha aviso-erro" role="alert">{erro}</li>
    {:else}
      {#each enderecos as e (e.tipo)}
        {@render linha(e)}
      {/each}
    {/if}
  </ul>

  {#if !carregando && !erro && bind}
    <p class="ac-legenda">{m.acesso_escuta_em({ ip: bind })}</p>
  {/if}

  <hr class="ac-sep">

  <p class="ac-secao">{m.acesso_parear_titulo()}</p>
  <p class="ac-legenda">{m.acesso_legenda_qr()}</p>

  {@render blocoPar()}
  {/if}
</div>

<style>
  /* Envelope da tela inteira (precedente: ContasSettings .ct-superficie): é ELE que
     é contêiner de consulta — sem isto o @container (max-width:620px) lá embaixo
     não tinha ancestral container acima do bloco de pareamento (o .ac-cartao era o
     único container do arquivo, e o pareamento é irmão dele). */
  .ac {
    container-type: inline-size;
  }
  .ac-secao {
    margin: 0 0 var(--space-1) var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ac-avancado { margin-top: var(--space-3); }
  .ac-avancado summary {
    cursor: pointer; min-height: 44px; display: flex; align-items: center;
    padding: 0 var(--space-2); color: var(--text-secondary); font-size: var(--text-sm);
  }
  .ac-avancado summary::-webkit-details-marker { display: none; }
  .ac-avancado summary::before { content: '›'; width: 1.2em; color: var(--text-muted); }
  .ac-avancado[open] summary::before { content: '⌄'; }
  .ac-avancado[open] summary { margin-bottom: var(--space-2); }
  .ac-avancado .ac-legenda { margin-top: var(--space-2); }
  .ac-legenda {
    margin: 0 var(--space-2) var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.4;
  }
  .ac-cartao {
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .ac-linha {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3);
    min-height: 52px;
  }
  .ac-linha + .ac-linha {
    border-top: 1px solid var(--border-subtle);
  }
  .ac-linha.aviso-erro {
    background: transparent;
    color: var(--error);
    font-size: var(--text-sm);
  }
  .ac-farol {
    flex-shrink: 0;
    width: 1.4em;
    text-align: center;
    font-size: 15px;
    line-height: 1.5;
  }
  .ac-farol.ok { color: var(--success); }
  .ac-farol.nao { color: var(--error); }
  .ac-farol.testando { color: var(--text-muted); }
  .ac-txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .ac-nome { color: var(--text-primary); font-size: var(--text-sm); }
  .ac-url {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    word-break: break-all;
  }
  .ac-estado { font-size: var(--text-xs); line-height: 1.35; }
  .ac-estado.ok { color: var(--success); }
  .ac-estado.nao { color: var(--warning); }
  .ac-estado.neutro { color: var(--text-muted); }
  .ac-copiar {
    flex-shrink: 0;
    align-self: center;
    height: 30px;
    min-height: 0;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-family: inherit;
  }

  /* Separador entre a lista de endereços e o pareamento (mock estado 1) */
  .ac-sep {
    height: 1px;
    background: var(--border-subtle);
    margin: var(--space-4) 0 var(--space-3);
    border: 0;
  }

  /* Pareamento — QR + código lado a lado (mock estado 2) */
  .ac-par {
    display: grid;
    grid-template-columns: 176px 1fr;
    gap: var(--space-4);
    align-items: start;
    padding: var(--space-4);
    background: var(--surface-card);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .ac-qr {
    width: 176px;
    height: 176px;
    padding: 10px;
    border-radius: var(--radius-sm);
    background: #fff;
    box-sizing: border-box;
  }
  .ac-qr :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .ac-qr-vazio {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .ac-par-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  .ac-cod-rot {
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 var(--space-1);
  }
  .ac-cod {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    letter-spacing: 0.08em;
    color: var(--text-primary);
    background: var(--surface-inset);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    user-select: all;
    word-break: break-all;
  }
  .ac-par-copy {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  .ac-par-copy.aviso-erro {
    color: var(--error);
  }
  .ac-par-escolha {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .ac-par-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .ac-select {
    align-self: flex-start;
    max-width: 100%;
    height: 36px;
    min-height: 0;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
  }
  .ac-par-aviso {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  .ac-acoes {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .ac-btn {
    height: 36px;
    min-height: 0;
    padding: 0 var(--space-4);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: inherit;
  }
  .ac-btn.primaria {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .ac-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* Estado escondido: o QR atrás de um toque (mock estado 1) */
  .ac-oculto {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-4);
    background: var(--surface-card);
    border: 1px dashed var(--border-default);
    border-radius: var(--radius-md);
    text-align: center;
  }
  .ac-oculto p {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    max-width: 40ch;
    line-height: 1.45;
  }
  /* O veredito é a âncora da tela: única superfície com fundo aqui dentro, para o olho cair
     na conclusão antes da lista de endereços que a sustenta. */
  .ac-veredito {
    margin: 0 0 var(--space-3);
    padding: var(--space-3);
    background: var(--fill-subtle);
    border-left: 3px solid var(--success);
    border-radius: var(--radius-md);
  }
  .ac-veredito.ruim { border-left-color: var(--error); }
  .ac-ver-titulo {
    margin: 0 0 var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ac-ver-linha {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .ac-ver-linha:last-child { margin-bottom: 0; }
  .ac-ver-linha b { color: var(--text-primary); font-weight: 600; }
  .ac-ver-nota {
    margin: var(--space-2) 0 0;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-subtle);
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }

  /* Alvo de toque no celular: o botao declara min-height:0, que anula a regra global
     `button { min-height: 44px }` do app.css:546 — sem isto ele fica 30px na folha
     estreita. Mesmo padrao da aba Contas (ContasSettings.svelte). */
  @container (max-width: 620px) {
    .ac-copiar { height: 44px; min-height: 44px; }
    /* Pareamento: no celular o QR empilha (mock não desenha, mas a régua de alvo de
       toque vale — botão de 36px fica abaixo de 44px na folha estreita). */
    .ac-par { grid-template-columns: 1fr; }
    .ac-qr { justify-self: center; }
    .ac-select, .ac-btn { height: 44px; min-height: 44px; }
  }
</style>