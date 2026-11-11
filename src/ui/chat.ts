// Chatvenster rechtsonder. Enter (of T) opent het invoerveld, Enter verstuurt, Esc sluit.
// Berichten blijven even staan en vervagen dan; met het invoerveld open zie je de hele geschiedenis.

export const CHAT_MAX = 120;
const SHOW_MS = 15_000;
const KEEP = 100;

const css = `
.chat { position: fixed; right: 16px; bottom: 16px; z-index: 30; width: min(360px, calc(100vw - 32px)); display: flex;
  flex-direction: column; gap: 6px; font: 13px system-ui, sans-serif; line-height: 1.4; color: #fff; pointer-events: none; }
.chat .log { max-height: 190px; overflow: hidden; border-radius: 8px; }
.chat .m { width: fit-content; max-width: 100%; box-sizing: border-box; margin-top: 3px; padding: 3px 9px; border-radius: 8px;
  background: rgba(0,0,0,.6); overflow-wrap: anywhere; transition: opacity .6s; }
.chat .m.old { opacity: 0; }
.chat .m.sys { color: #b9c0c7; font-style: italic; }
.chat .m b { margin-right: 6px; }
.chat.open .log { max-height: 40vh; overflow-y: auto; padding: 4px 8px 8px; background: rgba(0,0,0,.6); pointer-events: auto; }
.chat.open .m { opacity: 1; background: none; padding: 1px 0; }
.chat .hint { align-self: flex-end; padding: 4px 10px; border-radius: 8px; background: rgba(0,0,0,.5); color: #cfd8dc;
  font-size: 12px; cursor: pointer; pointer-events: auto; user-select: none; }
.chat .hint kbd { padding: 0 5px; margin-right: 5px; border-radius: 4px; background: #fff; color: #000; font: bold 11px system-ui, sans-serif; }
.chat input { display: none; box-sizing: border-box; width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #5a6570;
  background: rgba(0,0,0,.8); color: #fff; font: inherit; font-size: 14px; outline: none; pointer-events: auto; }
.chat.open input { display: block; }
.chat.open .hint { display: none; }
`;

export function createChat({ onSend }: { onSend: (text: string) => void }) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'chat';
  const log = document.createElement('div');
  log.className = 'log';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<kbd>Enter</kbd>chatten';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = CHAT_MAX;
  input.placeholder = 'Typ een bericht · Enter: versturen · Esc: sluiten';
  input.autocomplete = 'off';
  root.append(log, hint, input);
  document.body.appendChild(root);

  const toBottom = () => (log.scrollTop = log.scrollHeight);

  function open() {
    root.classList.add('open');
    input.focus();
    toBottom();
  }
  function close() {
    if (!root.classList.contains('open')) return;
    root.classList.remove('open');
    input.value = '';
    input.blur();
    toBottom();
  }

  function append(row: HTMLDivElement) {
    log.appendChild(row);
    while (log.childElementCount > KEEP) log.firstElementChild!.remove();
    setTimeout(() => row.classList.add('old'), SHOW_MS);
    toBottom();
  }

  hint.addEventListener('click', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) onSend(text);
      close();
    } else if (e.key === 'Escape') {
      close();
    }
  });
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t instanceof HTMLButtonElement) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyT') {
      e.preventDefault(); // anders komt de toets zelf in het invoerveld terecht
      open();
    }
  });

  return {
    /** Bericht van een speler (ook van jezelf). */
    add(name: string, color: string, text: string) {
      const row = document.createElement('div');
      row.className = 'm';
      const who = document.createElement('b');
      who.textContent = name;
      who.style.color = color;
      row.append(who, text);
      append(row);
    },
    /** Mededeling van de game zelf. */
    system(text: string) {
      const row = document.createElement('div');
      row.className = 'm sys';
      row.textContent = text;
      append(row);
    },
  };
}
