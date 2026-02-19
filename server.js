const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/exports', express.static('exports'));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// Upload media files
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = `/uploads/${req.file.filename}`;
  const type = detectMediaType(req.file.mimetype);

  ffmpeg.ffprobe(req.file.path, (err, metadata) => {
    const duration = metadata?.format?.duration || 5;
    const videoStream = metadata?.streams?.find(s => s.codec_type === 'video');
    const w = videoStream?.width || 1920;
    const h = videoStream?.height || 1080;

    res.json({
      id: uuidv4(),
      filename: req.file.originalname,
      path: filePath,
      type,
      duration: parseFloat(duration),
      width: w,
      height: h,
    });
  });
});

function detectMediaType(mime) {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'unknown';
}

// Export timeline to MP4
app.post('/api/export', async (req, res) => {
  const { timeline, width = 1920, height = 1080, fps = 30, duration } = req.body;

  if (!timeline || !duration) {
    return res.status(400).json({ error: 'timeline and duration required' });
  }

  const exportId = uuidv4();
  const outputPath = path.join(__dirname, 'exports', `${exportId}.mp4`);

  try {
    await renderTimeline({ timeline, width, height, fps, duration, outputPath });
    res.json({ url: `/exports/${exportId}.mp4` });
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed', details: err.message });
  }
});

/**
 * Render the timeline to MP4 using ffmpeg complex filter chains.
 *
 * Strategy:
 *  - Input 0 = black canvas background
 *  - Each video/image clip becomes an input, processed with trim/scale/pad,
 *    then overlaid onto the running composite using overlay with enable windows.
 *  - Keyframed x/y use overlay expressions. Opacity uses a static mid-clip value
 *    applied via colorchannelmixer (expressions in colorchannelmixer can fail with
 *    comma-parsing issues in complex_filter, so we keep it static).
 *  - Text uses drawtext filter.
 */
