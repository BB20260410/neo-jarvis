const ACTION_BUTTON_IDS = [
  'btnVision',
  'btnLive',
  'btnNoeVoiceLive',
  'btnCommandSurface',
  'btnTaskFlow',
  'btnAcuiCards',
  'btnLocalWiki',
  'btnWebSearch',
  'btnDeepResearch',
];

const $ = (selector) => document.querySelector(selector);

function installStyle() {
  if ($('#cognitiveActionDrawerStyle')) return;
  const style = document.createElement('style');
  style.id = 'cognitiveActionDrawerStyle';
  style.textContent = `
#cognitiveActionDrawer{position:relative;flex:0 0 auto;display:flex;align-items:center}
#cognitiveActionDrawerToggle{min-width:72px}
#cognitiveActionDrawerPanel{position:absolute;right:0;bottom:calc(100% + 10px);display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:min(390px,calc(100vw - 32px));padding:10px;border:1px solid var(--line-strong);border-radius:12px;background:rgba(7,13,24,.96);backdrop-filter:blur(18px);box-shadow:0 18px 52px rgba(0,0,0,.38);z-index:45}
#cognitiveActionDrawer.open #cognitiveActionDrawerPanel{display:grid}
#input-row #cognitiveActionDrawerPanel .cbtn,#input-row #cognitiveActionDrawerPanel .cbtn[data-icon]{width:100%;height:auto;min-height:40px;padding:8px 10px;border-radius:9px;font-size:11px;letter-spacing:0;display:flex;align-items:center;justify-content:flex-start;text-align:left}
#input-row #cognitiveActionDrawerPanel .cbtn[data-icon]::before{content:none}
@media(max-width:520px){#cognitiveActionDrawerPanel{right:auto;left:50%;transform:translateX(-50%);grid-template-columns:1fr;width:min(300px,calc(100vw - 24px))}#cognitiveActionDrawerToggle{min-width:42px;font-size:0}#cognitiveActionDrawerToggle::before{content:'⚙';font-size:15px}}`;
  document.head.appendChild(style);
}

function ensureDrawer() {
  installStyle();
  const row = $('#input-row');
  const send = $('#send-btn');
  if (!row || !send) return null;
  let drawer = $('#cognitiveActionDrawer');
  if (!drawer) {
    drawer = document.createElement('div');
    drawer.id = 'cognitiveActionDrawer';
    drawer.innerHTML = '<button type="button" class="cbtn" id="cognitiveActionDrawerToggle" title="配置与工具">⚙ 配置</button><div id="cognitiveActionDrawerPanel" role="menu" aria-label="配置与工具"></div>';
    row.insertBefore(drawer, send);
    const toggle = drawer.querySelector('#cognitiveActionDrawerToggle');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      drawer.classList.toggle('open');
      toggle.setAttribute('aria-expanded', drawer.classList.contains('open') ? 'true' : 'false');
    });
    document.addEventListener('click', (event) => {
      if (!drawer.contains(event.target)) drawer.classList.remove('open');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') drawer.classList.remove('open');
    });
  } else if (drawer.parentElement !== row) {
    row.insertBefore(drawer, send);
  }
  return drawer;
}

function buttonOrder(button) {
  const index = ACTION_BUTTON_IDS.indexOf(button.id);
  return index === -1 ? ACTION_BUTTON_IDS.length : index;
}

function syncActionDrawer() {
  const drawer = ensureDrawer();
  const panel = drawer?.querySelector('#cognitiveActionDrawerPanel');
  if (!panel) return false;
  const buttons = ACTION_BUTTON_IDS
    .map((id) => document.getElementById(id))
    .filter((button, index, rows) => button && rows.indexOf(button) === index)
    .sort((a, b) => buttonOrder(a) - buttonOrder(b));
  const same = buttons.length === panel.children.length
    && buttons.every((button, index) => panel.children[index] === button);
  if (!same) {
    for (const button of buttons) {
      button.type = 'button';
      button.classList.add('cognitive-action-item');
      panel.appendChild(button);
    }
  }
  const toggle = drawer.querySelector('#cognitiveActionDrawerToggle');
  if (toggle) toggle.disabled = buttons.length === 0;
  return buttons.length > 0;
}

function install() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      syncActionDrawer();
    });
  };
  syncActionDrawer();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(schedule, 250);
  setTimeout(schedule, 1000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}
