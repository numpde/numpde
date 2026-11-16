/* A focus-and-context lens: redraw and distort pixels, never graph positions.
 * https://bost.ocks.org/mike/fisheye/
 */
function attachGraphFisheye({ cy, graph }) {
  const toggle = document.getElementById('fisheye-toggle');
  const lens = document.getElementById('fisheye');
  const source = document.createElement('canvas');
  const sourceContext = source.getContext('2d');
  const background = getComputedStyle(document.documentElement).backgroundColor;
  const distortion = 4;
  const peakZoom = distortion / (1 - Math.exp(-distortion));
  const touches = new Set();
  let enabled = false, pointer = null, frame = null, renderer = null;

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
      varying ${precision} vec2 uv;
      void main() {
        vec2 offset = uv * 2.0 - 1.0;
        float radius = length(offset);
        if (radius > 1.0) discard;
        // Invert the normalized exponential radial map. Its edge is fixed
        // and its center magnification is D / (1 - exp(-D)).
        float sourceRadius = -log(1.0 - radius * (1.0 - exp(-distortion))) / distortion;
        vec2 sampleOffset = radius > 0.00001 ? offset * sourceRadius / radius : vec2(0.0);
        gl_FragColor = texture2D(graphImage, sampleOffset * 0.5 + 0.5);
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
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'graphImage'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'distortion'), distortion);
    return { gl, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  }

  function hide() {
    lens.hidden = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function schedule() {
    if (!enabled || !pointer || document.hidden || graph.getAttribute('aria-busy') === 'true') {
      hide();
      return;
    }
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = null;
    if (!enabled || !pointer || document.hidden || graph.getAttribute('aria-busy') === 'true') return hide();
    const graphRenderer = cy.renderer();
    // Forces may update positions between the main render and this callback.
    // Bring cached label and edge projections up to the same frame first.
    graphRenderer.flushRenderedStyleQueue();
    const radius = Math.min(200, innerWidth * .42, innerHeight * .42);
    const diameter = radius * 2, pixelRatio = devicePixelRatio || 1;
    const size = Math.ceil(diameter * pixelRatio);
    if (lens.width !== size || lens.height !== size) { lens.width = size; lens.height = size; }
    lens.style.width = lens.style.height = diameter + 'px';
    let x = pointer.x, y = pointer.y;
    if (pointer.touch) {
      x = Math.max(radius + 8, Math.min(innerWidth - radius - 8, x));
      y = Math.max(radius + 8, Math.min(innerHeight - radius - 8, y - radius - 32));
    }
    lens.style.left = x - radius + 'px'; lens.style.top = y - radius + 'px';
    const sourceSize = Math.min(renderer.maxTextureSize, Math.ceil(diameter * pixelRatio * peakZoom));
    if (source.width !== sourceSize || source.height !== sourceSize) { source.width = sourceSize; source.height = sourceSize; }
    const scale = sourceSize / diameter;
    sourceContext.setTransform(1, 0, 0, 1, 0, 0);
    sourceContext.fillStyle = background;
    sourceContext.fillRect(0, 0, sourceSize, sourceSize);
    const bounds = graph.getBoundingClientRect(), pan = cy.pan();
    // Use the pinned renderer's vector export path. renderTo() reuses viewport
    // textures, so a larger canvas still magnifies cached low-resolution text.
    sourceContext.save();
    sourceContext.translate((radius + pan.x - (pointer.x - bounds.left)) * scale,
      (radius + pan.y - (pointer.y - bounds.top)) * scale);
    sourceContext.scale(cy.zoom() * scale, cy.zoom() * scale);
    graphRenderer.drawElements(sourceContext, graphRenderer.getCachedZSortedEles());
    sourceContext.restore();
    const { gl } = renderer;
    gl.viewport(0, 0, size, size);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
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
    toggle.setAttribute('aria-pressed', String(enabled));
    if (write) {
      const url = new URL(location.href);
      if (enabled) url.searchParams.set('fisheye', '1');
      else url.searchParams.delete('fisheye');
      history.replaceState(null, '', url);
      for (const link of document.querySelectorAll('#views a')) {
        const target = new URL(link.href);
        if (enabled) target.searchParams.set('fisheye', '1');
        else target.searchParams.delete('fisheye');
        link.href = target.pathname + target.search;
      }
    }
    schedule();
  }

  function track(event) {
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
    touches.delete(event.pointerId); pointer = null; hide();
  }, { passive: true });
  graph.addEventListener('pointerleave', () => { pointer = null; hide(); });
  toggle.addEventListener('click', () => setEnabled(!enabled, true));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !enabled) return;
    event.preventDefault();
    event.stopPropagation();
    setEnabled(false, true);
  }, true);
  cy.on('render', schedule);
  addEventListener('resize', schedule);
  addEventListener('popstate', () => setEnabled(new URLSearchParams(location.search).get('fisheye') === '1'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { touches.clear(); pointer = null; }
    schedule();
  });
  lens.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    setEnabled(false, true); renderer = null; toggle.disabled = true;
  });
  lens.addEventListener('webglcontextrestored', () => { toggle.disabled = false; });
  setEnabled(new URLSearchParams(location.search).get('fisheye') === '1');
}
