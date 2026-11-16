/* The solver owns velocities and integration; the page owns input and painting.
 * Each short task yields for new input. Snapshots are independent of paint FPS. */
let simulation = null;
const channel = new MessageChannel();
channel.port1.onmessage = event => {
  if (!simulation || event.data !== simulation.session) return;
  simulation.queued = false;
  const batchStart = performance.now(), deadline = batchStart + 6;
  const { bodies, neighborhood } = simulation;
  for (const body of bodies) body.fixed = body.grabbed || body.locked
    || (neighborhood !== null && !neighborhood.has(body.id));
  for (let i = 0; i < simulation.stepsPerBatch; i++) {
    step(simulation);
    simulation.steps++;
    if (simulation.quietSteps >= 12 || performance.now() >= deadline) break;
  }
  simulation.computeMs += performance.now() - batchStart;
  const settled = simulation.quietSteps >= 12;
  if (settled || performance.now() - simulation.lastSnapshot >= 1000 / 60) snapshot(settled);
  if (!settled) queueStep();
};

function queueStep() {
  if (simulation.queued) return;
  simulation.queued = true;
  channel.port2.postMessage(simulation.session);
}

function snapshot(settled) {
  const positions = new Float64Array(simulation.bodies.length * 3);
  simulation.bodies.forEach((body, i) => {
    positions[i * 3] = body.x; positions[i * 3 + 1] = body.y;
    positions[i * 3 + 2] = body.inputRevision;
  });
  simulation.lastSnapshot = performance.now();
  postMessage({ session: simulation.session, revision: simulation.revision,
    settled, positions, steps: simulation.steps, computeMs: simulation.computeMs,
    elapsedMs: simulation.lastSnapshot - simulation.startedAt }, [positions.buffer]);
}

onmessage = ({ data }) => {
  if (data.type === 'stop') { simulation = null; return; }
  if (data.type === 'start') {
    const bodies = data.bodies.map(body => ({ ...body, vx: 0, vy: 0,
      fixed: false, degree: 0, inputRevision: 0 }));
    const byId = new Map(bodies.map(body => [body.id, body]));
    const links = data.links.map(link => {
      const a = byId.get(link.a), b = byId.get(link.b);
      a.degree++; b.degree++;
      return { a, b, length: link.length };
    });
    for (const link of links) link.strength = .04 / Math.min(link.a.degree, link.b.degree);
    const center = bodies.reduce((point, body) => ({
      x: point.x + body.x / bodies.length, y: point.y + body.y / bodies.length
    }), { x: 0, y: 0 });
    simulation = { session: data.session, bodies, byId, links, center,
      neighborhood: data.neighborhood === null ? null : new Set(data.neighborhood),
      targets: new Map(data.targets), anchors: data.anchors === null ? null : new Map(data.anchors),
      revision: 0, quietSteps: 0, queued: false, lastSnapshot: -Infinity, stepsPerBatch: data.stepsPerBatch,
      startedAt: performance.now(), steps: 0, computeMs: 0 };
    queueStep();
    return;
  }
  if (!simulation || data.session !== simulation.session) return;
  const body = simulation.byId.get(data.id);
  body.x = data.position.x; body.y = data.position.y;
  body.grabbed = data.grabbed; body.locked = data.locked;
  body.inputRevision = data.revision;
  if (data.target) simulation.targets.set(data.id, data.target);
  if (data.anchors) simulation.anchors = new Map(data.anchors);
  if (data.neighborhood) simulation.neighborhood = new Set(data.neighborhood);
  simulation.revision = data.revision;
  simulation.quietSteps = 0;
  queueStep();
};

