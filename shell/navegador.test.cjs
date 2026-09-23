const test = require('node:test');
const assert = require('node:assert/strict');
const { uaDeChrome, normalizaBounds, urlNavegavel, nomeSidecar, proximaAtiva, hostLoopback } = require('./navegador.cjs');

test('hostLoopback aceita só loopback de verdade', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(hostLoopback(h), true, h);
  for (const h of ['localhost.exemplo.com', '127.0.0.1.nip.io', '10.0.0.1', '128.0.0.1', '127.0.0.256', 'exemplo.com', '', null]) {
    assert.equal(hostLoopback(h), false, String(h));
  }
});

test('uaDeChrome remove marcas de app e vira Chrome vanilla', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) hangar/0.1.3 Chrome/142.0.0.0 Electron/43.3.0 Safari/537.36 hangar-shell';
  assert.equal(
    uaDeChrome(ua),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  );
});

test('uaDeChrome em UA já limpo não muda nada', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  assert.equal(uaDeChrome(ua), ua);
});

test('normalizaBounds arredonda float de getBoundingClientRect e corta negativo', () => {
  assert.deepEqual(
    normalizaBounds({ x: 10.6, y: -3, width: 800.4, height: 600 }),
    { x: 11, y: 0, width: 800, height: 600 },
  );
  assert.deepEqual(normalizaBounds(undefined), { x: 0, y: 0, width: 0, height: 0 });
});

test('urlNavegavel aceita http(s) e recusa o resto', () => {
  assert.equal(urlNavegavel('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(urlNavegavel('https://exemplo.com'), 'https://exemplo.com/');
  assert.equal(urlNavegavel('file:///etc/passwd'), null);
  assert.equal(urlNavegavel('javascript:alert(1)'), null);
  assert.equal(urlNavegavel('não é url'), null);
});

test('proximaAtiva prefere a aba criada logo antes, senao a seguinte', () => {
  // Fechou a 2 com a 1 tendo sido a anterior: volta pra 1.
  assert.equal(proximaAtiva([1, 3, 5], 2, 1), 1);
  // Sem anterior valido (ela tambem ja morreu): a seguinte em ordem de id.
  assert.equal(proximaAtiva([1, 3, 5], 2, null), 3);
  assert.equal(proximaAtiva([1, 3, 5], 9, null), 1, 'fechou a ultima: volta pra primeira');
  assert.equal(proximaAtiva([], 1, null), null, 'sem abas nao ha ativa');
  assert.equal(proximaAtiva([1, 3], 2, 7), 3, 'anterior que nao existe mais nao vale');
});

test('nomeSidecar: chave vira nome de arquivo seguro, com sufixo casável', () => {
  assert.equal(nomeSidecar('srv-abc123::hangar'), 'srv-abc123--hangar');
  assert.equal(nomeSidecar('srv-x::minha sessao/noite'), 'srv-x--minha-sessao-noite');
  // o CLI casa pelo sufixo `--<nome da sessão>.json`
  assert.ok(nomeSidecar('srv-x::hangar').endsWith('--hangar'));
});
