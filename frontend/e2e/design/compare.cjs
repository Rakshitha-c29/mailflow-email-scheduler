/**
 * Design check tool: Design export (cropped to its frame, scaled to 1440px) stacked over a screenshot.
 *   node e2e/design/compare.cjs <design.png> <screenshot.png> <out.png> <height> <frameX> <frameY> <frameWidth> <frameHeight> <designImageWidth>
 */
const { launch, finish } = require('../lib.cjs');
const fs = require('fs');
const [design, ours, out, h, sx, sy, sw, sh] = process.argv.slice(2);
(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1440, height: Number(h) * 2 + 10 } });
  const img = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  const scale = 1440 / Number(sw);
  await p.setContent(`<body style="margin:0">
    <div style="position:relative;width:1440px;height:${h}px;overflow:hidden;border-bottom:3px solid #e11">
      <img src="${img(design)}" style="position:absolute;left:${-sx * scale}px;top:${-sy * scale}px;width:${scale * Number(process.argv[10] || 812)}px;image-rendering:auto">
      <span style="position:absolute;right:8px;bottom:6px;font:bold 14px sans-serif;color:#e11">DESIGN</span></div>
    <div style="position:relative;width:1440px;height:${h}px;overflow:hidden;border-bottom:3px solid #e11">
      <img src="${img(ours)}" style="width:1440px;display:block">
      <span style="position:absolute;right:8px;bottom:6px;font:bold 14px sans-serif;color:#e11">BUILT</span></div></body>`);
  await p.waitForTimeout(200);
  await p.screenshot({ path: out });
  await finish(b);
})();