function step(simulation) {
  const { bodies, links, center, neighborhood } = simulation;
  const local = neighborhood !== null, dragging = bodies.some(body => body.grabbed);
  for (const body of bodies) {
    body.previousX = body.x;
    body.previousY = body.y;
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (local && a.fixed && b.fixed) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      if (dx === 0 && dy === 0) {
        // Coincident pairs need distinct directions, not a shared diagonal.
        const angle = (i * bodies.length + j) * 2.399963229728653;
        dx = Math.cos(angle); dy = Math.sin(angle);
      }
      const distance = Math.sqrt(dx * dx + dy * dy);
      const gapX = Math.max(0, Math.abs(dx) - a.halfWidth - b.halfWidth);
      const gapY = Math.max(0, Math.abs(dy) - a.halfHeight - b.halfHeight);
      const gap = Math.sqrt(gapX * gapX + gapY * gapY);
      // Unbounded 1/d repulsion separates neighborhoods at every scale;
      // softened surface pressure supplies extra room around labels.
      const force = 120 / Math.max(40, distance) + 3 / (1 + gap / 80) ** 2;
      const fx = dx / distance * force, fy = dy / distance * force;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }
  for (const { a, b, length, strength } of links) {
    let dx = b.x - a.x, dy = b.y - a.y;
    if (dx === 0 && dy === 0) { dx = 1; dy = 1; }
    const distance = Math.sqrt(dx * dx + dy * dy);
    const ux = Math.abs(dx) / distance, uy = Math.abs(dy) / distance;
    // Measure the gap between rectangle boundaries along the edge.
    const clearance = Math.min(a.halfWidth / ux, a.halfHeight / uy)
      + Math.min(b.halfWidth / ux, b.halfHeight / uy);
    const target = clearance + length;
    const force = (distance - target) * strength;
    const fx = dx / distance * force, fy = dy / distance * force;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }
  for (const body of bodies) {
    if (body.fixed) {
      body.vx = 0; body.vy = 0;
      continue;
    }
    // Preserve deliberate placements, but let ordinary neighbors reflow.
    const anchor = simulation.targets.get(body.id) ?? simulation.anchors?.get(body.id);
    const anchorStrength = simulation.targets.has(body.id) ? .15 : .008;
    const anchorX = anchor ? (anchor.x - body.x) * anchorStrength : 0;
    const anchorY = anchor ? (anchor.y - body.y) * anchorStrength : 0;
    // A weak shared center contains disconnected components without
    // tethering individual nodes to a packed arrangement.
    body.vx = (body.vx + (center.x - body.x) * .001 + anchorX) * .78;
    body.vy = (body.vy + (center.y - body.y) * .001 + anchorY) * .78;
    const limit = Math.min(1, 1 / (Math.sqrt(body.vx * body.vx + body.vy * body.vy) || 1));
    body.vx *= limit; body.vy *= limit;
  }
  // Blend corrections into predicted velocities instead of snapping
  // positions and erasing the motion needed to escape a crowded patch.
  let overlap = 0;
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        if (a.fixed && b.fixed) continue;
        let dx = b.x + b.vx - a.x - a.vx, dy = b.y + b.vy - a.y - a.vy;
        const overlapX = a.halfWidth + b.halfWidth + 24 - Math.abs(dx);
        const overlapY = a.halfHeight + b.halfHeight + 24 - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        // Release a spatial neighbor only when pressure reaches its
        // inner 8px margin; graph distance alone must not trap a node.
        if (local && overlapX > 16 && overlapY > 16) {
          if (a.fixed && !a.locked && !a.grabbed) {
            neighborhood.add(a.id); a.fixed = false;
          }
          if (b.fixed && !b.locked && !b.grabbed) {
            neighborhood.add(b.id); b.fixed = false;
          }
        }
        const freeA = !a.fixed;
        const freeB = !b.fixed;
        const free = Number(freeA) + Number(freeB);
        if (!free) continue;
        overlap = Math.max(overlap, Math.min(overlapX, overlapY) - 24);
        if (dx === 0 && dy === 0) {
          const angle = (i * bodies.length + j) * 2.399963229728653;
          dx = Math.cos(angle); dy = Math.sin(angle);
        }
        const distance = Math.sqrt(dx * dx + dy * dy), ux = dx / distance, uy = dy / distance;
        const clearance = Math.min((a.halfWidth + b.halfWidth + 24) / Math.abs(ux),
          (a.halfHeight + b.halfHeight + 24) / Math.abs(uy));
        // Correct along the line between centers, avoiding horizontal
        // and vertical snapping that packs rectangles into rows.
        const push = (clearance - distance) * .7 / free;
        if (freeA) { a.vx -= ux * push; a.vy -= uy * push; }
        if (freeB) { b.vx += ux * push; b.vy += uy * push; }
      }
    }
  }
  let movementSquared = 0;
  for (const body of bodies) {
    if (body.fixed) continue;
    body.x += body.vx; body.y += body.vy;
    const dx = body.x - body.previousX, dy = body.y - body.previousY;
    movementSquared = Math.max(movementSquared, dx * dx + dy * dy);
  }
  simulation.quietSteps = !dragging && movementSquared < .01 && overlap < .5 ? simulation.quietSteps + 1 : 0;
}
