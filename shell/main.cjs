// Janela nativa do hangar. Ver docs/superpowers/specs/2026-08-05-shell-electron-design.md.
const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ler, gravar, urlSemConfig, urlInicial } = require('./settings.cjs');
const { uaDeChrome, normalizaBounds, urlNavegavel, nomeSidecar, proximaAtiva, hostLoopback } = require('./navegador.cjs');
const { criarControlador } = require('./preview_ctl.cjs');
const { commitDoCheckout } = require('./versao.cjs');
const { importarCookiesDoChrome, PAGINA_ATIVAR } = require('./cookies_chrome.cjs');
const { credenciaisPara } = require('./senhas_chrome.cjs');
require('./log.cjs').instalar();

// Preenche usuário/senha no view a partir das senhas salvas do Chrome. A decifração roda no MAIN
// (não no renderer): a senha em claro só existe aqui e no campo da página, some depois, nunca vai
// a disco nem a outra máquina. Escolhe a 1ª credencial do domínio; a página pode ter mais de um
// campo de senha (login + trocar-senha) — preenche o primeiro VISÍVEL e o texto/email antes dele.
async function preencherLogin(wc, host) {
  let creds;
  try { creds = credenciaisPara(host); } catch (e) { console.warn('[senha] leitura falhou:', e.message); return; }
  if (!creds.length) return;
  const { usuario, senha } = creds[0];
  // SPA desenha o formulário depois do dom-ready: três tentativas, e para na primeira que achou.
  for (const espera of [0, 1500, 4000]) {
    await new Promise((r) => setTimeout(r, espera));
    if (wc.isDestroyed()) return;
    if (await injetarLogin(wc, usuario, senha)) return;
  }
}

function injetarLogin(wc, usuario, senha) {
  // O valor entra como JSON literal (nunca concatenado na string do script) — senha com aspas,
  // barra ou template não pode virar código.
  const arg = JSON.stringify({ usuario, senha });
  return wc.executeJavaScript(`(() => {
    const { usuario, senha } = ${arg};
    const vis = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
    // Atravessa shadow DOM aberto: tela de login em web component (authentik, Lit) não tem
    // input nenhum no document — o querySelectorAll de cima devolvia vazio e nada preenchia.
    const inputs = [];
    const anda = (raiz) => {
      for (const el of raiz.querySelectorAll('*')) {
        if (el.tagName === 'INPUT') inputs.push(el);
        if (el.shadowRoot) anda(el.shadowRoot);
      }
    };
    anda(document);
    const pw = inputs.find((el) => el.type === 'password' && vis(el));
    if (!pw) return false;
    const set = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);   // React ouve o setter nativo
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(pw, senha);
    if (usuario) {
      // Campo de usuário: o de texto/email/tel mais próximo ANTES do de senha no fluxo do DOM.
      const ate = inputs.slice(0, inputs.indexOf(pw));
      const user = ate.reverse().find((el) => vis(el) && /^(text|email|tel|)$/i.test(el.type));
      if (user) set(user, usuario);
    }
    return true;
  })()`, true).catch(() => false);
}

// Lido UMA vez, na subida: é o código que este processo de fato carregou, e é isso que a tela de
// atualização compara com o commit atualizado pra saber se "feche e abra o Hangar" ainda vale.
const SHELL_COMMIT = commitDoCheckout(path.join(__dirname, '..'));
const { subirServidor } = require('./preview_srv.cjs');

// O navegador embutido (WebContentsView, handlers hangar:nav-*) é dirigível por CDP na 9223 — o
// agent-browser conecta nela como conecta no Chrome do usuário (9222), sem backend no meio. A
// porta expõe TODOS os webContents, inclusive o cockpit (com o token no localStorage), a qualquer
// processo local — mesmo risco do Chrome com remote-debugging, assumido de propósito.
app.commandLine.appendSwitch('remote-debugging-port', '9223');

// MEDIDO 05/08/2026 (Hyprland/Wayland, Electron 43.3.0): o switch `enable-transparent-visuals`
// do spike NAO e necessario — a janela continua transparente sem ele. Linha removida.

const PADRAO = 'http://127.0.0.1:8765';

// Transparência por plataforma. No Windows `transparent: true` só funciona sem moldura (doc da
// própria opção) e a gente mantém a moldura nativa -> lá o caminho é backgroundMaterial, que o
// sistema desenha inclusive atrás da barra de título. No Windows 10, sem material, janela opaca.
function opcoesDeFundo() {
  if (process.platform === 'darwin') {
    return { transparente: true, extra: { vibrancy: 'under-window', visualEffectState: 'followWindow' } };
  }
  if (process.platform === 'win32') {
    return { transparente: false, extra: { backgroundMaterial: 'acrylic' } };
  }
  return { transparente: true, extra: {} };   // linux
}

