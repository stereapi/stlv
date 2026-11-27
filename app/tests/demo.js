// Development helper: builds a small poster document to try features on.
import { FillLayer, TextLayer, PixelLayer } from '../js/doc.js';
import { defaultGradient } from '../js/gradient.js';
import { ctx } from '../js/util.js';

export function poster(app) {
  const d = app.newDoc({ name: 'Poster', width: 1200, height: 1500, ppi: 150, background: 'white' });
  d.addLayer(new FillLayer('Sky', 'gradient', { gradient: { ...defaultGradient({ r: 11, g: 13, b: 31 }, { r: 255, g: 79, b: 216 }), angle: -90 } }));
  const mtn = new PixelLayer('mountains', 1200, 1500), m = ctx(mtn.canvas);
  m.fillStyle = '#1d2356'; m.beginPath(); m.moveTo(0, 900); [[200, 760], [420, 860], [640, 680], [880, 840], [1060, 740], [1200, 820], [1200, 1500], [0, 1500]].forEach(([x, y]) => m.lineTo(x, y)); m.fill();
  const sun = new PixelLayer('sun', 1200, 1500), x = ctx(sun.canvas); x.fillStyle = '#ffb347'; x.beginPath(); x.arc(800, 640, 220, 0, 7); x.fill();
  d.addLayer(sun); d.addLayer(mtn);
  d.addLayer(new TextLayer('STLV', { text: 'STLV', font: 'Helvetica Neue', fontStyle: 'Bold', size: 120, x: 600, y: 1200, align: 'center', color: { r: 243, g: 239, b: 230 } }));
  d.history.list = []; d.history.index = 0; d.history.saved = 0; d.changed('all');
  return { d, sun, mtn };
}
