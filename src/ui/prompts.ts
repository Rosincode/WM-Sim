// Toetsprompts midden-onder in beeld: zodra je bij iets staat waar je iets mee kunt, zie je hier welke
// toets je daarvoor indrukt.

const css = `
.prompts { position: fixed; left: 50%; bottom: 17vh; transform: translateX(-50%); z-index: 20; display: flex;
  flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: min(640px, calc(100vw - 32px));
  pointer-events: none; font: 16px system-ui, sans-serif; color: #fff; }
.prompts .p { display: flex; align-items: center; gap: 10px; padding: 7px 14px 7px 8px; border-radius: 10px;
  background: rgba(0,0,0,.72); box-shadow: 0 2px 12px rgba(0,0,0,.35); line-height: 1.35; }
.prompts .p.nokey { padding-left: 14px; font-size: 14px; }
.prompts .p.off { color: #b0b6bc; }
.prompts .p.off kbd { background: #8d949b; }
.prompts kbd { flex: none; min-width: 30px; height: 30px; box-sizing: border-box; padding: 0 8px; border-radius: 6px;
  background: #fff; color: #000; font: bold 17px/30px system-ui, sans-serif; text-align: center;
  box-shadow: 0 2px 0 rgba(255,255,255,.35); }
.prompts .p b { color: #ffe082; }
`;

/** `html` is opmaak: tekst uit de sim of van andere spelers eerst door esc() halen. */
export type Prompt = { key?: string; html: string; off?: boolean };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createPrompts() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.className = 'prompts';
  document.body.appendChild(el);

  let last = '';
  return {
    set(list: Prompt[]) {
      const html = list
        .map((p) => `<div class="p${p.off ? ' off' : ''}${p.key ? '' : ' nokey'}">${p.key ? `<kbd>${esc(p.key)}</kbd>` : ''}<span>${p.html}</span></div>`)
        .join('');
      if (html === last) return;
      last = html;
      el.innerHTML = html;
    },
  };
}
