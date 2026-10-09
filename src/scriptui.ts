import type { Bar, Timeframe } from './api';
import { ScriptError, TEMPLATE_SOURCE, newId, type InputDef, type InputValue, type Script, type ScriptRunner } from './scripts';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface EditorHost {
  runner: ScriptRunner;
  scripts(): Script[];
  /** persist the library and re-run the script wherever it is on a chart */
  saved(changedId?: string): void;
  deleted(id: string): void;
  addToChart(id: string): void;
  activeBars(): { bars: Bar[]; tf: Timeframe };
  dark(): boolean;
}

interface Cm {
  getDoc(): string;
  setDoc(text: string): void;
  setDark(dark: boolean): void;
  focus(): void;
}

/** The script list and code editor in the bottom panel. The editor library loads the first time it is opened. */
export class ScriptEditor {
  private cm: Cm | undefined;
  private loading: Promise<void> | undefined;
  private current: string | undefined;
  private dirty = false;
  private q: <T extends HTMLElement = HTMLElement>(sel: string) => T;

  constructor(
    private root: HTMLElement,
    private host: EditorHost,
  ) {
    root.innerHTML =
      `<div class="script-list"><div class="script-list-head"><span>My scripts</span><button data-act="new" title="New script">+ New</button></div>` +
      `<div class="script-items"></div>` +
      `<div class="script-list-foot"><button data-act="import" title="Load .js files as scripts">Import</button><button data-act="export" title="Download this script as a .js file">Export</button>` +
      `<input type="file" accept=".js,.txt,text/javascript" multiple hidden /></div></div>` +
      `<div class="script-main"><div class="script-bar"><span class="script-status"></span><span class="spacer"></span>` +
      `<button data-act="delete">Delete</button><button data-act="add">Add to chart</button><button data-act="save" class="primary" title="Ctrl / Cmd + S">Save</button></div>` +
      `<div class="script-editor"></div></div>`;
    this.q = (sel) => root.querySelector(sel)!;

    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const id = t.closest<HTMLElement>('[data-script]')?.dataset.script;
      if (id) return void this.open(id);
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'new') this.create(TEMPLATE_SOURCE, 'My indicator');
      else if (act === 'save') void this.save();
      else if (act === 'add') void this.save().then((ok) => ok && this.current && this.host.addToChart(this.current));
      else if (act === 'delete') this.remove();
      else if (act === 'export') this.exportCurrent();
      else if (act === 'import') this.q<HTMLInputElement>('input[type=file]').click();
    });
    this.q<HTMLInputElement>('input[type=file]').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      for (const f of [...(input.files ?? [])]) this.create(await f.text(), f.name.replace(/\.[^.]+$/, ''));
      input.value = '';
    });
  }

  /** Show the editor, optionally on a particular script. */
  async show(scriptId?: string) {
    this.loading ??= this.mount();
    await this.loading;
    const list = this.host.scripts();
    this.open(scriptId ?? this.current ?? list[0]?.id);
  }

  setDark(dark: boolean) {
    this.cm?.setDark(dark);
  }

  /** A script failed while running on a chart: surface it if that script is the one being edited. */
  reportError(scriptId: string, message: string) {
    if (scriptId === this.current && !this.dirty) this.status(message, true);
  }

  private async mount() {
    const [{ EditorView, basicSetup }, { javascript }, { oneDark }, { Compartment, EditorState }, { keymap }, { indentWithTab }] = await Promise.all([
      import('codemirror'),
      import('@codemirror/lang-javascript'),
      import('@codemirror/theme-one-dark'),
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/commands'),
    ]);
    const theme = new Compartment();
    const themeFor = (dark: boolean) => (dark ? oneDark : []);
    const view = new EditorView({
      parent: this.q('.script-editor'),
      state: EditorState.create({
        extensions: [
          basicSetup,
          javascript(),
          keymap.of([indentWithTab, { key: 'Mod-s', run: () => (void this.save(), true) }]),
          theme.of(themeFor(this.host.dark())),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || this.dirty) return;
            this.dirty = true;
            this.status('Unsaved changes');
          }),
          EditorView.theme({ '&': { height: '100%', fontSize: '12.5px' }, '.cm-scroller': { overflow: 'auto' } }),
        ],
      }),
    });
    this.cm = {
      getDoc: () => view.state.doc.toString(),
      setDoc: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
      setDark: (dark) => view.dispatch({ effects: theme.reconfigure(themeFor(dark)) }),
      focus: () => view.focus(),
    };
  }

  private renderList() {
    this.q('.script-items').innerHTML =
      this.host
        .scripts()
        .map((s) => `<button data-script="${esc(s.id)}" class="${s.id === this.current ? 'active' : ''}">${esc(s.name)}</button>`)
        .join('') || `<div class="empty">No scripts yet</div>`;
    const has = !!this.current;
    this.root.querySelectorAll<HTMLButtonElement>('.script-bar button, [data-act=export]').forEach((b) => (b.disabled = !has));
  }

  private open(id: string | undefined) {
    const s = this.host.scripts().find((x) => x.id === id);
    if (this.dirty && this.current && s?.id !== this.current && !confirm('Discard unsaved changes to the current script?')) return;
    this.current = s?.id;
    this.cm?.setDoc(s?.source ?? '');
    this.dirty = false;
    this.status(s ? '' : 'Create a script with “+ New”.');
    this.renderList();
  }

  private create(source: string, name: string) {
    const s: Script = { id: newId(), name, source };
    this.host.scripts().push(s);
    this.host.saved();
    this.dirty = false;
    this.open(s.id);
    void this.save();
    this.cm?.focus();
  }

  /** Store the source, then check it: first that it defines an indicator, then that it runs on the active chart's bars. */
  private async save(): Promise<boolean> {
    const s = this.host.scripts().find((x) => x.id === this.current);
    if (!s || !this.cm) return false;
    s.source = this.cm.getDoc();
    this.dirty = false;
    let ok = true;
    try {
      s.name = (await this.host.runner.describe(s.source)).name;
      const { bars, tf } = this.host.activeBars();
      if (bars.length) await this.host.runner.run(s.source, bars, {}, tf);
      this.status(`Saved · ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      ok = false;
      this.status(e instanceof ScriptError ? e.message : String(e), true);
    }
    // saved even when it has an error, so work in progress is never lost
    this.host.saved(s.id);
    this.renderList();
    return ok;
  }

  private remove() {
    const list = this.host.scripts();
    const i = list.findIndex((x) => x.id === this.current);
    if (i < 0 || !confirm(`Delete the script “${list[i].name}”? It is also removed from every chart.`)) return;
    const [gone] = list.splice(i, 1);
    this.host.deleted(gone.id);
    this.dirty = false;
    this.current = undefined;
    this.open(list[0]?.id);
  }

  private exportCurrent() {
    const s = this.host.scripts().find((x) => x.id === this.current);
    if (!s) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.cm?.getDoc() ?? s.source], { type: 'text/javascript' }));
    a.download = `${s.name.replace(/[^\w-]+/g, '_')}.js`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private status(text: string, error = false) {
    const el = this.q('.script-status');
    el.textContent = text;
    el.classList.toggle('down', error);
  }
}

/** Settings dialog for one script on one chart, generated from the script's `inputs`. Changes apply as they are made. */
export function openInputs(modal: HTMLElement, title: string, defs: InputDef[], values: Record<string, InputValue>, onChange: (v: Record<string, InputValue>) => void) {
  const current: Record<string, InputValue> = {};
  for (const d of defs) current[d.key] = typeof values[d.key] === typeof d.value ? values[d.key] : d.value;
  const attr = (name: string, v: number | undefined) => (typeof v === 'number' ? ` ${name}="${v}"` : '');
  const field = (d: InputDef) => {
    const v = current[d.key];
    if (d.type === 'boolean') return `<input type="checkbox" data-key="${esc(d.key)}" ${v ? 'checked' : ''} />`;
    if (d.type === 'select') return `<select data-key="${esc(d.key)}">${d.options!.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (d.type === 'number') return `<input type="number" data-key="${esc(d.key)}" value="${v}"${attr('min', d.min)}${attr('max', d.max)} step="${d.step ?? 'any'}" />`;
    return `<input type="${d.type === 'color' ? 'color' : 'text'}" data-key="${esc(d.key)}" value="${esc(v)}" />`;
  };
  const render = () => {
    modal.querySelector('.modal-card')!.innerHTML =
      `<h3>${esc(title)}</h3>` +
      (defs.map((d) => `<label><span>${esc(d.label)}</span>${field(d)}</label>`).join('') || `<p class="muted">This script has no inputs.</p>`) +
      `<div class="inputs-foot"><button class="tb-btn" data-act="reset">Defaults</button><button class="tb-btn" data-act="close">Done</button></div>`;
  };
  render();
  modal.classList.remove('hidden');
  modal.oninput = (e) => {
    const el = e.target as HTMLInputElement;
    const d = defs.find((x) => x.key === el.dataset.key);
    if (!d) return;
    if (d.type === 'boolean') current[d.key] = el.checked;
    else if (d.type === 'number') {
      if (el.value === '' || !Number.isFinite(Number(el.value))) return;
      current[d.key] = Number(el.value);
    } else current[d.key] = el.value;
    onChange({ ...current });
  };
  modal.onmousedown = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'reset') {
      for (const d of defs) current[d.key] = d.value;
      render();
      onChange({ ...current });
    } else if (act === 'close' || e.target === modal) modal.classList.add('hidden');
  };
}
