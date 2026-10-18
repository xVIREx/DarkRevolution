import { el, esc } from './dom';

/** Generic modal with one action button. */
export class Dialog {
  private root: HTMLDivElement;
  private msg: HTMLDivElement;
  private btn: HTMLButtonElement;
  private titleEl: HTMLDivElement;
  constructor(title: string, button: string, onClick: () => void) {
    this.root = el('div', 'overlay', undefined, document.body);
    this.root.style.display = 'none';
    const d = el('div', 'panel dialog', undefined, this.root);
    this.titleEl = el('div', 'panel-title', esc(title), d);
    const body = el('div', 'body', undefined, d);
    this.msg = el('div', undefined, '', body);
    this.btn = el('button', 'btn primary', esc(button), body);
    this.btn.addEventListener('click', onClick);
  }

  show(html: string, title?: string): void {
    this.msg.innerHTML = html;
    if (title) this.titleEl.textContent = title;
    this.root.style.display = 'flex';
    this.btn.focus();
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }
}
