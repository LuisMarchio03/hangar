<script lang="ts">
  // Editor da fileira de atalhos configurável (decisões da sessão de grilling de 2026-09-21):
  // lista ordenada única (nativos + customizados), subir/descer, remover, formulário de
  // adicionar/editar com ícone curado ou emoji, e "restaurar padrão" que apaga o override.
  // O estado salvo mora no servidor (runtime_config.shortcuts) via lib/shortcuts.svelte.ts.
  import * as m from '../../paraglide/messages';
  import {
    defaultShortcuts, getCommands, getSessions,
    type Shortcut, type ShortcutInternalAction, type ShortcutSendText, type ShortcutShell,
  } from '@hangar/core';
  import { carregarShortcuts, shortcutsDe, salvarShortcuts } from '../../lib/shortcuts.svelte';
  import ShortcutIcon, { GLIFOS } from '../icons/ShortcutIcon.svelte';
  import type { Server } from '../../lib/auth';

  interface Props {
    apiTarget: Server | null;
  }
  let { apiTarget }: Props = $props();
  const serverId = $derived(apiTarget?.id ?? null);

  let lista = $state<Shortcut[]>([]);
  let carregando = $state(true);
  let erroCarregar = $state(false);
  let salvando = $state(false);
  let salvo = $state(false);
  let erroSalvar = $state('');
  let sujo = $state(false);

  async function carregar() {
    carregando = true;
    erroCarregar = false;
    try {
      await carregarShortcuts(serverId);
      lista = shortcutsDe(serverId).map((s) => ({ ...s }));
      sujo = false;
    } catch {
      erroCarregar = true;
    } finally {
      carregando = false;
    }
  }
  $effect(() => { serverId; void carregar(); });

  async function salvar() {
    if (salvando) return;
    salvando = true;
    erroSalvar = '';
    try {
      await salvarShortcuts(lista, serverId);
      sujo = false;
      salvo = true;
      setTimeout(() => (salvo = false), 2500);
    } catch (e) {
      // Erro de validação do backend chega como veio ("shortcuts: item 2 …").
      erroSalvar = e instanceof Error ? e.message : String(e);
    } finally {
      salvando = false;
    }
  }

  async function restaurar() {
    if (salvando) return;
    salvando = true;
    erroSalvar = '';
    try {
      await salvarShortcuts(null, serverId);
      lista = defaultShortcuts();
      sujo = false;
    } catch (e) {
      erroSalvar = e instanceof Error ? e.message : String(e);
    } finally {
      salvando = false;
    }
  }

  // ── Lista ───────────────────────────────────────────────────────────────────
  const INTERNO_ROTULO: Record<ShortcutInternalAction, () => string> = {
    terminal: m.ctx_terminal,
    modo: m.atalhos_interno_modo,
    navegador: m.ctx_navegador,
    anexos: m.ctx_anexos,
    rodar: m.ctx_rodar,
  };
  const INTERNO_GLIFO: Record<ShortcutInternalAction, string> = {
    terminal: 'glifo:terminal', modo: 'glifo:git', navegador: 'glifo:globo',
    anexos: 'glifo:pasta', rodar: 'glifo:play',
  };
  const nativosAusentes = $derived(
    (Object.keys(INTERNO_ROTULO) as ShortcutInternalAction[]).filter(
      (a) => !lista.some((s) => s.type === 'internal' && s.action === a)));

  function mover(i: number, delta: -1 | 1) {
    const j = i + delta;
    if (j < 0 || j >= lista.length) return;
    const nova = [...lista];
    [nova[i], nova[j]] = [nova[j], nova[i]];
    lista = nova;
    sujo = true;
  }

  // ── Arrastar pra reordenar. HTML5 DnD não responde ao toque em tablet (regra do repo), então
  // os botões ↑/↓ ficam — são a alternativa exigida pela WCAG 2.2 SC 2.5.7, não redundância. ──
  let dragIdx = $state<number | null>(null);
  function dragStart(e: DragEvent, i: number) {
    dragIdx = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    }
  }
  function dragOver(e: DragEvent, i: number) {
    e.preventDefault();       // sem isto o drop é recusado e o arrasto "volta"
    if (dragIdx === null || dragIdx === i) return;
    const nova = [...lista];
    const [item] = nova.splice(dragIdx, 1);
    nova.splice(i, 0, item);
    lista = nova;
    dragIdx = i;
    sujo = true;
  }
  function dragEnd() { dragIdx = null; }
  function remover(i: number) {
    lista = lista.filter((_, k) => k !== i);
    sujo = true;
  }
  function reporNativo(a: ShortcutInternalAction) {
    lista = [...lista, { id: a, type: 'internal', action: a }];
    sujo = true;
  }

  // ── Formulário (adicionar/editar customizado) ───────────────────────────────
  let formAberto = $state(false);
  let editando = $state<number | null>(null);   // índice na lista; null = novo
  let fTipo = $state<'send_text' | 'shell'>('send_text');
  let fRotulo = $state('');
  let fGlifo = $state('raio');
  let fEmoji = $state('');
  let fConteudo = $state('');
  let fSendDirect = $state(true);
  let fConfirm = $state(false);

  function abrirNovo() {
    editando = null;
    fTipo = 'send_text'; fRotulo = ''; fGlifo = 'raio'; fEmoji = '';
    fConteudo = ''; fSendDirect = true; fConfirm = false;
    formAberto = true;
  }
  function abrirEdicao(i: number) {
    const s = lista[i];
    if (s.type === 'internal') return;
    editando = i;
    fTipo = s.type;
    fRotulo = s.label;
    fConteudo = s.type === 'shell' ? s.command : s.text;
    fSendDirect = s.type === 'send_text' ? s.send_direct !== false : true;
    fConfirm = s.confirm === true;
    if (s.icon?.startsWith('emoji:')) { fEmoji = s.icon.slice(6); fGlifo = 'raio'; }
    else { fEmoji = ''; fGlifo = s.icon?.startsWith('glifo:') ? s.icon.slice(6) : 'raio'; }
    formAberto = true;
  }
  const formValido = $derived(!!fRotulo.trim() && !!fConteudo.trim());
  function confirmarForm() {
    if (!formValido) return;
    const icon = fEmoji.trim() ? `emoji:${fEmoji.trim()}` : `glifo:${fGlifo}`;
    const base = { label: fRotulo.trim(), icon, ...(fConfirm ? { confirm: true } : {}) };
    const novo: ShortcutSendText | ShortcutShell = fTipo === 'shell'
      ? { id: idDoForm(), type: 'shell', command: fConteudo.trim(), ...base }
      : { id: idDoForm(), type: 'send_text', text: fConteudo.trim(),
          ...(fSendDirect ? {} : { send_direct: false }), ...base };
    if (editando === null) lista = [...lista, novo];
    else lista = lista.map((s, i) => (i === editando ? novo : s));
    sujo = true;
    formAberto = false;
  }
  function idDoForm(): string {
    if (editando !== null) return lista[editando].id;
    return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── Sugestão de skill (datalist): comandos de uma sessão viva do servidor ativo. Sem sessão,
  // o campo fica livre — a sugestão é conforto, não requisito. ─────────────────────────────────
  let sugestoes = $state<string[]>([]);
  $effect(() => {
    if (!formAberto || fTipo !== 'send_text' || sugestoes.length) return;
    void (async () => {
      try {
        const sessoes = await getSessions();
        const viva = sessoes.find((s) => s.state !== 'dead');
        if (!viva) return;
        const cmds = await getCommands(viva.name);
        sugestoes = cmds.map((c) => c.display ?? `/${c.name}`);
      } catch { /* sem sugestão, campo livre */ }
    })();
  });
</script>

<div class="at">
  <p class="sub">{m.atalhos_sub()}</p>

  {#if carregando}
    <p class="estado">{m.comum_carregando()}</p>
  {:else if erroCarregar}
    <p class="estado erro">{m.atalhos_erro_carregar()}</p>
    <button class="btn" onclick={() => void carregar()}>{m.config_server_tentar_de_novo()}</button>
  {:else}
    {#if lista.length === 0}
      <p class="estado">{m.atalhos_vazio()}</p>
    {/if}
    <ul class="linhas">
      {#each lista as s, i (s.id)}
        <li class="linha" class:arrastando={dragIdx === i} draggable="true"
            ondragstart={(e) => dragStart(e, i)} ondragover={(e) => dragOver(e, i)}
            ondragend={dragEnd}>
          <span class="alca" aria-hidden="true">⠿</span>
          <span class="ico"><ShortcutIcon icon={s.type === 'internal' ? INTERNO_GLIFO[s.action] : s.icon} /></span>
          <span class="txt">
            <span class="rotulo">{s.type === 'internal' ? INTERNO_ROTULO[s.action]() : s.label}</span>
            {#if s.type !== 'internal'}
              <span class="detalhe">{s.type === 'shell' ? s.command : s.text}</span>
            {/if}
          </span>
          <span class="acoes">
            {#if s.type !== 'internal'}
              <button class="mini" onclick={() => abrirEdicao(i)} aria-label={m.atalhos_editar()}>✎</button>
            {/if}
            <button class="mini" onclick={() => mover(i, -1)} disabled={i === 0} aria-label={m.atalhos_subir()}>↑</button>
            <button class="mini" onclick={() => mover(i, 1)} disabled={i === lista.length - 1} aria-label={m.atalhos_descer()}>↓</button>
            <button class="mini" onclick={() => remover(i)} aria-label={m.atalhos_remover()}>✕</button>
          </span>
        </li>
      {/each}
    </ul>

    {#if nativosAusentes.length}
      <div class="repor">
        <span>{m.atalhos_repor()}</span>
        {#each nativosAusentes as a (a)}
          <button class="chip" onclick={() => reporNativo(a)}>+ {INTERNO_ROTULO[a]()}</button>
        {/each}
      </div>
    {/if}

    {#if formAberto}
      <div class="form">
        <label class="campo">
          <span>{m.atalhos_tipo()}</span>
          <select bind:value={fTipo} disabled={editando !== null}>
            <option value="send_text">{m.atalhos_tipo_send()}</option>
            <option value="shell">{m.atalhos_tipo_shell()}</option>
          </select>
        </label>
        <label class="campo">
          <span>{m.atalhos_rotulo()}</span>
          <input type="text" bind:value={fRotulo} maxlength="24" />
        </label>
        <div class="campo">
          <span>{m.atalhos_icone()}</span>
          <div class="glifos" role="radiogroup" aria-label={m.atalhos_icone()}>
            {#each Object.keys(GLIFOS) as g (g)}
              <button type="button" class="glifo" class:sel={!fEmoji.trim() && fGlifo === g}
                      role="radio" aria-checked={!fEmoji.trim() && fGlifo === g} aria-label={g}
                      onclick={() => { fGlifo = g; fEmoji = ''; }}>
                <ShortcutIcon icon={`glifo:${g}`} />
              </button>
            {/each}
            <input class="emoji" type="text" bind:value={fEmoji} maxlength="4"
                   placeholder={m.atalhos_emoji_dica()} aria-label={m.atalhos_emoji_dica()} />
          </div>
        </div>
        <label class="campo">
          <span>{fTipo === 'shell' ? m.atalhos_comando() : m.atalhos_texto()}</span>
          <input type="text" bind:value={fConteudo} list={fTipo === 'send_text' ? 'atalho-skills' : undefined}
                 placeholder={fTipo === 'shell' ? m.atalhos_comando_dica() : m.atalhos_texto_dica()} />
          {#if fTipo === 'send_text'}
            <datalist id="atalho-skills">
              {#each sugestoes as sk (sk)}<option value={sk}></option>{/each}
            </datalist>
          {/if}
        </label>
        {#if fTipo === 'send_text'}
          <label class="liga">
            <input type="checkbox" bind:checked={fSendDirect} />
            <span>{m.atalhos_send_direct()}</span>
            <small>{m.atalhos_send_direct_ajuda()}</small>
          </label>
        {/if}
        <label class="liga">
          <input type="checkbox" bind:checked={fConfirm} />
          <span>{m.atalhos_confirm()}</span>
        </label>
        <div class="form-acoes">
          <button class="btn" onclick={() => (formAberto = false)}>{m.comum_cancelar()}</button>
          <button class="btn primario" onclick={confirmarForm} disabled={!formValido}>{m.comum_confirmar()}</button>
        </div>
      </div>
    {:else}
      <button class="btn" onclick={abrirNovo}>{m.atalhos_add()}</button>
    {/if}

    <div class="rodape">
      <button class="btn" onclick={() => void restaurar()} disabled={salvando}
              title={m.atalhos_restaurar_ajuda()}>{m.atalhos_restaurar()}</button>
      <span class="feedback">
        {#if erroSalvar}<span class="erro">{erroSalvar}</span>
        {:else if salvo}{m.atalhos_salvo()}{/if}
      </span>
      <button class="btn primario" onclick={() => void salvar()} disabled={!sujo || salvando}>
        {m.atalhos_salvar()}
      </button>
    </div>
  {/if}
</div>

<style>
  /* Container query, não media query: quem aperta a linha é a largura do PAINEL (regra do repo). */
  .at { container-type: inline-size; display: flex; flex-direction: column; gap: var(--space-3); }
  .sub { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .estado { margin: 0; font-size: var(--text-sm); color: var(--text-muted); }
  .erro { color: var(--danger, #e5484d); }

  .linhas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .linha {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-2); border-radius: var(--radius-md);
    background: var(--surface-inset);
  }
  .linha.arrastando { opacity: 0.45; }
  .alca { flex-shrink: 0; color: var(--text-muted); cursor: grab; font-size: var(--text-sm); user-select: none; }
  .ico {
    width: 32px; height: 32px; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm); background: var(--surface-raised);
    color: var(--text-secondary);
  }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .rotulo { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); }
  .detalhe {
    font-size: var(--text-xs); color: var(--text-muted); font-family: var(--font-mono);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acoes { display: flex; gap: 2px; flex-shrink: 0; }
  .mini {
    min-width: 30px; min-height: 30px; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-secondary); font-size: var(--text-sm);
  }
  .mini:hover { background: var(--surface-raised); color: var(--text-primary); }
  .mini:disabled { opacity: 0.35; }

  .repor { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); }
  .chip {
    font-size: var(--text-xs); padding: 3px 10px; border-radius: var(--radius-full);
    background: var(--surface-raised); color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }
  .chip:hover { color: var(--text-primary); }

  .form {
    display: flex; flex-direction: column; gap: var(--space-3);
    padding: var(--space-3); border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle); background: var(--surface-inset);
  }
  .campo { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-sm); color: var(--text-secondary); }
  .campo input[type='text'], .campo select {
    padding: 8px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); background: var(--surface-raised);
    color: var(--text-primary); font-size: var(--text-sm);
  }
  .glifos { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }
  .glifo {
    width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary);
  }
  .glifo:hover { background: var(--surface-raised); }
  .glifo.sel { background: var(--accent-dim); color: var(--accent); }
  .emoji { width: 96px; padding: 6px 8px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); background: var(--surface-raised);
    color: var(--text-primary); font-size: var(--text-sm); }
  .liga { display: grid; grid-template-columns: auto 1fr; gap: 2px var(--space-2); align-items: center; font-size: var(--text-sm); color: var(--text-primary); }
  .liga small { grid-column: 2; color: var(--text-muted); font-size: var(--text-xs); }
  .form-acoes { display: flex; justify-content: flex-end; gap: var(--space-2); }

  .btn {
    align-self: flex-start;
    padding: 7px 14px; border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 600;
    background: var(--surface-raised); color: var(--text-primary);
    border: 1px solid var(--border-subtle);
  }
  .btn:hover { background: var(--bg-hover); }
  .btn:disabled { opacity: 0.45; }
  .btn.primario { background: var(--accent); color: #fff; border-color: transparent; }

  .rodape { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
  .feedback { flex: 1; text-align: right; font-size: var(--text-xs); color: var(--success, #30a46c); }
  .feedback .erro { color: var(--danger, #e5484d); }

  @container (max-width: 480px) {
    .acoes { flex-direction: column; }
    .rodape { flex-wrap: wrap; }
  }
</style>
