import { el, esc } from './dom';
import { DOWindow, ui } from './ui';

/** DO "Chat" window (UIChat prefab): room tabs, message area, send field. ENTER focuses. */
export class ChatBox {
  private lines: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly win: DOWindow;
  constructor(_parent: HTMLElement, onSend: (text: string) => void) {
    this.win = new DOWindow({ id: 'win-chat', title: 'Chat', icon: 'chat', w: 320, h: 190, anchor: 'bl', x: 8, y: 8, resizable: true, cls: 'win-chat' });
    const tabs = el('div', 'chat-tabs', undefined, this.win.body);
    el('img', 'slope', undefined, tabs).src = ui('win/divider_slope');
    for (const [n, on] of [['Global', true], ['Company', false], ['Clan', false]] as const) {
      const t = el('div', `chat-tab${on ? ' on' : ''}`, n, tabs);
      t.addEventListener('click', () => { tabs.querySelectorAll('.chat-tab').forEach((x) => x.classList.remove('on')); t.classList.add('on'); });
    }
    this.lines = el('div', 'lines', undefined, this.win.body);
    const form = el('form', undefined, undefined, this.win.body);
    this.input = el('input', undefined, undefined, form);
    this.input.type = 'text';
    this.input.maxLength = 200;
    this.input.placeholder = 'Press ENTER to chat...';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const t = this.input.value.trim();
      if (t) onSend(t);
      this.input.value = '';
      this.input.blur();
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.input.blur();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  add(from: string, text: string): void {
    el('div', undefined, `<b>${esc(from)}:</b> ${esc(text)}`, this.lines);
    while (this.lines.childElementCount > 150) this.lines.firstElementChild?.remove();
    this.lines.scrollTop = this.lines.scrollHeight;
  }

  focus(): void {
    if (!this.win.visible) this.win.open();
    this.input.focus();
  }
}
