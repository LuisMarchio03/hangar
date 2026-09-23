# Frontend — telas, CSS, i18n, terminal embutido

Decisões medidas, com data e número. O `CLAUDE.md` carrega a regra;
a medição que a sustenta mora aqui. Conteúdo movido sem alteração.

## Planejamento no chat (07/09/2026)

`SessionModeControl` é o controle compartilhado de
  Claude e Codex. Ele ocupa a linha inferior do compositor; quando os controles e seus rótulos
  não cabem, passa para a primeira linha existente, sem acrescentar uma faixa vertical. A medida
  considera o texto cortado pelo flex do celular, para não esconder o modelo só para acomodar o modo.
  Shift+Tab percorre todos os modos disponíveis no Claude, como Alt+Shift+P; no Codex,
  alterna Normal e Planejar. O monitor reaproveita a captura do pane para publicar o modo e lembrar
  o último modo fora do planejamento por identidade de sessão. Sondas e trocas controladas
  não deixam seus modos intermediários contaminarem essa memória.
  Pedidos `item/tool/requestUserInput` do Codex têm identidade própria: JSON-RPC distingue
  pedido de resposta pela presença de `method`, mesmo quando os IDs coincidem. O cliente
  guarda pendências independentemente do SSE; `serverRequest/resolved` e o fim do turno
  retiram a pergunta de todos os clientes. Fechar o formulário não responde ao servidor.
  A confirmação de um `proposed_plan` é uma ação local da TUI, não um pedido JSON-RPC:
  implementar muda para Normal e envia o pedido de implementação. Tags em linhas próprias
  são retiradas da apresentação, preservando exemplos dentro de cercas de código.
  O plano nativo do Claude usa `/plan-preview`, separado de `planprog`: escritas confirmadas
  pela sessão identificam o arquivo. Um `slug` isolado não prova que existe plano, pois o
  Claude também o grava em conversas comuns. A prévia busca o conteúdo atualizado ao abrir;
  visualizar não aprova execução.

## Duas interfaces, não uma: o front web (`frontend/`, Svelte) e o app nativo (`mobile/`, Expo).


  Mudança de comportamento tem que passar pelas DUAS, e a pergunta certa não é "qual arquivo eu
  edito", é "de onde essa lógica vem". Quem responde é `packages/core`: 90 arquivos do app nativo
  importam dele, sempre pelo barrel `@hangar/core`, e o front web também — foi pra lá que os 46
  arquivos de `frontend/src/lib` migraram. Daí a regra prática:
  - **Lógica (chamada de API, formatação, parser de transcript, tipos) entra no `core`** e serve as
    duas de uma vez. É onde o esforço rende, e é onde um teste cobre as duas.
  - **Tela é por interface, sem exceção**: `.svelte` no front web, `.tsx` no app nativo. Não há
    componente compartilhado e não vai haver — Svelte e React Native não renderizam a mesma coisa.
    Feature nova de tela é escrita duas vezes, de propósito.
  - **A verificação é `npm run check` (ou `npm run test`) NA RAIZ, e ela cobre as três** — core,
    front web e app nativo. Não era assim: cada uma tinha o seu comando, nenhum cobria o outro, e
    quem mexesse no core e rodasse só o `check` do frontend levava verde com o app quebrado. O app
    entra por `scripts/verificar-app.mjs` — não por não ser workspace (ele é), e sim porque o
    `npm ci` do CI, do deploy e dos instaladores é **seletivo** e não instala as dependências dele.
    A regra desse script é a que dá sentido a tudo: **dependência do app ausente FALHA com código 1
    e diz o que fazer**, nunca é pulada em silêncio — um check que passa por não ter olhado é pior
    que um que não roda. Complementos: um hook em `.claude/settings.json`
    (versionado, vale para quem clonar) avisa ao editar `packages/core`, e o CI segue compilando só
    front e backend, por decisão — o build do app é no Expo.
  - **Texto de interface é um `project.inlang` só, compilado três vezes** (`frontend/src/paraglide`,
    `packages/core/src/paraglide`, `mobile/src/paraglide`, todos gerados e gitignored). Chave nova
    nasce nos dois `messages/*.json` da raiz e já vale para as duas interfaces; o que muda é só quem
    a compila.
  Dentro do front web, a divisão continua sendo esta:

## Two views: mobile & desktop (820px breakpoint).

