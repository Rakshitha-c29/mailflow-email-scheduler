/**
 * Design check tool: Pixel-perfect enlargement of a region.
 *   node e2e/design/zoom.cjs <image.png> <out.png> <x> <y> <width> <height> <scale>
 */
const { launch, finish } = require('../lib.cjs');
const fs = require('fs');
const [src, out, x, y, w, h, scale] = process.argv.slice(2);
(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: w * scale, height: h * scale } });
  const data = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
  await p.setContent(`<body style="margin:0"><canvas id=c width=${w * scale} height=${h * scale}></canvas><script>
    const i=new Image();i.onload=()=>{const c=document.getElementById('c').getContext('2d');c.imageSmoothingEnabled=false;
    c.drawImage(i,${x},${y},${w},${h},0,0,${w * scale},${h * scale});document.title='done'};i.src='${data}';</script></body>`);
  await p.waitForFunction(() => document.title === 'done');
  await p.screenshot({ path: out });
  await finish(b);
})();
