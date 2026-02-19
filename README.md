# Web Video Editor

A browser-based video editor with keyframe animation support. Uses vanilla JS on the frontend and Node.js + ffmpeg on the backend for MP4 export.

## Setup

```bash
cd video-editor
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Features

- **Timeline** with multi-layer support, scrubber, zoom
- **Drag, trim, split, delete** clips on the timeline
- **Media support**: video, audio, image, text overlays
- **Keyframe animation**: position (x/y), scale, rotation, opacity with linear interpolation
- **Real-time canvas preview** in the browser
- **Undo/Redo** (Ctrl+Z / Ctrl+Y)
- **MP4 export** via server-side ffmpeg

## Usage

1. Click **+ Media** to upload video/audio/image files
2. Click **+ Text** to add a text overlay
3. Drag clips on the timeline to reposition; use trim handles on edges
4. Select a clip and adjust properties in the right panel (position, scale, rotation, opacity)
5. Position the playhead and click **+ Keyframe** to create animation keyframes
6. Press **Space** to play/pause the preview
7. Click **Export MP4** to render the final video server-side

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Delete | Delete selected clip |

## Limitations

- Export can be slow for long timelines or many layers — ffmpeg processes everything server-side
- No live server-rendered preview (preview is client-side canvas only, may differ slightly from export)
- Keyframe-driven scale/rotation in export uses ffmpeg expression-based interpolation which has some limitations compared to the canvas preview
- Audio mixing in export is basic
- Large file uploads may take time; 500MB limit per file
- No transitions or effects (by design)

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS, Canvas API
- **Backend**: Node.js, Express, fluent-ffmpeg, @ffmpeg-installer/ffmpeg
- **Storage**: Local filesystem (uploads/ and exports/ directories)