function renderTimeline({ timeline, width, height, fps, duration, outputPath }) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    // Input 0: blank canvas
    cmd.input(`color=c=black:s=${width}x${height}:d=${duration}:r=${fps}`)
      .inputOptions(['-f', 'lavfi']);

    const filterParts = [];
    let inputIdx = 1;
    let labelIdx = 1;
    let lastOverlay = '[0:v]';
    const audioLabels = [];

    // Sort layers by their layer index (bottom to top)
    const layers = [...timeline].sort((a, b) => (a.layer || 0) - (b.layer || 0));

    for (const item of layers) {
      if (item.type === 'text') {
        const startT = item.startTime || 0;
        const endT = startT + (item.duration || 5);
        const escaped = escapeDrawtext(item.text || 'Text');
        const fontSize = item.fontSize || 48;

        // Convert hex color to ffmpeg-compatible format
        const hexColor = (item.color || '#ffffff').replace('#', '');
        const ffColor = `0x${hexColor}`;

        // Compute static position or use keyframe expressions
        const kf = item.keyframes || [];
        let xExpr, yExpr, alphaVal;

        if (kf.length >= 2) {
          xExpr = buildKeyframeExpr(kf, 'x', startT, item.x || 0);
          yExpr = buildKeyframeExpr(kf, 'y', startT, item.y || 0);
          const mid = interpolateAtTime(kf, (item.duration || 5) / 2);
          alphaVal = clamp01(mid.opacity !== undefined ? mid.opacity : 1);
        } else if (kf.length === 1) {
          xExpr = `${Math.round(kf[0].x || 0)}`;
          yExpr = `${Math.round(kf[0].y || 0)}`;
          alphaVal = clamp01(kf[0].opacity !== undefined ? kf[0].opacity : 1);
        } else {
          xExpr = `${Math.round(item.x || 0)}`;
          yExpr = `${Math.round(item.y || 0)}`;
          alphaVal = clamp01(item.opacity !== undefined ? item.opacity : 1);
        }

        // Shift xExpr/yExpr to account for canvas center offset the client uses
        const xOffset = Math.round(width / 2);
        const yOffset = Math.round(height / 2);

        // Wrap expressions to add center offset
        const finalX = kf.length >= 2
          ? `(${xExpr})+${xOffset}` : `${parseInt(xExpr) + xOffset}`;
        const finalY = kf.length >= 2
          ? `(${yExpr})+${yOffset}` : `${parseInt(yExpr) + yOffset}`;

        const nextOverlay = `[v${labelIdx}]`;

        // Find font file for this text's font family
        const fontFile = findFontFile(item.fontFamily || 'Arial');
        const fontFileParam = fontFile ? `fontfile='${escapeFontPath(fontFile)}':` : '';

        // Use fontcolor with @alpha for opacity
        const alphaHex = Math.round(alphaVal * 255).toString(16).padStart(2, '0');
        filterParts.push(
          `${lastOverlay}drawtext=${fontFileParam}text='${escaped}':fontsize=${fontSize}:fontcolor=${ffColor}${alphaHex}:x=${finalX}:y=${finalY}:enable='between(t,${startT},${endT})'${nextOverlay}`
        );

        lastOverlay = nextOverlay;
        labelIdx++;
        continue;
      }

      // Video / Image / Audio clips
      const filePath = path.join(__dirname, item.path.replace(/^\//, ''));
      if (!fs.existsSync(filePath)) {
        console.warn(`File not found, skipping: ${filePath}`);
        continue;
      }

      cmd.input(filePath);

      const startT = item.startTime || 0;
      const clipDur = item.duration || 5;
      const trimStart = item.trimStart || 0;
      const trimEnd = trimStart + clipDur;

      if (item.type === 'audio') {
        const audioLabel = `[a${labelIdx}]`;
        filterParts.push(
          `[${inputIdx}:a]atrim=start=${trimStart}:end=${trimEnd},adelay=${Math.round(startT * 1000)}|${Math.round(startT * 1000)},asetpts=PTS-STARTPTS${audioLabel}`
        );
        audioLabels.push(audioLabel);
        inputIdx++;
        labelIdx++;
        continue;
      }

      // Video or image input
      const kf = item.keyframes || [];
      const trimLabel = `[tr${labelIdx}]`;

      if (item.type === 'video') {
        filterParts.push(
          `[${inputIdx}:v]trim=start=${trimStart}:end=${trimEnd},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${trimLabel}`
        );
      } else {
        // Image: loop for duration then trim
        const loopFrames = Math.ceil(clipDur * fps) + 10;
        filterParts.push(
          `[${inputIdx}:v]loop=loop=${loopFrames}:size=1:start=0,setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,trim=duration=${clipDur},setpts=PTS-STARTPTS${trimLabel}`
        );
      }

      // Overlay onto composite
      const nextOverlay = `[v${labelIdx}]`;

      if (kf.length >= 2) {
        // Keyframed: use overlay x/y expressions, static alpha
        const xExpr = buildKeyframeExpr(kf, 'x', startT, 0);
        const yExpr = buildKeyframeExpr(kf, 'y', startT, 0);
        const mid = interpolateAtTime(kf, clipDur / 2);
        const alphaVal = clamp01(mid.opacity !== undefined ? mid.opacity : 1);

        if (alphaVal < 0.999) {
          // Apply static alpha via colorchannelmixer
          const alphaLabel = `[al${labelIdx}]`;
          filterParts.push(
            `${trimLabel}format=rgba,colorchannelmixer=aa=${alphaVal.toFixed(3)}${alphaLabel}`
          );
          filterParts.push(
            `${lastOverlay}${alphaLabel}overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${startT},${startT + clipDur})':eof_action=pass:format=auto${nextOverlay}`
          );
        } else {
          filterParts.push(
            `${lastOverlay}${trimLabel}overlay=x='${xExpr}':y='${yExpr}':enable='between(t,${startT},${startT + clipDur})':eof_action=pass${nextOverlay}`
          );
        }
      } else {
        // No keyframes or single keyframe: static position
        const ox = Math.round(item.x || 0);
        const oy = Math.round(item.y || 0);
        const opacityVal = clamp01(
          kf.length === 1 ? (kf[0].opacity !== undefined ? kf[0].opacity : 1)
            : (item.opacity !== undefined ? item.opacity : 1)
        );

        if (opacityVal < 0.999) {
          const alphaLabel = `[al${labelIdx}]`;
          filterParts.push(
            `${trimLabel}format=rgba,colorchannelmixer=aa=${opacityVal.toFixed(3)}${alphaLabel}`
          );
          filterParts.push(
            `${lastOverlay}${alphaLabel}overlay=x=${ox}:y=${oy}:enable='between(t,${startT},${startT + clipDur})':eof_action=pass:format=auto${nextOverlay}`
          );
        } else {
          filterParts.push(
            `${lastOverlay}${trimLabel}overlay=x=${ox}:y=${oy}:enable='between(t,${startT},${startT + clipDur})':eof_action=pass${nextOverlay}`
          );
        }
      }

      lastOverlay = nextOverlay;
      inputIdx++;
      labelIdx++;
    }

    const complexFilter = filterParts.join('; ');
    console.log('Filter chain:', complexFilter);

    // Build output options — NO -map here, complexFilter handles it
    const outOpts = [
      '-t', `${duration}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
    ];

    // If we have audio, mix them
    if (audioLabels.length > 0) {
      const mixLabel = '[amix_out]';
      if (audioLabels.length === 1) {
        // Single audio — just reference it
        const finalAudioLabel = audioLabels[0].replace(/[\[\]]/g, '');
        filterParts.push(`${audioLabels[0]}anull[amix_out]`);
      } else {
        filterParts.push(
          `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest[amix_out]`
        );
      }
      const fullFilter = filterParts.join('; ');
      const videoOut = lastOverlay.replace(/[\[\]]/g, '');
      cmd.complexFilter(fullFilter, [videoOut, 'amix_out']);
      outOpts.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      if (complexFilter) {
        const videoOut = lastOverlay.replace(/[\[\]]/g, '');
        cmd.complexFilter(complexFilter, [videoOut]);
      }
      outOpts.push('-an');
    }

    cmd
      .outputOptions(outOpts)
      .output(outputPath)
      .on('start', (cmdline) => console.log('ffmpeg:', cmdline))
      .on('progress', (p) => {
        if (p.percent) console.log(`Export progress: ${Math.round(p.percent)}%`);
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err, stdout, stderr) => {
        console.error('ffmpeg stderr:', stderr);
        reject(err);
      })
      .run();
  });
}

/**
 * Build an ffmpeg expression for linear interpolation between keyframes.
 * Uses nested if(lt(t,...),...) expressions. Uses only functions available
 * in ffmpeg's libavutil expression evaluator: if, lt, min, max, t.
 */
function buildKeyframeExpr(keyframes, prop, baseTime, defaultVal) {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const vals = sorted.map(kf => ({
    t: roundN(kf.time + baseTime, 4),
    v: kf[prop] !== undefined ? roundN(kf[prop], 4) : defaultVal,
  }));

  if (vals.length === 0) return `${defaultVal}`;
  if (vals.length === 1) return `${vals[0].v}`;

  // Build from last segment backwards
  let expr = `${vals[vals.length - 1].v}`;
  for (let i = vals.length - 2; i >= 0; i--) {
    const t0 = vals[i].t;
    const t1 = vals[i + 1].t;
    const v0 = vals[i].v;
    const v1 = vals[i + 1].v;
    const dt = roundN(t1 - t0, 4) || 0.001;
    const dv = roundN(v1 - v0, 4);

    if (Math.abs(dv) < 0.0001) {
      // Constant segment
      expr = `if(lt(t,${t1}),${v0},${expr})`;
    } else {
      const lerpExpr = `(${v0}+${dv}*min(max((t-${t0})/${dt},0),1))`;
      expr = `if(lt(t,${t1}),${lerpExpr},${expr})`;
    }
  }
  // Before first keyframe: hold first value
  expr = `if(lt(t,${vals[0].t}),${vals[0].v},${expr})`;
  return expr;
}

/**
 * Simple linear interpolation at a given local time for computing static values.
 */
function interpolateAtTime(keyframes, localTime) {
  if (!keyframes || keyframes.length === 0) return { opacity: 1 };
  if (keyframes.length === 1) return { ...keyframes[0] };

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (localTime <= sorted[0].time) return { ...sorted[0] };
  if (localTime >= sorted[sorted.length - 1].time) return { ...sorted[sorted.length - 1] };

  for (let i = 0; i < sorted.length - 1; i++) {
    if (localTime >= sorted[i].time && localTime <= sorted[i + 1].time) {
      const t = (localTime - sorted[i].time) / (sorted[i + 1].time - sorted[i].time || 0.001);
      const result = {};
      for (const key of Object.keys(sorted[i])) {
        if (key === 'time') continue;
        const a = sorted[i][key] ?? 0;
        const b = sorted[i + 1][key] ?? 0;
        result[key] = a + (b - a) * t;
      }
      return result;
    }
  }
  return { ...sorted[sorted.length - 1] };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function roundN(v, n) {
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\\\:')
    .replace(/%/g, '%%')
    .replace(/\n/g, '');
}

/**
 * Find a usable font file on the system for ffmpeg drawtext.
 * Maps common font family names to system paths, with fallbacks.
 */
function findFontFile(fontFamily) {
  const platform = process.platform;

  const macFonts = {
    'Arial':            ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial Unicode.ttf'],
    'Helvetica':        ['/System/Library/Fonts/Helvetica.ttc'],
    'Georgia':          ['/System/Library/Fonts/Supplemental/Georgia.ttf'],
    'Times New Roman':  ['/System/Library/Fonts/Supplemental/Times New Roman.ttf'],
    'Courier New':      ['/System/Library/Fonts/Supplemental/Courier New.ttf'],
    'Verdana':          ['/System/Library/Fonts/Supplemental/Verdana.ttf'],
    'Impact':           ['/System/Library/Fonts/Supplemental/Impact.ttf'],
    'Comic Sans MS':    ['/System/Library/Fonts/Supplemental/Comic Sans MS.ttf'],
  };

  const linuxFonts = {
    'Arial':            ['/usr/share/fonts/truetype/msttcorefonts/Arial.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'],
    'Helvetica':        ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'],
    'Georgia':          ['/usr/share/fonts/truetype/msttcorefonts/Georgia.ttf'],
    'Times New Roman':  ['/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'],
    'Courier New':      ['/usr/share/fonts/truetype/msttcorefonts/Courier_New.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'],
    'Verdana':          ['/usr/share/fonts/truetype/msttcorefonts/Verdana.ttf'],
    'Impact':           ['/usr/share/fonts/truetype/msttcorefonts/Impact.ttf'],
  };

  const fontTable = platform === 'darwin' ? macFonts : linuxFonts;
  const candidates = fontTable[fontFamily] || [];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Fallback: find any available font
  const fallbacks = platform === 'darwin' ? [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
  ] : [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  ];

  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Escape a font file path for use inside ffmpeg drawtext filter.
 * Colons and backslashes must be escaped.
 */
function escapeFontPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
}

app.listen(PORT, () => {
  console.log(`Video editor running at http://localhost:${PORT}`);
});