`App.svelte` switches on
  `matchMedia('(min-width: 820px)')`: desktop → `DesktopShell` (which uses `Sidebar.svelte`), mobile →
  `SessionList.svelte`. Lots of UI has a per-view path (the session list is the clearest — `Sidebar` vs
  `SessionList`; sheets also re-dock as a right-side panel via `@media (min-width: 820px)`). Whenever you
  touch the front, make the change in BOTH views and verify BOTH — they drift apart easily (e.g. the
  session-list ordering ended up alphabetical only in `SessionList`, not `Sidebar`).
  - **The multi-server SSE aggregation lives in ONE place now** — `lib/sessions.ts` (pure dedup/order/
    classify helpers, unit-tested) + `lib/sessionsStore.svelte.ts` (a refcounted singleton: one
    `openSessionsStream` per *server* for the whole app, `retain`/`release` by consumer). `Sidebar`,
    `SessionList`, `Board` and `Canvas` all subscribe to it — the old `slots`/`recompute`/`connect` trio
    copied in three files is gone (top item of the polish-backlog structural debt, resolved 2026-07-17).
    The **two-views drift warning still stands**, though: `Sidebar` and `SessionList` are still separate
    files, so template/CSS changes to the list must be made and verified in BOTH. See
    [`docs/polish-backlog.md`](docs/polish-backlog.md#structural-debt-in-the-session-list-2026-07-16) —
    unifying the two list views is the remaining "bigger fish", deliberately not done yet.
  - **A LÓGICA da lista também mora num lugar só** — `lib/sessionListModel.svelte.ts`
    (`createSessionListModel({ variant })`): agrupar/colapsar/filtrar, seleção+broadcast+comparar,
    abrir/excluir/renomear/retomar/Git. `Sidebar` e `SessionList` instanciam o modelo com a
    sua variante e só mantêm o chrome próprio (rail/pin/kebab/hover/menu no desktop; drawer/feed/
    scroll no celular). O que diverge entre as views está na tabela `RULES` no topo do arquivo, uma
    regra por linha (como a preferência gravada é lida, modo efetivo de agrupamento, ordem dos
    grupos por servidor, rótulo que o filtro casa, ordem no Comparar, restaurar o servidor ativo
    depois da ação) — convergir é trocar um valor ali, de propósito. Lógica nova da lista entra no modelo, com teste nas DUAS variantes;
    template e CSS continuam por view, e o aviso de "mudar e verificar nas DUAS" vale para eles.
    Loop segue no `SessionList` — só o celular abre pela lista; dar Loop ao desktop seria feature.

## i18n: todo texto de interface vem de `m.<chave>()`

(Paraglide, `frontend/src/paraglide/` gerado;
  `pt.json` + `en.json` em `frontend/messages/`). A trava em `src/lib/i18nGuard.test.ts` falha o teste
  quando um arquivo passa do seu número na linha de base `frontend/i18n-baseline.json` — e a linha de
  base **só desce**: arquivo novo tem limite zero, e texto novo em arquivo existente quebra o CI.
  Falso positivo do extrator (heurística ~89%) vai pro `i18n-allow.json`, nunca pra linha de base.
  Chave nova primeiro procura no `pt.json` (reuso antes de duplicar), e `pt.json`/`en.json` andam
  juntos no mesmo commit — chave que falta num deles aparece como ID cru na tela sem erro nenhum.
  Dado do servidor (nome de sessão, caminho, mensagem do agente, saída de comando) **não** vira chave.
  O idioma segue o sistema por padrão e troca em Configurações → Geral (a tela recarrega — as
  mensagens são funções compiladas, não valores reativos); o seletor guarda em `PARAGLIDE_LOCALE`.
  Texto que o **backend** manda pra tela (erros, descrições de built-ins) chega como chave/código e é
  traduzido no front — exceção: frontmatter de skills e conteúdo de chat são dados, não interface.
  Rótulo de stub/fixture de teste que vive em árvore varrida pela trava é identificador
  (`abrir-term`), nunca frase: numa orquestração de setembro/2026 um stub escrito como frase disparou
  a trava e tentou uma exceção global no `i18n-allow.json`; renomeado pra identificador, o extrator
  voltou vazio e o build real mostrou que ele não vaza pro produto. A regra saiu da skill
  `orquestrar` (é deste repo, não do fluxo) e mora aqui.

## iOS black-rectangle repaint.

Glass on NavBar/Composer lives in a `::before` leaf with a near-opaque
  solid bg and **no** `backdrop-filter` / `transform` / `translateZ` on WebKit — those promote a layer that
  renders pure black during momentum scroll. Don't reintroduce them. Liquid-glass blur is Chromium-only
  (`html[data-liquid]`).

## Transparência é padrão do app, não enfeite de uma tela.

O app tem papel de parede
  (`html[data-bg="image"]`) e um slider **Transparência** que move `--cp-panel-alpha`
  (`lib/background.ts`, `aplicarScrim`). Todo painel de vidro — `BottomSheet`, `ModalDialog`,
  `Sidebar`, `DesktopSessionContext` — já anda com esse slider via `--glass-panel`. Quem quebra é
  **superfície DENTRO do painel**: um `background: var(--bg-elevated)` ou `var(--bg-base)` cru não
  acompanha o véu, e o controle vira retângulo chapado boiando sobre a foto enquanto o painel atrás
  dele é translúcido. Ao escrever CSS de qualquer componente, nesta ordem:
  1. **`transparent`** — o certo por padrão. Quem carrega o material é o contêiner; a textarea do
     `Composer.svelte` é o precedente (`background: transparent` por cima do vidro).
  2. Precisa mesmo de superfície própria (campo de texto, chip, menu flutuante, bloco de saída)?
     Use os tokens de `app.css`: **`--surface-raised`** (chip, botão pequeno, menu) e
     **`--surface-inset`** (campo de texto, área de entrada). Sem papel de parede eles são
     exatamente `--bg-elevated`/`--bg-base`; com papel de parede entram no mesmo véu sozinhos.
  3. `--bg-elevated`/`--bg-base` crus só para **realce de estado** (`:hover`, `.sel`, linha atual),
     que é tinta por cima da linha, não superfície.
  Quanto as caixas ficam mais opacas que o painel **não é constante no CSS**: é o slider *Solidez
  das caixas* (Aparência → Fundo, ao lado de Transparência), que escreve `--cp-surface-alpha`
  (`lib/background.ts`). O ponto certo depende da foto de quem usa — se um valor desses te parecer
  errado no código, o lugar dele é um controle, não um número fixo.
  Verificação: ligue um papel de parede e olhe a tela. Qualquer retângulo que não deixe a foto
  atravessar, enquanto o painel em volta deixa, é bug — não estilo.

## Config e opção moram em MODAL, não em painel docado.

Decisão de desenho de 2026-07-30, vale
  daqui pra frente. No desktop, a **única** coisa que fica docada à direita do chat é o
  `DesktopSessionContext` — o painel de contexto **daquela sessão** (estado, plano, grupo, repo).
  Ele é dado do que está aberto na tela, então acompanha a conversa. Todo o resto — Aparência,
  Configurações do servidor, Motores, Git, e o que for adicionado — abre como **modal centrado**:
  `BottomSheet` com `wide={isDesktop} centered={isDesktop}` (o mesmo par que o próprio
  `SettingsModal.svelte` usa; no celular continua folha subindo de baixo).
  O porquê é medido, não gosto: no dock de ~530px, rótulo + descrição à esquerda e um segmentado à
  direita brigam pela linha, e como o rótulo tem `min-width: 0` ele cede tudo — a descrição quebrava
  em **uma palavra por linha**. Tela de configuração é rótulo-e-controle repetido dezenas de vezes;
  ela precisa de largura, e largura é o que o dock não tem.
  Ao mexer em qualquer tela dessas, use **container query** (`container-type: inline-size` no
  wrapper + `@container`), nunca media query: quem aperta a linha é a largura do PAINEL, não a da
  janela — num monitor de 1440px o dock tem 530px e uma media query de 560px nunca dispara ali.
  **Config e opção num modal único — implementado (2026-08-16).** A direção acordada de juntar as
  configs num só modal (antes marcada "ainda não implementada") existe: `SettingsModal.svelte` abre
  todas as telas num `BottomSheet` de navegação por seções (Aplicativo · Servidor) com as linhas de
  `LINHAS` — hoje Geral, Aparência, Diário, Sobre (aplicativo) e Máquinas, Contas e modelos,
  Harnesses, Voz, Notificações, Anexos, Avançado, Orquestração (servidor). Quem for adicionar aba: registra no `LINHAS` do `SettingsModal.svelte` e no
  `lib/configRoute.ts` (`TelaConfig`/`TELAS_DE_SERVIDOR`), com chave de idioma nos dois
  `messages/*.json` no mesmo commit. O `lib/gitTabs.ts` + `GitTabs.svelte` continuam sendo o
  precedente de navegação por abas DENTRO de uma tela (incluindo nível por aba no celular).
  Servidores e Acesso viraram **Máquinas** (2026-09-04); as rotas antigas seguem por
  `RENOMEADAS`. Dentro de Máquinas as duas listas — a do navegador (`cp_servers`, este aparelho
  acompanha) e a do servidor (`peers.json`, os servidores se falam) — são **uma linha por máquina,
  casada pelo identificador** (`lib/maquinas.ts`, `unirMaquinas`), com duas caixas. O identificador
  da outra máquina vem dela mesma (`GET /api/peers/identificador` com o token que o navegador
  guarda); nada no navegador o persiste. Casar pela URL viraria duas linhas (IP da LAN no celular,
  Tailscale no servidor). O interruptor nunca muda sozinho: `checked` é o dado, o `onchange` repõe
  o dado e chama a ação, e a ação confirmada é quem muda a lista.

## Bloco rolável dentro da conversa é `position: relative`, ou o `.sr-only` dele vaza pra lista


  (`EditDiff.svelte`, 10/09/2026). Sintoma relatado por dois usuários e nunca reproduzido à mão:
  "espaço vazio no fim do chat que rola sem acabar", às vezes, em sessão trabalhando — e, pior, a
  partir daí mensagem nova não entrava (chegava no terminal, não no app); sair e voltar resolvia.
  Causa, medida por CDP na janela do app no momento do bug: o diff de um Write de 68 linhas tem um
  `<pre>` de 2284px dentro do `.ed-split` de 46vh com `overflow: hidden`; cada linha carrega um
  `<span class="sr-only">` (`position: absolute`, `app.css`), e absoluto só é cortado pelo overflow
  do seu **bloco de contenção** — o `.ed-split` era `static`, então o bloco de contenção ficava
  fora dele e os 200 spans das linhas escondidas contavam na área rolável da CONVERSA:
  `scrollHeight` = base do último `sr-only`, 1464px além do fim do `.messages-inner`, com todos
  os filhos visíveis e de altura normal. A segunda metade do sintoma é consequência: com o fim
  nunca alcançável, `atBottom` (folga < 64px) ficava falso, a janela de eventos congelava e o
  chat parava de mostrar o que chegava. Prova: `position: relative` aplicado ao vivo no
  `.ed-split` da janela do usuário zerou a sobra; reverter trouxe de volta. O mesmo vale pra
  qualquer bloco com overflow próprio que abrigue um `.sr-only` (o `.ed-uni` levou junto). A
  sonda `chat.vazio_no_fim` (`MessageList.svelte`) fica: é o que apontou o elemento.

## The message list is windowed.

`MessageList.svelte` mounts only the last `WINDOW=120` events; scroll-to-top
  reveals older pages (in-memory, no backend call). Don't render the whole transcript at once.

## Queue/pending dedup.

Messages sent while Claude is `working` echo as `pending` / `queued-` bubbles and
  reconcile against the real transcript by normalized text/line. Touch `Chat.svelte` dedup carefully.

## The phone app renders `AskUserQuestion` natively.

The `ask_question` SSE event opens the
  `AskQuestionSheet` stepper; since the pending payload isn't in the jsonl, a PreToolUse hook
  (`askq_capture.py`, installed idempotently by `hook_installer.py`) captures it into a sidecar. Verified
  live: use AskUserQuestion freely, it shows as the stepper. Numbered plain text is only a fallback for a
  session where that capture hook isn't installed. Raw TUI option pickers (not the tool) surface separately
  via `OptionButtons` (selection sent by `terminal_input.py`), so free composer text does not answer a picker.

## Vite HMR servindo componente VAZIO (stub de ~800 bytes).

Medido 2× em 2026-08-04 (vite 8.1.0 +
  vite-plugin-svelte 7.1.2 + svelte 5.56.4): depois de editar um `.svelte` com a página aberta, o dev
  server passa a servir o módulo transformado como um stub sem template (`function X(...) { ...; return
  $.pop(...) }` e mais nada) — o componente monta ZERO nós, SEM erro no console e SEM overlay do Vite.
  Sintoma na UI: a tela/componente some (ex: o chat inteiro vira papel de parede; cliques em cards não
  fazem nada porque a rota nunca monta). O `svelte-check` passa — o arquivo está bom, quem corrompeu é o
  cache de transform do dev server, e ele vale pra TODOS os clientes (não é por-browser). Diagnóstico:
  `fetch('/src/<modulo>')` na página — stub tem <1KB e não contém o markup. Remédio: `systemctl --user
  restart hangar-frontend.service` + reload ignorando cache. Verificação pós-edição de front
  SEMPRE inclui abrir a tela afetada e conferir que ela montou (não só o `check`/`vitest`).

## Markdown NUNCA aparece cru.

Todo conteúdo `.md` exibido no app passa por `lib/markdown.ts`
  (`renderMarkdown`) com tipografia própria — contrato do par (`PairSheet`), prompt/transcript de
  subagente (`ActivitySheet`), plano, README, qualquer arquivo lido do disco. Um `<pre>` com
  `**Tarefa:**` e `##` à mostra é sempre bug, não estilo. Vale também pro que vem de fora do
  transcript: se o texto é markdown, renderize.

## CSS animations.

Shared tokens/keyframes live in `app.css` (`--ease-out`, `--spring`, …); a global
  `prefers-reduced-motion` rule neutralizes loops, so new keyframes don't each need their own guard.
  **Animação de `transform` NUNCA em `<svg>`, `<g>` ou `<path>` — só em elemento HTML** (medido
  05/09/2026, `icons/HangarWorking.svelte`, Chrome 150 no Electron 43). O indicador de "trabalhando"
  girava `<path>`s dentro do SVG: o Chromium não compõe isso na GPU, e cada quadro refazia style +
  layout + paint da PÁGINA INTEIRA — 144 layouts e 576 paints em 3 s numa página com 3 sessões
  trabalhando. Custo real: os dois renderers visíveis do app desktop a ~96% de CPU cada e o
  gpu-process a 139%, por horas, com o JS ocioso (o profiler mostrava 85% em `(program)`). Pausar só
  essas animações via CDP levou os renderers a 0–11%. Três armadilhas no conserto, todas medidas:
  (1) mover a animação pra RAIZ do `<svg>` tirou layout e paint, mas o compositor ainda recusou
  (`compositeFailed=1024`, `kTransformRelatedPropertyCannotBeAcceleratedOnTarget`) — num Chrome
  headless avulso a mesma raiz compunha, dentro do app não; quem compõe de verdade é um `<span>` em
  volta do svg; (2) a propriedade `rotate` (individual, usada pra compor com `transform` no mesmo
  elemento) também não compõe — compor é aninhar spans, um por transformação; (3) nome de
  `@keyframes` passado por `var()` a partir do markup não recebe o escopo do Svelte (só o nome
  escrito na folha é reescrito) — a espiral final ficou meses sem rodar por isso, calada; escolher
  por `:nth-child` no CSS. Diagnóstico reutilizável: CDP na 9223 com `Tracing`
  (`disabled-by-default-devtools.timeline`) contando `Layout`/`Paint`/`UpdateLayoutTree` por 3 s —
  composto é ~3 eventos, não-composto é um por quadro; e `blink.animations` traz o
  `compositeFailed` de cada animação ao (re)iniciar. Depois do conserto: 3 eventos em 3 s e os
  renderers a ~9%.

## Real terminal in the desktop footer

(`app/termsock.py` + `components/TerminalPanel.svelte`,
  plus `tmux.new_hidden_shell` and the native-terminal launcher in `api.py`): one PTY per WebSocket
  running `tmux attach`, consumed by xterm.js. The backend interprets **nothing** here — no ANSI, no
  state, no scraping; it's a pipe, same choice as `adapters/codex`. Seven invariants, all measured
  on this machine (tmux 3.7b) while replacing the old `capture-pane` mirror:
  - **A tmux target needs the colon, and it fails DIFFERENTLY per command.** `={name}` is exact
    session match; `={name}:` is exact session, active window. Without the `:`, `list-panes -s -t =0`
    for a numeric name with no such session returns rc=0 **and the panes of the attached session**
    (a numeric name reads as a *window index*), `display -p '#{window_width}'` comes back **empty**,
    and `set-option -t "=alvo"` answers **"no such session" with the session alive**. `has-session`
    is the deliberate exception (it resolves sessions only, never a pane/window). Rule: every
    pane/window/option target carries `=` **and** `:`; the same operation never gets two spellings
    (the native-terminal `attach` was aligned to the termsock one in the final review).
  - **`attach` targets the SESSION, never the pane.** `attach -t %N` moves the active window/pane
    for **every** client attached to that session — opening the browser panel would drag the owner's
    native `tmux attach` to the agent's pane. `_pane_target` (send-keys/capture-pane) is the opposite
    case on purpose.
  - **One panel per session** (`termsock._ativos`, keyed by name). Two clients with
    `window-size=latest` fight over the size on every frame; the second connection tears the first
    down and the first one's socket is **closed** (a silently frozen terminal is worse than a
    visible disconnect).
  - **xterm's theme takes `rgba(0, 0, 0, 0)`, never the string `'transparent'`** — xterm 6.0.0's
    color parser only matches hex/`rgb()`/`rgba()`, the keyword throws inside `ThemeService`, which
    **swallows** it and falls back to opaque `#000000` over the panel's `--surface-inset`. Nothing
    in the console; you just lose the wallpaper behind a black rectangle.
  - **The hidden shell is a tmux user option (`@cp_hidden`), not a name convention.** The `+` tab
    creates a SEPARATE session `term-<name>` so the panel and the user's native terminal stop
    fighting over which window is in front; it is filtered out of the three views by the **mark**,
    read straight from tmux (`is_hidden`), because "missing from `registry.list()`" also happens to
    a real Codex session of the same name. The mark rides the shared `list-panes -a -F` as a 6th
    field, and that parse is **defensive** (5 fields or more): a multiplexer that doesn't
    interpolate a user option must cost you the *mark*, never the whole session list, which feeds
    the three views, `list_with_state`, `_pane_info` and `_cwd_has_siblings`. Only the psmux probe
    (`scripts/test-psmux.py`, section 4b) can tell you the command is *refused*, which no parse
    survives — keep it in sync with the format.
  - **`term-<name>` is keyed by NAME, so the name has to be kept in sync by hand.** Two different
    paths, don't mix them up:
    - *Orphan from another repo* — the shell outlives an agent session killed outside the app, and a
      later session that reuses the name would reattach the OLD repo's shell under the new label: a
      command typed in the wrong directory. `new_hidden_shell` compares `#{session_path}` (the birth
      directory — measured that a `cd` inside the pane moves `pane_current_path` and **not** this
      one) and kills+recreates on divergence. If that kill **fails**, it returns `None` (→ 500)
      instead of handing back the old-directory shell.
    - *Rename* — `registry.rename` **renames** `term-<old>` → `term-<new>`. A rename touches neither
      the cwd nor what is running in the pane, so there is no wrong-directory risk here; killing
      would silently take down whatever was running in the Shell tab (a `npm run dev`) with nothing
      but a `_log.debug`. The kill is only the **fallback** for when `term-<new>` is already taken —
      leaving the old one alive brings back the orphan this exists to prevent. Both paths gate on
      the `@cp_hidden` mark (`is_hidden`, exact `={name}:` target), so a third party's `term-<name>`
      is never renamed or killed.
  - **POSIX-only imports (`pty`, `fcntl`, `termios`) live INSIDE the functions.** `termsock` is
    imported by the 409 guard that also runs on Windows; a top-level `import fcntl` there is a
    `ModuleNotFoundError` that breaks a feature which works today. The rule is symmetric now that
    there are two engines: `asyncio.windows_utils` (which pulls `_winapi`/`msvcrt`) is imported
    inside `_pipe_handle` for the same reason, and `app/conpty.py` guards its `ctypes.wintypes`
    import on `sys.platform` — `wintypes` does not import at all on Linux. A gate that turns the
    *panel* off never protects an import — or a format string — on a shared path.
  - **The panel runs on Windows too, and it is TWO ENGINES, not one** (`app/conpty.py` +
    `termsock._motor_windows`, 22/08/2026). `terminal_panel` in `/api/config` is
    `termsock.painel_disponivel()` — a **capability** ("can a panel open here?"), never
    `os.name == "posix"`, which is what it used to say. POSIX is `pty.fork()` + `add_reader`;
    Windows is a ConPTY via ctypes whose pipes are fed to the Proactor's
    `connect_read_pipe`/`connect_write_pipe` — no thread, no queue, because
    `pause_reading()`/`resume_reading()` on `_ProactorReadPipeTransport` is a one-for-one
    replacement for `remove_reader`/`add_reader`. The shared front door (auth, Origin, session
    exists, cols/rows clamp) stays in ONE place; only the engine forks. Four things measured that
    bite whoever touches this:
    (1) **`STARTF_USESTDHANDLES` with all three handles NULL is mandatory** — without it
    `CreateProcess` propagates the *parent's* std handles, so in a service (stdout → log file) the
    child writes to the log and the pseudoconsole renders a **blank screen**, while `mode con`
    inside the child already reports the right size. Clearing `HANDLE_FLAG_INHERIT` does **not**
    fix it. Microsoft's own sample omits the flag and "works" only because its parent is a console
    app whose std handles are already console handles;
    (2) the ConPTY **input** pipe needs `duplex=True` — `_ProactorWritePipeTransport` fires a
    16-byte `ReadFile` on the write end just to detect closure, and `GENERIC_WRITE` alone returns
    WinError 5;
    (3) kill the child **before** `ClosePseudoConsole` (it can hang, microsoft/terminal#17716) —
    which is also the only safe teardown psmux allows;
    (4) there is **no size-restore step** on Windows, deliberately: psmux's window size follows
    whichever client is attached (the next client at 80x24 makes it 80x23 by itself), and
    `resize-window`/`setw window-size latest` both return rc=0 and do nothing there.
    `pywinpty` was tried and **removed**: it ships its own `conpty.dll`/`OpenConsole.exe` instead
    of using the system ConPTY, so it exposes no handle for asyncio; it also returns `str` from
    `read()` and opens a **listening** socket per session.
  While the panel is attached the window is at ITS size (~120x20), so anything that counts lines in
  the pane (option picker, AskUserQuestion stepper, `model_picker`) would read a truncated screen:
  `/select`, `/answer` and friends answer **409**, and the phone UI must **show that text** — the
  refusal explains the way out ("close the panel"), and a `catch` that only logs turns a tap into
  nothing at all.

## O mesmo terminal no CELULAR

(`components/TerminalMobile.svelte`, aberto pelo botão Terminal do
  `Chat` quando `desktop` é falso): mesmo PTY, mesmo socket, mesma montagem do xterm — o que é
  compartilhado mora em `lib/xterm.ts` (`novoTerminal`/`temaDe`, onde vivem o fundo
  `rgba(0, 0, 0, 0)` e a fonte lida por `getComputedStyle`), e não em uma segunda cópia. O
  `TerminalMirror` (capture-pane a cada 450ms, texto cru) **continua existindo**: é o caminho quando
  `somente_leitura.terminal_panel` é falso — hoje isso não é mais "Windows", que ganhou motor de
  ConPTY em 22/08/2026, e sim qualquer máquina sem motor nenhum —, e o Chat escolhe pela config do
  servidor — otimista em `true` enquanto ela não chega, senão o primeiro toque cairia no espelho por
  causa de um fetch em voo. Três decisões medidas em 21/08/2026:
  - **A entrada são BYTES CRUS, não os nomes de tecla do `/term-input`.** Do outro lado está o
    `tmux attach`, que parseia a entrada como um terminal de verdade e reemite pro programa no modo
    que ELE espera (inclusive cursor-keys em modo aplicação): `\x1b[A` é exatamente o que a seta
    física manda. Texto e Enter saem no MESMO `send` (`valor + '\r'`) — dois envios abrem janela pra
    a TUI processar a linha antes do texto inteiro chegar.
  - **A fonte é o controle de COLUNAS, não só de legibilidade**, porque o tmux redimensiona a janela
    pro tamanho deste cliente enquanto ele estiver anexado (medido: 68x53 com o celular aberto,
    200x50 de volta ao fechar). Por isso trocar a fonte **não** remonta o terminal: muda
    `options.fontSize`, refaz o `fit()` e manda `resize` — remontar fecharia o socket e repintaria a
    TUI a cada toque em A+.
  - **O `Origin` do WebSocket precisa ser declarado quando o front vem de OUTRA máquina**
    (`CP_TERM_ORIGINS`, csv). O PWA carregado da VPS manda a Origin da VPS, que não é mesma-origem,
    não é a `public_url` e não está no `peers.json` — o handshake voltava **403** e a tela dizia só
    "desconectado". Vazio (o default) **não** pode virar "aceita qualquer um": o handshake também
    autentica pelo cookie `cp_token`, então origem arbitrária seria qualquer site abrindo um
    terminal na máquina.

## Fechar `x` e criar outra `x`: a chave do Chat e a marca de exclusão eram só o NOME

(10/09/2026).
No desktop o `Chat` remonta por `{#key serverId::nome}`; com o mesmo nome a chave não muda, o
componente da morta segue montado com a conversa antiga e estado `dead` (sem reconectar), e o que
o usuário via era a conversa do Claude enquanto o Codex de mesmo nome subia — o backend serviu o
transcript certo em todas as aberturas do dia (medido no log). Hoje `sessionsStore.epoca()` sobe
quando um nome some dos `slots` e volta (`epocasDeRecriacao`, no core), e as duas `{#key}` do
`DesktopShell` a incluem. Segundo furo do mesmo nome: `markDeleting` escondia `serverId::nome` até
a lista vir SEM ele; recriada antes disso, a nova ficava escondida pra sempre (a varredura via um
`x` na lista e mantinha a marca). A marca agora guarda o `jsonl` da excluída, e `sweepHidden` só a
mantém pra sessão com o mesmo nome E mesmo jsonl. Vale nas duas interfaces (store do front e
`mobile/src/stores/sessions.ts`). O cache de cauda do chat (`chat-cauda`, TanStack) já era por
jsonl e não entrou nisso. Não reproduzido de ponta a ponta pelo navegador embutido: o item
"Fechar" do menu de contexto não aceitou o clique sintético.

## Aba ativa do navegador embutido é UMA só, compartilhada entre painel e CLI

(14/09/2026).
O navegador da sessão ganhou abas (até 8). A alternativa era cada lado ter o seu foco — a pessoa
numa aba, o agente noutra —, e ela quebra o que o preview existe pra fazer: o print que o agente
lê deixaria de ser a tela que a pessoa está olhando, e "vê como ficou" viraria duas telas
diferentes discutindo a mesma. Então a ativa é única: clicar numa aba no painel muda onde os
próximos comandos do CLI caem. Para o caso legítimo de mexer numa página sem tirar a outra da
frente existe `--aba <id>`, que age na aba escondida sem trocar a ativa — o print dela custa 2-3 s
a mais, porque o Electron precisa render a view que não está composta na tela.

O sidecar `~/.hangar/nav/<chave>.json` é **aditivo** pelo mesmo motivo prático: `url` e `targetId`
no topo continuam sendo os da aba ativa, e `ativa`/`abas` entram ao lado. Três leitores dependem do
topo — `backend/app/navsock.py` (espelho do celular e teclado remoto, que resolve a sessão por
`sc.get("targetId")`), `backend/app/navshell.py` e o `GET /api/sessions/{name}/navegador` que o
front usa pra saber se a sessão tem navegador. Mover qualquer um desses campos para dentro de
`abas` quebraria os três de uma vez, e a suíte do backend passando **sem mudança** é a prova de que
não quebrou.

## O clique do preview some depois que a aba escondida navega

18/09/2026, Linux/Hyprland, painel fora da tela, página local escrita para o caso. Com um ouvinte
de clique em fase de captura no `document`, o gatilho é **navegação de documento**, e não a página
nem a geometria:

- `open clinica.html` do zero, `click @e9` repetido → **15 de 15 entregues**.
- `eval 'location.reload()'` e repetir o mesmo `click` → **0 de 8**, sempre respondendo `ok`.

No estado quebrado, descartados por medição: **coordenada e elemento coberto** (`innerWidth` 1280,
`innerHeight` 800, `scrollY` 0, `getBoundingClientRect` certo e `document.elementFromPoint` no
centro calculado devolvendo o próprio botão); **página congelada** (um `setInterval` seguia
contando); **canal** (`Input.dispatchMouseEvent` por CDP cru em
`ws://127.0.0.1:9223/devtools/page/<id>`, nas mesmas coordenadas, entregou **zero** eventos — o que
desmente a leitura anterior, de que o CDP externo entregava e o `webContents.debugger` não).

O que sobra é o **quadro**. No mesmo estado:

- `press a` → keydown **não** chega; `hover @e9` → mousemove **chega**. Só o evento discreto morre.
- `Runtime.evaluate` esperando dois `requestAnimationFrame` **pendura**. Não há quadro sendo
  produzido — o view escondido não compõe, e depois de navegar não volta a compor sozinho.
- `Page.captureScreenshot` (o `shot`) devolve clique e tecla na hora.
- `Emulation.setDeviceMetricsOverride` com o **mesmo** 1280×800 não muda nada; com **1280×801**,
  devolve. É a mudança de medida — surface nova — que reancora, não a reemissão do comando.

Daí a forma do conserto, em `shell/preview_ctl.cjs`: o gancho `aoNavegar` reaplicava a emulação com
a medida idêntica, que é justo a que não reancora; agora ele pede `medir()` com a altura vizinha
antes da real, e só ali (`definirOculto` e `layout` já trocam a medida por conta própria). E o
`click`/`press` deixou de responder `ok` sem conferir: arma um ouvinte em captura antes de
disparar, lê o marcador depois, reancora e tenta **uma** vez, e só então responde `erro:`. Marcador
sumido conta como entregue — é documento novo, ou seja o evento navegou a página.

**A sonda do clique escuta `pointerdown` E `mousedown`, nessa ordem, e não só o segundo.** Um
`preventDefault()` no `pointerdown` SUPRIME o `mousedown` de compatibilidade, e é exatamente o que
todo combobox do Radix faz. Com a sonda só em `mousedown`, um clique que CHEGOU era lido como não
entregue, e a retentativa disparava um segundo `pointerdown` que alternava o componente de volta ao
estado inicial — resposta `erro:` numa tela que não mudou, a mesma classe de falha que a sonda veio
eliminar. Medido numa página feita para o caso, com contador por tipo em captura: um `click` dava
`pointerdown: 2`, `pointerup: 2`, `click: 2`, **`mousedown` ausente**, `aria-expanded` de volta em
`false`. O `pointerdown` a página não consegue suprimir; por isso ele é o primeiro da lista.

**Por que parecia depender da página:** não dependia. `open` numa aba que já existe é `loadURL`, ou
seja navegação. Abrindo `fluxo.html` e depois `clinica.html` na mesma aba, quem falha é a segunda;
invertendo a ordem, falha a outra. O mesmo no site real: o primeiro clique num link da barra
lateral navega, e da navegação em diante nada mais chega — a URL parece presa.

**Antes de concluir que uma página não reage, confirme com um ouvinte em captura**
(`document.addEventListener('click', …, true)`) que o evento chega. Um teste inteiro já foi
conduzido sobre cliques que nunca chegaram.

Não bate com [a entrada do Windows](windows.md#o-navegador-embutido-funciona-no-windows--com-a-sessão-gráfica-ativa),
que mediu a janela **ocluída**: lá a sessão gráfica é que não existe; aqui a aba tem sessão e só
não tem quadro.

## Navegar uma aba CONGELADA derruba a sessão do depurador

18/09/2026. `a aba escondida nao descongelou; tente de novo` é o `economia()` do `preview_ctl`
falhando, e o `shell.log` diz por quê: `[nav] aba nao foi para active: Not attached to an active
page`, quatro vezes (o laço de retentativa). Depois disso todo verbo é recusado até `close` +
`open`, e o alvo na 9223 fica com `url: ""`.

A causa é o **congelamento**. A aba escondida e ociosa vai para `frozen`, e navegar um documento
congelado o descarta junto com o `DevToolsAgentHost` — o `webContents.debugger` fica sem página.
Medido, com o mesmo par de páginas e o mesmo `open` numa aba que já existe:

- navegações emendadas, sem ociosidade entre elas: **0 falhas em 16** (a aba nem chega a congelar);
- com 6 s de ociosidade antes de cada `open`: **6 falhas em 16**.

Por isso o `preview_ctl` ganhou a janela `navegando(true/false)`: enquanto há carga em voo, a aba
escondida fica acordada, custe o que custar em GPU — é segundo, não minuto. O `main` abre a janela
**antes** do `loadURL` que ele mesmo dispara (aí a aba está congelada desde o último verbo, e o
`did-start-loading` chegaria tarde) e a fecha no `did-stop-loading`, que também cobre a navegação
que um clique causou.

No mesmo caminho havia um segundo jeito de emular em cima da troca de página: `hangar:nav-open`
chamava `trocarAba` → `avisarOculto` → `definirOculto` → `setDeviceMetricsOverride` logo depois do
`loadURL`, e o guarda só recusava `about:blank`/URL vazia — logo depois do `loadURL` o `getURL()`
ainda devolve a URL **antiga**. O guarda agora conta navegação em voo (`isLoadingMainFrame()`) e
espera `did-stop-loading`; `did-finish-load` não serve porque carga que **falha** não o emite, e a
aba escondida ficaria sem medida nenhuma.

## Arrastar sessão sobre sessão pra formar o grupo de trabalho (18/09/2026)

Gesto nas quatro superfícies — Sidebar, Board, Canvas, lista do celular —, regra pura em
`packages/core/src/pairDrop.ts` (`canPair`/`canLeave`), estado compartilhado em
`frontend/src/lib/arrastarGrupo.svelte.ts` e um único `GrupoDropDialog.svelte` montado no
`App.svelte`.

- **Soltar não pareia direto: abre diálogo de confirmação.** `join_group` (`backend/app/pair.py`)
  funde os grupos INTEIROS dos dois lados — não só origem e alvo, os pares de cada um também — e
  escreve o texto do protocolo na conversa de cada membro resultante; não existe desfazer. Sair do
  grupo confirma pelo mesmo motivo: o backend avisa quem saiu e quem ficou (`api.py:4138`). Por
  isso o `GrupoDropDialog` lista todos os afetados, não só os dois nomes arrastados — a lista é a
  união de `origemSessao`/`alvoSessao` com o `pair_peers` de cada um (`afetados`,
  `GrupoDropDialog.svelte`), relida do `sessionsStore` a cada render em vez do objeto capturado no
  clique: um SSE que mude o grupo (ou mate a sessão) enquanto o diálogo está aberto não pode
  confirmar dado velho.
- **No Canvas o alvo válido é só a faixa de cabeçalho do card (`HEADER_HIT_H = 34`, em
  `canvasLayout.ts`), não o corpo inteiro.** Lá arrastar já significa MOVER o tile e tiles se
  sobrepõem livremente — sobrepor corpos continua sendo só mover, senão qualquer reorganização
  visual dispararia um pedido de parear. O hit-test (`findDropTarget`) varre cards e depois grupos
  recolhidos na ordem INVERSA da lista recebida, que é a ordem de renderização: sem inverter, dois
  cabeçalhos sobrepostos pareavam sempre com o card desenhado primeiro (o de BAIXO na tela), nunca
  o que a pessoa está vendo por cima.
- **No celular o arrasto sai de uma alça na trilha do swipe** (`SessionCard.svelte`), porque os
  outros três gestos já estão ocupados: toque longo abre o menu de ações, swipe horizontal abre a
  trilha, arrasto vertical é a rolagem da lista — não sobrava um gesto livre pra "arrastar a
  linha". Duas rodadas de correção depois de escrito (`21b6bf3e`): o hit-test caindo sobre a
  própria origem (dedo ainda dentro da trilha recém-aberta) tem que virar "sem alvo" em vez de
  piscar como recusado antes de qualquer movimento real; e o cabeçalho de um cluster de pareamento
  precisa resolver pra um membro representante (1º da lista), senão soltar ali caía no "fundo" da
  lista e pedia SAÍDA do grupo da origem — nada a ver com o que a pessoa mirou.
- **Limite aceito: em tablet na largura desktop (iPad com a `Sidebar`) o arrasto HTML5 não responde
  ao toque, e não haverá gesto ali** — o caminho é o `PairSheet`. Esse mesmo `PairSheet` é também a
  alternativa SEM arrasto exigida pela WCAG 2.2 SC 2.5.7 (todo atalho de arrastar precisa de um
  caminho equivalente por clique/toque simples): o arrasto é atalho, nunca o único jeito de parear
  ou sair de um grupo.
- **Cross-server não entra pelo arrasto.** `canPair` recusa com `cross_server` quando origem ou
  alvo já tem algum `pair_peers` com `::` (peer remoto) — o backend recusaria a mesma combinação
  com `400 erro_pareamento_mistura_cross` (`pair.py:169`), então o front nem deixa tentar. Parear
  entre máquinas continua só pelo `PairSheet`/`hangar-send`.

## A aba que NASCE com a sessão fora da tela vem 0×0

17/09/2026. A skill promete que a página escondida é medida em 1280×800, e o desenho entrega isso:
`definirOculto(true)` liga `VIEWPORT_OCULTO` em `shell/preview_ctl.cjs`, e o `nav-hide` do
`main.cjs` chama isso quando o view sai da tela. O que falha é o estado INICIAL. Em
`shell/main.cjs:688` (e `:813`):

```js
const escondida = oculto ?? (anterior ? !anterior.view.getVisible() : false);
```

Sem `oculto` explícito e **sem aba anterior** — o caso de um navegador nascendo do zero para uma
sessão que não está na tela — o padrão é `false`. O controlador nunca recebe `definirOculto(true)`,
não liga a emulação, cai no `clearDeviceMetricsOverride` e o agente lê uma página de 0×0: sem
layout, `snapshot` e `shot` de uma tela sem dimensão.

**Saída enquanto não for consertado:** `hangar-preview layout 1280 800` (modo custom, que aplica
`setDeviceMetricsOverride` direto). `layout desktop` NÃO serve — ele cai no ramo que limpa a
emulação e devolve o tamanho real, que é zero. Confira com `eval 'innerWidth'` antes de concluir
que a página está vazia.

## Navegador embutido com janela estreita

22/09/2026. Em uma janela Electron de 758×366 com outra conversa aberta, `hangar-preview open`
registrava o pedido de uma sessão Codex sem terminal, mas nenhum navegador nascia. A identidade
estava correta: abaixo de 820px o `DesktopShell` não montava, e o chat sozinho não mantinha o SSE
da lista que entrega os pedidos `nav`. O `App` agora retém o `sessionsStore` enquanto a ponte nativa
existe e o login/sync permite entrar. O contador existente compartilha a conexão com as telas.
Conferido no mesmo app e largura: o pedido passou a criar o navegador de uma sessão fora da tela.

## Pares entre servidores e nomes compridos na lista

22/09/2026. `jefferson-2` no notebook e `setup-vm` no Delphi-02 apareciam em dois grupos de um
membro: cada ponta tem seu próprio `pair_gid`, e a lista separava servidores antes de agrupar.
Pares remotos recíprocos agora são reunidos antes da divisão por servidor/projeto. A identidade
vem de `/api/peers/identificador`, consultado uma vez após um quadro válido com par remoto;
nome ou rótulo do servidor não basta. Os IDs originais continuam nas ações e no arrasto.

O grupo mostra a origem de cada sessão. Títulos compridos quebram linha dentro da largura da
barra. Na prova real, o par apareceu uma vez com contador 2, sem exceder a largura do cabeçalho.
Os servidores offline ficam em um resumo recolhido; expandi-lo não dispara consultas.
