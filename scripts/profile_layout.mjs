// Run in the generic Node container against the existing debug window.
// Measures physics and forced redraw CPU work with the lens off, not presented FPS.
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

function profileLayout() {
  const button = document.getElementById('fisheye-toggle');
  const wasEnabled = button.getAttribute('aria-pressed') === 'true', wasActive = liveActive;
  const camera = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  const anchors = layoutAnchors, targets = new Map(positionTargets);
  const positions = cy.nodes().map(node => ({ node, position: { ...node.position() } }));
  const originalFrame = requestAnimationFrame, originalCancel = cancelAnimationFrame, renderer = cy.renderer();
  let tick, published = 0;
  const countPublished = () => published++;
  stopLiveLayout();
  if (wasEnabled) button.click();
  window.requestAnimationFrame = callback => {
    if (callback.name === 'tick') { tick = callback; return -1; }
    return originalFrame(callback);
  };
  window.cancelAnimationFrame = id => { if (id !== -1) originalCancel(id); };
  cy.on('position', 'node', countPublished);
  function paintMain() {
    const start = performance.now();
    renderer.redrawHint('eles', true);
    for (const { fn } of renderer.beforeRenderCallbacks) fn(true, performance.now());
    renderer.render();
    return performance.now() - start;
  }
  try {
    for (let frame = 0; frame < 3; frame++) paintMain();
    layoutAnchors = new Map(positions.map(({ node, position }) => [node.id(), position]));
    positionTargets.clear();
    const source = cy.nodes().toArray().sort((a, b) => b.degree() - a.degree())[0];
    const position = source.position();
    source.position({ x: position.x + 50 / cy.zoom(), y: position.y });
    positionTargets.set(source.id(), { ...source.position() });
    const start = performance.now();
    startLiveLayout(source);
    const setupMs = performance.now() - start, samples = [];
    let time = performance.now();
    for (let frame = 0; frame < 20 && liveActive; frame++) {
      published = 0;
      const begin = performance.now();
      tick(time += frame < 10 ? 16.67 : 40);
      const afterTick = performance.now();
      const renderMs = paintMain();
      samples.push({ physicsMs: afterTick - begin, renderMs, published });
    }
    const stats = values => {
      const sorted = [...values].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
    };
    const summarize = frames => Object.fromEntries(['physicsMs', 'renderMs', 'published'].map(key => [key, stats(frames.map(frame => frame[key]))]));
    return { viewport: [innerWidth, innerHeight, devicePixelRatio], nodes: cy.nodes().length, edges: cy.edges().length,
      source: source.id(), localNodes: liveNeighborhood?.size, setupMs,
      normal: summarize(samples.slice(0, 10)), slowFrames: summarize(samples.slice(10)) };
  } finally {
    stopLiveLayout();
    cy.off('position', 'node', countPublished);
    window.requestAnimationFrame = originalFrame;
    window.cancelAnimationFrame = originalCancel;
    cy.batch(() => positions.forEach(({ node, position }) => node.position(position)));
    cy.viewport(camera);
    layoutAnchors = anchors;
    positionTargets = targets;
    if (wasEnabled) button.click();
    if (wasActive) startLiveLayout();
  }
}

try {
  const result = await call('Runtime.evaluate', { expression: `(${profileLayout})()`, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket.close();
}
