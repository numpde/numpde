/* A focus-and-context lens: redraw and distort pixels, never graph positions.
 * https://bost.ocks.org/mike/fisheye/
 */
function attachGraphFisheye({ cy, graph, inventory }) {
  const toggle = document.getElementById('fisheye-toggle');
  const lens = document.getElementById('fisheye');
  const status = document.getElementById('lens-status');
  const statusDescription = document.getElementById('lens-description');
  const statusRepositories = document.getElementById('lens-repositories');
  const projects = new Map(inventory.projects.map(project => [project.id, project]));
  const repositories = new Map(inventory.repositories.map(repo => [repo.id, repo]));
  let statusNode = null;
  const source = document.createElement('canvas');
  const sourceContext = source.getContext('2d', { alpha: false });
  const preview = document.createElement('canvas');
  const previewContext = preview.getContext('2d', { alpha: false });
  const background = getComputedStyle(document.documentElement).backgroundColor;
  const distortion = 4;
  const peakZoom = distortion / (1 - Math.exp(-distortion));
  const fixedLens = matchMedia('(hover: none) and (pointer: coarse)');
  const touches = new Set();
  let enabled = false, pointer = null, frame = null, renderer = null;
  let panThroughNodes = null;
  let sceneVersion = 0, geometryVersion = 0;
  const nodePositions = new Map(cy.nodes().map(node => [node.id(), { ...node.position() }]));
  const changedStyles = new Set(), styleKeys = new Map();
  let drawing = false;
  let hullVersion = -1, nodeHull = [];
  let lastMotion = -Infinity, refineTimer = null;
  let renderedCamera = { zoom: cy.zoom(), pan: { ...cy.pan() }, version: 0 };

  function motion() {
    lastMotion = performance.now();
    if (!enabled) return;
    if (refineTimer === null) refineTimer = setTimeout(refine, 160);
    schedule();
  }

  function refine() {
    refineTimer = null;
    if (!enabled) return;
    const remaining = lastMotion + 160 - performance.now();
    if (remaining > 0) refineTimer = setTimeout(refine, remaining);
    else schedule();
  }

  function distanceToGraph(x, y) {
    if (hullVersion !== sceneVersion) {
      const points = [];
      for (const node of cy.nodes()) {
        if (!node.visible()) continue;
        const position = node.position(), halfWidth = node.outerWidth() / 2, halfHeight = node.outerHeight() / 2;
        const b = { x1: position.x - halfWidth, x2: position.x + halfWidth,
          y1: position.y - halfHeight, y2: position.y + halfHeight };
        points.push({ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y1 },
          { x: b.x2, y: b.y2 }, { x: b.x1, y: b.y2 });
      }
      points.sort((a, b) => a.x - b.x || a.y - b.y);
      const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const lower = [], upper = [];
      for (const point of points) {
        while (lower.length > 1 && turn(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
        lower.push(point);
      }
      for (let i = points.length - 1; i >= 0; i--) {
        const point = points[i];
        while (upper.length > 1 && turn(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
        upper.push(point);
      }
      nodeHull = lower.slice(0, -1).concat(upper.slice(0, -1));
      hullVersion = sceneVersion;
    }
    let inside = nodeHull.length > 2, nearest = Infinity;
    for (let i = 0; i < nodeHull.length; i++) {
      const a = nodeHull[i], b = nodeHull[(i + 1) % nodeHull.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx * (y - a.y) - dy * (x - a.x) < 0) inside = false;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
      nearest = Math.min(nearest, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
    return inside ? 0 : nearest;
  }

  function fixedGeometry() {
    return { x: innerWidth / 2, y: innerHeight / 2, radius: Math.min(innerWidth, innerHeight) * .4 };
  }

  function mobileLens() {
    return fixedLens.matches || panThroughNodes !== null;
  }

  function syncGestures() {
    // Finish the current touch gesture under the rules with which it started.
    if (touches.size) return;
    if (enabled && fixedLens.matches && panThroughNodes === null) {
      panThroughNodes = cy.nodes().filter(node => !node.pannable());
      panThroughNodes.panify();
    } else if ((!enabled || !fixedLens.matches) && panThroughNodes !== null) {
      panThroughNodes.unpanify();
      panThroughNodes = null;
    }
  }

  function initializeRenderer() {
    const gl = lens.getContext('webgl', { alpha: true, antialias: false });
    if (!gl) return null;
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision > 0
      ? 'highp' : 'mediump';
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertex, `
      attribute vec2 position;
      varying ${precision} vec2 uv;
      void main() {
        uv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `);
    gl.compileShader(vertex);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragment, `
      precision ${precision} float;
      uniform sampler2D graphImage;
      uniform float distortion;
      uniform vec2 focus;
      uniform float reach;
      uniform float diameter;
      uniform float overNode;
      varying ${precision} vec2 uv;
      void main() {
        vec2 offset = uv * 2.0 - 1.0;
        float radius = length(offset);
        if (radius > 1.0) discard;
        // Invert the normalized exponential radial map. Its edge is fixed
        // and its center magnification is D / (1 - exp(-D)).
        float sourceRadius = -log(1.0 - radius * (1.0 - exp(-distortion))) / distortion;
        vec2 sampleOffset = radius > 0.00001 ? offset * sourceRadius / radius : vec2(0.0);
        gl_FragColor = texture2D(graphImage, focus + sampleOffset * reach);
        // Fine rounded arms leave the focal point unobstructed.
        vec2 p = abs((uv - 0.5) * diameter);
        float horizontal = length(vec2(p.x - clamp(p.x, 4.0, 8.0), p.y));
        float vertical = length(vec2(p.y - clamp(p.y, 4.0, 8.0), p.x));
        float arms = min(horizontal, vertical) - 0.5;
        float ring = abs(length(p) - 4.5) - 0.6;
        float hair = mix(arms, ring, overNode);
        gl_FragColor = mix(gl_FragColor, vec4(0.04, 0.07, 0.09, 1.0),
          0.65 * (1.0 - smoothstep(0.25, 1.0, hair)));
        gl_FragColor = mix(gl_FragColor, vec4(0.7, 0.9, 0.83, 1.0),
          0.95 * (1.0 - smoothstep(-0.25, 0.25, hair)));
      }
    `);
    gl.compileShader(fragment);
    const program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Fisheye renderer could not initialize:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const atlasTexture = gl.createTexture(), previewTexture = gl.createTexture();
    for (const [texture, wrap] of [[atlasTexture, gl.REPEAT], [previewTexture, gl.CLAMP_TO_EDGE]]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    }
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'graphImage'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'distortion'), distortion);
    // A repeating, world-aligned tile atlas keeps pointer movement from
    // redrawing and uploading the whole high-resolution lens image.
    const atlasSize = Math.min(4096, 2 ** Math.floor(Math.log2(gl.getParameter(gl.MAX_TEXTURE_SIZE))));
    const tileSize = atlasSize / 16;
    source.width = source.height = tileSize;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasSize, atlasSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return { gl, atlasTexture, previewTexture, previewFrame: null, previewSize: 0, atlasSize, tileSize,
      tiles: new Map(), bounds: new Map(), version: -1, geometryVersion: -1, modelScale: null, complete: false,
      focus: gl.getUniformLocation(program, 'focus'), reach: gl.getUniformLocation(program, 'reach'),
      diameter: gl.getUniformLocation(program, 'diameter'), overNode: gl.getUniformLocation(program, 'overNode') };
  }

  function updateTiles(graphRenderer, focusX, focusY, radius, scale, modelScale) {
    const { gl, atlasSize, tileSize, tiles } = renderer;
    gl.bindTexture(gl.TEXTURE_2D, renderer.atlasTexture);
    const deadline = performance.now() + 5;
    if (renderer.geometryVersion !== geometryVersion || renderer.modelScale !== modelScale) {
      tiles.clear();
      renderer.bounds.clear();
      renderer.geometryVersion = geometryVersion;
      renderer.modelScale = modelScale;
    }
    renderer.version = sceneVersion;
    const wrap = value => ((value % 16) + 16) % 16;
    // Include a pixel beyond the circle for bilinear sampling at tile edges.
    const reach = radius * scale + 1;
    const firstX = Math.floor((focusX - reach) / tileSize), lastX = Math.floor((focusX + reach) / tileSize);
    const firstY = Math.floor((focusY - reach) / tileSize), lastY = Math.floor((focusY + reach) / tileSize);
    let elements, covered = true, complete = true;
    for (let ty = firstY; ty <= lastY; ty++) for (let tx = firstX; tx <= lastX; tx++) {
      const slotX = wrap(tx), slotY = wrap(-ty - 1), slot = slotY * 16 + slotX;
      const previous = tiles.get(slot);
      const present = previous && previous.x === tx && previous.y === ty;
      if (present && !previous.dirty) continue;
      if (performance.now() >= deadline) {
        complete = false;
        if (!present) covered = false;
        continue;
      }
      if (!elements) {
        elements = graphRenderer.getCachedZSortedEles().map(element => ({ element, bounds: { ...element.boundingBox() } }));
        for (const { element, bounds } of elements) {
          renderer.bounds.set(element, bounds);
          if (!styleKeys.has(element)) styleKeys.set(element, element._private.styleKey);
        }
      }
      const extent = { x1: (tx * tileSize - 1) / modelScale, y1: (ty * tileSize - 1) / modelScale,
        x2: ((tx + 1) * tileSize + 1) / modelScale, y2: ((ty + 1) * tileSize + 1) / modelScale };
      sourceContext.setTransform(1, 0, 0, 1, 0, 0);
      sourceContext.fillStyle = background;
      sourceContext.fillRect(0, 0, tileSize, tileSize);
      sourceContext.save();
      sourceContext.setTransform(modelScale, 0, 0, modelScale, -tx * tileSize, -ty * tileSize);
      // The vector export path retains sharp text at the lens's peak zoom.
      graphRenderer.drawElements(sourceContext, elements.filter(({ bounds: b }) =>
        b.x1 <= extent.x2 && b.x2 >= extent.x1 && b.y1 <= extent.y2 && b.y2 >= extent.y1
      ).map(({ element }) => element));
      sourceContext.restore();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, slotX * tileSize, slotY * tileSize, gl.RGBA, gl.UNSIGNED_BYTE, source);
      tiles.set(slot, { x: tx, y: ty, dirty: false });
    }
    const fraction = value => ((value / atlasSize) % 1 + 1) % 1;
    gl.uniform2f(renderer.focus, fraction(focusX), fraction(-focusY));
    gl.uniform1f(renderer.reach, radius * scale / atlasSize);
    renderer.complete = complete;
    return covered;
  }

  function invalidateAppearance(element) {
    if (!renderer || renderer.modelScale === null) return;
    const { modelScale, tileSize } = renderer;
    const previous = renderer.bounds.get(element), current = element.boundingBox();
    const affected = [{ previous, current }];
    if (element.isNode() && previous && ['x1', 'y1', 'x2', 'y2'].some(key => previous[key] !== current[key])) {
      for (const edge of element.connectedEdges()) affected.push({ previous: renderer.bounds.get(edge), current: edge.boundingBox() });
    }
    for (const { previous: before, current: after } of affected) {
      for (const tile of renderer.tiles.values()) {
        const x1 = tile.x * tileSize / modelScale, x2 = (tile.x + 1) * tileSize / modelScale;
        const y1 = tile.y * tileSize / modelScale, y2 = (tile.y + 1) * tileSize / modelScale;
        if (!before || [before, after].some(b => b.x1 <= x2 && b.x2 >= x1 && b.y1 <= y2 && b.y2 >= y1)) tile.dirty = true;
      }
    }
  }

  function drawPreview(graphRenderer, modelX, modelY, radius, zoom, size) {
    const { gl } = renderer;
    gl.bindTexture(gl.TEXTURE_2D, renderer.previewTexture);
    const pixels = Math.min(size, Math.ceil(2 * radius), 512), scale = pixels / (2 * radius), modelScale = zoom * scale;
    const previous = renderer.previewFrame;
    if (!previous || previous.version !== renderedCamera.version || previous.x !== modelX || previous.y !== modelY
        || previous.scale !== modelScale || preview.width !== pixels) {
      if (renderer.previewSize !== pixels) {
        preview.width = preview.height = pixels;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pixels, pixels, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        renderer.previewSize = pixels;
      }
      previewContext.setTransform(1, 0, 0, 1, 0, 0);
      previewContext.fillStyle = background;
      previewContext.fillRect(0, 0, pixels, pixels);
      const pixelRatio = graphRenderer.pixelRatio, camera = renderedCamera;
      const reach = radius / zoom;
      const x = ((modelX - reach) * camera.zoom + camera.pan.x) * pixelRatio;
      const y = ((modelY - reach) * camera.zoom + camera.pan.y) * pixelRatio;
      const span = 2 * reach * camera.zoom * pixelRatio;
      // Reuse the actual visible frame: no second geometry projection or
      // text rasterization while the force solver is updating positions.
      for (const layer of [graphRenderer.NODE, graphRenderer.DRAG]) {
        previewContext.drawImage(graphRenderer.data.canvases[layer], x, y, span, span, 0, 0, pixels, pixels);
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, preview);
      renderer.previewFrame = { version: renderedCamera.version, x: modelX, y: modelY, scale: modelScale };
    }
    gl.uniform2f(renderer.focus, .5, .5);
    gl.uniform1f(renderer.reach, .5);
  }

  function hide() {
    lens.hidden = true;
    if (!enabled || document.hidden || graph.getAttribute('aria-busy') === 'true') {
      clearTimeout(refineTimer); refineTimer = null;
      status.hidden = true;
      statusNode = null;
      statusDescription.textContent = '';
      statusRepositories.replaceChildren();
    }
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function schedule() {
    if (!enabled || (!mobileLens() && !pointer) || document.hidden || graph.getAttribute('aria-busy') === 'true') {
      hide();
      return;
    }
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = null;
    if (!enabled || (!mobileLens() && !pointer) || document.hidden || graph.getAttribute('aria-busy') === 'true') return hide();
    drawing = true;
    try {
      paint();
    } finally {
      drawing = false;
    }
  }

  function paint() {
    const graphRenderer = cy.renderer();
    const interactive = performance.now() - lastMotion < 160 || touches.size > 1;
    // Sharp vector rendering needs current projections. Live previews reuse
    // the main canvas, whose text and geometry already belong to one frame.
    if (!interactive) graphRenderer.flushRenderedStyleQueue();
    // Cytoscape also emits style events while painting unchanged backgrounds.
    // Only changes to the computed style should discard the image tiles.
    if (!interactive) {
      for (const element of changedStyles) {
        const key = element._private.styleKey;
        if (styleKeys.get(element) !== key) {
          sceneVersion++;
          invalidateAppearance(element);
        }
        styleKeys.set(element, key);
      }
      changedStyles.clear();
    }
    const fixed = mobileLens() ? fixedGeometry() : null;
    const focus = fixed ?? pointer;
    const radius = fixed ? fixed.radius : Math.min(200, innerWidth * .42, innerHeight * .42);
    const diameter = radius * 2, pixelRatio = devicePixelRatio || 1;
    const bounds = graph.getBoundingClientRect(), pan = cy.pan(), zoom = cy.zoom();
    const modelX = (focus.x - bounds.left - pan.x) / zoom;
    const modelY = (focus.y - bounds.top - pan.y) / zoom;
    const distance = distanceToGraph(modelX, modelY) * zoom / radius;
    const displayedDistance = (1 - Math.exp(-distortion * distance)) / (1 - Math.exp(-distortion));
    // A boundary half a radius from the center leaves only a ~20% circle cap.
    // Use the nodes' hull so gaps within a sparse graph don't dismiss the lens.
    // A small reentry margin prevents flicker along that boundary.
    if (displayedDistance > (lens.hidden ? .46 : .5)) return hide();
    const size = Math.ceil(diameter * pixelRatio);
    if (lens.width !== size || lens.height !== size) { lens.width = size; lens.height = size; }
    lens.style.width = lens.style.height = diameter + 'px';
    let x = focus.x, y = focus.y;
    if (!fixed && pointer.touch) {
      x = Math.max(radius + 8, Math.min(innerWidth - radius - 8, x));
      y = Math.max(radius + 8, Math.min(innerHeight - radius - 8, y - radius - 32));
    }
    lens.style.left = x - radius + 'px'; lens.style.top = y - radius + 'px';
    const maxScale = (renderer.atlasSize - 2 * renderer.tileSize) / diameter;
    let scale = Math.min(pixelRatio * peakZoom, maxScale);
    let modelScale = zoom * scale;
    if (interactive && renderer.version === sceneVersion && renderer.modelScale !== null) {
      // Reuse world-space pixels during zoom instead of rebuilding every
      // tile for each tiny change. Rebase in powers of two to
      // stay within the atlas and avoid excessive magnification blur.
      const desiredScale = modelScale;
      modelScale = renderer.modelScale;
      while (modelScale / zoom > maxScale) modelScale /= 2;
      while (modelScale < desiredScale / 2) modelScale *= 2;
      scale = modelScale / zoom;
    }
    const sharp = (!interactive || (renderer.version === sceneVersion && !changedStyles.size)) && updateTiles(graphRenderer,
      (focus.x - bounds.left - pan.x) * scale, (focus.y - bounds.top - pan.y) * scale, radius, scale, modelScale);
    if (!sharp) {
      drawPreview(graphRenderer, modelX, modelY, radius, zoom, size);
    }
    if (!interactive && !renderer.complete) schedule();
    const { gl } = renderer;
    gl.viewport(0, 0, size, size);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(renderer.diameter, diameter);
    const node = graphRenderer.findNearestElements(modelX, modelY, true, false).find(element => element.isNode());
    gl.uniform1f(renderer.overNode, node ? 1 : 0);
    if (node && statusNode !== node.id()) {
      statusNode = node.id();
      const project = projects.get(statusNode);
      statusDescription.textContent = project.description;
      statusRepositories.replaceChildren();
      for (const id of project.repository_ids) {
        const repo = repositories.get(id);
        const row = document.createElement('div'), link = document.createElement('a');
        link.href = repo.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = repo.full_name;
        row.append(link, document.createTextNode(` · ${repo.visibility}`));
        statusRepositories.append(row);
      }
      status.hidden = false;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    lens.hidden = false;
  }

  function setEnabled(next, write = false) {
    if (next && !renderer) renderer = initializeRenderer();
    if (next && !renderer) {
      toggle.disabled = true;
      toggle.title = 'Fisheye is unavailable: WebGL could not initialize.';
      next = false;
    }
    enabled = next;
    syncGestures();
    toggle.setAttribute('aria-pressed', String(enabled));
    if (write) {
      const url = new URL(location.href);
      if (enabled) url.searchParams.delete('fisheye');
      else url.searchParams.set('fisheye', '0');
      history.replaceState(null, '', url);
      for (const link of document.querySelectorAll('#views a')) {
        const target = new URL(link.href);
        if (enabled) target.searchParams.delete('fisheye');
        else target.searchParams.set('fisheye', '0');
        link.href = target.pathname + target.search;
      }
    }
    if (enabled && performance.now() - lastMotion < 160 && refineTimer === null) refineTimer = setTimeout(refine, 160);
    schedule();
  }

  function track(event) {
    if (mobileLens()) return;
    if (event.pointerType === 'touch' && touches.size !== 1) { pointer = null; hide(); return; }
    pointer = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
    schedule();
  }
  graph.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') track(event); });
  graph.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') touches.add(event.pointerId);
    track(event);
  }, { passive: true });
  graph.addEventListener('pointermove', track, { passive: true });
  for (const name of ['pointerup', 'pointercancel']) graph.addEventListener(name, event => {
    if (event.pointerType !== 'touch') return;
    touches.delete(event.pointerId); pointer = null;
    // Let native touchend finish before restoring another drag policy.
    setTimeout(() => { syncGestures(); schedule(); }, 0);
  }, { passive: true });
  graph.addEventListener('pointerleave', () => { pointer = null; schedule(); });
  toggle.addEventListener('click', () => setEnabled(!enabled, true));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !enabled) return;
    event.preventDefault();
    event.stopPropagation();
    setEnabled(false, true);
  }, true);
  cy.on('render', () => {
    renderedCamera = { zoom: cy.zoom(), pan: { ...cy.pan() }, version: renderedCamera.version + 1 };
    if (enabled) schedule();
  });
  cy.on('position add remove', event => {
    const node = event.target;
    if (event.type === 'position') {
      const position = node.position(), previous = nodePositions.get(node.id());
      if (previous && previous.x === position.x && previous.y === position.y) return;
      nodePositions.set(node.id(), { ...position });
    } else if (node.isNode()) {
      if (event.type === 'remove') nodePositions.delete(node.id());
      else nodePositions.set(node.id(), { ...node.position() });
    }
    sceneVersion++;
    geometryVersion++;
    if (event.type === 'remove' && renderer) renderer.bounds.delete(event.target);
    if (event.type === 'remove') { styleKeys.delete(event.target); changedStyles.delete(event.target); }
    if (event.type === 'position') motion();
    else if (enabled) schedule();
  });
  cy.on('zoom', motion);
  cy.on('style', event => {
    changedStyles.add(event.target);
    if (enabled && !drawing) schedule();
  });
  addEventListener('resize', schedule);
  fixedLens.addEventListener('change', () => { pointer = null; syncGestures(); schedule(); });
  addEventListener('popstate', () => setEnabled(new URLSearchParams(location.search).get('fisheye') !== '0'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { touches.clear(); pointer = null; syncGestures(); }
    schedule();
  });
  lens.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    setEnabled(false, true); renderer = null; toggle.disabled = true;
  });
  lens.addEventListener('webglcontextrestored', () => { toggle.disabled = false; });
  setEnabled(new URLSearchParams(location.search).get('fisheye') !== '0');
  return {
    nodeAt(renderedPosition, originalNode) {
      if (!enabled || !mobileLens() || lens.hidden || !renderedPosition) return originalNode;
      const bounds = graph.getBoundingClientRect(), fixed = fixedGeometry();
      const center = { x: fixed.x - bounds.left, y: fixed.y - bounds.top };
      const dx = renderedPosition.x - center.x, dy = renderedPosition.y - center.y;
      const radius = Math.hypot(dx, dy) / fixed.radius;
      if (radius > 1) return originalNode;
      // Match the shader's inverse radial map when picking a magnified node.
      const sourceRadius = -Math.log1p(-radius * (1 - Math.exp(-distortion))) / distortion;
      const scale = radius > .00001 ? sourceRadius / radius : 1 / peakZoom;
      const pan = cy.pan(), zoom = cy.zoom(), graphRenderer = cy.renderer();
      graphRenderer.flushRenderedStyleQueue();
      return graphRenderer.findNearestElements(
        (center.x + dx * scale - pan.x) / zoom,
        (center.y + dy * scale - pan.y) / zoom, true, false
      ).find(element => element.isNode()) ?? null;
    }
  };
}
