<script lang="ts">
  import type { Server } from '../../lib/auth';
  import { getComputerControl, saveComputerControl, listComputerControlModels,
    type ComputerControlState } from '../../lib/credenciais';
  import EscopoChip from './EscopoChip.svelte';
  import * as m from '../../paraglide/messages';

  let { apiTarget }: { apiTarget: Server | null } = $props();

  let current = $state<ComputerControlState | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let savedMessage = $state('');

  let enabled = $state(false);
  let projectDir = $state('');
  let agentConfig = $state('');
  let preset = $state<'cliproxy' | 'custom'>('cliproxy');
  let url = $state('');
  let model = $state('');
  let effort = $state('');
  let newLlmKey = $state('');
  let newJevKey = $state('');
  let models = $state<string[]>([]);
  let loadingModels = $state(false);
  let modelsError = $state('');

  const fileName = (p: string) => p.split('/').pop() ?? p;

  function fill(s: ComputerControlState) {
    current = s;
    enabled = s.enabled;
    projectDir = s.project_dir;
    agentConfig = s.agent_config;
    preset = s.llm_url === s.cliproxy.preset_url ? 'cliproxy' : 'custom';
    url = s.llm_url;
    model = s.llm_model;
    effort = s.llm_effort;
    newLlmKey = '';
    newJevKey = '';
  }

  async function load() {
    const target = apiTarget;
    loading = true;
    error = '';
    try {
      const s = await getComputerControl(target);
      if (target === apiTarget) fill(s);
    } catch (e) {
      if (target === apiTarget) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (target === apiTarget) loading = false;
    }
  }
  $effect(() => { void apiTarget; void load(); });

  async function loadModels() {
    if (!current) return;
    loadingModels = true;
    modelsError = '';
    try {
      const r = await listComputerControlModels(apiTarget, preset === 'cliproxy'
        ? { llm_url: current.cliproxy.preset_url, use_cliproxy_key: true }
        : { llm_url: url, llm_key: newLlmKey || null, use_saved_key: !newLlmKey });
      models = r.models;
      if (!r.models.length) modelsError = m.computer_control_models_empty();
    } catch (e) {
      modelsError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingModels = false;
    }
  }

  async function save(ev: SubmitEvent) {
    ev.preventDefault();
    if (!current || saving) return;
    saving = true;
    error = '';
    savedMessage = '';
    try {
      const s = await saveComputerControl(apiTarget, {
        enabled,
        project_dir: projectDir.trim(),
        agent_config: agentConfig,
        llm_url: preset === 'cliproxy' ? current.cliproxy.preset_url : url.trim(),
        llm_model: model.trim(),
        llm_effort: effort,
        llm_key: preset === 'custom' ? (newLlmKey || null) : null,
        jev_key: newJevKey || null,
        use_cliproxy_key: preset === 'cliproxy',
      });
      fill(s);
      savedMessage = s.enabled
        ? m.computer_control_saved_on({ n: String(s.files.filter((f) => f.enabled).length) })
        : m.computer_control_saved_off();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="cc">
  <p class="cc-title">{m.computer_control_title()} <EscopoChip escopo="servidor" /></p>
  <p>{m.computer_control_what()}</p>
  <ol class="cc-steps">
    <li>{m.computer_control_step_tree()}</li>
    <li>{m.computer_control_step_jev()}</li>
    <li>{m.computer_control_step_llm()}</li>
    <li>{m.computer_control_step_repeat()}</li>
  </ol>

  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if loading}
    <p role="status">{m.comum_carregando()}</p>
  {:else if !current}
    <button type="button" class="action" onclick={load}>{m.lista_tentar_novamente()}</button>
  {:else}
    <!-- Sem isto o gerenciador de senhas do navegador enfia e-mail na pasta e senha salva na chave. -->
    <form onsubmit={save} autocomplete="off">
      <label class="check">
        <input type="checkbox" bind:checked={enabled} disabled={saving} />
        <span>{m.computer_control_enable()}</span>
      </label>
      <p class="hint">{m.computer_control_enable_hint()}</p>

      <label for="cc-dir">{m.computer_control_dir()}</label>
      <input id="cc-dir" name="cc-dir" autocomplete="off" bind:value={projectDir} disabled={saving || !enabled} spellcheck="false" />

      <label for="cc-agent">{m.computer_control_target()}</label>
      {#if current.agent_configs.length}
        <select id="cc-agent" bind:value={agentConfig} disabled={saving || !enabled}>
          {#each current.agent_configs as c (c)}<option value={c}>{fileName(c)}</option>{/each}
        </select>
      {:else}
        <input id="cc-agent" name="cc-agent" autocomplete="off" bind:value={agentConfig} disabled={saving || !enabled} spellcheck="false" />
      {/if}
      <p class="hint">{m.computer_control_target_hint()}</p>

      <label for="cc-jev">{m.computer_control_jev_key()}</label>
      <p class="hint">
        {current.jev_key_set
          ? (current.jev_key_from_settings
            ? m.computer_control_key_from_settings({ tail: current.jev_key_tail })
            : m.computer_control_key_saved({ tail: current.jev_key_tail }))
          : m.computer_control_key_missing()}
      </p>
      <input id="cc-jev" name="cc-jev" type="password" bind:value={newJevKey} placeholder={m.computer_control_replace_key()}
             autocomplete="new-password" disabled={saving || !enabled} />

      <p class="cc-title cc-sub">{m.computer_control_llm()}</p>
      <p class="hint">{m.computer_control_llm_hint()}</p>
      <div class="presets" role="radiogroup" aria-label={m.computer_control_llm()}>
        <button type="button" role="radio" aria-checked={preset === 'cliproxy'} class:on={preset === 'cliproxy'}
                disabled={saving || !enabled} onclick={() => { preset = 'cliproxy'; models = []; }}>{m.computer_control_preset_cliproxy()}</button>
        <button type="button" role="radio" aria-checked={preset === 'custom'} class:on={preset === 'custom'}
                disabled={saving || !enabled} onclick={() => { preset = 'custom'; models = []; }}>{m.computer_control_preset_custom()}</button>
      </div>

      {#if preset === 'cliproxy'}
        <p class="hint">{current.cliproxy.has_keys ? m.computer_control_cliproxy_key_ok() : m.computer_control_cliproxy_no_key()}</p>
        <details class="help">
          <summary>{m.computer_control_cliproxy_how()}</summary>
          <ol>
            <li>{m.computer_control_cliproxy_step_service()}</li>
            <li>{m.computer_control_cliproxy_step_panel()} <a href="http://127.0.0.1:8317/management.html" target="_blank" rel="noreferrer">http://127.0.0.1:8317/management.html</a></li>
            <li>{m.computer_control_cliproxy_step_key()}</li>
          </ol>
        </details>
      {:else}
        <label for="cc-url">{m.computer_control_url()}</label>
        <input id="cc-url" name="cc-url" autocomplete="off" bind:value={url} placeholder="https://…/v1/chat/completions" disabled={saving || !enabled} spellcheck="false" />
        <label for="cc-llm-key">{m.computer_control_llm_key()}</label>
        {#if current.llm_key_set && !current.cliproxy.key_is_cliproxy}
          <p class="hint">{m.computer_control_key_saved({ tail: current.llm_key_tail })}</p>
        {/if}
        <input id="cc-llm-key" name="cc-llm-key" type="password" bind:value={newLlmKey} placeholder={m.computer_control_replace_key()}
               autocomplete="new-password" disabled={saving || !enabled} />
      {/if}

      <label for="cc-model">{m.computer_control_model()}</label>
      <div class="row">
        <input id="cc-model" name="cc-model" autocomplete="off" list="cc-models" bind:value={model} disabled={saving || !enabled} spellcheck="false" />
        <button type="button" onclick={loadModels} disabled={loadingModels || saving || !enabled} aria-busy={loadingModels}>
          {loadingModels ? m.computer_control_listing() : m.computer_control_list_models()}
        </button>
      </div>
      <datalist id="cc-models">{#each models as id (id)}<option value={id}></option>{/each}</datalist>
      {#if modelsError}<p class="err" role="alert">{modelsError}</p>
      {:else if models.length}<p class="hint">{m.computer_control_models_found({ n: String(models.length) })}</p>{/if}

      <label for="cc-effort">{m.computer_control_effort()}</label>
      <select id="cc-effort" bind:value={effort} disabled={saving || !enabled}>
        <option value="">{m.computer_control_effort_default()}</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>

      <button class="action primary" type="submit" disabled={saving} aria-busy={saving}>
        {saving ? m.computer_control_saving() : m.computer_control_save()}
      </button>
      {#if savedMessage}<p class="status" role="status">{savedMessage}</p>{/if}
    </form>

    <p class="hint">{m.computer_control_where({ n: String(current.files.length) })}</p>
  {/if}
</div>

<style>
  .cc { display: flex; flex-direction: column; gap: var(--space-3); container-type: inline-size; }
  p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
  .cc-title {
    display: flex; align-items: center; gap: var(--space-2);
    color: var(--text-muted); font-size: var(--label-size); font-weight: var(--label-weight);
    text-transform: uppercase; letter-spacing: var(--label-tracking);
  }
  .cc-sub { margin-top: var(--space-4); }
  .cc-steps, .help ol { margin: 0; padding-left: var(--space-5); color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }
  .hint { color: var(--text-muted); font-size: var(--text-xs); }
  .err { color: var(--error); }
  .status { color: var(--text-primary); font-weight: 600; }
  form { display: flex; flex-direction: column; gap: var(--space-2); }
  label { margin-top: var(--space-2); color: var(--text-primary); font-size: var(--text-sm); }
  .check { display: flex; align-items: center; gap: var(--space-2); margin-top: 0; font-weight: 600; }
  input:not([type='checkbox']), select {
    width: 100%; box-sizing: border-box; padding: var(--space-3); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); background: var(--surface-inset); color: var(--text-primary); font: inherit;
  }
  input:disabled, select:disabled { opacity: .6; }
  .row { display: flex; gap: var(--space-2); }
  .row input { flex: 1; min-width: 0; }
  button, .action {
    padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
    background: var(--surface-raised); color: var(--text-primary); font: inherit; font-size: var(--text-sm); cursor: pointer;
  }
  .action { align-self: flex-start; margin-top: var(--space-3); }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .6; cursor: default; }
  .presets { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .presets .on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .help summary { cursor: pointer; color: var(--text-secondary); font-size: var(--text-sm); }
  .help ol { margin-top: var(--space-2); }
  a { color: var(--accent); overflow-wrap: anywhere; }
  input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @container (max-width: 420px) { .row { flex-direction: column; } }
</style>
