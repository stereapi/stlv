// Autosave + crash recovery: every minute (and when the window loses focus)
// each document with unsaved changes is written as .stlv to the app's data
// folder. Saving or closing a document deletes its copy. If the app quits
// unexpectedly, the next launch offers to bring the work back.

import { bridge } from '../bridge.js';
import { saveStlv, loadStlv } from './stlvfile.js';

export class Autosave {
  constructor(app) {
    this.app = app; this.done = new Map(); this.busy = false;
    setInterval(() => this.tick(), 60000);
    window.addEventListener('blur', () => this.tick());
  }
  async tick() {
    const app = this.app;
    if (this.busy || app.prefs.autosave === false || this.pointerDown) return;
    this.busy = true;
    try {
      let changed = false;
      for (const d of app.docs) {
        if (!d.history.dirty) continue;
        const key = d.history.index + ':' + d.history.list.length + ':' + (d.history.list[d.history.index - 1] || {}).t;
        if (this.done.get(d.id) === key) continue;
        const bytes = await saveStlv(d, null);
        await bridge.setData(`autosave/${d.id}.stlv`, new Blob([bytes]));
        this.done.set(d.id, key); changed = true;
      }
      if (changed) await this.writeIndex();
    } catch (e) { console.warn('autosave failed', e); }
    finally { this.busy = false; }
  }
  async writeIndex() {
    const list = this.app.docs.filter(d => d.history.dirty && this.done.has(d.id)).map(d => ({ id: d.id, name: d.name, path: d.path, time: Date.now() }));
    await bridge.setData('autosave/index.json', list);
  }
  async drop(doc) {
    if (!this.done.has(doc.id)) return;
    this.done.delete(doc.id);
    await bridge.setData(`autosave/${doc.id}.stlv`, null);
    await this.writeIndex();
  }
  async clearAll() {
    for (const id of this.done.keys()) await bridge.setData(`autosave/${id}.stlv`, null);
    this.done.clear(); await bridge.setData('autosave/index.json', []);
  }
  /** on launch: offer to restore documents from a session that ended without saving */
  async recover() {
    const list = await bridge.getData('autosave/index.json').catch(() => null);
    if (!list || !list.length) return;
    const names = list.map(e => `• ${e.name} (${new Date(e.time).toLocaleString()})`).join('\n');
    const r = await this.app.ui.confirm('Recover unsaved work?', `stlv closed before these documents were saved:\n${names}`, ['Recover', 'Discard']);
    for (const e of list) {
      if (r === 0) {
        try {
          const buf = await bridge.getData(`autosave/${e.id}.stlv`, 'buffer'); if (!buf) continue;
          const d = await loadStlv(buf, e.name);
          d.name = e.name + ' (recovered)'; d.path = null; d.token = null; d.history.saved = -1; d.openedAs = 'Recovered';
          this.app.addDoc(d);
        } catch (err) { console.warn('recover failed', err); }
      }
      await bridge.setData(`autosave/${e.id}.stlv`, null);
    }
    await bridge.setData('autosave/index.json', []);
  }
}
