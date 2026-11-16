/* Selection emphasis is a composited layer, not per-frame graph restyling. */
function attachGraphSelectionPulse({ cy, canvas, active, moving, onFrame }) {
  const context = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const snapshot = { canvas, version: 0, width: 0, height: 0, zoom: 1, pan: { x: 0, y: 0 } };
  let dirty = true, frame = null, gain = 0, previousTime = -Infinity;
  let viewportUntil = 0, viewportTimer = null;
  let viewport = { zoom: cy.zoom(), x: cy.pan().x, y: cy.pan().y, width: cy.width(), height: cy.height() };

  function available() {
    return active() && !moving() && !document.hidden && performance.now() >= viewportUntil;
  }

  function pulse(time) {
    return reducedMotion.matches ? .55 : .25 + .55 * (.5 - .5 * Math.cos(time * 2 * Math.PI / 1800));
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!canvas.hidden || gain) {
      canvas.hidden = true;
      gain = 0;
      onFrame();
    }
  }

  function animate(time) {
    frame = null;
    if (!available()) return stop();
    if (time - previousTime >= 1000 / 30) {
      previousTime = time;
      gain = pulse(time);
      canvas.style.opacity = gain;
      onFrame();
    }
    frame = requestAnimationFrame(animate);
  }

  function nodePath(node, outer = false) {
    const position = node.position(), border = outer ? node.pstyle('border-width').pfValue : 0;
    const width = node.width() + 2 * node.padding(), height = node.height() + 2 * node.padding();
    const radius = Math.min(width / 4, height / 4, 8) + border / 2;
    context.beginPath();
    context.roundRect(position.x - (width + border) / 2, position.y - (height + border) / 2,
      width + border, height + border, radius);
  }

  function paint() {
    const zoom = cy.zoom(), pan = cy.pan();
    const width = cy.width(), height = cy.height();
    const ratio = Math.min(1, 1024 / Math.max(width, height));
    const pixelsWide = Math.ceil(width * ratio), pixelsHigh = Math.ceil(height * ratio);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scaleX = canvas.width / width, scaleY = canvas.height / height;
    context.setTransform(scaleX * zoom, 0, 0, scaleY * zoom, scaleX * pan.x, scaleY * pan.y);
    context.strokeStyle = '#9ddcc8';
    context.lineCap = context.lineJoin = 'round';
    for (const edge of cy.edges().not('.filtered-out')) {
      const strength = Math.max(edge.source().data('selectionStrength'), edge.target().data('selectionStrength'));
      const points = edge._private.rscratch.allpts;
      if (!strength || !edge.visible() || !points) continue;
      context.globalAlpha = strength;
      context.lineWidth = Math.max(edge.pstyle('width').pfValue, 1.2 / zoom);
      context.beginPath();
      context.moveTo(points[0], points[1]);
      if (points.length === 4) context.lineTo(points[2], points[3]);
      else for (let i = 2; i + 3 < points.length; i += 4) {
        context.quadraticCurveTo(points[i], points[i + 1], points[i + 2], points[i + 3]);
      }
      context.stroke();
    }
    for (const node of cy.nodes(':visible')) {
      const strength = node.data('selectionStrength');
      if (!strength) continue;
      context.globalAlpha = strength;
      context.lineWidth = node.pstyle('border-width').pfValue + 2 / zoom;
      nodePath(node);
      context.stroke();
    }
    // Cut the fill and original border out of the glow, protecting labels and
    // nodes crossed by another connection in both the graph and the lens.
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'destination-out';
    for (const node of cy.nodes(':visible')) { nodePath(node, true); context.fill(); }
    context.globalCompositeOperation = 'source-over';
    Object.assign(snapshot, { version: snapshot.version + 1, width, height, zoom, pan: { ...pan } });
    dirty = false;
  }

  function update() {
    if (!available()) {
      if (active() && !moving() && !document.hidden && viewportTimer === null && performance.now() < viewportUntil) {
        viewportTimer = setTimeout(resumeViewport, viewportUntil - performance.now());
      }
      return stop();
    }
    if (dirty) paint();
    canvas.hidden = false;
    gain = pulse(performance.now());
    canvas.style.opacity = gain;
    onFrame();
    if (reducedMotion.matches) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    } else if (frame === null) frame = requestAnimationFrame(animate);
  }

  function resumeViewport() {
    viewportTimer = null;
    update();
  }

  cy.on('pan zoom resize', () => {
    const pan = cy.pan(), next = { zoom: cy.zoom(), x: pan.x, y: pan.y, width: cy.width(), height: cy.height() };
    if (Object.keys(next).every(key => next[key] === viewport[key])) return;
    viewport = next;
    viewportUntil = performance.now() + 160;
    dirty = true;
    update();
  });
  cy.on('position style data add remove', () => { dirty = true; });
  cy.on('render', update);
  document.addEventListener('visibilitychange', update);
  reducedMotion.addEventListener('change', update);
  return {
    update() { dirty = true; update(); },
    frame() { return available() && !canvas.hidden ? { ...snapshot, gain } : null; }
  };
}
