/**
 * image-annotator.ts — iPad-oriented image/diagram annotation overlay.
 *
 * Renders a transparent canvas on top of an image for freehand drawing,
 * arrows, rectangles, and text labels using Apple Pencil or touch.
 * Exports the composited result as a PNG and uploads it.
 *
 * Design:
 *   - Uses native addEventListener with { passive: false } for touch events
 *     because Preact/Safari register JSX pointer handlers as passive,
 *     preventing preventDefault() from stopping scroll/bounce.
 *   - Pencil draws (pointerType === 'pen'); finger scrolls unless
 *     no pencil is detected, in which case finger also draws.
 *   - Tools: pen, highlighter, arrow, rectangle, text, crop, eraser, undo
 *   - Done → flatten raster source + overlay PNG → upload via API
 *
 * Consumers: Post component wraps this inline when the user taps an image on iPad.
 */

import { html, useState, useEffect, useRef, useCallback } from '../vendor/preact-htm.js';
import { useTranslation } from '../utils/i18n.js';
import { uploadMedia } from '../api.js';

// ── Types ───────────────────────────────────────────────────────

type Tool = 'pen' | 'highlighter' | 'arrow' | 'rectangle' | 'text' | 'crop' | 'eraser';

interface Point { x: number; y: number; }

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Stroke {
  tool: Tool;
  color: string;
  lineWidth: number;
  points: Point[];
}

interface ShapeStroke {
  tool: 'arrow' | 'rectangle';
  color: string;
  lineWidth: number;
  start: Point;
  end: Point;
}

interface TextStroke {
  tool: 'text';
  color: string;
  text: string;
  position: Point;
  fontSize: number;
}

type HistoryEntry = Stroke | ShapeStroke | TextStroke;

// ── Constants ───────────────────────────────────────────────────

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ffffff', '#000000'];
const DEFAULT_COLOR = '#ef4444';
const PEN_WIDTH = 3;
const HIGHLIGHTER_WIDTH = 18;
const HIGHLIGHTER_ALPHA = 0.35;
const ERASER_WIDTH = 24;
const ARROW_HEAD_LENGTH = 16;
const TEXT_FONT_SIZE = 28;
const TEXT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif';

