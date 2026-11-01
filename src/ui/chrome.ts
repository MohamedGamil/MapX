// The dashboard's frame (M4-17): theme toggle, the navigation drawer on narrow screens, and the
// graph's details panel, which opens on a selection and closes from its button or Escape.

const THEME_KEY = 'mapx-theme';
type Theme = 'light' | 'dark';

function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // storage blocked
  }
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * The theme toggle. The inline script in index.html applied the saved theme, else the system's,
 * before first paint; this keeps following the system until the user picks one, which persists.
 */
export function initTheme(onChange: (theme: Theme) => void) {
  const button = document.getElementById('btn-theme');
  const apply = (theme: Theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    button?.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    button?.setAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    onChange(theme);
  };
  apply(currentTheme());
  button?.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked: this page only */ }
    apply(next);
  });
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  media?.addEventListener?.('change', (e) => { if (!savedTheme()) apply(e.matches ? 'light' : 'dark'); });
}

/** Below 640 px the sidebar is a drawer behind the menu button. */
export function initNavDrawer() {
  const layout = document.querySelector('.app-layout');
  const open = document.getElementById('btn-nav-open');
  const backdrop = document.getElementById('nav-backdrop');
  const title = document.getElementById('mobile-title');
  const setOpen = (isOpen: boolean) => {
    layout?.classList.toggle('nav-open', isOpen);
    open?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) (document.querySelector('.nav-item.active') as HTMLElement | null)?.focus();
  };
  open?.addEventListener('click', () => setOpen(!layout?.classList.contains('nav-open')));
  backdrop?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && layout?.classList.contains('nav-open')) {
      setOpen(false);
      open?.focus();
    }
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      if (title) title.textContent = item.getAttribute('aria-label') ?? '';
      if (layout?.classList.contains('nav-open')) setOpen(false);
    });
  });
}

export const DETAILS_PLACEHOLDER = 'Click a file node or dependency edge to view details.';

/**
 * The graph's details panel takes room only while something is selected: it opens when the
 * details content changes from the placeholder, and its close button or Escape clears it.
 */
export function initDetailsPanel(onClose: () => void, onResize: () => void) {
  const container = document.querySelector('.graph-container');
  const content = document.getElementById('details-content');
  if (!container || !content) return;
  const sync = () => {
    const open = (content.textContent ?? '').trim() !== DETAILS_PLACEHOLDER;
    if (container.classList.contains('has-selection') !== open) {
      container.classList.toggle('has-selection', open);
      onResize();
    }
  };
  new MutationObserver(sync).observe(content, { childList: true, subtree: true, characterData: true });
  sync();
  const close = () => {
    onClose();
    content.innerHTML = DETAILS_PLACEHOLDER;
  };
  document.getElementById('btn-details-close')?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && container.classList.contains('has-selection') && !document.querySelector('.app-layout.nav-open')) close();
  });
}
