// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import NavegadorPane from './NavegadorPane.svelte';
import * as bridge from '../lib/navegadorNativo';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['alertdialog', '', true],
  ['dialog', '', true],
  ['dialog', 'board-overlay', false],
] as const)('sincroniza navegador ao abrir e fechar %s %s', async (role, className, hidden) => {
  const bounds = vi.fn();
  const rect = { x: 640, y: 80, width: 600, height: 720 };
  vi.spyOn(bridge, 'navegadorNativo').mockReturnValue({
    open: vi.fn().mockResolvedValue({ ok: true }),
    hide: vi.fn(), bounds, reload: vi.fn(), close: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(rect.x, rect.y, rect.width, rect.height));
  const target = document.createElement('div');
  const backdrop = document.createElement('div');
  document.body.append(target);
  const component = mount(NavegadorPane, { target, props: { navKey: 'server::session' } });
  try {
    await tick();
    // O portal monta primeiro; o diálogo pode chegar depois, dentro dele.
    document.body.append(backdrop);
    await vi.waitFor(() => expect(bounds).toHaveBeenLastCalledWith('server::session', rect));
    bounds.mockClear();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', role);
    dialog.className = className;
    backdrop.append(dialog);
    await vi.waitFor(() => expect(bounds).toHaveBeenLastCalledWith('server::session',
      hidden ? { x: 0, y: 0, width: 0, height: 0 } : rect));
    bounds.mockClear();
    backdrop.remove();
    await vi.waitFor(() => expect(bounds).toHaveBeenLastCalledWith('server::session', rect));
  } finally {
    await unmount(component);
    target.remove();
    backdrop.remove();
  }
});
