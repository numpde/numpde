// Run in the generic Node container against the existing debug window.
// Separates worker compute, publication, and redraw CPU work; does not measure FPS.
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

async function profileLayout() {
  const button = document.getElementById('fisheye-toggle');
  const saved = { view: currentView, active: liveActive, lens: button.getAttribute('aria-pressed') === 'true',
    positions: cy.nodes().map(node => ({ node, position: { ...node.position() } })),
    camera: { zoom: cy.zoom(), pan: { ...cy.pan() } }, anchors: layoutAnchors, targets: new Map(positionTargets) };
  const renderer = cy.renderer(), receive = physicsWorker.onmessage;
  let snapshots = 0, latest = null;
  physicsWorker.onmessage = event => {
    if (event.data.session === liveSession) { snapshots++; latest = event.data; }
    receive(event);
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0, maxMs: sorted.at(-1) ?? 0 };
  };
  try {
    stopLiveLayout();
    if (saved.lens) button.click();
    const results = [];
    for (const target of [saved.view === 'curated' ? 'embedded' : 'curated', saved.view]) {
      snapshots = 0; latest = null;
      const started = performance.now(), renderTimes = [], publishTimes = [];
      switchView(target, true);
      const setupMs = performance.now() - started;
      while (liveActive && performance.now() - started < 30000) {
        await wait(16);
        if (!liveSnapshot) continue;
        // Consume the latest snapshot even when an occluded debug window is
        // withholding animation frames. These are CPU timings, not FPS.
        if (liveFrame !== null) cancelAnimationFrame(liveFrame);
        const beforePublish = performance.now();
        publishLivePositions();
        publishTimes.push(performance.now() - beforePublish);
        const beforeRender = performance.now();
        renderer.redrawHint('eles', true);
        for (const { fn } of renderer.beforeRenderCallbacks) fn(true, performance.now());
        renderer.render();
        renderTimes.push(performance.now() - beforeRender);
      }
      results.push({ target, setupMs, settled: !liveActive, observedMs: performance.now() - started,
        workerElapsedMs: latest?.elapsedMs, workerComputeMs: latest?.computeMs, steps: latest?.steps,
        snapshots, publish: summarize(publishTimes), render: summarize(renderTimes) });
      stopLiveLayout();
    }
    return { viewport: [innerWidth, innerHeight, devicePixelRatio], nodes: cy.nodes().length, results };
  } finally {
    physicsWorker.onmessage = receive;
    stopLiveLayout();
    switchView(saved.view, true);
    stopLiveLayout();
    cy.batch(() => saved.positions.forEach(({ node, position }) => node.position(position)));
    cy.viewport(saved.camera);
    layoutAnchors = saved.anchors;
    positionTargets = saved.targets;
    if (saved.lens) button.click();
    if (saved.active) startLiveLayout();
  }
}

try {
  const result = await call('Runtime.evaluate', { expression: `(${profileLayout})()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket.close();
}
