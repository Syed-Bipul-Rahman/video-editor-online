// ============================================================
// Video Editor – Client-side logic
// ============================================================
(() => {
  'use strict';

  const CANVAS_W = 1280;
  const CANVAS_H = 720;
  const DEFAULT_DURATION = 30;

  // --- State ---
  const state = {
    clips: [],
    layers: 3,
    selectedId: null,
    currentTime: 0,
    totalDuration: DEFAULT_DURATION,
    playing: false,
    pixelsPerSecond: 50,
    undoStack: [],
    redoStack: [],
    dragState: null,       // timeline drag
    canvasDrag: null,      // canvas drag { mode, clipId, startMX, startMY, orig }
    editingTextId: null,   // inline text editing on canvas
  };

  // Media cache: clipId -> HTMLVideoElement | HTMLImageElement | HTMLAudioElement
  // Also keeps "source" entries so split clips share the same media element
  const mediaCache = new Map();
  // sourceMap: clipId -> sourceClipId (for split clips sharing media)
  const sourceMap = new Map();

  // --- DOM refs ---
  const canvas = document.getElementById('preview-canvas');
  const ctx = canvas.getContext('2d');
  const timeDisplay = document.getElementById('time-display');
  const timelineContainer = document.getElementById('timeline-container');
  const timelineLayers = document.getElementById('timeline-layers');
  const timelineRuler = document.getElementById('timeline-ruler');
  const playhead = document.getElementById('playhead');
  const propsContent = document.getElementById('props-content');
  const fileInput = document.getElementById('file-input');
  const zoomSlider = document.getElementById('timeline-zoom');

  // Hidden textarea for inline text editing
  let inlineTextInput = null;

  // --- Init ---
  function init() {
    buildLayers();
    drawRuler();
    renderTimeline();
    renderFrame();
    bindEvents();
    requestAnimationFrame(tick);
  }

  // ============================================================
  // Undo / Redo
  // ============================================================
  function pushUndo() {
    state.undoStack.push(JSON.parse(JSON.stringify(state.clips)));
    state.redoStack = [];
    if (state.undoStack.length > 100) state.undoStack.shift();
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(JSON.parse(JSON.stringify(state.clips)));
    state.clips = state.undoStack.pop();
    reloadMissingMedia();
    onTimelineChanged();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(JSON.parse(JSON.stringify(state.clips)));
    state.clips = state.redoStack.pop();
    reloadMissingMedia();
    onTimelineChanged();
  }

  // After undo/redo, clips may reference IDs not in mediaCache
  function reloadMissingMedia() {
    for (const clip of state.clips) {
      if (clip.type === 'text') continue;
      if (!getMediaForClip(clip)) {
        loadMedia(clip);
      }
    }
  }

  // ============================================================
  // Media helpers
  // ============================================================
  function getMediaForClip(clip) {
    if (mediaCache.has(clip.id)) return mediaCache.get(clip.id);
    const srcId = sourceMap.get(clip.id);
    if (srcId && mediaCache.has(srcId)) return mediaCache.get(srcId);
    return null;
  }

  async function loadMedia(clip) {
    // Check if a source already exists (for split clips)
    const srcId = sourceMap.get(clip.id);
    if (srcId && mediaCache.has(srcId)) return;

    if (clip.type === 'video') {
      const video = document.createElement('video');
      video.src = clip.path;
      video.muted = true;
      video.preload = 'auto';
      await new Promise(resolve => {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener('error', resolve, { once: true });
        video.load();
      });
      mediaCache.set(clip.id, video);
    } else if (clip.type === 'image') {
      const img = new Image();
      img.src = clip.path;
      await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
      mediaCache.set(clip.id, img);
    } else if (clip.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = clip.path;
      audio.preload = 'auto';
      mediaCache.set(clip.id, audio);
    }
  }

  // ============================================================
  // Timeline rendering
  // ============================================================
  function buildLayers() {
    timelineLayers.innerHTML = '';
    for (let i = 0; i < state.layers; i++) {
      const layer = document.createElement('div');
      layer.className = 'timeline-layer';
      layer.dataset.layer = i;
      layer.innerHTML = `<span class="layer-label">Layer ${i + 1}</span>`;
      timelineLayers.appendChild(layer);
    }
  }

  function drawRuler() {
    timelineRuler.innerHTML = '';
    const totalPx = state.totalDuration * state.pixelsPerSecond;
    timelineRuler.style.width = totalPx + 'px';

    const step = state.pixelsPerSecond >= 80 ? 1 : state.pixelsPerSecond >= 30 ? 2 : 5;
    for (let t = 0; t <= state.totalDuration; t += step) {
      const mark = document.createElement('div');
      mark.className = 'ruler-mark';
      mark.style.left = (t * state.pixelsPerSecond) + 'px';
      mark.textContent = formatTime(t);
      timelineRuler.appendChild(mark);
    }
  }

  function renderTimeline() {
    timelineLayers.querySelectorAll('.timeline-clip').forEach(el => el.remove());

    const totalPx = state.totalDuration * state.pixelsPerSecond;
    timelineLayers.style.width = totalPx + 'px';

    for (const clip of state.clips) {
      const layerEl = timelineLayers.querySelector(`[data-layer="${clip.layer}"]`);
      if (!layerEl) continue;

      const el = document.createElement('div');
      el.className = 'timeline-clip' + (clip.id === state.selectedId ? ' selected' : '');
      el.dataset.id = clip.id;
      el.dataset.type = clip.type;
      el.style.left = (clip.startTime * state.pixelsPerSecond) + 'px';
      el.style.width = (clip.duration * state.pixelsPerSecond) + 'px';

      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = clip.name || clip.type;
      el.appendChild(label);

      // Trim handles
      const lh = document.createElement('div');
      lh.className = 'trim-handle left';
      el.appendChild(lh);
      const rh = document.createElement('div');
      rh.className = 'trim-handle right';
      el.appendChild(rh);

      // Keyframe diamonds
      if (clip.keyframes) {
        for (const kf of clip.keyframes) {
          const diamond = document.createElement('div');
          diamond.className = 'clip-keyframe';
          diamond.style.left = (kf.time * state.pixelsPerSecond) + 'px';
          diamond.title = `KF @${kf.time.toFixed(2)}s`;
          el.appendChild(diamond);
        }
      }

      layerEl.appendChild(el);
    }

    updatePlayhead();
  }

  function updatePlayhead() {
    playhead.style.left = (state.currentTime * state.pixelsPerSecond) + 'px';
    timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.totalDuration)}`;
  }

  function onTimelineChanged() {
    recalcDuration();
    renderTimeline();
    renderProperties();
    renderFrame();
  }

  function recalcDuration() {
    let max = DEFAULT_DURATION;
    for (const c of state.clips) {
      const end = c.startTime + c.duration;
      if (end > max) max = end;
    }
    state.totalDuration = max + 5;
    drawRuler();
  }

  // ============================================================
  // Events
  // ============================================================
  function bindEvents() {
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-add-media').addEventListener('click', () => fileInput.click());
    document.getElementById('btn-add-text').addEventListener('click', addTextClip);
    document.getElementById('btn-export').addEventListener('click', doExport);
    document.getElementById('btn-split').addEventListener('click', splitAtPlayhead);
    document.getElementById('btn-delete').addEventListener('click', deleteSelected);
    document.getElementById('btn-add-keyframe').addEventListener('click', addKeyframeAtPlayhead);
    document.getElementById('btn-add-layer').addEventListener('click', addLayer);
    document.getElementById('btn-play').addEventListener('click', play);
    document.getElementById('btn-pause').addEventListener('click', pause);
    document.getElementById('btn-stop').addEventListener('click', stop);
    document.getElementById('export-close').addEventListener('click', () => {
      document.getElementById('export-modal').classList.add('hidden');
    });

    fileInput.addEventListener('change', handleFileUpload);
    zoomSlider.addEventListener('input', () => {
      state.pixelsPerSecond = parseInt(zoomSlider.value);
      drawRuler();
      renderTimeline();
    });

    // Timeline interactions
    timelineContainer.addEventListener('mousedown', onTimelineMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Canvas interactions — click to select, drag to move, dblclick to edit text
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('dblclick', onCanvasDblClick);

    // Keyboard
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (state.editingTextId) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.preventDefault(); undo(); }
        if (e.key === 'y') { e.preventDefault(); redo(); }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      if (e.key === ' ') { e.preventDefault(); state.playing ? pause() : play(); }
      if (e.key === 'Escape') { finishInlineEdit(); state.selectedId = null; onTimelineChanged(); }
    });
  }

  // ============================================================
  // Timeline mouse handling
  // ============================================================
  function onTimelineMouseDown(e) {
    const clipEl = e.target.closest('.timeline-clip');

    if (!clipEl) {
      const rect = timelineContainer.getBoundingClientRect();
      const x = e.clientX - rect.left + timelineContainer.scrollLeft;
      state.currentTime = Math.max(0, x / state.pixelsPerSecond);
      updatePlayhead();
      renderFrame();
      state.selectedId = null;
      renderTimeline();
      renderProperties();
      return;
    }

    const clipId = clipEl.dataset.id;
    state.selectedId = clipId;
    renderTimeline();
    renderProperties();

    const clip = state.clips.find(c => c.id === clipId);
    if (!clip) return;

    const isLeftHandle = e.target.classList.contains('left');
    const isRightHandle = e.target.classList.contains('right');

    state.dragState = {
      clipId,
      mode: isLeftHandle ? 'trim-left' : isRightHandle ? 'trim-right' : 'move',
      startX: e.clientX,
      origLeft: clip.startTime,
      origWidth: clip.duration,
      origTrimStart: clip.trimStart || 0,
      origLayer: clip.layer,
    };

    pushUndo();
  }

  function onMouseMove(e) {
    // Timeline drag
    if (state.dragState) {
      const { clipId, mode, startX, origLeft, origWidth, origTrimStart } = state.dragState;
      const clip = state.clips.find(c => c.id === clipId);
      if (!clip) return;

      const dx = (e.clientX - startX) / state.pixelsPerSecond;

      if (mode === 'move') {
        clip.startTime = Math.max(0, origLeft + dx);
        const rect = timelineLayers.getBoundingClientRect();
        const y = e.clientY - rect.top + timelineContainer.scrollTop;
        const newLayer = Math.floor(y / 48);
        if (newLayer >= 0 && newLayer < state.layers) clip.layer = newLayer;
      } else if (mode === 'trim-left') {
        const delta = Math.min(dx, origWidth - 0.1);
        clip.startTime = origLeft + delta;
        clip.duration = origWidth - delta;
        clip.trimStart = Math.max(0, origTrimStart + delta);
      } else if (mode === 'trim-right') {
        clip.duration = Math.max(0.1, origWidth + dx);
      }

      renderTimeline();
      renderFrame();
      return;
    }

    // Canvas drag
    if (state.canvasDrag) {
      const { clipId, mode, startMX, startMY, orig } = state.canvasDrag;
      const clip = state.clips.find(c => c.id === clipId);
      if (!clip) return;

      const rect = canvas.getBoundingClientRect();
      const scaleFactorX = CANVAS_W / rect.width;
      const scaleFactorY = CANVAS_H / rect.height;
      const mx = (e.clientX - rect.left) * scaleFactorX;
      const my = (e.clientY - rect.top) * scaleFactorY;
      const dxCanvas = mx - startMX;
      const dyCanvas = my - startMY;

      if (mode === 'move') {
        clip.x = orig.x + dxCanvas;
        clip.y = orig.y + dyCanvas;
      } else if (mode === 'scale') {
        // Drag from corner: compute scale factor from distance to center
        const centerX = (orig.x || 0) + CANVAS_W / 2;
        const centerY = (orig.y || 0) + CANVAS_H / 2;
        const origDist = Math.hypot(startMX - centerX, startMY - centerY) || 1;
        const newDist = Math.hypot(mx - centerX, my - centerY);
        const factor = newDist / origDist;
        clip.scaleX = Math.max(0.05, orig.scaleX * factor);
        clip.scaleY = Math.max(0.05, orig.scaleY * factor);
      } else if (mode === 'rotate') {
        const centerX = (orig.x || 0) + CANVAS_W / 2;
        const centerY = (orig.y || 0) + CANVAS_H / 2;
        const origAngle = Math.atan2(startMY - centerY, startMX - centerX);
        const newAngle = Math.atan2(my - centerY, mx - centerX);
        clip.rotation = orig.rotation + (newAngle - origAngle) * 180 / Math.PI;
      }

      renderFrame();
      renderProperties();
    }
  }

  function onMouseUp() {
    state.dragState = null;
    state.canvasDrag = null;
  }

  // ============================================================
  // Canvas interaction — select, move, scale, rotate
  // ============================================================
  function canvasToLocal(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function getClipBounds(clip) {
    const localTime = state.currentTime - clip.startTime;
    const props = interpolateKeyframes(clip, localTime);
    const cx = (props.x || 0) + CANVAS_W / 2;
    const cy = (props.y || 0) + CANVAS_H / 2;
    const sx = props.scaleX || 1;
    const sy = props.scaleY || 1;

    let hw, hh;
    if (clip.type === 'text') {
      ctx.save();
      ctx.font = `${clip.fontSize || 48}px ${clip.fontFamily || 'Arial'}`;
      const metrics = ctx.measureText(clip.text || '');
      hw = metrics.width / 2;
      hh = (clip.fontSize || 48) / 2;
      ctx.restore();
    } else if (clip.type === 'video') {
      const media = getMediaForClip(clip);
      if (media) {
        const aspect = media.videoWidth / media.videoHeight;
        if (aspect > CANVAS_W / CANVAS_H) {
          hw = CANVAS_W / 2; hh = (CANVAS_W / aspect) / 2;
        } else {
          hh = CANVAS_H / 2; hw = (CANVAS_H * aspect) / 2;
        }
      } else {
        hw = CANVAS_W / 2; hh = CANVAS_H / 2;
      }
    } else if (clip.type === 'image') {
      const media = getMediaForClip(clip);
      if (media) {
        const aspect = media.naturalWidth / media.naturalHeight;
        if (aspect > CANVAS_W / CANVAS_H) {
          hw = CANVAS_W / 2; hh = (CANVAS_W / aspect) / 2;
        } else {
          hh = CANVAS_H / 2; hw = (CANVAS_H * aspect) / 2;
        }
      } else {
        hw = CANVAS_W / 2; hh = CANVAS_H / 2;
      }
    } else {
      hw = 50; hh = 20;
    }

    return { cx, cy, hw: hw * sx, hh: hh * sy, rotation: props.rotation || 0, props };
  }

  function hitTestClip(clip, px, py) {
    const t = state.currentTime;
    if (t < clip.startTime || t >= clip.startTime + clip.duration) return null;

    const b = getClipBounds(clip);
    const rot = -b.rotation * Math.PI / 180;
    // Rotate point into clip's local space
    const dx = px - b.cx;
    const dy = py - b.cy;
    const lx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ly = dx * Math.sin(rot) + dy * Math.cos(rot);

    const handleSize = 14;
    const rotHandleDist = b.hh + 30;

    // Rotation handle (top center, above bounding box)
    const rotDx = lx - 0;
    const rotDy = ly - (-rotHandleDist);
    if (Math.hypot(rotDx, rotDy) < handleSize) return 'rotate';

    // Scale handles (corners)
    const corners = [
      { x: -b.hw, y: -b.hh }, { x: b.hw, y: -b.hh },
      { x: -b.hw, y: b.hh },  { x: b.hw, y: b.hh },
    ];
    for (const c of corners) {
      if (Math.hypot(lx - c.x, ly - c.y) < handleSize) return 'scale';
    }

    // Body
    if (Math.abs(lx) <= b.hw && Math.abs(ly) <= b.hh) return 'move';

    return null;
  }

  function onCanvasMouseDown(e) {
    finishInlineEdit();
    const { x: mx, y: my } = canvasToLocal(e);

    // Test clips in reverse layer order (top = drawn last = clicked first)
    const visible = state.clips
      .filter(c => state.currentTime >= c.startTime && state.currentTime < c.startTime + c.duration)
      .sort((a, b) => b.layer - a.layer);

    // First check if clicking on selected clip's handles
    if (state.selectedId) {
      const sel = visible.find(c => c.id === state.selectedId);
      if (sel) {
        const hit = hitTestClip(sel, mx, my);
        if (hit) {
          pushUndo();
          state.canvasDrag = {
            clipId: sel.id,
            mode: hit,
            startMX: mx,
            startMY: my,
            orig: {
              x: sel.x || 0, y: sel.y || 0,
              scaleX: sel.scaleX || 1, scaleY: sel.scaleY || 1,
              rotation: sel.rotation || 0,
            },
          };
          return;
        }
      }
    }

    // Try to select a clip
    for (const clip of visible) {
      const hit = hitTestClip(clip, mx, my);
      if (hit) {
        state.selectedId = clip.id;
        pushUndo();
        state.canvasDrag = {
          clipId: clip.id,
          mode: hit,
          startMX: mx,
          startMY: my,
          orig: {
            x: clip.x || 0, y: clip.y || 0,
            scaleX: clip.scaleX || 1, scaleY: clip.scaleY || 1,
            rotation: clip.rotation || 0,
          },
        };
        renderTimeline();
        renderProperties();
        renderFrame();
        return;
      }
    }

    // Clicked empty area — deselect
    state.selectedId = null;
    renderTimeline();
    renderProperties();
    renderFrame();
  }

  function onCanvasDblClick(e) {
    const { x: mx, y: my } = canvasToLocal(e);
    const visible = state.clips
      .filter(c => state.currentTime >= c.startTime && state.currentTime < c.startTime + c.duration && c.type === 'text')
      .sort((a, b) => b.layer - a.layer);

    for (const clip of visible) {
      if (hitTestClip(clip, mx, my)) {
        startInlineEdit(clip);
        return;
      }
    }
  }

  // ============================================================
  // Inline text editing on canvas
  // ============================================================
  function startInlineEdit(clip) {
    finishInlineEdit();
    state.editingTextId = clip.id;
    state.selectedId = clip.id;

    const b = getClipBounds(clip);
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / CANVAS_W;
    const scaleY = rect.height / CANVAS_H;

    inlineTextInput = document.createElement('textarea');
    inlineTextInput.className = 'inline-text-edit';
    inlineTextInput.value = clip.text || '';
    inlineTextInput.style.left = (rect.left + (b.cx - b.hw) * scaleX) + 'px';
    inlineTextInput.style.top = (rect.top + (b.cy - b.hh) * scaleY) + 'px';
    inlineTextInput.style.width = (b.hw * 2 * scaleX) + 'px';
    inlineTextInput.style.minHeight = (b.hh * 2 * scaleY) + 'px';
    inlineTextInput.style.fontSize = ((clip.fontSize || 48) * scaleY) + 'px';
    inlineTextInput.style.color = clip.color || '#ffffff';
    inlineTextInput.style.transform = `rotate(${b.rotation}deg)`;

    document.body.appendChild(inlineTextInput);
    inlineTextInput.focus();
    inlineTextInput.select();

    inlineTextInput.addEventListener('blur', () => finishInlineEdit());
    inlineTextInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { inlineTextInput.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inlineTextInput.blur(); }
    });
  }

  function finishInlineEdit() {
    if (!state.editingTextId || !inlineTextInput) return;
    const clip = state.clips.find(c => c.id === state.editingTextId);
    if (clip && inlineTextInput.value !== clip.text) {
      pushUndo();
      clip.text = inlineTextInput.value;
    }
    state.editingTextId = null;
    if (inlineTextInput.parentNode) inlineTextInput.parentNode.removeChild(inlineTextInput);
    inlineTextInput = null;
    onTimelineChanged();
  }

  // ============================================================
  // File upload
  // ============================================================
  async function handleFileUpload(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    pushUndo();

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) { alert(data.error); continue; }

        const clip = {
          id: data.id,
          type: data.type,
          name: data.filename,
          path: data.path,
          startTime: findNextFreePosition(0),
          duration: data.type === 'image' ? 5 : data.duration,
          trimStart: 0,
          layer: findFreeLayer(),
          x: 0, y: 0,
          scaleX: 1, scaleY: 1,
          rotation: 0,
          opacity: 1,
          keyframes: [],
          sourceWidth: data.width,
          sourceHeight: data.height,
        };

        state.clips.push(clip);
        await loadMedia(clip);
      } catch (err) {
        console.error('Upload failed:', err);
        alert('Upload failed: ' + err.message);
      }
    }

    fileInput.value = '';
    onTimelineChanged();
  }

  function findNextFreePosition(layer) {
    let maxEnd = 0;
    for (const c of state.clips) {
      if (c.layer === layer) maxEnd = Math.max(maxEnd, c.startTime + c.duration);
    }
    return maxEnd;
  }

  function findFreeLayer() {
    for (let i = 0; i < state.layers; i++) {
      if (!state.clips.some(c => c.layer === i)) return i;
    }
    return 0;
  }

  // ============================================================
  // Text clips
  // ============================================================
  function addTextClip() {
    pushUndo();
    const clip = {
      id: generateId(),
      type: 'text',
      name: 'Text',
      text: 'Hello World',
      startTime: state.currentTime,
      duration: 5,
      layer: findFreeLayer(),
      x: 0, y: 0,
      scaleX: 1, scaleY: 1,
      rotation: 0,
      opacity: 1,
      fontSize: 48,
      fontFamily: 'Arial',
      color: '#ffffff',
      keyframes: [],
    };
    state.clips.push(clip);
    state.selectedId = clip.id;
    onTimelineChanged();
  }

  // ============================================================
  // Clip operations
  // ============================================================
  function splitAtPlayhead() {
    const clip = getSelectedClip();
    if (!clip) return;

    const localTime = state.currentTime - clip.startTime;
    if (localTime <= 0.05 || localTime >= clip.duration - 0.05) return;

    pushUndo();

    const newId = generateId();
    const newClip = {
      ...JSON.parse(JSON.stringify(clip)),
      id: newId,
      startTime: state.currentTime,
      duration: clip.duration - localTime,
      trimStart: (clip.trimStart || 0) + localTime,
      keyframes: clip.keyframes
        .filter(kf => kf.time >= localTime)
        .map(kf => ({ ...kf, time: kf.time - localTime })),
    };

    clip.duration = localTime;
    clip.keyframes = clip.keyframes.filter(kf => kf.time <= localTime);

    // Share media element: map new clip ID to original clip's media source
    const origSourceId = sourceMap.get(clip.id) || clip.id;
    sourceMap.set(newId, origSourceId);

    // For images, we need a separate element since they're stateless
    if (clip.type === 'image') {
      const origImg = getMediaForClip(clip);
      if (origImg) {
        const newImg = new Image();
        newImg.src = origImg.src;
        mediaCache.set(newId, newImg);
      }
    }
    // For video, create a new video element pointing to the same src
    // so the two halves can seek independently
    if (clip.type === 'video') {
      const origVideo = getMediaForClip(clip);
      if (origVideo) {
        const newVideo = document.createElement('video');
        newVideo.src = origVideo.src;
        newVideo.muted = true;
        newVideo.preload = 'auto';
        newVideo.load();
        mediaCache.set(newId, newVideo);
      }
    }

    state.clips.push(newClip);
    onTimelineChanged();
  }

  function deleteSelected() {
    if (!state.selectedId) return;
    pushUndo();
    state.clips = state.clips.filter(c => c.id !== state.selectedId);
    state.selectedId = null;
    onTimelineChanged();
  }

  function addLayer() {
    state.layers++;
    buildLayers();
    renderTimeline();
  }

  // ============================================================
  // Keyframes
  // ============================================================
  function addKeyframeAtPlayhead() {
    const clip = getSelectedClip();
    if (!clip) return;

    const localTime = state.currentTime - clip.startTime;
    if (localTime < 0 || localTime > clip.duration) return;

    pushUndo();

    if (!clip.keyframes) clip.keyframes = [];

    // Remove existing keyframe at same time
    clip.keyframes = clip.keyframes.filter(kf => Math.abs(kf.time - localTime) > 0.01);

    clip.keyframes.push({
      time: parseFloat(localTime.toFixed(3)),
      x: clip.x || 0,
      y: clip.y || 0,
      scaleX: clip.scaleX || 1,
      scaleY: clip.scaleY || 1,
      rotation: clip.rotation || 0,
      opacity: clip.opacity !== undefined ? clip.opacity : 1,
    });

    clip.keyframes.sort((a, b) => a.time - b.time);
    onTimelineChanged();
  }

  function interpolateKeyframes(clip, localTime) {
    const kf = clip.keyframes;
    if (!kf || kf.length === 0) {
      return {
        x: clip.x || 0, y: clip.y || 0,
        scaleX: clip.scaleX || 1, scaleY: clip.scaleY || 1,
        rotation: clip.rotation || 0,
        opacity: clip.opacity !== undefined ? clip.opacity : 1,
      };
    }

    if (kf.length === 1) return { ...kf[0] };

    if (localTime <= kf[0].time) return { ...kf[0] };
    if (localTime >= kf[kf.length - 1].time) return { ...kf[kf.length - 1] };

    let prev = kf[0], next = kf[1];
    for (let i = 0; i < kf.length - 1; i++) {
      if (localTime >= kf[i].time && localTime <= kf[i + 1].time) {
        prev = kf[i]; next = kf[i + 1]; break;
      }
    }

    const t = (localTime - prev.time) / (next.time - prev.time || 0.001);
    return {
      x: lerp(prev.x, next.x, t),
      y: lerp(prev.y, next.y, t),
      scaleX: lerp(prev.scaleX, next.scaleX, t),
      scaleY: lerp(prev.scaleY, next.scaleY, t),
      rotation: lerp(prev.rotation, next.rotation, t),
      opacity: lerp(prev.opacity, next.opacity, t),
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  // ============================================================
  // Canvas rendering
  // ============================================================
  function renderFrame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const t = state.currentTime;

    // Visible clips sorted by layer (lower drawn first)
    const visible = state.clips
      .filter(c => t >= c.startTime && t < c.startTime + c.duration)
      .sort((a, b) => a.layer - b.layer);

    for (const clip of visible) {
      const localTime = t - clip.startTime;
      const props = interpolateKeyframes(clip, localTime);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, props.opacity));

      const cx = (props.x || 0) + CANVAS_W / 2;
      const cy = (props.y || 0) + CANVAS_H / 2;
      ctx.translate(cx, cy);
      ctx.rotate((props.rotation || 0) * Math.PI / 180);
      ctx.scale(props.scaleX || 1, props.scaleY || 1);

      if (clip.type === 'video') {
        const video = getMediaForClip(clip);
        if (video) {
          const seekTime = (clip.trimStart || 0) + localTime;
          if (Math.abs(video.currentTime - seekTime) > 0.15) {
            video.currentTime = seekTime;
          }
          const aspect = video.videoWidth / video.videoHeight || 16 / 9;
          let dw = CANVAS_W, dh = CANVAS_H;
          if (aspect > CANVAS_W / CANVAS_H) { dh = CANVAS_W / aspect; }
          else { dw = CANVAS_H * aspect; }
          ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
        }
      } else if (clip.type === 'image') {
        const img = getMediaForClip(clip);
        if (img && img.naturalWidth) {
          const aspect = img.naturalWidth / img.naturalHeight;
          let dw = CANVAS_W, dh = CANVAS_H;
          if (aspect > CANVAS_W / CANVAS_H) { dh = CANVAS_W / aspect; }
          else { dw = CANVAS_H * aspect; }
          ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
        }
      } else if (clip.type === 'text') {
        ctx.font = `${clip.fontSize || 48}px ${clip.fontFamily || 'Arial'}`;
        ctx.fillStyle = clip.color || '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(clip.text || '', 0, 0);
      }

      ctx.restore();
    }

    // Draw transform gizmo for selected clip
    drawTransformGizmo(visible);
  }

  function drawTransformGizmo(visible) {
    if (!state.selectedId) return;
    const clip = visible.find(c => c.id === state.selectedId);
    if (!clip) return;

    const b = getClipBounds(clip);
    const rot = b.rotation * Math.PI / 180;

    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate(rot);

    // Bounding box
    ctx.strokeStyle = '#00bfff';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);

    // Corner handles (scale)
    const corners = [
      [-b.hw, -b.hh], [b.hw, -b.hh],
      [-b.hw, b.hh], [b.hw, b.hh],
    ];
    ctx.fillStyle = '#00bfff';
    for (const [hx, hy] of corners) {
      ctx.fillRect(hx - 5, hy - 5, 10, 10);
    }

    // Rotation handle (line + circle above top center)
    ctx.beginPath();
    ctx.moveTo(0, -b.hh);
    ctx.lineTo(0, -b.hh - 30);
    ctx.strokeStyle = '#00bfff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, -b.hh - 30, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#00bfff';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================
  // Playback
  // ============================================================
  let lastTickTime = 0;

  function tick(timestamp) {
    if (state.playing) {
      const dt = (timestamp - lastTickTime) / 1000;
      if (dt > 0 && dt < 0.5) {
        state.currentTime += dt;
        if (state.currentTime >= state.totalDuration) state.currentTime = 0;
        updatePlayhead();
        renderFrame();
        syncAudioVideo();
      }
    }
    lastTickTime = timestamp;
    requestAnimationFrame(tick);
  }

  function play() {
    state.playing = true;
    lastTickTime = performance.now();
    syncAudioVideo();
  }

  function pause() {
    state.playing = false;
    pauseAllMedia();
  }

  function stop() {
    state.playing = false;
    state.currentTime = 0;
    pauseAllMedia();
    updatePlayhead();
    renderFrame();
  }

  function syncAudioVideo() {
    for (const clip of state.clips) {
      const media = getMediaForClip(clip);
      if (!media) continue;

      const localTime = state.currentTime - clip.startTime;
      const inRange = localTime >= 0 && localTime < clip.duration;

      if (clip.type === 'video' || clip.type === 'audio') {
        if (state.playing && inRange) {
          const seekTime = (clip.trimStart || 0) + localTime;
          if (Math.abs(media.currentTime - seekTime) > 0.3) media.currentTime = seekTime;
          if (media.paused) media.play().catch(() => {});
          if (clip.type === 'video') media.muted = false;
        } else {
          if (!media.paused) media.pause();
        }
      }
    }
  }

  function pauseAllMedia() {
    for (const [, media] of mediaCache) {
      if (media.pause) media.pause();
    }
  }

  // ============================================================
  // Properties panel
  // ============================================================
  function renderProperties() {
    const clip = getSelectedClip();
    if (!clip) {
      propsContent.innerHTML = '<p class="hint">Select a clip to edit properties</p>';
      return;
    }

    let html = `<div class="prop-group"><label>Name</label>
      <input type="text" id="prop-name" value="${esc(clip.name || '')}"></div>`;

    html += `<div class="prop-row">
      <div class="prop-group"><label>Start (s)</label>
        <input type="number" id="prop-start" value="${clip.startTime.toFixed(3)}" step="0.1"></div>
      <div class="prop-group"><label>Duration (s)</label>
        <input type="number" id="prop-duration" value="${clip.duration.toFixed(3)}" step="0.1" min="0.1"></div>
    </div>`;

    html += `<div class="prop-row">
      <div class="prop-group"><label>Layer</label>
        <input type="number" id="prop-layer" value="${clip.layer}" min="0" max="${state.layers - 1}"></div>
      <div class="prop-group"><label>Trim Start (s)</label>
        <input type="number" id="prop-trim" value="${(clip.trimStart || 0).toFixed(3)}" step="0.1" min="0"></div>
    </div>`;

    // Position / Transform
    html += `<div class="prop-row">
      <div class="prop-group"><label>X</label>
        <input type="number" id="prop-x" value="${Math.round(clip.x || 0)}" step="1"></div>
      <div class="prop-group"><label>Y</label>
        <input type="number" id="prop-y" value="${Math.round(clip.y || 0)}" step="1"></div>
    </div>`;

    html += `<div class="prop-row">
      <div class="prop-group"><label>Scale X</label>
        <input type="number" id="prop-scaleX" value="${(clip.scaleX || 1).toFixed(2)}" step="0.05" min="0.05"></div>
      <div class="prop-group"><label>Scale Y</label>
        <input type="number" id="prop-scaleY" value="${(clip.scaleY || 1).toFixed(2)}" step="0.05" min="0.05"></div>
    </div>`;

    html += `<div class="prop-row">
      <div class="prop-group"><label>Rotation</label>
        <input type="number" id="prop-rotation" value="${Math.round(clip.rotation || 0)}" step="1"></div>
      <div class="prop-group"><label>Opacity</label>
        <input type="number" id="prop-opacity" value="${(clip.opacity !== undefined ? clip.opacity : 1).toFixed(2)}" step="0.05" min="0" max="1"></div>
    </div>`;

    if (clip.type === 'text') {
      html += `<div class="prop-group"><label>Text</label>
        <textarea id="prop-text">${esc(clip.text || '')}</textarea></div>`;

      // Font size: slider + number input
      html += `<div class="prop-group"><label>Font Size</label>
        <div class="slider-row">
          <input type="range" id="prop-fontSize-slider" min="8" max="200" value="${clip.fontSize || 48}" class="prop-slider">
          <input type="number" id="prop-fontSize" value="${clip.fontSize || 48}" min="8" max="400" class="prop-number-sm">
        </div>
      </div>`;

      // Color: color picker + text input
      html += `<div class="prop-group"><label>Color</label>
        <div class="color-row">
          <input type="color" id="prop-color-picker" value="${clip.color || '#ffffff'}" class="prop-color-picker">
          <input type="text" id="prop-color" value="${clip.color || '#ffffff'}" class="prop-color-text">
        </div>
      </div>`;

      // Font family
      html += `<div class="prop-group"><label>Font</label>
        <select id="prop-fontFamily" class="prop-select">
          ${['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Comic Sans MS'].map(
            f => `<option value="${f}" ${clip.fontFamily === f ? 'selected' : ''}>${f}</option>`
          ).join('')}
        </select>
      </div>`;
    }

    // Keyframes list
    html += `<h4 style="margin-top:12px;font-size:13px;">Keyframes</h4>`;
    if (clip.keyframes && clip.keyframes.length) {
      html += `<div class="keyframe-list">`;
      for (let i = 0; i < clip.keyframes.length; i++) {
        const kf = clip.keyframes[i];
        html += `<div class="keyframe-item" data-kf-index="${i}">
          <span>@${kf.time.toFixed(2)}s x:${Math.round(kf.x)} y:${Math.round(kf.y)} op:${kf.opacity.toFixed(2)} s:${(kf.scaleX||1).toFixed(1)} r:${Math.round(kf.rotation||0)}</span>
          <button class="kf-delete" data-kf-index="${i}">&times;</button>
        </div>`;
      }
      html += `</div>`;
    } else {
      html += `<p class="hint">No keyframes. Position playhead and click "+ Keyframe"</p>`;
    }

    propsContent.innerHTML = html;

    // --- Bind events ---
    const bindInput = (id, prop, parse) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        pushUndo();
        clip[prop] = parse ? parse(el.value) : el.value;
        onTimelineChanged();
      });
    };

    bindInput('prop-name', 'name');
    bindInput('prop-start', 'startTime', parseFloat);
    bindInput('prop-duration', 'duration', parseFloat);
    bindInput('prop-layer', 'layer', parseInt);
    bindInput('prop-trim', 'trimStart', parseFloat);
    bindInput('prop-x', 'x', parseFloat);
    bindInput('prop-y', 'y', parseFloat);
    bindInput('prop-scaleX', 'scaleX', parseFloat);
    bindInput('prop-scaleY', 'scaleY', parseFloat);
    bindInput('prop-rotation', 'rotation', parseFloat);
    bindInput('prop-opacity', 'opacity', parseFloat);
    bindInput('prop-text', 'text');
    bindInput('prop-fontFamily', 'fontFamily');

    // Font size: link slider and number input
    const fsSlider = document.getElementById('prop-fontSize-slider');
    const fsNumber = document.getElementById('prop-fontSize');
    if (fsSlider && fsNumber) {
      fsSlider.addEventListener('input', () => {
        fsNumber.value = fsSlider.value;
        clip.fontSize = parseInt(fsSlider.value);
        renderFrame();
      });
      fsSlider.addEventListener('change', () => {
        pushUndo();
        clip.fontSize = parseInt(fsSlider.value);
        onTimelineChanged();
      });
      fsNumber.addEventListener('change', () => {
        pushUndo();
        clip.fontSize = parseInt(fsNumber.value);
        fsSlider.value = fsNumber.value;
        onTimelineChanged();
      });
    }

    // Color: link picker and text input
    const colorPicker = document.getElementById('prop-color-picker');
    const colorText = document.getElementById('prop-color');
    if (colorPicker && colorText) {
      colorPicker.addEventListener('input', () => {
        colorText.value = colorPicker.value;
        clip.color = colorPicker.value;
        renderFrame();
      });
      colorPicker.addEventListener('change', () => {
        pushUndo();
        clip.color = colorPicker.value;
        colorText.value = colorPicker.value;
        onTimelineChanged();
      });
      colorText.addEventListener('change', () => {
        pushUndo();
        clip.color = colorText.value;
        colorPicker.value = colorText.value;
        onTimelineChanged();
      });
    }

    // Keyframe delete buttons
    propsContent.querySelectorAll('.kf-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        const idx = parseInt(e.target.dataset.kfIndex);
        clip.keyframes.splice(idx, 1);
        onTimelineChanged();
      });
    });

    // Click keyframe item to seek
    propsContent.querySelectorAll('.keyframe-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('kf-delete')) return;
        const idx = parseInt(item.dataset.kfIndex);
        const kf = clip.keyframes[idx];
        if (kf) {
          state.currentTime = clip.startTime + kf.time;
          updatePlayhead();
          renderFrame();
        }
      });
    });
  }

  // ============================================================
  // Export
  // ============================================================
  async function doExport() {
    const modal = document.getElementById('export-modal');
    const statusEl = document.getElementById('export-status');
    const progressEl = document.getElementById('export-progress');
    const closeBtn = document.getElementById('export-close');
    const downloadLink = document.getElementById('export-download');

    modal.classList.remove('hidden');
    closeBtn.classList.add('hidden');
    downloadLink.classList.add('hidden');
    statusEl.textContent = 'Sending timeline to server...';
    progressEl.style.width = '10%';

    const timeline = state.clips.map(c => ({ ...c }));

    try {
      progressEl.style.width = '30%';
      statusEl.textContent = 'Rendering MP4 (this may take a while)...';

      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeline,
          width: 1920,
          height: 1080,
          fps: 30,
          duration: state.totalDuration - 5,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.details || data.error);

      progressEl.style.width = '100%';
      statusEl.textContent = 'Export complete!';
      downloadLink.href = data.url;
      downloadLink.classList.remove('hidden');
      closeBtn.classList.remove('hidden');
    } catch (err) {
      statusEl.textContent = 'Export failed: ' + err.message;
      closeBtn.classList.remove('hidden');
      progressEl.style.width = '0%';
    }
  }

  // ============================================================
  // Utility
  // ============================================================
  function getSelectedClip() {
    return state.clips.find(c => c.id === state.selectedId) || null;
  }

  function generateId() {
    return 'clip_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
  }

  function esc(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Boot ---
  init();
})();
