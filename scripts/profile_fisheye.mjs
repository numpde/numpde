// Run in the generic Node container against the existing debug window.
// Measures lens drawing, moving geometry, zoom, and refinement, not presented FPS.
const endpoint = process.argv[2] || 'http://127.0.0.1:9333';
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find(page => page.type === 'page' && page.title === 'Projects');
if (!target) throw Error(`No Projects tab is open at ${endpoint}.`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(Error(message.error.message));
  else request.resolve(message.result);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function profile() {
  const button = document.getElementById('fisheye-toggle');
  if (button.disabled) throw Error(button.title);
  if (matchMedia('(hover: none) and (pointer: coarse)').matches) throw Error('Use a desktop pointer for this movement profile.');
  const lens = document.getElementById('fisheye'), gl = lens.getContext('webgl'), renderer = cy.renderer();
  const wasEnabled = button.getAttribute('aria-pressed') === 'true', wasActive = liveActive;
  const camera = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  const positions = cy.nodes().map(node => ({ node, position: { ...node.position() } }));
  const originalFrame = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame;
  const originalUpload = gl.texSubImage2D;
  const rectangle = lens.getBoundingClientRect();
  const pointer = { x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2 };
  const center = { x: innerWidth / 2, y: innerHeight / 2 };
  let draw, uploads = 0, pixels = 0;
  const move = (x, y) => graph.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerType: 'mouse', clientX: x, clientY: y
  }));
  const restorePositions = () => cy.batch(() => positions.forEach(({ node, position }) => node.position(position)));
  stopLiveLayout();
  if (wasEnabled) button.click();
  // Drive the real lens callback directly so window occlusion cannot distort
  // the timings. Main graph rendering stays on its native path.
  window.requestAnimationFrame = callback => {
    if (callback.name === 'draw') { draw = callback; return -1; }
    return originalFrame(callback);
  };
  window.cancelAnimationFrame = id => { if (id !== -1) originalCancel(id); };
  gl.texSubImage2D = function (...args) {
    uploads++;
    const canvas = args.at(-1);
    pixels += canvas.width * canvas.height;
    return originalUpload.apply(this, args);
  };
  function sample(index = 0, paintMain = false) {
    let mainMs = 0;
    if (paintMain) {
      const start = performance.now();
      renderer.flushRenderedStyleQueue();
      renderer.redrawHint('eles', true);
      renderer.render();
      mainMs = performance.now() - start;
    }
    move(center.x + Math.sin(index * .15) * 30, center.y + Math.cos(index * .15) * 20);
    uploads = pixels = 0;
    const start = performance.now();
    draw();
    gl.finish();
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    return { ms: performance.now() - start, mainMs, uploads, pixels,
      sharp: gl.getUniform(program, gl.getUniformLocation(program, 'reach')) < .5 };
  }
  const summarize = samples => {
    const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
    return { medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * .95)],
      maxMs: times.at(-1), meanMainMs: samples.reduce((sum, sample) => sum + sample.mainMs, 0) / samples.length,
      meanUploads: samples.reduce((sum, sample) => sum + sample.uploads, 0) / samples.length,
      meanPixels: samples.reduce((sum, sample) => sum + sample.pixels, 0) / samples.length };
  };
  async function refineImage() {
    await new Promise(resolve => setTimeout(resolve, 200));
    const samples = [];
    for (let frame = 0; frame < 120; frame++) {
      const result = sample();
      samples.push(result);
      if (result.sharp && result.uploads === 0) return { frames: samples.length, ...summarize(samples) };
    }
    throw Error('The lens did not finish sharp refinement within 120 drawing passes.');
  }
  try {
    move(center.x, center.y);
    button.click();
    sample(0, true);
    await refineImage();
    const stationary = Array.from({ length: 12 }, (_, index) => sample(index));
    const moving = [];
    for (let index = 0; index < 12; index++) {
      cy.batch(() => positions.forEach(({ node, position }) => node.position({
        x: position.x + index * 1.5, y: position.y + index * .75
      })));
      moving.push(sample(index, true));
    }
    restorePositions();
    sample(0, true);
    await refineImage();
    cy.zoom({ level: camera.zoom * 1.3, renderedPosition: center });
    const firstAfterZoom = sample(0, true);
    const zoomPanning = Array.from({ length: 12 }, (_, index) => sample(index));
    const refinement = await refineImage();
    const sharpPanning = Array.from({ length: 12 }, (_, index) => sample(index));
    return { viewport: [innerWidth, innerHeight, devicePixelRatio], nodes: cy.nodes().length, edges: cy.edges().length,
      stationary: summarize(stationary), moving: summarize(moving), firstAfterZoom,
      zoomPanning: summarize(zoomPanning), refinement, sharpPanning: summarize(sharpPanning), glError: gl.getError() };
  } finally {
    button.click();
    gl.texSubImage2D = originalUpload;
    window.requestAnimationFrame = originalFrame;
    window.cancelAnimationFrame = originalCancel;
    restorePositions();
    cy.viewport(camera);
    move(pointer.x || center.x, pointer.y || center.y);
    if (wasEnabled) button.click();
    if (wasActive) startLiveLayout();
  }
}

try {
  const result = await call('Runtime.evaluate', { expression: `(${profile})()`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket.close();
}
