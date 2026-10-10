/**
 * Design check tool: Exact colours at given points of an image.
 *   node e2e/design/colors.cjs <image.png> '[["name",x,y],...]'
 */
const { launch, finish } = require('../lib.cjs');
const fs = require('fs');
(async () => {
  const b = await launch();
  const p = await b.newPage();
  const src = 'data:image/png;base64,' + fs.readFileSync(process.argv[2]).toString('base64');
  const pts = JSON.parse(process.argv[3]);
  const out = await p.evaluate(async ({ src, pts }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const hex = (d) => '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    const res = { size: [img.width, img.height] };
    for (const [name, px, py] of pts) res[name] = hex(x.getImageData(px, py, 1, 1).data);
    return res;
  }, { src, pts });
  console.log(JSON.stringify(out, null, 1));
  await finish(b);
})();
