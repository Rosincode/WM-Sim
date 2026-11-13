// Menu rechtsboven: alles wat je niet de hele tijd hoeft te zien (besturing, spelers, WMS-API, API-log,
// voorraad) zit achter één knop. Onderdelen melden zich aan met addSection(); Tab opent en sluit het menu.

const css = `
.menu-btn { position: fixed; right: 16px; top: 16px; z-index: 61; padding: 8px 14px; border: 0; border-radius: 8px;
  background: rgba(0,0,0,.65); color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; user-select: none; }
.menu-btn:hover, .menu-btn.on { background: rgba(0,0,0,.85); }
.menu-btn .key { margin-left: 8px; color: #9aa0a6; font-weight: 400; font-size: 12px; }
.menu-btn .dot, .menu-panel .tabs .dot { display: none; width: 8px; height: 8px; margin-left: 6px; border-radius: 50%;
  background: #ff5252; vertical-align: middle; }
.menu-btn.alert .dot, .menu-panel .tabs button.alert .dot { display: inline-block; }
.menu-panel { position: fixed; right: 16px; top: 60px; z-index: 60; display: none; flex-direction: column;
  width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 76px); box-sizing: border-box; padding: 12px 14px;
  border-radius: 10px; background: rgba(12,14,17,.88); color: #fff; font: 13px system-ui, sans-serif; line-height: 1.5;
  box-shadow: 0 10px 34px rgba(0,0,0,.45); }
.menu-panel.open { display: flex; }
.menu-panel .tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.menu-panel .tabs button { padding: 4px 10px; border: 0; border-radius: 5px; background: #3a4047; color: #fff; font: inherit; cursor: pointer; }
.menu-panel .tabs button.on { background: #3b6ea5; }
.menu-panel .body { overflow-y: auto; min-height: 0; }
`;

type Section = { id: string; order: number; el: HTMLElement; tab: HTMLButtonElement };

function createMenu() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.className = 'menu-btn';
  button.title = 'Besturing, spelers, WMS-API, API-log en voorraad';
  button.innerHTML = '☰ Menu<span class="dot"></span><span class="key">Tab</span>';
  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const body = document.createElement('div');
  body.className = 'body';
  panel.append(tabs, body);
  document.body.append(button, panel);

  const sections: Section[] = [];
  let current = '';
  let isOpen = false;

  function refresh() {
    panel.classList.toggle('open', isOpen);
    button.classList.toggle('on', isOpen);
    for (const s of sections) {
      const shown = s.id === current;
      s.el.style.display = shown ? '' : 'none';
      s.tab.classList.toggle('on', shown);
      if (shown && isOpen) s.tab.classList.remove('alert');
    }
    button.classList.toggle('alert', sections.some((s) => s.tab.classList.contains('alert')));
  }

  function open(id?: string) {
    if (id && sections.some((s) => s.id === id)) current = id;
    isOpen = true;
    document.exitPointerLock?.(); // muis vrij om te klikken
    refresh();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) document.activeElement.blur();
    button.blur();
    refresh();
  }
  /** Zonder id: menu open/dicht. Met id: dat onderdeel tonen, of sluiten als het al in beeld is. */
  function toggle(id?: string) {
    if (isOpen && (!id || id === current)) close();
    else open(id);
  }

  // Menu open = muis vrij. Klik je met het menu open in de game, dan wordt de muis weer vastgezet om rond te kijken
  // en zijn de knoppen niet meer aan te klikken: het menu gaat dan dicht (Tab haalt het terug, met de muis vrij).
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) close();
  });

  button.addEventListener('click', () => {
    toggle();
    button.blur(); // anders drukt spatie of Enter tijdens het spelen de knop opnieuw in
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    // Tab (M is van de radio). Staat de focus in het menu zelf, dan blijft Tab gewoon naar het volgende veld springen.
    if (e.code === 'Tab' && !(t instanceof Node && panel.contains(t))) {
      e.preventDefault();
      toggle();
    }
    if (e.code === 'Escape') close();
  });

  return {
    /** Voegt een onderdeel toe; `order` bepaalt de volgorde van de tabs. */
    addSection(id: string, title: string, el: HTMLElement, order: number) {
      const tab = document.createElement('button');
      tab.innerHTML = '<span class="label"></span><span class="dot"></span>';
      tab.querySelector('.label')!.textContent = title;
      tab.addEventListener('click', () => {
        open(id);
        tab.blur();
      });
      const section = { id, order, el, tab };
      sections.push(section);
      sections.sort((a, b) => a.order - b.order);
      tabs.replaceChildren(...sections.map((s) => s.tab));
      body.appendChild(el);
      if (!current || section.order < (sections.find((s) => s.id === current)?.order ?? Infinity)) current = sections[0].id;
      refresh();
    },
    open,
    close,
    toggle,
    /** Is dit onderdeel nu in beeld? */
    showing: (id: string) => isOpen && current === id,
    /** Er is iets nieuws in dit onderdeel (bijvoorbeeld een fout): rode stip op de knop tot het bekeken is. */
    notify(id: string) {
      if (isOpen && current === id) return;
      sections.find((s) => s.id === id)?.tab.classList.add('alert');
      refresh();
    },
  };
}

export const menu = createMenu();
