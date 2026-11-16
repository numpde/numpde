// Run in the generic Node container against the existing debug window.
// Measures synchronous lens drawing on a stationary graph, not presented FPS.
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

function profile() {
  const button = document.getElementById('fisheye-toggle');
  if (button.disabled) throw Error(button.title);
  if (matchMedia('(hover: none) and (pointer: coarse)').matches) throw Error('Use a desktop pointer for this movement profile.');
  const lens = document.getElementById('fisheye'), gl = lens.getContext('webgl');
  const wasEnabled = button.getAttribute('aria-pressed') === 'true', wasActive = liveActive;
  const originalFrame = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame;
  const originalUpload = gl.texSubImage2D, originalImage = gl.texImage2D;
  const originalDraw = cy.renderer().drawElements;
  const rectangle = lens.getBoundingClientRect();
  const pointer = { x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2 };
  let draw, uploads = 0, pixels = 0, vectors = 0;
  const samples = [];
  const move = (x, y) => graph.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerType: 'mouse', clientX: x, clientY: y
  }));
  stopLiveLayout();
  // Cancel the lens's pending callback, then run that same callback directly.
  // This avoids counting background-window RAF throttling as rendering time.
  if (wasEnabled) button.click();
  window.requestAnimationFrame = callback => { draw = callback; return -1; };
  window.cancelAnimationFrame = id => { if (id !== -1) originalCancel(id); };
  const countUpload = (original, args) => {
    const canvas = args.at(-1);
    uploads++;
    if (canvas instanceof HTMLCanvasElement) pixels += canvas.width * canvas.height;
    return original.apply(gl, args);
  };
  gl.texSubImage2D = function (...args) { return countUpload(originalUpload, args); };
  gl.texImage2D = function (...args) { return countUpload(originalImage, args); };
  cy.renderer().drawElements = function (context, elements) {
    vectors += elements.length;
    return originalDraw.call(this, context, elements);
  };
  try {
    move(innerWidth / 2, innerHeight / 2);
    button.click();
    for (let i = 0; i < 50; i++) {
      move(innerWidth / 2 + Math.sin(i * .15) * 120, innerHeight / 2 + Math.cos(i * .15) * 90);
      uploads = pixels = vectors = 0;
      const start = performance.now();
      draw();
      const submitted = performance.now();
      gl.finish();
      samples.push({ submitMs: submitted - start, completedMs: performance.now() - start, uploads, pixels, vectors });
    }
    const warm = samples.slice(1);
    const stats = field => {
      const values = warm.map(sample => sample[field]).sort((a, b) => a - b);
      return { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)],
        mean: values.reduce((sum, value) => sum + value, 0) / values.length };
    };
    return { viewport: [innerWidth, innerHeight, devicePixelRatio], nodes: cy.nodes().length, edges: cy.edges().length,
      cold: samples[0], movement: Object.fromEntries(Object.keys(samples[0]).map(field => [field, stats(field)])) };
  } finally {
    button.click();
    gl.texSubImage2D = originalUpload;
    gl.texImage2D = originalImage;
    cy.renderer().drawElements = originalDraw;
    window.requestAnimationFrame = originalFrame;
    window.cancelAnimationFrame = originalCancel;
    move(pointer.x || innerWidth / 2, pointer.y || innerHeight / 2);
    if (wasEnabled) button.click();
    if (wasActive) startLiveLayout();
  }
}

try {
  const result = await call('Runtime.evaluate', { expression: `(${profile})()`, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket.close();
}