async function paginaResponde(url) {
  // Critério é `GET /` devolver 200 text/html — NÃO um probe na API: o backend pode estar vivo
  // sem o dist (o mount é condicional, backend/app/api.py:3151-3153) e o usuário veria 404.
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok && (res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
}

// `dialog.showMessageBox` NÃO tem campo de texto — só botões. Pedir URL por ele devolveria sempre
// a mesma URL, e o atalho de recuperação recarregaria o mesmo endereço pra sempre. A tela é uma
// página `data:` carregada na própria janela: tem `<input>`, vem preenchida com a URL atual, e o
// submit navega. Sem preload, sem IPC, sem dependência.
function telaDeUrl(atual) {
  // `atual` vira valor de atributo HTML — escapa o mínimo que já basta pra não quebrar fora do
  // `value="..."` (uma URL com `"` fecharia o atributo cedo).
  const segura = String(atual).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><meta charset="utf-8">
<style>body{background:#1a181d;color:#e8e6e3;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0}
form{display:flex;gap:8px;flex-direction:column;width:min(90vw,420px)}
input{padding:10px;border-radius:8px;border:1px solid #3a373f;background:#232028;color:inherit}
button{padding:10px;border-radius:8px;border:0;background:#6b5bd6;color:#fff;cursor:pointer}
p{opacity:.7;margin:0 0 4px}</style>
<form onsubmit="location.href=this.u.value;return false">
  <p>Não consegui carregar a interface. Qual o endereço do seu cockpit?</p>
  <input name="u" value="${segura}" autofocus>
  <button>Abrir</button>
</form>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function geometriaValida(j) {
  if (!j) return null;
  // Reencaixa na tela mais próxima: sem isto a janela renasce invisível num monitor desligado.
  const tela = screen.getDisplayMatching(j);
  const a = tela.workArea;
  return {
    x: Math.min(Math.max(j.x, a.x), a.x + a.width - 200),
    y: Math.min(Math.max(j.y, a.y), a.y + a.height - 100),
    width: Math.min(j.width, a.width),
    height: Math.min(j.height, a.height),
  };
}

// UMA instância, VÁRIAS janelas. Duas instâncias sobre o MESMO userData não funcionam: o
// armazenamento do Chromium (localStorage, onde moram o token e a aparência) só abre num
// processo. Medido em 18/08/2026, com duas janelas abertas sobre uma cópia do perfil real: a
// segunda subiu com `Failed to delete the database: Database IO error` e caiu na tela de login,
// sem papel de parede — parecia "o app não pegou as configs", e era o perfil trancado.
// Com a trava, o segundo lançamento não vira processo: ele avisa esta instância, que abre mais
// uma janela no mesmo perfil (mesmo token, mesma aparência, mesmas sessões).
async function criarJanela() {
  const dir = app.getPath('userData');
  const cfg = ler(dir);
  // Precedência: variável de ambiente > escolha salva > padrão.
  const url = urlSemConfig(process.env.COCKPIT_URL || cfg.url || PADRAO);
  // Ultimo endereco que CARREGOU de verdade (did-navigate abaixo mantem isto atualizado). `url`
  // acima fica congelada no valor do boot; sem esta variavel a tela de recuperacao reoferecia
  // 127.0.0.1:8765 depois que o usuario ja tinha corrigido pra outro endereco e ele caiu de novo.
  //
  // Comeca no PADRAO, NAO em `url`: `url` pode vir de COCKPIT_URL, que ninguem verificou. Medido em
  // 05/08/2026 — abrir com COCKPIT_URL apontando pra uma porta morta e fechar na tela de
  // recuperacao gravava a porta morta como "endereco bom", e TODA abertura seguinte caia na tela de
  // erro. Endereco que nunca carregou nao pode ser o ultimo bom.
  let urlBoa = PADRAO;

  const fundo = opcoesDeFundo();
  const geo = geometriaValida(cfg.janela) || { width: 1280, height: 800 };
  // Janela nova em cima de janela aberta nasce EXATAMENTE sobre a anterior (a geometria salva é
  // uma só) e some — parece que o clique não fez nada. Desloca em cascata por janela já aberta e
  // reencaixa na área de trabalho, pela mesma régua do `geometriaValida`.
  const jaAbertas = BrowserWindow.getAllWindows().length;
  if (jaAbertas > 0) {
    const desloc = geometriaValida({ ...geo, x: (geo.x ?? 0) + 32 * jaAbertas, y: (geo.y ?? 0) + 32 * jaAbertas });
    if (desloc) { geo.x = desloc.x; geo.y = desloc.y; }
  }

  // A marca que o front lê (frontend/src/lib/background.ts, isShell) SÓ é injetada quando a janela
  // vai mesmo ser transparente. Sem esta condição, numa plataforma opaca (Windows 10, GNOME sem
  // extensão) a tela de Aparência ofereceria "Desktop" e escolher isso zeraria o fundo de uma
  // janela sólida — o app nasceria sem fundo nenhum. Vai no user agent, e não na URL, porque
  // Login.svelte:111 apaga a query quando ela traz ?token= (pareamento).
  // `+=` uma vez só: com várias janelas, appendar a cada abertura empilharia a marca no user
  // agent ("… hangar-shell hangar-shell").
  if (fundo.transparente && !app.userAgentFallback.includes(' hangar-shell')) app.userAgentFallback += ' hangar-shell';

  const win = new BrowserWindow({
    ...geo,
    icon: path.join(__dirname, 'build', 'icon.png'),
    transparent: fundo.transparente,
    // Fallback opaco: onde a transparência não vale, a janela precisa de cor própria, senão
    // aparece preta. O front também não recebe a marca de fundo nesse caso (ver abaixo).
    backgroundColor: fundo.transparente ? '#00000000' : '#1a181d',
    ...fundo.extra,
    // O preload expõe SÓ window.hangar.pickFolder (seletor nativo de pasta) — ver preload.cjs.
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // O commit que ESTE main.cjs carregou vai por argv, não lido pelo preload: o preload roda
      // de novo a cada reload da página e leria o .git JÁ atualizado com o main ainda velho —
      // escondendo o "feche e abra" exatamente quando ele vale. Main velho não manda o flag, e o
      // preload novo devolve null (= avisa), que é o certo.
      additionalArguments: [`--hangar-shell-commit=${SHELL_COMMIT ?? ''}`],
    },
  });
  win.removeMenu();

  // Título FIXO: é ele que a windowrulev2 do Hyprland casa (a classe é sempre 'electron' e não
  // muda — medido com app.setName e --class em 05/08/2026). preventDefault impede que a navegação
  // do SPA troque o título.
  win.setTitle('hangar');
  win.on('page-title-updated', (e) => e.preventDefault());

  // Link do chat (`target="_blank"`) sem isto abre uma BrowserWindow NOVA do proprio Electron — sem
  // barra de endereco, sem abas, sem as sessoes/extensoes do usuario. Parece "outro navegador".
  // `openExternal` manda pro navegador padrao do sistema (aqui, o Chrome).
  win.webContents.setWindowOpenHandler(({ url: alvo }) => {
    if (/^https?:/i.test(alvo)) shell.openExternal(alvo);
    return { action: 'deny' };
  });
  // Mesmo destino pra link que navega na PROPRIA janela (sem `target`): sem isto o cockpit vira um
  // navegador de uma aba so e o usuario fica preso no site externo, sem botao de voltar.
  win.webContents.on('will-navigate', (e, alvo) => {
    if (alvo.startsWith('data:')) return;                 // tela de recuperacao navega sozinha
    const atual = win.webContents.getURL();
    if (atual.startsWith('data:')) return;                // o submit da tela de recuperacao
    try {
      if (new URL(alvo).origin === new URL(atual).origin) return;   // navegacao interna do app
    } catch { return; }
    e.preventDefault();
    if (/^https?:/i.test(alvo)) shell.openExternal(alvo);
  });

  // A tela de recuperação não é endereço de cockpit: se o fechamento pegar a janela parada nela
  // (backend fora, usuário fechou em vez de responder), gravar essa URL faria a próxima abertura
  // tentar carregar a própria tela de erro. Nesse caso mantém a URL que já estava salva.
  win.on('close', () => {
    // Janela morrendo leva TODOS os views de navegador dela — sem isto o Map guardaria
    // referência de webContents mortos.
    // Mesmo caminho do × do painel (view, controlador e o sidecar da chave — sem apagá-lo o CLI
    // lista "MORTO" acumulando lixo a cada quit): um lugar só, exercitado pelo mesmo teste.
    const porChave = navegadores.get(win);
    if (porChave) {
      for (const chave of [...porChave.keys()]) fecharNavegador(win, chave);
      navegadores.delete(win);
    }
    const u = win.webContents.getURL();
    // Na tela de recuperacao (data:) nao ha endereco de cockpit pra salvar — usa o ULTIMO que
    // carregou de verdade (urlBoa), nao o `cfg.url` do boot, que fica pra tras assim que o
    // usuario troca de endereco em tela.
    gravar(dir, { url: u.startsWith('data:') ? urlBoa : urlSemConfig(u),
                  janela: win.getBounds() });
  });

  // A URL que vale é a que a janela REALMENTE carregou — inclusive a digitada na tela de
  // recuperação, que navega por conta própria.
  win.webContents.on('did-navigate', (_e, u) => {
    if (u.startsWith('data:')) return;
    urlBoa = urlSemConfig(u);
    gravar(dir, { url: urlBoa, janela: win.getBounds() });
  });
  // Reload/navegação da página (Ctrl+R) derruba o DOM sem rodar o desmonte do NavegadorPane,
  // então o view nativo ficava pintado no lugar antigo, por cima do chat, até alguém abrir a aba
  // Navegador de novo. Esconde todos os views da janela na hora; quem reexibe é o painel ao montar.
  win.webContents.on('did-start-navigation', (_e, _u, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    for (const v of viewsDaJanela(win)) {
      try { v.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch { /* view já morto */ }
    }
  });
  // Carga que falha (backend caiu no meio, URL errada) traz a tela de volta. Mas só se for a
  // página principal: o app mantém SSE e faz XHR de sessão o tempo todo, e um recurso solto que
  // falhou no meio de uma página que carregou bem também dispara este evento — sem o filtro, a
  // janela seria jogada pra tela de erro no meio do uso.
  win.webContents.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 é ERR_ABORTED: uma navegação mais nova venceu a corrida (ex.: o duplo disparo do
    // Ctrl+Shift+U antes do guard de keyDown abaixo) — não é falha nenhuma, e recarregar a tela
    // de erro aqui é o próprio bug que o guard de baixo existe pra evitar.
    if (errorCode === -3) return;
    // Prefil com o endereço que ACABOU de falhar (não o último bom, urlBoa): é o que está
    // relevante pro que quebrou agora — inclusive pra corrigir um erro de digitação recém-feito
    // na própria tela de recuperação.
    win.loadURL(telaDeUrl(validatedURL || url));
  });

  // Atalho de recuperação. NÃO usar globalShortcut: ele registra no sistema inteiro enquanto o app
  // viver, e no Linux com IBus o Ctrl+Shift+U é a entrada de unicode. before-input-event vale só
  // com a janela em foco e funciona mesmo com removeMenu().
  win.webContents.on('before-input-event', (e, input) => {
    // before-input-event dispara pra keyDown E keyUp da MESMA tecla — sem este filtro, um
    // Ctrl+Shift+U soltava dois loadURL: o segundo aborta o primeiro (ERR_ABORTED), que sem o
    // guard acima reabria a tela de erro sozinho.
    if (input.type !== 'keyDown') return;
    if (input.control && input.shift && input.key.toLowerCase() === 'u') {
      e.preventDefault();
      win.loadURL(telaDeUrl(win.webContents.getURL() || url));
    }
    // Ctrl+Shift+R — recarregar de verdade. O `removeMenu()` acima tira o menu padrao e, com ele,
    // TODOS os aceleradores que vinham de graca: no Electron o reload nasce do role do menu, entao
    // sem menu o Ctrl+R e o Ctrl+Shift+R simplesmente nao existem (medido 10/08/2026 — o usuario
    // apertava e nada acontecia).
    //
    // E `reloadIgnoringCache()` sozinho NAO bastaria: a interface e um PWA com service worker
    // fazendo precache dos assets. O SW intercepta o fetch ANTES do cache HTTP, entao ignorar o
    // cache do Chromium ainda entrega o bundle velho — foi exatamente isso que segurou uma versao
    // antiga da tela depois de um rebuild nesta mesma sessao. Por isso limpa `serviceworkers` +
    // `cachestorage` primeiro e so entao recarrega.
    //
    // Nao mexe em cookies nem localStorage de proposito: ali moram o token de autenticacao e as
    // preferencias de aparencia — um "recarregar" que desloga o usuario e uma armadilha.
    if (input.control && input.shift && input.key.toLowerCase() === 'r') {
      e.preventDefault();
      // Desregistra o SW ANTES de limpar o armazenamento dele. `clearStorageData` apaga os bytes,
      // mas o registro vivo continua na página: ele volta a se instalar no reload e pode reservir
      // o bundle antigo. Sem isto o atalho "funcionava" e a tela continuava velha, que foi o que o
    // usuário viu — e como a promessa era engolida, nada aparecia dizendo o que houve.
      const atual = win.webContents.getURL();
      const inicio = urlInicial(atual.startsWith('data:') ? urlBoa : atual);
      win.webContents
        .executeJavaScript(`navigator.serviceWorker?.getRegistrations?.()
            .then(rs => Promise.all(rs.map(r => r.unregister())))
            .then(rs => rs.length).catch(() => -1)`)
        .then((n) => console.log(`[recarregar] service workers desregistrados: ${n}`))
        .catch((err) => console.error('[recarregar] desregistro falhou:', err))
        .then(() => win.webContents.session.clearStorageData({
          storages: ['serviceworkers', 'cachestorage'],
        }))
        .then(() => console.log('[recarregar] cache do service worker limpo'))
        .catch((err) => console.error('[recarregar] limpeza falhou:', err))
        // `loadURL` não tem o bypass de cache do reloadIgnoringCache; apaga também o cache HTTP
        // antes de recarregar a mesma rota, sem a query do hash. Cookies e localStorage continuam preservados.
        .then(() => win.webContents.session.clearCache())
        .catch((err) => console.error('[recarregar] cache HTTP falhou:', err))
        .finally(() => {
          // `loadURL` com a URL IDÊNTICA à atual (rota + hash, sem query pra tirar) é navegação
          // de fragmento pro Chromium: não recarrega nada, e a tela ficava no bundle velho sem
          // nem piscar. Só quando há query pra descartar a URL muda e o loadURL vale.
          if (inicio === atual) win.webContents.reloadIgnoringCache();
          else win.loadURL(inicio);
        });
    }
    // Ctrl+Shift+I — DevTools. Mesmo motivo do R: o `removeMenu()` acima leva junto TODOS os
    // aceleradores padrão, e o DevTools é um deles. Sem menu, sem atalho — e sem DevTools não há
    // como conferir qual bundle a janela carregou, que é justamente o que se precisa quando a tela
    // não acompanha o build.
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // Endereco salvo fora do ar NAO significa perguntar: o caso comum e o backend local, que esta
  // bem ali no PADRAO. So depois que os dois falham e que faz sentido pedir ajuda pro usuario.
  let alvo = null;
  if (await paginaResponde(url)) alvo = url;
  else if (url !== PADRAO && (await paginaResponde(PADRAO))) alvo = PADRAO;
  win.loadURL(alvo ? alvo : telaDeUrl(url));
}

// A trava vem ANTES do whenReady: quem não a conseguiu não pode chegar a criar janela nenhuma —
// é justamente a janela quebrada que este bloco existe pra evitar. O processo que perdeu a trava
// sai na hora, e o `second-instance` dispara no processo que já está de pé.
// `criarJanela` e async: chamar sem catch transforma qualquer excecao dentro dela (geometria
// salva estranha, BrowserWindow que nao nasce) numa unhandled rejection. No app empacotado isso
// nao aparece em lugar nenhum — o clique pra abrir a segunda janela simplesmente nao faz nada —
// e, dependendo da politica do Node, derruba o processo inteiro, fechando as janelas que ja
// estavam abertas no meio do uso. Falha de abrir UMA janela nao pode custar as outras.
function abrirJanela(origem) {
  criarJanela().catch((err) => {
    console.error(`[janela] ${origem} falhou:`, err);
    // Segunda janela e um pedido EXPLICITO do usuario: silenciar ali e o bug. No arranque, se a
    // primeira janela nao nasce, tambem nao ha nada na tela pra explicar o que houve.
    dialog.showErrorBox('Hangar', `Não consegui abrir a janela.\n\n${err && err.message ? err.message : err}`);
  });
}

// ---------------------------------------------------------------------------
// Navegador embutido. UM WebContentsView POR ABA, agrupados por sessão (chave serverId::nome),
// pendurado no contentView da janela — navegação top-level, então X-Frame-Options não se aplica
// (diferente de iframe). Trocar de sessão ESCONDE o view (nav-hide), não fecha: o agente segue
// dirigindo ele via CDP em background (o controlador tira o view do modo economia enquanto um
// verbo roda — ver `aoDirigir`). Fechar de
// verdade é só pelo × do painel (nav-close). A POSIÇÃO é medida pelo front (div âncora no
// NavegadorPane) e chega por IPC: o view não é DOM, flutua POR CIMA da página — o front esconde
// com bounds zero quando um overlay DOM abre, e o layout do Chat reserva a faixa pra nada cobrir
// texto/composer.
const navegadores = new Map();   // BrowserWindow -> Map<chave, Map<id, WebContentsView>>

// chave da sessão -> { proximoId, ativa, abas: Map<id, { ctl, view, urlPedida, targetId }> }.
// Vive fora do `navegadores` porque a vida é a mesma dos VIEWS, não a da janela, e é por ele que
// o servidor local acha o alvo de um comando. Guarda o `view` junto do controlador (não só o
// controlador) porque é a identidade que `soltarControlador` confere antes de apagar — ver
// comentário ali. O CONTADOR mora aqui, não no Map por janela: duas janelas do app com a mesma
// sessão não podem gerar o mesmo id.
const registros = new Map();

const TETO_ABAS = 8;

function regDe(chave) {
  let r = registros.get(chave);
  if (!r) {
    r = { proximoId: 1, ativa: null, abas: new Map(),
      layoutEstado: { modo: 'desktop', width: null, height: null, versao: 0, erro: null } };
    registros.set(chave, r);
  }
  return r;
}

function entradaDe(chave, id) {
  const r = registros.get(chave);
  if (!r) return null;
  return r.abas.get(id ?? r.ativa) || null;
}

function abasDaJanela(win, chave) {
  let porChave = navegadores.get(win);
  if (!porChave) { porChave = new Map(); navegadores.set(win, porChave); }
  let abas = porChave.get(chave);
  if (!abas) { abas = new Map(); porChave.set(chave, abas); }
  return abas;
}

// Todos os views de uma janela, de todas as chaves — o que `did-start-navigation` e o `close` da
// janela precisam varrer.
function* viewsDaJanela(win) {
  for (const abas of navegadores.get(win)?.values() ?? []) yield* abas.values();
}

// Fecha o controlador de uma chave e desanexa o depurador do view — trio repetido em três
// pontos (× do painel, queda da janela, webContents morto por fora): um lugar só. Sem isto num
// dos três, o Map fica com controlador órfão apontando pra webContents morto: o servidor local
// acha ele (não devolve null) e um comando vira 500 de CDP em vez do 404 "sem navegador aberto".
// A CONFERÊNCIA DE IDENTIDADE (entrada.view === view) é o que impede uma janela A de apagar o
// controlador da janela B: com duas janelas do app abrindo a MESMA sessão, as abas das duas caem
// no MESMO registro global (a chave é só a sessão, não a janela); sem procurar a entrada DAQUELE
// view antes de soltar, fechar a janela A apagava o controlador vivo da B — o painel dela ficava
// aberto respondendo 404 pra todo comando. Mesma guarda que já existia no ouvinte `destroyed`
// (linha abaixo), agora na função compartilhada — vale pros três chamadores, não só pra esse.
function soltarControlador(chave, view) {
  const r = registros.get(chave);
  if (r) {
    for (const [id, entrada] of r.abas) {
      if (entrada.view !== view) continue;
      // Sem controlador quando o depurador não anexou na criação — a aba existe mesmo assim.
      entrada.ctl?.fechar();
      r.abas.delete(id);
      // Só ZERA a ativa; escolher a sucessora aqui a deixaria registrada mas invisível — quem
      // decide qual entra também tem que exibi-la, e isso é de quem fechou a aba.
      if (r.ativa === id) r.ativa = null;
      break;
    }
    if (!r.abas.size) registros.delete(chave);
  }
  try { view.webContents.debugger.detach(); } catch { /* já solto */ }
}

// Conta ao controlador que o view saiu da tela (ou voltou pra ela): é ele quem liga a emulação
// de tamanho que dá viewport e print a um view escondido. Espera a página carregar, porque
// emular tamanho no `about:blank` de um view recém-criado derruba o processo com SIGSEGV.
const ctlDoView = (chave, view) => {
  const r = registros.get(chave);
  const entrada = r && [...r.abas.values()].find((e) => e.view === view);
  return entrada ? entrada.ctl : null;
};

function avisarOculto(chave, view, oculto) {
  const ctl = ctlDoView(chave, view);
  if (!ctl?.definirOculto) return;
  const aplicar = () => ctl.definirOculto(oculto).catch((err) => {
    console.error('[nav] viewport do view escondido:', err && err.message);
  });
  // `about:blank` (ou URL vazia) é o documento em que a emulação mata o processo. Navegação EM
  // VOO conta igual, e o `getURL()` não denuncia: logo depois de um `loadURL` ele ainda devolve a
  // URL antiga, e emular em cima da troca de página derrubava a sessão do depurador — daí em
  // diante todo verbo respondia "Not attached to an active page" até fechar e abrir de novo.
  // `did-stop-loading` e não `did-finish-load` porque carga que FALHA também precisa devolver a
  // medida: sem isso a aba escondida ficaria sem viewport nenhuma até alguém navegar de novo.
  const url = view.webContents.getURL();
  const navegando = view.webContents.isLoadingMainFrame?.() ?? view.webContents.isLoading?.() ?? false;
  if (url && url !== 'about:blank' && !navegando) aplicar();
  else view.webContents.once('did-stop-loading', aplicar);
}

// View escondido não pode ficar com o teclado: o Chromium foca o WebContents que acabou de nascer
// ou de carregar, a janela segue ativa pro compositor e todo atalho do front morre em silêncio.
// `!view.webContents` é estado válido: um Target.closeTarget por fora deixa o view no Map sem ele.
const viewVivo = (win, view) => !win.isDestroyed() && view.webContents && !view.webContents.isDestroyed();

function anexarNaJanela(win, view) {
  if (!viewVivo(win, view)) return;
  if (!win.contentView.children.includes(view)) win.contentView.addChildView(view);
}

const algumViewVisivel = (win) => {
  for (const v of viewsDaJanela(win)) if (viewVivo(win, v) && v.getVisible()) return true;
  return false;
};

// Uma pendência por janela: o `did-finish-load` de um view dirigido por CDP repete a cada
// navegação, e um `once` por load empilharia listeners e chamadas redundantes de foco.
const focoPendente = new WeakSet();

function devolverFoco(win, view) {
  if (!viewVivo(win, view) || view.getVisible()) return;
  // O teclado é de quem está na tela: se QUALQUER aba desta janela está visível, ele fica com ela
  // — uma aba de fundo que terminou de carregar não pode arrancá-lo.
  if (algumViewVisivel(win)) return;
  // Com a janela em segundo plano, `focus()` vira pedido de ativação (xdg-activation) e um
  // compositor com focus_on_activate traz o app pra frente — devolver o teclado não pode roubar a
  // tela de quem está noutro aplicativo. Espera a volta do usuário; focar já focado não ativa nada.
  if (!win.isFocused()) {
    if (focoPendente.has(win)) return;
    focoPendente.add(win);
    win.once('focus', () => {
      focoPendente.delete(win);
      // Enquanto o usuário esteve fora ele pode ter aberto o painel: o teclado é de quem está na
      // tela, e arrancá-lo do navegador visível seria o mesmo roubo, ao contrário.
      if (win.isDestroyed() || algumViewVisivel(win)) return;
      win.webContents.focus();
    });
    return;
  }
  win.webContents.focus();
}

// Fecha TODAS as abas da chave naquela janela: o × do painel é do navegador inteiro, não da aba.
function fecharNavegador(win, chave) {
  const porChave = navegadores.get(win);
  const abas = porChave && porChave.get(chave);
  if (!abas || !abas.size) return;
  porChave.delete(chave);
  if (porChave.size === 0) navegadores.delete(win);
  // "Já morto" é silencioso; qualquer outra falha aqui deixaria um view vivo com o painel
  // desmontado e o CLI dizendo "ok" — precisa aparecer no log.
  const avisar = (etapa, err) => console.error(`[nav] fechar ${chave}: ${etapa}:`, err && err.message);
  for (const view of abas.values()) {
    soltarControlador(chave, view);
    try { if (!win.isDestroyed()) win.contentView.removeChildView(view); } catch (err) { avisar('removeChildView', err); }
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (err) { avisar('close', err); }
  }
  // A mesma sessão aberta em OUTRA janela do app ainda tem abas vivas no registro: o sidecar
  // passa a contar só elas. Apagar aqui deixava o CLI, o espelho do celular e o GET /navegador
  // dizendo "sem navegador" para uma sessão que seguia sendo dirigida na outra janela.
  if (registros.get(chave)?.abas.size) { gravarSidecarNav(chave); return; }
  try { fs.rmSync(path.join(NAV_SIDECARS, `${nomeSidecar(chave)}.json`), { force: true }); } catch (err) { avisar('sidecar', err); }
}

// `hangar-preview close`: o CLI só conhece a chave, não a janela. O painel não pediu o fechamento,
// então precisa ser avisado — sem o evento ele seguia mostrando um view que não existe mais.
function fecharNavegadorPorChave(chave) {
  // Duas janelas com a mesma chave: o navegador "de verdade" é o da aba ATIVA registrada (último
  // open ganha no registro); fechar o outro deixaria o vivo na tela.
  const vivo = entradaDe(chave)?.view;
  let alvo = null;
  for (const [win, porChave] of navegadores) {
    const abas = porChave.get(chave);
    if (!abas) continue;
    if (!alvo || [...abas.values()].includes(vivo)) alvo = win;
  }
  if (!alvo) return false;
  fecharNavegador(alvo, chave);
  if (!alvo.isDestroyed()) alvo.webContents.send('hangar:nav-fechado', { chave });
  return true;
}

// Sidecar por sessão em ~/.hangar/nav/<chave>.json — é o que o `hangar-preview` lê pra achar o
// target CDP DESTA sessão sem adivinhar por URL (duas sessões no mesmo localhost:3000 teriam a
// mesma). O targetId é descoberto por diff do /json/list antes/depois do view nascer: opens são
// raros e seriais, então o alvo novo é o view. Gravação é async e tmp+rename (o CLI pode estar
// lendo). Sem targetId (CDP fora do ar?), grava só chave+url e o CLI casa por URL.
const NAV_SIDECARS = path.join(os.homedir(), '.hangar', 'nav');

// Varre a pasta na largada. O sidecar não sobrevive ao processo — o view morre junto com a janela
// —, mas ele só era apagado no × e no close da janela: app derrubado por sinal ou por crash
// deixava o arquivo pra trás, e um navegador MORTO de um servidor passava a disputar o nome com um
// vivo de outro, obrigando o `hangar-preview` a exigir a chave completa. A trava de instância única
// (logo abaixo) garante um dono só, então tudo que está aqui na subida é de execução encerrada.
function limparSidecaresNav() {
  let restos = [];
  try {
    restos = fs.readdirSync(NAV_SIDECARS);
  } catch { return; }                 // pasta ainda não existe: nada a limpar
  for (const nome of restos) {
    if (!nome.endsWith('.json') && !nome.endsWith('.tmp')) continue;
    if (nome === '_srv.json') continue;   // é do processo VIVO, não resto de execução morta
    try { fs.rmSync(path.join(NAV_SIDECARS, nome), { force: true }); } catch { /* já sumiu */ }
  }
}

// PERGUNTA AO PRÓPRIO VIEW quem ele é. A versão anterior descobria o id por diferença da lista
// global de alvos do CDP (foto antes de criar, foto depois, o que apareceu é ele) — e a lista é do
// processo inteiro, não desta janela: dois `nav-open` ao mesmo tempo (duas janelas do app, ou dois
// cliques seguidos) e a foto "antes" de um já continha o alvo criado pelo outro, então cada um
// podia levar o targetId da sessão errada. Um agente dirigindo o navegador da sessão vizinha é o
// pior desfecho possível aqui, e nenhuma quantidade de tentativas conserta um diff sobre estado
// compartilhado. Anexar o depurador ao webContents pergunta direto, sem lista e sem corrida.
// Solta na hora: enquanto anexado, o alvo não aceita outro cliente CDP (é o `hangar-preview`).
async function targetIdDe(view) {
  const dbg = view.webContents.debugger;
  // Task 6 passou a anexar o mesmo depurador PERMANENTEMENTE (controlador do preview) antes de
  // chamar isto via `gravarSidecarNav`: sem esta checagem, o `attach` daqui falhava com "already
  // attached" e o `detach` do finally derrubava a sessão permanente que ainda nem tinha sido usada.
  const jaAnexado = dbg.isAttached();
  try {
    if (!jaAnexado) dbg.attach('1.3');
    const info = await dbg.sendCommand('Target.getTargetInfo');
    return info?.targetInfo?.targetId ?? null;
  } catch (err) {
    console.error('[nav] targetId indisponivel:', err?.message || err);
    return null;   // o CLI cai no casamento por URL, como já fazia
  } finally {
    if (!jaAnexado) { try { dbg.detach(); } catch { /* já solto */ } }
  }
}

function gravarSidecarNav(chave) {
  const reg = registros.get(chave);
  if (!reg || !reg.abas.size) return;
  const abas = [...reg.abas].map(([id, e]) => {
    const wc = e.view.webContents;
    const vivo = wc && !wc.isDestroyed();
    // A url gravada cai na PEDIDA quando o alvo ainda não navegou: no instante da criação ele está
    // em about:blank, que não é endereço de nada. Ela é só o plano B de quem não tem targetId.
    return { id, url: (vivo && wc.getURL()) || e.urlPedida, titulo: vivo ? wc.getTitle() : '', targetId: e.targetId };
  });
  const ativa = abas.find((x) => x.id === reg.ativa) || abas[0];
  try {
    fs.mkdirSync(NAV_SIDECARS, { recursive: true });
    const arq = path.join(NAV_SIDECARS, `${nomeSidecar(chave)}.json`);
    // O tmp leva o pid: duas janelas do app são o MESMO processo, mas o nome fixo ainda deixaria
    // duas gravações da mesma chave se sobreporem no rename.
    const tmp = path.join(NAV_SIDECARS, `.${nomeSidecar(chave)}.${process.pid}.tmp`);
    // `url` e `targetId` no TOPO continuam sendo os da ativa: é só isso que o backend lê, e
    // `ativa`/`abas` entram AO LADO — por isso o Python não muda.
    fs.writeFileSync(tmp, JSON.stringify({
      chave, url: ativa.url, targetId: ativa.targetId, ts: Date.now(), ativa: reg.ativa, abas,
    }));
    fs.renameSync(tmp, arq);
  } catch (err) {
    console.error('[nav] sidecar nao gravado:', err?.message || err);
  }
}

// O targetId chega depois (pergunta ao próprio alvo por CDP); a aba pode ter fechado nesse meio.
async function registrarTargetId(chave, id, view) {
  const tid = await targetIdDe(view);
  const entrada = registros.get(chave)?.abas.get(id);
  if (!entrada || entrada.view !== view) return;   // aba já fechou
  entrada.targetId = tid;
  gravarSidecarNav(chave);
}

// Um lugar só monta o payload: a faixa de abas e os campos planos (url/carregando/voltar/avançar)
// têm que contar a MESMA verdade, e os planos são sempre os da ativa — front antigo lê só eles.
function publicarEstado(win, chave) {
  const reg = registros.get(chave);
  if (!reg || !win || win.isDestroyed()) return;
  const abas = [];
  for (const [id, entrada] of reg.abas) {
    const wc = entrada.view.webContents;
    if (!wc || wc.isDestroyed()) continue;
    abas.push({ id, url: wc.getURL(), titulo: wc.getTitle(), carregando: wc.isLoading() });
  }
  const ativa = reg.abas.get(reg.ativa)?.view?.webContents;
  const viva = ativa && !ativa.isDestroyed();
  win.webContents.send('hangar:nav-estado', {
    chave, ativa: reg.ativa, abas,
    layoutWidth: reg.layoutEstado.modo === 'custom' ? reg.layoutEstado.width : null,
    layoutHeight: reg.layoutEstado.modo === 'custom' ? reg.layoutEstado.height : null,
    layoutError: reg.layoutEstado.erro,
    url: viva ? ativa.getURL() : '',
    carregando: viva ? ativa.isLoading() : false,
    voltar: viva ? ativa.navigationHistory.canGoBack() : false,
    avancar: viva ? ativa.navigationHistory.canGoForward() : false,
  });
}

// O que o servidor local mostra no `tab list` e usa pra saber quantas abas há.
function abasDe(chave) {
  const reg = registros.get(chave);
  if (!reg || !reg.abas.size) return null;
  const abas = [...reg.abas].map(([id, e]) => {
    const wc = e.view.webContents;
    const vivo = wc && !wc.isDestroyed();
    return { id, url: vivo ? wc.getURL() || e.urlPedida : e.urlPedida, titulo: vivo ? wc.getTitle() : '' };
  });
  return { ativa: reg.ativa, abas };
}

// Uma aba nova nasce na janela e no estado de exibição da ATIVA: o agente que abre aba com a
// sessão fora da tela não pode puxar a janela pra frente, e o usuário que abre pelo + não pode
// ganhar uma aba invisível.
function criarAba(win, chave, { url, oculto, bounds = null } = {}) {
  const reg = regDe(chave);
  if (reg.abas.size >= TETO_ABAS) return { ok: false, motivo: 'teto' };
  // Aba SÓ nasce com URL: o reexibir (troca de sessão, reload do front) não passa por aqui.
  const destino = urlNavegavel(url);
  if (!destino) return { ok: false, motivo: 'url' };
  const anterior = reg.ativa != null ? reg.abas.get(reg.ativa) : null;
  const escondida = oculto ?? (anterior ? !anterior.view.getVisible() : false);
  // persist: cookies/localStorage no disco. COMPARTILHADA entre sessões de propósito — o uso é
  // cada sessão com suas URLs, não isolamento de conta; se um dia precisar, vira por-sessão.
  const view = new WebContentsView({ webPreferences: { partition: 'persist:nav' } });
  const wc = view.webContents;
  wc.setUserAgent(uaDeChrome(wc.getUserAgent()));
  // target=_blank vai pro navegador do sistema, mesmo padrão do cockpit.
  wc.setWindowOpenHandler(({ url: alvo }) => {
    if (/^https?:/i.test(alvo)) shell.openExternal(alvo);
    return { action: 'deny' };
  });
  // Escondido, o view carrega SOLTO e só entra na janela com a página pronta: é o primeiro load
  // de um view anexado que leva o teclado (anexar depois não leva). Solto ele não tem quadro,
  // por isso a anexação vem antes da emulação que o `avisarOculto` liga no mesmo evento.
  if (escondida) {
    // Load que falha também anexa: solto pra sempre, o view não teria print nem viewport e o
    // agente que o dirige não receberia erro nenhum — só um `shot` que nunca responde.
    const anexar = () => { wc.removeListener('did-finish-load', anexar); wc.removeListener('did-fail-load', falhou); anexarNaJanela(win, view); };
    const falhou = (_e, codigo, descricao) => { console.error(`[nav] ${chave}: load escondido falhou (${codigo} ${descricao})`); anexar(); };
    wc.once('did-finish-load', anexar);
    wc.once('did-fail-load', falhou);
  } else {
    anexarNaJanela(win, view);
  }
  const id = reg.proximoId++;
  abasDaJanela(win, chave).set(id, view);
  // Estado de navegação pro painel (barra de carregamento, ✕/↻, voltar/avançar, endereço que
  // acompanha os cliques). O view não tem DOM no cockpit — sem isto a página carrega em silêncio.
  for (const nome of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(nome, () => publicarEstado(win, chave));
  }
  wc.on('did-navigate', (_e, u) => {
    const entrada = reg.abas.get(id);
    if (entrada) entrada.urlPedida = u;
    gravarSidecarNav(chave);
  });
  wc.on('did-start-loading', () => ctl?.navegando?.(true));
  wc.on('did-stop-loading', () => ctl?.navegando?.(false));
  wc.on('did-finish-load', () => { devolverFoco(win, view); ctl?.recongelar(); });
  // Preenchimento de login com as senhas salvas do Chrome do usuário, ao terminar de carregar
  // uma página cujo domínio tem senha salva. Uma vez por URL (o `dom-ready` repete em SPA).
  let ultimoPreenchido = '';
  wc.on('dom-ready', () => {
    if (win.isDestroyed() || wc.isDestroyed()) return;
    let host = '';
    try { host = new URL(wc.getURL()).hostname; } catch { return; }
    const atual = wc.getURL();
    if (!host || atual === ultimoPreenchido) return;
    ultimoPreenchido = atual;
    preencherLogin(wc, host);
  });
  // O depurador fica ANEXADO enquanto o view viver: é o que dá tema, console e rede contínuos.
  // O `targetIdDe` que já existia anexa e solta na hora, e por isso não servia pra guardar estado.
  // `isAttached` antes: o Electron lança quando já há depurador anexado.
  let ctl = null;
  try {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    // Network e Accessibility ficam de fora de propósito: o controlador os liga no primeiro
    // verbo que precisa (são os dois que custam CPU o tempo todo, mesmo sem ninguém dirigir).
    for (const dominio of ['Runtime.enable', 'Log.enable', 'DOM.enable']) {
      dbg.sendCommand(dominio).catch(() => {});
    }
    ctl = criarControlador({
      dbg,
      capturarPagina: () => wc.capturePage(),
      aoNavegar: (cb) => wc.on('did-navigate', cb),
      layoutEstado: reg.layoutEstado,
      aoLayout: () => publicarEstado(win, chave),
      // Modo economia do Chromium (timers a 1 Hz, sem rAF) só sai enquanto um verbo dirige a aba
      // escondida; o que segura o compositor é o congelamento, no controlador.
      aoDirigir: (dirigindo) => { if (!wc.isDestroyed()) wc.setBackgroundThrottling(!dirigindo); },
    });
  } catch (err) {
    // Falha aqui custa os verbos novos, não o navegador: a aba entra no registro sem controlador
    // (quem depende dele checa antes) e o usuário navega na mão.
    console.error('[nav] depurador nao anexou:', err && err.message);
  }
  reg.abas.set(id, { ctl, view, urlPedida: destino, targetId: null });
  // Aba morta por fora (Target.closeTarget via CDP, crash do renderer) não passa pelo × nem pelo
  // `fecharAba`. A conferência de identidade impede um `destroyed` ATRASADO (o `close` do view é
  // assíncrono e a mesma chave pode ser reaberta antes de ele terminar) de apagar a aba NOVA:
  // quem morre só limpa o que é dele. Sem o `garantirAtiva`, a sessão ficava com abas vivas e sem
  // ativa, e o CLI respondia "nao tem navegador aberto" para todas elas.
  wc.once('destroyed', () => {
    if (abasDaJanela(win, chave).get(id) !== view) return;
    abasDaJanela(win, chave).delete(id);
    soltarControlador(chave, view);
    garantirAtiva(win, chave);
  });
  wc.loadURL(destino).catch((err) => console.error('[nav] loadURL falhou:', err?.message || err));
  // Nasce ESCONDIDA e sem emulação; quem exibe, emula e foca é `trocarAba` — um dono só para o
  // estado de tela evita dois views visíveis empilhados e aba sem viewport.
  view.setVisible(false);
  if (bounds) view.setBounds(normalizaBounds(bounds));
  registrarTargetId(chave, id, view);   // async, não bloqueia o IPC
  trocarAba(chave, id, { oculto: escondida });
  return { ok: true, id, view };
}

// Sessão que perdeu a ativa (aba morta por fora) volta a ter uma, no mesmo estado de tela das
// outras — sem isto o navegador existe e ninguém o alcança.
function garantirAtiva(win, chave) {
  const reg = registros.get(chave);
  if (!reg || !reg.abas.size) return;
  if (reg.ativa != null && reg.abas.has(reg.ativa)) return;
  // O -1 entra como "a fechada": id nenhum é negativo, então a escolha cai na primeira viva.
  const proxima = proximaAtiva([...reg.abas.keys(), -1], -1, reg.anterior ?? null);
  if (proxima != null) trocarAba(chave, proxima);
  if (win && !win.isDestroyed()) publicarEstado(win, chave);
}

// ÚNICO dono do estado de tela de uma aba: quem entra fica visível (ou escondida), recebe a
// emulação de tamanho e o teclado; quem sai é escondida. Espalhar isso por `criarAba` e
// `fecharAba` deixava dois views visíveis empilhados e aba sem viewport.
//
// O estado é HERDADO da aba que sai: com o navegador escondido (usuário noutra sessão), um
// `hangar-preview tab 2` não pode pintar o view por cima do chat — e, pior, tirar a emulação
// que dá viewport e print à aba que o agente acabou de ativar.
function trocarAba(chave, id, { oculto, bounds } = {}) {
  const reg = registros.get(chave);
  if (!reg || !reg.abas.has(id)) return { ok: false };
  const anterior = reg.ativa != null && reg.ativa !== id ? reg.abas.get(reg.ativa) : null;
  const nova = reg.abas.get(id);
  const win = janelaDoView(nova.view);
  // Sem pedido explícito, vale o que a anterior estava mostrando; sem anterior (primeira aba),
  // visível.
  const escondida = oculto ?? (anterior ? !anterior.view.getVisible() : false);
  const caixa = bounds ? normalizaBounds(bounds) : anterior?.view.getBounds?.();
  if (anterior) {
    // Escondida SEM `devolverFoco`: o teclado tem que ficar com a aba que entrou, não voltar
    // para o front.
    anterior.view.setVisible(false);
    avisarOculto(chave, anterior.view, true);
  }
  if (reg.ativa !== id) reg.anterior = reg.ativa;
  reg.ativa = id;
  if (caixa) nova.view.setBounds(caixa);
  if (escondida) {
    nova.view.setVisible(false);
  } else {
    if (win) anexarNaJanela(win, nova.view);
    nova.view.setVisible(true);
    // Clicar numa aba na faixa acontece no FRONT, que fica com o teclado; `setVisible` não foca.
    try { nova.view.webContents.focus(); } catch { /* view morrendo */ }
  }
  avisarOculto(chave, nova.view, escondida);
  gravarSidecarNav(chave);
  if (win) publicarEstado(win, chave);
  return { ok: true };
}

function janelaDoView(view) {
  if (!view) return null;
  for (const [win, porChave] of navegadores) {
    for (const abas of porChave.values()) if ([...abas.values()].includes(view)) return win;
  }
  return null;
}

function fecharAba(win, chave, id) {
  const reg = registros.get(chave);
  const alvo = id ?? reg?.ativa;
  if (!reg || alvo == null || !reg.abas.has(alvo)) return { ok: false, fechouNavegador: false, ativa: reg?.ativa ?? null };
  // Última aba: o navegador inteiro fecha — mesmo efeito do × da barra (view, controlador,
  // sidecar e aviso ao painel).
  if (reg.abas.size === 1) {
    fecharNavegador(win, chave);
    if (win && !win.isDestroyed()) win.webContents.send('hangar:nav-fechado', { chave });
    return { ok: true, fechouNavegador: true, ativa: null };
  }
  const view = reg.abas.get(alvo).view;
  // `soltarControlador` zera a ativa quando a fechada era ela: quem era a ativa se decide ANTES.
  const eraAtiva = reg.ativa === alvo;
  // A sucessora é escolhida antes de soltar (que apaga a entrada) e no estado de tela da que sai
  // — é `trocarAba` quem exibe.
  const escondida = !view.getVisible();
  const caixa = view.getBounds?.();
  const proxima = proximaAtiva([...reg.abas.keys()], alvo, reg.anterior ?? null);
  if (win) abasDaJanela(win, chave).delete(alvo);
  soltarControlador(chave, view);
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch (err) { console.error('[nav] fechar aba: removeChildView:', err && err.message); }
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (err) { console.error('[nav] fechar aba: close:', err && err.message); }
  if (eraAtiva && proxima != null) trocarAba(chave, proxima, { oculto: escondida, bounds: caixa });
  gravarSidecarNav(chave);
  if (win && !win.isDestroyed()) {
    win.webContents.send('hangar:nav-aba-fechada', { chave, id: alvo, ativa: reg.ativa });
    publicarEstado(win, chave);
  }
  return { ok: true, fechouNavegador: false, ativa: reg.ativa };
}

// A ATIVA da janela do remetente. Com a ativa global ausente daquela janela (duas janelas, mesma
// sessão), cai na primeira dela — é o view que aquele painel tem na tela.
function viewDe(ev, chave) {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const abas = win && navegadores.get(win)?.get(chave);
  if (!abas || !abas.size) return undefined;
  return abas.get(registros.get(chave)?.ativa) ?? abas.values().next().value;
}

// `oculto`: pedido que veio pelo stream da LISTA (agente abriu com a sessão fora da tela). O view
// nasce escondido e já carrega — o agente dirige via CDP desde já; o NavegadorPane reexibe quando
// o usuário abrir a sessão. View já VISÍVEL fica como está: ali quem manda é o painel montado.
ipcMain.handle('hangar:nav-open', async (ev, { chave, url, bounds, oculto } = {}) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win || !chave) return { ok: false };
  const abas = abasDaJanela(win, chave);
  const reg = regDe(chave);
  let id = reg.ativa != null && abas.has(reg.ativa) ? reg.ativa : ([...abas.keys()][0] ?? null);
  let view = id != null ? abas.get(id) : undefined;
  if (oculto && view && view.webContents && !view.webContents.isDestroyed() && view.getVisible?.()) return { ok: true, oculto: true };
  // O webContents pode ter morrido por fora (fechado via CDP Target.closeTarget, crash do
  // renderer): sem esta checagem o view volta invisível e nunca mais pinta — a área fica preta.
  // Medido: um Target.closeTarget externo pode deixar `view.webContents` undefined (não só
  // isDestroyed()===true) — sem o `!view.webContents` o acesso a `.isDestroyed()` lança e derruba
  // o handler do IPC inteiro, antes de soltar o controlador.
  if (view && (!view.webContents || view.webContents.isDestroyed())) {
    abas.delete(id);
    soltarControlador(chave, view);
    try { win.contentView.removeChildView(view); } catch { /* já saiu */ }
    view = undefined;
    id = null;
  }
  if (!view) {
    // Aba nova SÓ nasce com URL; o reexibir (troca de sessão, reload do front) chama open sem
    // url e recebe ok:false se o shell já não tiver o view — aí o front repete com a url salva.
    // Escondida, ela ainda não tem retângulo nenhum: quem manda bounds é o painel montado.
    const r = criarAba(win, chave, { url, oculto: !!oculto, bounds: oculto ? null : bounds });
    if (!r.ok) return { ok: false };
    view = r.view;
  } else {
    // Reexibir NUNCA recarrega: a URL atual do view pode ter mudado por navegação interna (o
    // agente clicou em links) e o front só manda `url` quando o usuário digita uma nova.
    const destino = url ? urlNavegavel(url) : null;
    if (destino && view.webContents.getURL() !== destino) {
      // Acordar ANTES do loadURL, e esperar: aqui a aba escondida está congelada desde o último
      // verbo, e navegar documento congelado é o que derruba a sessão do depurador. O
      // `did-start-loading` chegaria tarde demais — a troca de página já teria começado.
      await ctlDoView(chave, view)?.navegando?.(true);
      view.webContents.loadURL(destino);
    }
    // Exibir, esconder, emular tamanho e posicionar é tudo do `trocarAba`: um dono só pro estado
    // de tela. Escondido, a página fica em 0x0 e sem quadro — quem devolve viewport de desktop e
    // print é a emulação de tamanho, e ela SÓ entra com a página carregada (antes disso, SIGSEGV).
    trocarAba(chave, id, { oculto: !!oculto, bounds: oculto ? undefined : bounds });
  }
  // Quem chama este handler é o painel montando (ou remontando): ele perdeu tudo que foi
  // publicado antes de existir, e sem esta publicação a faixa de abas só apareceria na próxima
  // navegação — reabrir o navegador com uma aba só deixava a faixa invisível para sempre.
  publicarEstado(win, chave);
  if (oculto) {
    devolverFoco(win, view);
    // `oculto: true` na resposta é a prova de que este shell entendeu o pedido: um shell antigo
    // ignora o campo, cria o view visível com bounds zero e devolve só {ok} — o front não confirma.
    return { ok: true, oculto: true };
  }
  return { ok: true };
});

// A aba nova nasce na janela da ativa e herda o estado de tela dela — quem decide isso é o
// `trocarAba` que o `criarAba` chama, não este handler.
ipcMain.handle('hangar:nav-tab-new', async (ev, { chave, url } = {}) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  if (!win || !chave) return { ok: false, motivo: 'sessao' };
  const r = criarAba(win, chave, { url });
  if (!r.ok) return r;
  gravarSidecarNav(chave);
  publicarEstado(win, chave);
  return { ok: true, id: r.id };
});

ipcMain.handle('hangar:nav-tab-switch', async (ev, { chave, id } = {}) => trocarAba(chave, id));

ipcMain.handle('hangar:nav-tab-close', async (ev, { chave, id } = {}) =>
  fecharAba(BrowserWindow.fromWebContents(ev.sender), chave, id));

ipcMain.on('hangar:nav-hide', (ev, { chave } = {}) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const view = viewDe(ev, chave);
  if (!view) return;
  view.setVisible(false);
  // Sair da tela é o mesmo estado do view que nasceu escondido: sem a emulação, o agente que
  // continuar dirigindo esta sessão passa a ler uma página de 0x0.
  avisarOculto(chave, view, true);
  devolverFoco(win, view);
});

ipcMain.on('hangar:nav-bounds', (ev, { chave, bounds } = {}) => {
  const view = viewDe(ev, chave);
  if (view) view.setBounds(normalizaBounds(bounds));
});

// Cookies do Chrome real -> partição do navegador embutido. Nunca rejeita: o front lê `erro`.
// Porta: argumento > `chromeCdpPort` das configurações > 9222.
// Porta SEMPRE inteiro: no Windows o spawn roda com `shell: true` e o valor vai numa linha de
// comando — um settings.json adulterado ou um caller de IPC com "9226 & calc" executaria isso.
const portaValida = (v) => (Number.isInteger(+v) && +v > 0 && +v < 65536 ? +v : null);
const PORTA_CHROME = () => portaValida(ler(app.getPath('userData')).chromeCdpPort) || null;

// Abre `chrome://inspect/#remote-debugging` no Chrome do usuário (na instância que já está
// aberta, ou abrindo uma). O Chrome 136+ não aceita `--remote-debugging-port` no perfil padrão;
// o que liga a depuração é o toggle dessa página, que grava o `DevToolsActivePort` que o
// `cookies_chrome.cjs` lê. NÃO se lança o Chrome direto deste processo: o filho herdava o socket
// do CDP do próprio shell (a 9223) e o segurava depois de o shell fechar — por isso o `sh` que
// fecha todo descritor acima de 2 antes do exec.
ipcMain.handle('hangar:chrome-ativar', async () => {
  const { spawn } = require('child_process');
  const url = PAGINA_ATIVAR;
  // O Chrome em execução recusa `chrome://` vindo da linha de comando (abre uma "Nova guia" em
  // branco, medido no Chrome 150). Então o endereço vai pra área de transferência e a instrução
  // manda colar na barra — a aba nova que o Chrome abre já deixa a janela dele na frente.
  clipboard.writeText(url);
  const candidatos = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', 'chrome', url]]]
    : process.platform === 'darwin'
      ? [['open', ['-a', 'Google Chrome', url]]]
      : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave'].map((bin) =>
        ['sh', ['-c', 'for fd in $(seq 3 1023); do eval "exec $fd>&-"; done 2>/dev/null; exec "$0" "$@"', bin, url]]);
  for (const [cmd, args] of candidatos) {
    const ch = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // ENOENT chega pelo evento `error`, não por exceção. O `sh` sempre nasce; o binário
    // inexistente aparece como saída 127 logo em seguida.
    const ok = await new Promise((res) => {
      ch.once('error', () => res(false));
      ch.once('exit', (code) => res(code !== 127));
      setTimeout(() => res(true), 1500);   // ainda rodando = abriu
    });
    if (ok) { ch.unref(); return { ok: true }; }
  }
  return { ok: false, motivo: 'sem_binario' };
});

ipcMain.handle('hangar:nav-import-cookies', async (ev, { chave, host, porta, recarregar = true } = {}) => {
  if (!host) return { ok: false, gravados: 0, falhos: 0, erro: 'sem_host' };
  const p = portaValida(porta) || PORTA_CHROME();
  let cookies;
  try {
    cookies = await importarCookiesDoChrome({ porta: p, dominio: host });
  } catch (e) {
    return { ok: false, gravados: 0, falhos: 0, erro: e.code || 'cdp', detalhe: e.message };
  }
  const ses = session.fromPartition('persist:nav');
  let gravados = 0, falhos = 0;
  for (const c of cookies) {
    try { await ses.cookies.set(c); gravados++; } catch { falhos++; }
  }
  // Reload só quando pedido: a importação automática roda em cima de uma navegação que pode ser
  // do agente (hangar-preview) no meio de um formulário — recarregar ali jogaria o estado fora.
  const view = viewDe(ev, chave);
  if (view && gravados && recarregar) view.webContents.reload();
  return { ok: true, gravados, falhos };
});

ipcMain.on('hangar:nav-reload', (ev, { chave } = {}) => {
  const view = viewDe(ev, chave);
  if (view) view.webContents.reload();
});
ipcMain.on('hangar:nav-stop', (ev, { chave } = {}) => { viewDe(ev, chave)?.webContents.stop(); });
ipcMain.on('hangar:nav-back', (ev, { chave } = {}) => {
  const wc = viewDe(ev, chave)?.webContents;
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
});
ipcMain.on('hangar:nav-forward', (ev, { chave } = {}) => {
  const wc = viewDe(ev, chave)?.webContents;
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
});

ipcMain.on('hangar:nav-close', (ev, { chave } = {}) => fecharNavegador(BrowserWindow.fromWebContents(ev.sender), chave));

// Seletor nativo de pasta (window.hangar.pickFolder, via preload.cjs). Registrado UMA vez, fora
// do criarJanela — handler duplicado por janela é erro do ipcMain. O diálogo ancora na janela que
// pediu, senão ele nasce solto e pode cair atrás do app.
// Reabrir o app depois de uma atualização que tocou shell/: `relaunch` agenda uma instância nova
// com os mesmos argumentos e `exit` derruba esta — é o único jeito de carregar o main.cjs novo.
ipcMain.handle('hangar:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// Reinício do serviço POR FORA dele. O botão da tela de Máquinas pede pelo próprio backend, e
// serviço travado não atende o próprio pedido — aqui quem manda é o systemd, então trava não
// impede. Só Linux/systemd: nas outras topologias quem sobe e desce o serviço é o instalador, e
// inventar um kill no processo de alguém seria pior que recusar (mesma regra do atualizar.py).
ipcMain.handle('hangar:reiniciar-servico', async () => {
  if (process.platform !== 'linux') return { ok: false, motivo: 'plataforma' };
  const { execFile } = require('child_process');
  return new Promise((res) => {
    execFile('systemctl', ['--user', 'restart', 'hangar-backend.service'], { timeout: 30000 }, (err) => {
      if (!err) return res({ ok: true });
      res({ ok: false, motivo: err.code === 'ENOENT' ? 'sem_systemd' : 'falhou', detalhe: String(err.message || err) });
    });
  });
});

ipcMain.handle('hangar:pick-folder', async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const r = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory'] })
                       : dialog.showOpenDialog({ properties: ['openDirectory'] }));
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => abrirJanela('segunda janela'));
  app.whenReady().then(() => {
    // Servidor de dev com certificado auto-assinado (ex.: ApiGateway em https://localhost) só abre
    // no navegador embutido e só em loopback. -3 devolve a decisão ao Chromium pra todo o resto.
    // Vale pra toda conexão da sessão, websocket incluído, e nunca pra janela do app.
    session.fromPartition('persist:nav').setCertificateVerifyProc((req, cb) => cb(hostLoopback(req.hostname) ? 0 : -3));
    limparSidecaresNav();
    subirServidor({
      controladorDe: (chave, aba) => entradaDe(chave, aba)?.ctl || null,
      fecharDe: fecharNavegadorPorChave,
      abasDe,
      // A janela é a da aba ativa: aba nova nasce ao lado da que está na tela, não numa janela
      // que o CLI teria de escolher no escuro.
      abaNova: (chave, url) => {
        const ativa = entradaDe(chave);
        const win = janelaDoView(ativa?.view);
        if (!win) return { ok: false };
        const r = criarAba(win, chave, {
          url,
          oculto: ativa ? !ativa.view.getVisible() : false,
          bounds: ativa && ativa.view.getBounds ? ativa.view.getBounds() : null,
        });
        if (r.ok) { gravarSidecarNav(chave); publicarEstado(win, chave); }
        return r;
      },
      abaTrocar: (chave, id) => trocarAba(chave, id),
      abaFechar: (chave, id) => fecharAba(janelaDoView(entradaDe(chave, id)?.view), chave, id),
      escrever: (dados) => {
        fs.mkdirSync(NAV_SIDECARS, { recursive: true });
        fs.writeFileSync(path.join(NAV_SIDECARS, '_srv.json'), JSON.stringify(dados), { mode: 0o600 });
      },
    }).catch((err) => console.error('[nav] servidor do preview nao subiu:', err && err.message));
    abrirJanela('arranque');
  });
}

app.on('window-all-closed', () => app.quit());

// `limparSidecaresNav` pula `_srv.json` de propósito (é do processo VIVO) — ninguém mais o
// apagava na saída. Sem isto, o CLI encontrava o arquivo de uma execução morta e falava com
// qualquer processo que tivesse reciclado aquela porta de loopback, imprimindo a resposta dele
// como se fosse do navegador. `will-quit` roda mesmo em `app.quit()` disparado por sinal.
app.on('will-quit', () => {
  try { fs.rmSync(path.join(NAV_SIDECARS, '_srv.json'), { force: true }); } catch { /* ja sumiu */ }
});
