/**
 * Movable panel blocks: every card and slider group in the side panel can be
 * put in any order — drag its ⠿ handle (mouse or touch), or ↑ / ↓ (also the
 * arrow keys on the handle). The order is remembered on this device; 重設區塊
 * 順序 restores the default.
 *
 * A block is a direct child of the panel with `data-block` (its storage key)
 * and a header (`h3` or `summary`) that receives the controls.
 */
const KEY = 'uwStudio.blockOrder.v1';

const load = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const store = (keys: string[] | null) => {
  try {
    if (keys) localStorage.setItem(KEY, JSON.stringify(keys));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the order just isn't remembered */
  }
};

export function movableBlocks(panel: HTMLElement, end: HTMLElement) {
  const blocks = () => [...panel.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.block);
  const keys = () => blocks().map((b) => b.dataset.block!);
  const initial = keys();

  const place = (order: string[]) => {
    const byKey = new Map(blocks().map((b) => [b.dataset.block!, b]));
    // saved keys first, then any block the saved order doesn't know (new in an update)
    for (const k of [...order.filter((k) => byKey.has(k)), ...initial.filter((k) => !order.includes(k))]) panel.insertBefore(byKey.get(k)!, end);
  };
  const changed = () => {
    const k = keys();
    store(k.join() === initial.join() ? null : k);
    end.classList.toggle('hidden', k.join() === initial.join());
  };

  const move = (b: HTMLElement, to: number) => {
    const list = blocks().filter((x) => x !== b);
    to = Math.max(0, Math.min(list.length, to));
    panel.insertBefore(b, list[to] ?? end);
    changed();
  };
  const flash = (b: HTMLElement) => {
    b.classList.remove('blk-moved');
    void b.offsetWidth;
    b.classList.add('blk-moved');
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  for (const b of blocks()) {
    const head = b.querySelector<HTMLElement>(':scope > h3, :scope > summary');
    if (!head) continue;
    const name = (head.firstChild?.textContent ?? b.dataset.block!).trim();
    const ctl = document.createElement('span');
    ctl.className = 'blk-ctl';
    ctl.innerHTML =
      `<button type="button" class="blk-btn" data-dir="-1" title="上移" aria-label="${name} 上移">↑</button>` +
      `<button type="button" class="blk-btn" data-dir="1" title="下移" aria-label="${name} 下移">↓</button>` +
      `<span class="blk-grip" tabindex="0" role="button" title="拖曳移動這個區塊（方向鍵也可以）" aria-label="${name}：拖曳或方向鍵移動">⠿</span>`;
    head.append(ctl);
    // inside a <summary>, a click must not open / close the group
    ctl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = Number((e.target as HTMLElement).closest<HTMLElement>('[data-dir]')?.dataset.dir);
      if (!dir) return;
      move(b, blocks().indexOf(b) + dir);
      flash(b);
    });
    const grip = ctl.querySelector<HTMLElement>('.blk-grip')!;
    grip.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      move(b, blocks().indexOf(b) + dir);
      grip.focus();
      flash(b);
    });

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // listen on window, not with pointer capture: moving the block in the
      // DOM releases the grip's capture after the first step
      const id = e.pointerId;
      b.classList.add('blk-drag');
      panel.classList.add('blk-sorting');
      let y = e.clientY;
      let raf = 0;
      // the block follows the pointer: it goes before the first other block
      // whose middle is below the pointer
      const reorder = () => {
        const others = blocks().filter((x) => x !== b);
        const next = others.find((o) => {
          const r = o.getBoundingClientRect();
          return y < r.top + r.height / 2;
        });
        const ref = next ?? end;
        if (b.nextElementSibling !== ref) panel.insertBefore(b, ref);
      };
      // near the top / bottom of the window, scroll so far blocks can be reached
      const tick = () => {
        const edge = 70;
        const v = y < edge ? -(edge - y) / 4 : y > innerHeight - edge ? (y - (innerHeight - edge)) / 4 : 0;
        if (v) {
          scrollBy(0, v);
          reorder();
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        ev.preventDefault();
        y = ev.clientY;
        reorder();
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        cancelAnimationFrame(raf);
        removeEventListener('pointermove', onMove);
        removeEventListener('pointerup', onUp);
        removeEventListener('pointercancel', onUp);
        b.classList.remove('blk-drag');
        panel.classList.remove('blk-sorting');
        changed();
        flash(b);
      };
      addEventListener('pointermove', onMove, { passive: false });
      addEventListener('pointerup', onUp);
      addEventListener('pointercancel', onUp);
    });
  }

  end.addEventListener('click', () => {
    place(initial);
    changed();
  });
  place(load());
  changed();

  return {
    /** Block keys in panel order. */
    order: keys,
    /** Move a block to position `to` (test hook). */
    move(key: string, to: number) {
      const b = blocks().find((x) => x.dataset.block === key);
      if (b) move(b, to);
    },
  };
}