const TOOLS: { id: Tool; label: string; icon: string }[] = [
  { id: 'pen',         label: 'Pen',         icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>' },
  { id: 'highlighter', label: 'Highlighter', icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>' },
  { id: 'arrow',       label: 'Arrow',       icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>' },
  { id: 'rectangle',   label: 'Rectangle',   icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>' },
  { id: 'text',        label: 'Text',        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>' },
  { id: 'crop',        label: 'Crop',        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>' },
  { id: 'eraser',      label: 'Eraser',      icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.9-9.9c1-1 2.5-1 3.4 0l5.3 5.3c1 1 1 2.5 0 3.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>' },
];

const UNDO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

// ── Helpers ─────────────────────────────────────────────────────

function isShapeTool(tool: Tool): boolean {
  return tool === 'arrow' || tool === 'rectangle';
}

function isSvgImageSource(src: string, mimeType?: string): boolean {
  const type = String(mimeType || '').toLowerCase();
  if (type.startsWith('image/svg')) return true;
  const value = String(src || '').toLowerCase();
  return value.startsWith('data:image/svg+xml') || /\.svg(?:[?#]|$)/.test(value);
}

function canvasPointFromTouch(canvas: HTMLCanvasElement, t: Touch | { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (t.clientX - rect.left) * (canvas.width / rect.width),
    y: (t.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeCropRect(start: Point, end: Point, width: number, height: number): CropRect | null {
  const x0 = clamp(Math.min(start.x, end.x), 0, width);
  const y0 = clamp(Math.min(start.y, end.y), 0, height);
  const x1 = clamp(Math.max(start.x, end.x), 0, width);
  const y1 = clamp(Math.max(start.y, end.y), 0, height);
  const w = Math.round(x1 - x0);
  const h = Math.round(y1 - y0);
  if (w < 8 || h < 8) return null;
  return { x: Math.round(x0), y: Math.round(y0), width: w, height: h };
}

function drawCropOverlay(ctx: CanvasRenderingContext2D, rect: CropRect, width: number, height: number): void {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.fillRect(0, 0, width, rect.y);
  ctx.fillRect(0, rect.y + rect.height, width, height - rect.y - rect.height);
  ctx.fillRect(0, rect.y, rect.x, rect.height);
  ctx.fillRect(rect.x + rect.width, rect.y, width - rect.x - rect.width, rect.height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, Math.round(Math.min(width, height) / 320));
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.restore();
}

function drawTextStroke(ctx: CanvasRenderingContext2D, entry: TextStroke): void {
  ctx.save();
  ctx.font = `bold ${entry.fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  const metrics = ctx.measureText(entry.text);
  const pad = 6;
  const bgH = entry.fontSize + pad * 2;
  const bgW = metrics.width + pad * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const radius = 6;
  const x = entry.position.x - pad;
  const y = entry.position.y - pad;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + bgW - radius, y);
  ctx.quadraticCurveTo(x + bgW, y, x + bgW, y + radius);
  ctx.lineTo(x + bgW, y + bgH - radius);
  ctx.quadraticCurveTo(x + bgW, y + bgH, x + bgW - radius, y + bgH);
  ctx.lineTo(x + radius, y + bgH);
  ctx.quadraticCurveTo(x, y + bgH, x, y + bgH - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.fill();
  ctx.fillStyle = entry.color;
  ctx.fillText(entry.text, entry.position.x, entry.position.y);
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, entry: HistoryEntry): void {
  ctx.save();
  if ('text' in entry && entry.tool === 'text') {
    drawTextStroke(ctx, entry as TextStroke);
    ctx.restore();
    return;
  }
  if ('points' in entry) {
    const { tool, color, lineWidth, points } = entry;
    if (points.length < 2) { ctx.restore(); return; }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else if (tool === 'highlighter') {
      ctx.globalAlpha = HIGHLIGHTER_ALPHA;
      ctx.strokeStyle = color;
    } else {
      ctx.strokeStyle = color;
    }
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.stroke();
  } else {
    const { tool, color, lineWidth, start, end } = entry;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (tool === 'rectangle') {
      ctx.strokeRect(
        Math.min(start.x, end.x), Math.min(start.y, end.y),
        Math.abs(end.x - start.x), Math.abs(end.y - start.y),
      );
    } else if (tool === 'arrow') {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const angle = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - ARROW_HEAD_LENGTH * Math.cos(angle - Math.PI / 6), end.y - ARROW_HEAD_LENGTH * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - ARROW_HEAD_LENGTH * Math.cos(angle + Math.PI / 6), end.y - ARROW_HEAD_LENGTH * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function redrawAll(ctx: CanvasRenderingContext2D, history: HistoryEntry[], width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  for (const entry of history) drawStroke(ctx, entry);
}

// ── Detection ───────────────────────────────────────────────────

function isIPad(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

export function canAnnotate(): boolean {
  return isIPad();
}

// ── Component ───────────────────────────────────────────────────

export function ImageAnnotator({ src, mimeType, onSave, onCancel }) {
  const { t: tr } = useTranslation();
  const isSvgSource = isSvgImageSource(src, mimeType);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const drawingRef = useRef(false);
  const shapeStartRef = useRef<Point | null>(null);
  const cropSelectionRef = useRef<CropRect | null>(null);
  const currentPointsRef = useRef<Point[]>([]);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [sourceRasterReady, setSourceRasterReady] = useState(false);
  const [cropSelection, setCropSelection] = useState<CropRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<Point>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const pinchRef = useRef<{ startDist: number; startZoom: number; startMid: Point; startPan: Point } | null>(null);
  const gestureModeRef = useRef<'idle' | 'draw' | 'pinch'>('idle');
  const suppressTouchDrawUntilRef = useRef(0);
  const [textInput, setTextInput] = useState<{ position: Point; visible: boolean }>({ position: { x: 0, y: 0 }, visible: false });
  const [textValue, setTextValue] = useState('');
  const textInputRef = useRef<HTMLInputElement>(null);

  // Refs for current tool/color so native event listeners always see latest values
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panOffsetRef.current = panOffset; }, [panOffset]);

  const getLineWidth = useCallback((t?: Tool) => {
    const activeTool = t ?? toolRef.current;
    if (activeTool === 'highlighter') return HIGHLIGHTER_WIDTH;
    if (activeTool === 'eraser') return ERASER_WIDTH;
    return PEN_WIDTH;
  }, []);

  // Initialize canvas to match displayed image size. All sources are rasterized
  // into a canvas first, so crop/annotation edits operate on pixels and the
  // final upload is a flattened PNG instead of trying to preserve SVG vectors.
  const initCanvas = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    if (!img || !canvas || !overlay || !sourceCanvas) return;
    const rect = img.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = w;
    canvas.height = h;
    overlay.width = w;
    overlay.height = h;
    sourceCanvas.width = w;
    sourceCanvas.height = h;
    sourceCanvas.style.width = `${rect.width}px`;
    sourceCanvas.style.height = `${rect.height}px`;

    const sctx = sourceCanvas.getContext('2d');
    if (sctx) {
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(img, 0, 0, w, h);
      setSourceRasterReady(true);
    }
    setCanvasReady(true);
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) initCanvas();
    else img.onload = initCanvas;
  }, [initCanvas]);

  const commitTextLabel = useCallback(() => {
    if (!textValue.trim() || !textInput.visible) return;
    const entry: TextStroke = {
      tool: 'text',
      color: colorRef.current,
      text: textValue.trim(),
      position: textInput.position,
      fontSize: TEXT_FONT_SIZE,
    };
    historyRef.current.push(entry);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) drawStroke(ctx, entry);
    }
    setTextInput({ position: { x: 0, y: 0 }, visible: false });
    setTextValue('');
  }, [textValue, textInput]);

  const cancelTextLabel = useCallback(() => {
    setTextInput({ position: { x: 0, y: 0 }, visible: false });
    setTextValue('');
  }, []);

  // ── Native touch event handlers (registered with { passive: false }) ──
  // This is the critical fix: Preact/Safari registers JSX event props as
  // passive listeners, so preventDefault() is ignored and the browser
  // consumes touches for scrolling. We must use native addEventListener.

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const clearOverlay = () => {
      const overlay = overlayRef.current;
      const octx = overlay?.getContext('2d');
      if (overlay && octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    };

    const cancelActiveDrawing = () => {
      drawingRef.current = false;
      shapeStartRef.current = null;
      cropSelectionRef.current = null;
      currentPointsRef.current = [];
      setCropSelection(null);
      clearOverlay();
      const ctx = canvas.getContext('2d');
      if (ctx) redrawAll(ctx, historyRef.current, canvas.width, canvas.height);
    };

    const beginPinch = (e: TouchEvent) => {
      const t0 = e.touches[0]!;
      const t1 = e.touches[1]!;
      const dist = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const mid = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
      pinchRef.current = {
        startDist: dist,
        startZoom: zoomRef.current,
        startMid: mid,
        startPan: { ...panOffsetRef.current },
      };
      gestureModeRef.current = 'pinch';
      suppressTouchDrawUntilRef.current = Date.now() + 250;
      cancelActiveDrawing();
    };

    const updatePinch = (e: TouchEvent) => {
      if (!pinchRef.current || e.touches.length < 2) return;
      const t0 = e.touches[0]!;
      const t1 = e.touches[1]!;
      const dist = Math.max(1, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const mid = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
      const scaleFactor = dist / pinchRef.current.startDist;
      const nextZoom = Math.min(5, Math.max(1, pinchRef.current.startZoom * scaleFactor));
      setZoom(nextZoom);
      const dx = mid.x - pinchRef.current.startMid.x;
      const dy = mid.y - pinchRef.current.startMid.y;
      setPanOffset({ x: pinchRef.current.startPan.x + dx, y: pinchRef.current.startPan.y + dy });
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.touches.length >= 2) {
        beginPinch(e);
        return;
      }
      if (e.touches.length !== 1 || Date.now() < suppressTouchDrawUntilRef.current) return;
      const touch = e.touches[0]!;
      const pt = canvasPointFromTouch(canvas, touch);
      const currentTool = toolRef.current;

      if (currentTool === 'text') {
        setTextInput({ position: pt, visible: true });
        setTextValue('');
        requestAnimationFrame(() => textInputRef.current?.focus());
        return;
      }

      gestureModeRef.current = 'draw';
      drawingRef.current = true;
      if (currentTool === 'crop') {
        shapeStartRef.current = pt;
        cropSelectionRef.current = null;
        setCropSelection(null);
        clearOverlay();
      } else if (isShapeTool(currentTool)) {
        shapeStartRef.current = pt;
      } else {
        currentPointsRef.current = [pt];
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.touches.length >= 2) {
        if (!pinchRef.current) beginPinch(e);
        updatePinch(e);
        return;
      }
      if (gestureModeRef.current !== 'draw' || !drawingRef.current || e.touches.length !== 1) return;
      const touch = e.touches[0]!;
      const pt = canvasPointFromTouch(canvas, touch);
      const currentTool = toolRef.current;
      const currentColor = colorRef.current;
      const lineWidth = getLineWidth(currentTool);
      const overlay = overlayRef.current;

      if (currentTool === 'crop' && shapeStartRef.current) {
        if (!overlay) return;
        const octx = overlay.getContext('2d');
        const rect = octx ? normalizeCropRect(shapeStartRef.current, pt, canvas.width, canvas.height) : null;
        if (!octx || !rect) return;
        cropSelectionRef.current = rect;
        drawCropOverlay(octx, rect, overlay.width, overlay.height);
      } else if (isShapeTool(currentTool) && shapeStartRef.current) {
        if (!overlay) return;
        const octx = overlay.getContext('2d');
        if (!octx) return;
        octx.clearRect(0, 0, overlay.width, overlay.height);
        drawStroke(octx, {
          tool: currentTool as 'arrow' | 'rectangle',
          color: currentColor,
          lineWidth,
          start: shapeStartRef.current,
          end: pt,
        });
      } else {
        currentPointsRef.current.push(pt);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const pts = currentPointsRef.current;
        if (pts.length < 2) return;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = lineWidth;
        if (currentTool === 'eraser') {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.strokeStyle = 'rgba(0,0,0,1)';
        } else if (currentTool === 'highlighter') {
          redrawAll(ctx, historyRef.current, canvas.width, canvas.height);
          ctx.globalAlpha = HIGHLIGHTER_ALPHA;
          ctx.strokeStyle = currentColor;
          ctx.beginPath();
          ctx.moveTo(pts[0]!.x, pts[0]!.y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
          ctx.stroke();
          ctx.restore();
          return;
        } else {
          ctx.strokeStyle = currentColor;
        }
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 2]!.x, pts[pts.length - 2]!.y);
        ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
        ctx.stroke();
        ctx.restore();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (gestureModeRef.current === 'pinch' || pinchRef.current) {
        if (e.touches.length >= 2) {
          updatePinch(e);
          return;
        }
        pinchRef.current = null;
        gestureModeRef.current = 'idle';
        suppressTouchDrawUntilRef.current = Date.now() + 250;
        cancelActiveDrawing();
        return;
      }
      if (gestureModeRef.current !== 'draw' || !drawingRef.current) return;
      gestureModeRef.current = 'idle';
      drawingRef.current = false;
      const currentTool = toolRef.current;
      const currentColor = colorRef.current;
      const lineWidth = getLineWidth(currentTool);
      const overlay = overlayRef.current;

      if (currentTool === 'crop' && shapeStartRef.current) {
        const touch = e.changedTouches[0];
        const end = touch ? canvasPointFromTouch(canvas, touch) : shapeStartRef.current;
        const rect = normalizeCropRect(shapeStartRef.current, end, canvas.width, canvas.height);
        const octx = overlay?.getContext('2d');
        shapeStartRef.current = null;
        cropSelectionRef.current = rect;
        setCropSelection(rect);
        if (rect && octx && overlay) drawCropOverlay(octx, rect, overlay.width, overlay.height);
        else clearOverlay();
      } else if (isShapeTool(currentTool) && shapeStartRef.current) {
        // Use last known touch point from the changedTouches
        const touch = e.changedTouches[0];
        const end = touch ? canvasPointFromTouch(canvas, touch) : shapeStartRef.current;
        const entry: ShapeStroke = {
          tool: currentTool as 'arrow' | 'rectangle',
          color: currentColor,
          lineWidth,
          start: shapeStartRef.current,
          end,
        };
        historyRef.current.push(entry);
        const ctx = canvas.getContext('2d');
        if (ctx) drawStroke(ctx, entry);
        clearOverlay();
        shapeStartRef.current = null;
      } else {
        const pts = currentPointsRef.current;
        if (pts.length >= 2) {
          historyRef.current.push({
            tool: currentTool,
            color: currentColor,
            lineWidth,
            points: [...pts],
          });
        }
        currentPointsRef.current = [];
      }
    };

    const onTouchCancel = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pinchRef.current = null;
      gestureModeRef.current = 'idle';
      suppressTouchDrawUntilRef.current = Date.now() + 250;
      cancelActiveDrawing();
    };

    // Register with { passive: false } — this is the iPad Safari fix
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [canvasReady, getLineWidth]);

  const handleUndo = useCallback(() => {
    historyRef.current.pop();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    redrawAll(ctx, historyRef.current, canvas.width, canvas.height);
  }, []);

  const clearCropSelection = useCallback(() => {
    cropSelectionRef.current = null;
    setCropSelection(null);
    const overlay = overlayRef.current;
    const octx = overlay?.getContext('2d');
    if (overlay && octx) octx.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  const handleApplyCrop = useCallback(() => {
    const rect = cropSelection || cropSelectionRef.current;
    const sourceCanvas = sourceCanvasRef.current;
    const drawCanvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!rect || !sourceCanvas || !drawCanvas || !overlay) return;
    const sctx = sourceCanvas.getContext('2d');
    const dctx = drawCanvas.getContext('2d');
    const octx = overlay.getContext('2d');
    if (!sctx || !dctx || !octx) return;

    const sourceRect = sourceCanvas.getBoundingClientRect();
    const cssScale = sourceCanvas.width ? sourceRect.width / sourceCanvas.width : 1;
    const cropWidth = Math.max(1, rect.width);
    const cropHeight = Math.max(1, rect.height);
    const merged = document.createElement('canvas');
    merged.width = cropWidth;
    merged.height = cropHeight;
    const mctx = merged.getContext('2d');
    if (!mctx) return;
    mctx.drawImage(sourceCanvas, rect.x, rect.y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    // Flatten existing annotations into the cropped source so future redraws,
    // highlighter strokes, and undo do not lose or misplace pre-crop marks.
    mctx.drawImage(drawCanvas, rect.x, rect.y, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    sourceCanvas.width = cropWidth;
    sourceCanvas.height = cropHeight;
    sourceCanvas.style.width = `${Math.max(1, cropWidth * cssScale)}px`;
    sourceCanvas.style.height = `${Math.max(1, cropHeight * cssScale)}px`;
    sctx.clearRect(0, 0, cropWidth, cropHeight);
    sctx.drawImage(merged, 0, 0);

    drawCanvas.width = cropWidth;
    drawCanvas.height = cropHeight;
    dctx.clearRect(0, 0, cropWidth, cropHeight);
    overlay.width = cropWidth;
    overlay.height = cropHeight;
    octx.clearRect(0, 0, cropWidth, cropHeight);

    historyRef.current = [];
    currentPointsRef.current = [];
    shapeStartRef.current = null;
    cropSelectionRef.current = null;
    setCropSelection(null);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setTool('pen');
  }, [cropSelection]);

  const handleDone = useCallback(async () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    setSaving(true);
    try {
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const octx = out.getContext('2d');
      if (!octx) return;
      const rasterSource = sourceRasterReady ? sourceCanvasRef.current : null;
      if (rasterSource) octx.drawImage(rasterSource, 0, 0, out.width, out.height);
      else octx.drawImage(img, 0, 0, out.width, out.height);
      octx.drawImage(canvas, 0, 0);

      const blob: Blob = await new Promise((resolve, reject) => {
        out.toBlob((b) => b ? resolve(b) : reject(new Error('Canvas export failed')), 'image/png');
      });

      const file = new File([blob], `annotated-${Date.now()}.png`, { type: 'image/png' });
      const result = await uploadMedia(file);
      onSave?.(result);
    } catch (err) {
      console.error('[image-annotator] Save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [onSave, sourceRasterReady]);

  // Commit text on tool switch
  useEffect(() => {
    if (tool !== 'text' && textInput.visible && textValue.trim()) {
      commitTextLabel();
    } else if (tool !== 'text' && textInput.visible) {
      cancelTextLabel();
    }
  }, [tool]);

  return html`
    <div class="image-annotator" role="dialog" aria-modal="true" aria-label=${tr('annotator.title')}>
      <div class="image-annotator-stage">
        <div class="image-annotator-canvas-wrap" style="transform: scale(${zoom}) translate(${panOffset.x / zoom}px, ${panOffset.y / zoom}px); transform-origin: center center;">
          <img
            ref=${imgRef}
            src=${src}
            class=${`image-annotator-source${sourceRasterReady ? ' image-annotator-source-hidden' : ''}`}
            alt="Source"
            draggable="false"
          />
          <canvas
            ref=${sourceCanvasRef}
            class=${`image-annotator-source-raster-canvas${isSvgSource ? ' image-annotator-source-svg-raster' : ''}`}
            hidden=${!sourceRasterReady}
          />
          <canvas
            ref=${canvasRef}
            class="image-annotator-draw-canvas"
          />
          <canvas
            ref=${overlayRef}
            class="image-annotator-preview-canvas"
          />
          ${textInput.visible && html`
            <div
              class="image-annotator-text-input-wrap"
              style="left: ${(textInput.position.x / (canvasRef.current?.width || 1)) * 100}%; top: ${(textInput.position.y / (canvasRef.current?.height || 1)) * 100}%"
            >
              <input
                ref=${textInputRef}
                type="text"
                class="image-annotator-text-input"
                value=${textValue}
                onInput=${(e) => setTextValue(e.currentTarget.value)}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter') commitTextLabel();
                  if (e.key === 'Escape') cancelTextLabel();
                }}
                placeholder=${tr('annotator.typeLabel')}
                style="color: ${color}"
              />
            </div>
          `}
        </div>
      </div>
      <div class="image-annotator-toolbar">
        <div class="image-annotator-tools">
          ${TOOLS.map((t) => html`
            <button
              key=${t.id}
              class=${`image-annotator-tool-btn${tool === t.id ? ' active' : ''}`}
              onClick=${() => setTool(t.id)}
              title=${t.label}
              aria-label=${t.label}
              dangerouslySetInnerHTML=${{ __html: t.icon }}
            />
          `)}
          <button
            class="image-annotator-tool-btn"
            onClick=${handleUndo}
            title=${tr('annotator.undo')}
            aria-label=${tr('annotator.undo')}
            disabled=${saving}
            dangerouslySetInnerHTML=${{ __html: UNDO_ICON }}
          />
          ${zoom > 1 && html`
            <button
              class="image-annotator-tool-btn"
              onClick=${() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
              title=${`Reset zoom (${Math.round(zoom * 100)}%)`}
              aria-label=${tr('annotator.resetZoom')}
            >${Math.round(zoom * 100)}%</button>
          `}
          ${cropSelection && html`
            <button
              class="image-annotator-tool-btn image-annotator-crop-apply-btn"
              onClick=${handleApplyCrop}
              title="Apply crop"
              aria-label="Apply crop"
              disabled=${saving}
            >Crop</button>
            <button
              class="image-annotator-tool-btn image-annotator-crop-cancel-btn"
              onClick=${clearCropSelection}
              title="Cancel crop"
              aria-label="Cancel crop"
              disabled=${saving}
            >×</button>
          `}
        </div>
        <div class="image-annotator-colors">
          ${COLORS.map((c) => html`
            <button
              key=${c}
              class=${`image-annotator-color-btn${color === c ? ' active' : ''}`}
              style="background: ${c}; border: 2px solid ${color === c ? 'var(--accent-color)' : 'transparent'}"
              onClick=${() => setColor(c)}
              aria-label=${`Color ${c}`}
            />
          `)}
        </div>
        <div class="image-annotator-actions">
          <button class="image-annotator-cancel-btn" onClick=${onCancel} disabled=${saving}>Cancel</button>
          <button class="image-annotator-done-btn" onClick=${handleDone} disabled=${saving}>
            ${saving ? 'Saving…' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  `;
}
