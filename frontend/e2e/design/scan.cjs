/**
 * Design check tool: Runs of colour along lines (borders, sizes, positions) of an image.
 *   node e2e/design/scan.cjs <image.png> '[["h",y,x0,x1,"label"],["v",x,y0,y1,"label"]]'
 */
const { launch, finish } = require('../lib.cjs');
const fs = require('fs');
(async () => {
  const b = await launch();
  const p = await b.newPage();
  const src = 'data:image/png;base64,' + fs.readFileSync(process.argv[2]).toString('base64');
  const lines = JSON.parse(process.argv[3]);
  const out = await p.evaluate(async ({ src, lines }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    const hex = (i) => '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    return lines.map(([dir, fixed, a, bnd, label]) => {
      const runs = []; let cur = null;
      for (let t = a; t <= bnd; t++) {
        const [px, py] = dir === 'h' ? [t, fixed] : [fixed, t];
        const col = hex((py * img.width + px) * 4);
        if (cur && cur.c === col) cur.to = t; else { cur = { c: col, from: t, to: t }; runs.push(cur); }
      }
      return label + ': ' + runs.filter((r) => r.c !== '#ffffff').map((r) => `${r.c}@${r.from}${r.to > r.from ? '-' + r.to : ''}`).join(' ');
    });
  }, { src, lines });
  console.log(out.join('\n'));
  await finish(b);
})();
