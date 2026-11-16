/* Presentation derives from the project inventory; no metadata is written back. */
function attachGraphControls({ cy, inventory, embedded, onGraphChange }) {
  const controls = document.getElementById('controls');
  const colorSelect = document.getElementById('color-by');
  const sizeSelect = document.getElementById('size-by');
  const edgeOptions = document.getElementById('edge-options');
  const legend = document.getElementById('legend-content');
  const parameters = new URLSearchParams(location.search);
  const defaults = { color: 'commits', size: 'complexity' };
  const repositories = new Map(inventory.repositories.map(repo => [repo.id, repo]));
  const info = new Map(inventory.projects.map(project => {
    const members = project.repository_ids.map(id => repositories.get(id));
    const representative = members[0];
    const difficulty = project.contribution_difficulty ?? representative.assessments.difficulty;
    return [project.id, {
      domain: representative.categories[0] ?? null,
      context: representative.work_contexts[0] ?? null,
      visibility: members.some(repo => repo.visibility === 'private') ? 'private' : 'public',
      commits: project.user_work.commit_count,
      activity: project.user_work.last_activity_date ? Date.parse(project.user_work.last_activity_date + 'T00:00:00Z') : null,
      repositories: members.length,
      complexity: representative.assessments.repository_complexity.score,
      difficulty: difficulty?.score ?? null,
      connections: 0
    }];
  }));
  const title = text => text.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
  const palette = ['#85c9b7', '#b4b0e0', '#e3bd86', '#d9a2bb', '#b1ca83', '#93bee4', '#c9a8df',
    '#ddd08a', '#8cccd0', '#e6ad8c', '#abc5ad', '#a6b3dd', '#c1d796', '#cfb59c', '#99c2d2',
    '#daa5d4', '#9ac9b9', '#bcb0de', '#c1cc8c', '#dfc39b', '#b8c2ce'];
  const categoryColors = new Map(Object.keys(inventory.category_definitions).map((key, i) => [key, palette[i % palette.length]]));
  const contextColors = new Map(Object.keys(inventory.work_context_types).map((key, i) => [key, palette[i % palette.length]]));
  const colorModes = {
    none: { label: 'Color by' },
    domain: { label: 'Primary domain', colors: categoryColors, labelFor: title, fade: 'activity' },
    context: { label: 'Primary work context', colors: contextColors, fade: 'commits',
      labelFor: key => inventory.work_context_types[key].label },
    visibility: { label: 'Visibility', colors: new Map([['public', '#91ceb2'], ['private', '#e3b388']]), labelFor: title, fade: 'activity' },
    commits: { label: 'Personal commits', log: true, fade: 'activity' },
    activity: { label: 'Last personal activity', date: true, fade: 'commits' },
    difficulty: { label: 'Contribution difficulty', max: 100, fade: 'commits',
      gradient: [[247, 231, 195], [238, 155, 70]] },
    connections: { label: 'Visible connections', log: true, fade: 'commits' }
  };
  const sizeModes = {
    none: { label: 'Size by' },
    commits: colorModes.commits,
    connections: colorModes.connections,
    repositories: { label: 'Repository count', log: true },
    complexity: { label: 'Codebase complexity', max: 100 },
    difficulty: colorModes.difficulty
  };
  const mutedCategories = new Map();
  function restoreLegendSelections(current) {
    for (const [mode, settings] of Object.entries(colorModes)) {
      if (!settings.colors) continue;
      const parameter = 'muted-' + mode;
      mutedCategories.set(mode, current.has(parameter)
        ? new Set(current.get(parameter).split(',').map(value => value || null)) : new Set());
    }
  }
  restoreLegendSelections(parameters);
  function populate(select, modes, parameter) {
    for (const [value, mode] of Object.entries(modes)) select.add(new Option(mode.label, value));
    select.value = Object.hasOwn(modes, parameters.get(parameter)) ? parameters.get(parameter) : defaults[parameter];
  }
  populate(colorSelect, colorModes, 'color');
  populate(sizeSelect, sizeModes, 'size');

  const groups = [];
  function edgeCount(key, value) {
    return cy.edges().filter(edge => {
      if (key === 'rules') return edge.data(value === 'cutoff' ? 'withinCutoff' : 'nearest');
      if (key === 'types') return edge.data('type') === value;
      return edge.data('claims').some(claim => claim[key] === value);
    }).length;
  }
  function checklist(key, heading, choices, { actions = false } = {}) {
    const fieldset = document.createElement('fieldset');
    const headingElement = document.createElement('legend');
    headingElement.textContent = heading;
    fieldset.append(headingElement);
    const current = new URLSearchParams(location.search);
    const selected = current.has(key) ? new Set(current.get(key).split(',')) : new Set(choices.map(choice => choice.value));
    const group = { key, fieldset, inputs: [] };
    if (actions) {
      const buttons = document.createElement('div');
      buttons.className = 'filter-actions';
      for (const [label, checked] of [['All', true], ['None', false]]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label;
        button.setAttribute('aria-label', label + ' ' + heading.toLowerCase());
        button.addEventListener('click', () => {
          group.inputs.forEach(input => { input.checked = checked; });
          filterEdges();
        });
        buttons.append(button);
      }
      fieldset.append(buttons);
    }
    for (const choice of choices) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.name = key; input.value = choice.value;
      input.checked = selected.has(choice.value);
      input.addEventListener('change', () => filterEdges());
      const count = document.createElement('span');
      count.className = 'edge-count';
      count.textContent = edgeCount(key, choice.value).toLocaleString();
      label.append(input, document.createTextNode(choice.label), count);
      fieldset.append(label); group.inputs.push(input);
    }
    edgeOptions.append(fieldset); groups.push(group);
    return () => new Set(group.inputs.filter(input => input.checked).map(input => input.value));
  }
  let selectedRules, selectedTypes, selectedBases, selectedConfidence;
  function buildEdgeOptions() {
  groups.length = 0;
  edgeOptions.replaceChildren();
  if (embedded) {
    selectedRules = checklist('rules', 'Selection rules', [
      { value: 'cutoff', label: 'Within the 2% distance cutoff' },
      { value: 'nearest', label: 'Each project’s two nearest neighbors' }
    ]);
  } else {
    selectedTypes = checklist('types', 'Relationship types', Object.entries(inventory.link_types).map(([value, type]) => ({
      value, label: type.label
    })), { actions: true });
    selectedBases = checklist('basis', 'Evidence basis', [
      { value: 'established', label: 'Established' },
      { value: 'interpretive', label: 'Interpretive' },
      { value: 'prospective', label: 'Prospective' }
    ]);
    selectedConfidence = checklist('confidence', 'Confidence', ['high', 'medium', 'low'].map(value => ({ value, label: title(value) })));
  }
  }

  function writeURL() {
    const url = new URL(location.href);
    for (const [key, select] of [['color', colorSelect], ['size', sizeSelect]]) {
      if (select.value === defaults[key]) url.searchParams.delete(key);
      else url.searchParams.set(key, select.value);
    }
    for (const [mode, muted] of mutedCategories) {
      const parameter = 'muted-' + mode;
      if (!muted.size) url.searchParams.delete(parameter);
      else url.searchParams.set(parameter, [...muted].map(value => value ?? '').join(','));
    }
    for (const group of groups) {
      const checked = group.inputs.filter(input => input.checked).map(input => input.value);
      if (checked.length === group.inputs.length) url.searchParams.delete(group.key);
      else url.searchParams.set(group.key, checked.join(','));
    }
    history.replaceState(null, '', url);
    for (const link of document.querySelectorAll('#views a')) {
      const target = new URL(url);
      target.searchParams.set('view', link.dataset.view);
      link.href = target.pathname + target.search;
    }
  }
  function updateConnections() {
    const neighbors = new Map(cy.nodes().map(node => [node.id(), new Set()]));
    for (const edge of cy.edges().not('.filtered-out')) {
      neighbors.get(edge.source().id()).add(edge.target().id());
      neighbors.get(edge.target().id()).add(edge.source().id());
    }
    for (const [id, peers] of neighbors) info.get(id).connections = peers.size;
  }
  const known = value => typeof value === 'number' && Number.isFinite(value);
  function scale(mode, key) {
    const values = [...info.values()].map(item => item[key]).filter(known);
    const min = mode.date && values.length ? Math.min(...values) : 0;
    const max = mode.date ? new Date().setUTCHours(0, 0, 0, 0) : mode.max ?? Math.max(0, ...values);
    return { min, max, knownCount: values.length, ratio(value) {
      if (!known(value)) return null;
      // A 30-day half-life concentrates date contrast near today.
      if (mode.date) return 2 ** (-Math.max(0, max - value) / (30 * 86400000));
      if (max === min) return 0;
      return Math.max(0, Math.min(1, mode.log ? Math.log1p(value) / Math.log1p(max) : (value - min) / (max - min)));
    } };
  }
  function gradient(ratio, mode) {
    const [low, high] = mode.gradient ?? [[210, 222, 231], [83, 185, 160]];
    return '#' + low.map((value, i) => Math.round(value + (high[i] - value) * ratio).toString(16).padStart(2, '0')).join('');
  }
  const background = getComputedStyle(document.documentElement).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number);
  const channels = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const luminance = rgb => rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const darkText = '#14212a', lightText = '#d1dce5';
  const darkLuminance = luminance(channels(darkText)), lightLuminance = luminance(channels(lightText));
  function fadedAppearance(color, amount) {
    const rgb = channels(color).map((channel, index) => Math.round(background[index] + (channel - background[index]) * amount));
    const brightness = luminance(rgb);
    const darkContrast = (brightness + .05) / (darkLuminance + .05);
    const lightContrast = (lightLuminance + .05) / (brightness + .05);
    return {
      color: '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join(''),
      textColor: darkContrast >= lightContrast ? darkText : lightText
    };
  }
  function applyAppearance(render = true) {
    const colorMode = colorModes[colorSelect.value], sizeMode = sizeModes[sizeSelect.value];
    const colorScale = !colorMode.colors && colorSelect.value !== 'none' ? scale(colorMode, colorSelect.value) : null;
    const sizeScale = sizeSelect.value !== 'none' ? scale(sizeMode, sizeSelect.value) : null;
    const fadeScale = colorMode.fade ? scale(colorModes[colorMode.fade], colorMode.fade) : null;
    cy.batch(() => {
      for (const node of cy.nodes()) {
        const item = info.get(node.id());
        let color = '#bac5cf';
        if (colorMode.colors) {
          const category = item[colorSelect.value];
          color = mutedCategories.get(colorSelect.value).has(category)
            ? '#bac5cf' : colorMode.colors.get(category) ?? '#aab2bd';
        }
        else if (colorScale) {
          const ratio = colorScale.ratio(item[colorSelect.value]);
          color = ratio === null ? '#aab2bd' : gradient(ratio, colorMode);
        }
        const ratio = sizeScale ? sizeScale.ratio(item[sizeSelect.value]) : 0;
        const size = (ratio ?? 0) * (sizeSelect.value === 'difficulty' ? 2.5 : 1);
        const fade = fadeScale ? .35 + .65 * (fadeScale.ratio(item[colorMode.fade]) ?? 0) : 1;
        node.data({ ...fadedAppearance(color, fade), width: node.data('labelWidth') + 12 * size,
          height: 16 + 16 * size, padding: sizeScale ? 6 + 8 * size : 9,
          borderStyle: sizeScale && ratio === null ? 'dashed' : 'solid' });
      }
    });
    if (render) renderLegend(colorMode, colorScale, sizeMode, sizeScale);
  }
  function renderLegend(colorMode, colorScale, sizeMode, sizeScale) {
    legend.replaceChildren();
    const heading = text => { const element = document.createElement('h3'); element.textContent = text; legend.append(element); };
    if (colorSelect.value !== 'none') heading('Color · ' + colorMode.label);
    if (colorMode.colors) {
      const counts = new Map();
      for (const item of info.values()) { const value = item[colorSelect.value]; counts.set(value, (counts.get(value) ?? 0) + 1); }
      const mode = colorSelect.value, muted = mutedCategories.get(mode);
      const actions = document.createElement('div');
      actions.className = 'filter-actions';
      for (const [text, checked] of [['All', true], ['None', false]]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = text;
        button.addEventListener('click', () => {
          muted.clear();
          if (!checked) for (const key of counts.keys()) muted.add(key);
          legend.querySelectorAll('input.legend-toggle').forEach(input => { input.checked = checked; });
          applyAppearance(false);
          writeURL();
        });
        actions.append(button);
      }
      legend.append(actions);
      for (const [key, count] of counts) {
        const row = document.createElement('label'), swatch = document.createElement('input');
        row.className = 'legend-entry'; swatch.className = 'legend-swatch legend-toggle';
        swatch.type = 'checkbox'; swatch.name = 'legend-' + mode; swatch.value = key ?? '';
        swatch.checked = !muted.has(key);
        swatch.style.setProperty('--swatch-color', colorMode.colors.get(key) ?? '#aab2bd');
        swatch.addEventListener('change', () => {
          if (swatch.checked) muted.delete(key);
          else muted.add(key);
          applyAppearance(false);
          writeURL();
        });
        row.append(swatch, document.createTextNode(`${key === null ? 'Unknown' : colorMode.labelFor(key)} · ${count}`));
        legend.append(row);
      }
    } else if (colorScale && colorScale.knownCount) {
      const bar = document.createElement('div'), range = document.createElement('div');
      bar.className = 'legend-gradient'; range.className = 'legend-range';
      bar.style.background = `linear-gradient(to right, ${gradient(0, colorMode)}, ${gradient(1, colorMode)})`;
      for (const value of [colorScale.min, colorScale.max]) {
        const text = document.createElement('span'); text.textContent = colorMode.date ? new Date(value).toISOString().slice(0, 10) : value.toLocaleString(); range.append(text);
      }
      legend.append(bar, range);
    }
    if (colorScale && [...info.values()].some(item => !known(item[colorSelect.value]))) {
      const row = document.createElement('div'), swatch = document.createElement('span');
      row.className = 'legend-entry'; swatch.className = 'legend-swatch';
      swatch.style.background = '#aab2bd';
      row.append(swatch, document.createTextNode('Unknown')); legend.append(row);
    }
    if (sizeSelect.value !== 'none') heading('Size · ' + sizeMode.label);
    if (sizeScale) {
      const range = document.createElement('div');
      range.textContent = `${sizeScale.min.toLocaleString()}–${sizeScale.max.toLocaleString()}`;
      legend.append(range);
      if ([...info.values()].some(item => !known(item[sizeSelect.value]))) {
        const row = document.createElement('div'), swatch = document.createElement('span');
        row.className = 'legend-entry'; swatch.className = 'legend-swatch';
        swatch.style.borderStyle = 'dashed';
        row.append(swatch, document.createTextNode('Unknown')); legend.append(row);
      }
    }
  }
  function filterEdges(initial = false) {
    const rules = embedded ? selectedRules() : null;
    const types = embedded ? null : selectedTypes(), bases = embedded ? null : selectedBases(), confidence = embedded ? null : selectedConfidence();
    cy.batch(() => {
      for (const edge of cy.edges()) {
        const include = embedded
          ? (rules.has('cutoff') && edge.data('withinCutoff')) || (rules.has('nearest') && edge.data('nearest'))
          : types.has(edge.data('type')) && edge.data('claims').some(claim => bases.has(claim.basis) && confidence.has(claim.confidence));
        edge.toggleClass('filtered-out', !include);
      }
    });
    updateConnections();
    applyAppearance();
    writeURL();
    if (!initial) onGraphChange({ resize: sizeSelect.value === 'connections', edgesChanged: true });
  }
  colorSelect.addEventListener('change', () => { applyAppearance(); writeURL(); });
  sizeSelect.addEventListener('change', () => { applyAppearance(); onGraphChange({ resize: true }); writeURL(); });
  for (const details of controls.querySelectorAll('details')) details.addEventListener('toggle', () => {
    if (details.open) for (const other of controls.querySelectorAll('details')) if (other !== details) other.open = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!controls.contains(event.target)) controls.querySelectorAll('details[open]').forEach(details => { details.open = false; });
  });
  controls.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = controls.querySelector('details[open]');
    if (open) { open.open = false; open.querySelector('summary').focus(); event.preventDefault(); }
  });
  buildEdgeOptions();
  filterEdges(true);
  return {
    setView(nextEmbedded, restoreAppearance = false) {
      embedded = nextEmbedded;
      if (restoreAppearance) {
        const current = new URLSearchParams(location.search);
        restoreLegendSelections(current);
        colorSelect.value = Object.hasOwn(colorModes, current.get('color')) ? current.get('color') : defaults.color;
        sizeSelect.value = Object.hasOwn(sizeModes, current.get('size')) ? current.get('size') : defaults.size;
      }
      controls.querySelectorAll('details').forEach(details => { details.open = false; });
      buildEdgeOptions();
      filterEdges(true);
    }
  };
}
