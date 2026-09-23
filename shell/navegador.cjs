// Lógica PURA do navegador embutido (o main.cjs é todo efeito: IPC, janela, view). Separado pra
// rodar no `node --test` sem bootar Electron — mesmo padrão do settings.cjs.

// O Google bloqueia login em browser embutido e detecta o Electron pela marca "Electron/x.y" no
// user agent. Deriva do UA que o próprio Chromium já manda (hardcoded envelhece e vira mentira)
// tirando as marcas de app. SÓ o view do navegador usa isto — o UA do cockpit carrega a marca
// `hangar-shell`, que é como o front detecta o shell (background.ts) pra ligar transparência.
function uaDeChrome(ua) {
  return String(ua)
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/\s+hangar\/\S+/g, '')
    .replace(/\s+hangar-shell\b/g, '')
    .trim();
}

// getBoundingClientRect devolve floats e o setBounds exige int; área zerada = escondido (o front
// manda rect zerado quando o painel sai da tela, em vez de fechar o view).
function normalizaBounds(b) {
  const r = (n) => Math.max(0, Math.round(Number(n) || 0));
  return { x: r(b && b.x), y: r(b && b.y), width: r(b && b.width), height: r(b && b.height) };
}

// Só http(s) navega no painel — file:, data:, javascript: ficam de fora por construção.
function urlNavegavel(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

// A chave da sessão (serverId::nome) vira nome de arquivo de sidecar em ~/.hangar/nav/.
// `::` e qualquer coisa hostil a path viram traço — o CLI casa pelo SUFIXO `--<nome>.json`.
function nomeSidecar(chave) {
  return String(chave).replace(/::/g, '--').replace(/[^\w.-]+/g, '-');
}

// Qual aba fica ativa quando a atual fecha. A criada logo antes (o "anterior") é a que o usuário
// tinha na tela e espera de volta, como no Chrome; sem ela, a de id seguinte.
function proximaAtiva(ids, fechada, anterior) {
  const vivos = [...ids].filter((i) => i !== fechada).sort((a, b) => a - b);
  if (!vivos.length) return null;
  if (anterior != null && vivos.includes(anterior)) return anterior;
  return vivos.find((i) => i > fechada) ?? vivos[0];
}

// Host de loopback: o único onde certificado inválido passa (servidor de dev com auto-assinado).
// Nome que só PARECE local (`localhost.exemplo.com`, `127.0.0.1.nip.io`) não conta.
function hostLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

module.exports = { uaDeChrome, normalizaBounds, urlNavegavel, nomeSidecar, proximaAtiva, hostLoopback };
