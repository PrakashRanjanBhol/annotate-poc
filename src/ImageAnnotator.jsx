/**
 * ImageAnnotator.jsx
 *
 * Architecture:
 * - FlatCanvas: offscreen canvas composites the base image + committed annotations
 *   (including eraser strokes via destination-out on the annotation layer only).
 *   Displayed as a KonvaImage. The base image is NEVER touched by the eraser.
 *
 * - In SELECT mode, actual Konva shapes (Rect/Circle/Line) are rendered ON TOP
 *   of FlatCanvas so the Transformer can attach to them directly and drag/resize/
 *   rotate works correctly for ALL shape types.
 *
 * - In drawing modes, a DrawingOverlay shows the in-progress shape preview.
 *
 * Fixed issues:
 *  #1  Drag/Resize/Rotate for all shapes — real Konva shapes in SELECT mode
 *  #2  Same filename from different folders — fileKey includes path + size + mtime
 *  #3  TIFF support — uses tiff.js loaded via dynamic <script> injection at startup
 *  #4  Base64 API rendering — addImageFromBase64 via forwardRef/useImperativeHandle
 */

import React, {
    useState, useRef, useEffect, useCallback,
    useImperativeHandle, forwardRef,
} from "react";
import {
    Stage, Layer, Image as KonvaImage,
    Rect, Circle, Line, Transformer,
} from "react-konva";
import styles from "./ImageAnnotator.module.css";

/* ─── Module-level image store ───────────────────────────
 * HTMLImageElement refs stored here never get GC'd between renders.
 */
const IMG_STORE = new Map();

/* ─── TIFF.js: inject CDN script once at module load ────── */
if (typeof window !== "undefined" && !window.__tiffScriptInjected) {
    window.__tiffScriptInjected = true;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tiff.js@1.0.0/tiff.min.js";
    s.async = true;
    document.head.appendChild(s);
}

/* ─── Tools ──────────────────────────────────────────────── */
const TOOLS = {
    SELECT: "select", RECT: "rect", CIRCLE: "circle",
    LINE: "line", POLYGON: "polygon", BRUSH: "brush", ERASER: "eraser",
};

const TOOL_ICONS = {
    [TOOLS.SELECT]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 3l14 9-7 1-4 7L5 3z" /></svg>,
    [TOOLS.RECT]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="1" /></svg>,
    [TOOLS.CIRCLE]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>,
    [TOOLS.LINE]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="20" x2="20" y2="4" /></svg>,
    [TOOLS.POLYGON]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12,3 21,9 18,20 6,20 3,9" /></svg>,
    [TOOLS.BRUSH]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 2v3.5" /><path d="M21 17a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-2z" /></svg>,
    [TOOLS.ERASER]: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 20H7L3 16l11-11 6 6-4 4" /><path d="m6.7 6.7 10.6 10.6" /></svg>,
};

const STROKE_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ffffff"];
const FILL_COLORS = ["transparent", "#ef444466", "#f9731666", "#eab30866", "#22c55e66", "#3b82f666", "#a855f766", "#ec489966"];

let annCounter = 0;
const nextId = () => `ann-${++annCounter}`;

/* Fix #2: folder-aware file key — includes full path so same filename
   from different folders produces a different key */
const makeFileKey = (file) => {
    const path = file.webkitRelativePath || file.name;
    return `${path}__${file.size}__${file.lastModified}`;
};

/* ─── TIFF / image decoding ──────────────────────────────── */

function waitForTiff(maxMs = 8000) {
    return new Promise((resolve) => {
        if (typeof window.Tiff !== "undefined") { resolve(); return; }
        const start = Date.now();
        const t = setInterval(() => {
            if (typeof window.Tiff !== "undefined" || Date.now() - start > maxMs) {
                clearInterval(t); resolve();
            }
        }, 100);
    });
}

async function decodeImageFile(file) {
    const isTiff = /\.tiff?$/i.test(file.name) || file.type === "image/tiff";
    if (isTiff) {
        await waitForTiff();
        const buf = await file.arrayBuffer();
        if (typeof window.Tiff !== "undefined") {
            try {
                const tiff = new window.Tiff({ buffer: buf });
                const dataUrl = tiff.toCanvas().toDataURL("image/png");
                return loadHtmlImage(dataUrl);
            } catch (_) { /* fall through to blob URL */ }
        }
        return loadHtmlImage(URL.createObjectURL(file));
    }
    // Non-tiff: read as DataURL to avoid blob URL GC
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => loadHtmlImage(e.target.result).then(resolve).catch(reject);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function loadHtmlImage(src) {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function decodeBase64Image(base64, mimeType = "image/png") {
    const src = base64.startsWith("data:") ? base64 : `data:${mimeType};base64,${base64}`;
    return loadHtmlImage(src);
}

/* ─── FlatCanvas ─────────────────────────────────────────
 * Renders base image + ALL committed annotations (+ optional live
 * eraser stroke) onto an offscreen canvas, displayed as a KonvaImage.
 *
 * Two-canvas approach so eraser (destination-out) NEVER touches the image:
 *   annCanvas  — annotations on transparent bg; eraser punches holes here
 *   outCanvas  — image drawn first, then annCanvas composited on top
 */
const FlatCanvas = React.memo(({ imgId, displayW, displayH, annotations, liveEraserStroke }) => {
    const annRef = useRef(null);
    const outRef = useRef(null);
    const [bitmap, setBitmap] = useState(null);

    useEffect(() => {
        if (!annRef.current) annRef.current = document.createElement("canvas");
        if (!outRef.current) outRef.current = document.createElement("canvas");
        annRef.current.width = displayW; annRef.current.height = displayH;
        outRef.current.width = displayW; outRef.current.height = displayH;
    }, [displayW, displayH]);

    useEffect(() => {
        const htmlImg = IMG_STORE.get(imgId);
        if (!htmlImg || !annRef.current || !outRef.current) return;

        const all = liveEraserStroke ? [...annotations, liveEraserStroke] : annotations;

        // ── annotation canvas (transparent background) ──
        const ac = annRef.current.getContext("2d");
        ac.clearRect(0, 0, displayW, displayH);

        for (const ann of all) {
            if (!ann || !ann.type) continue;
            ac.save();
            const ox = ann.x ?? 0, oy = ann.y ?? 0;

            if (ann.type === "eraser") {
                ac.globalCompositeOperation = "destination-out";
                ac.strokeStyle = "rgba(0,0,0,1)";
                ac.lineWidth = ann.size * 2;
                ac.lineCap = "square";
                ac.lineJoin = "miter";
                const pts = ann.points || [];
                if (pts.length >= 2) {
                    ac.beginPath();
                    ac.moveTo(pts[0], pts[1]);
                    for (let i = 2; i < pts.length; i += 2) ac.lineTo(pts[i], pts[i + 1]);
                    ac.stroke();
                    if (pts.length === 2) {
                        ac.fillStyle = "rgba(0,0,0,1)";
                        ac.fillRect(pts[0] - ann.size, pts[1] - ann.size, ann.size * 2, ann.size * 2);
                    }
                }
                ac.restore(); continue;
            }

            ac.globalCompositeOperation = "source-over";
            ac.strokeStyle = ann.stroke || "#ef4444";
            ac.lineWidth = ann.strokeWidth || 3;
            const hasFill = ann.fill && ann.fill !== "transparent";
            if (hasFill) ac.fillStyle = ann.fill;

            // apply rotation / scale for FlatCanvas visual
            if (ann.rotation || ann.scaleX !== 1 || ann.scaleY !== 1) {
                const cx = (ann.x ?? 0) + (ann.width ?? ann.radius ?? 0) / 2;
                const cy = (ann.y ?? 0) + (ann.height ?? ann.radius ?? 0) / 2;
                ac.translate(cx, cy);
                ac.rotate(((ann.rotation ?? 0) * Math.PI) / 180);
                ac.scale(ann.scaleX ?? 1, ann.scaleY ?? 1);
                ac.translate(-cx, -cy);
            }

            if (ann.type === "rect") {
                ac.beginPath(); ac.rect(ann.x ?? 0, ann.y ?? 0, ann.width, ann.height);
                if (hasFill) ac.fill(); ac.stroke();
            } else if (ann.type === "circle") {
                ac.beginPath(); ac.arc(ann.x ?? 0, ann.y ?? 0, ann.radius, 0, Math.PI * 2);
                if (hasFill) ac.fill(); ac.stroke();
            } else if (ann.type === "line") {
                const p = ann.points || [];
                if (p.length >= 4) {
                    ac.beginPath(); ac.lineCap = "round";
                    ac.moveTo(p[0] + ox, p[1] + oy); ac.lineTo(p[2] + ox, p[3] + oy); ac.stroke();
                }
            } else if (ann.type === "brush") {
                const p = ann.points || [];
                if (p.length >= 2) {
                    ac.beginPath(); ac.lineCap = "round"; ac.lineJoin = "round";
                    ac.moveTo(p[0] + ox, p[1] + oy);
                    for (let i = 2; i < p.length; i += 2) ac.lineTo(p[i] + ox, p[i + 1] + oy);
                    ac.stroke();
                }
            } else if (ann.type === "polygon") {
                const p = ann.points || [];
                if (p.length >= 4) {
                    ac.beginPath();
                    ac.moveTo(p[0] + ox, p[1] + oy);
                    for (let i = 2; i < p.length; i += 2) ac.lineTo(p[i] + ox, p[i + 1] + oy);
                    if (ann.closed) ac.closePath();
                    if (hasFill) ac.fill(); ac.stroke();
                }
            }
            ac.restore();
        }

        // ── output canvas: image first, then annotation layer ──
        const oc = outRef.current.getContext("2d");
        oc.clearRect(0, 0, displayW, displayH);
        oc.drawImage(htmlImg, 0, 0, displayW, displayH);
        oc.drawImage(annRef.current, 0, 0, displayW, displayH);

        createImageBitmap(outRef.current).then(setBitmap);
    }, [imgId, displayW, displayH, annotations, liveEraserStroke]);

    if (!bitmap) return null;
    return <KonvaImage image={bitmap} x={0} y={0} width={displayW} height={displayH} listening={false} />;
});

/* ─── ImageCard ──────────────────────────────────────────── */
const ImageCard = ({ item, isActive, onSelect, onDragStart, onRemove }) => (
    <div
        className={`${styles.imageCard} ${isActive ? styles.imageCardActive : ""}`}
        onClick={onSelect} draggable onDragStart={onDragStart}
        title={`${item.path} — drag to canvas`}
    >
        <span className={styles.cardSerial}>{item.serial}</span>
        <div className={styles.cardThumbWrap}>
            <img src={item.thumbSrc} alt={item.name} className={styles.cardThumb} draggable={false} />
            {item.annotationCount > 0 && <span className={styles.cardBadge}>{item.annotationCount}</span>}
        </div>
        <div className={styles.cardInfo}>
            <span className={styles.cardName}>{item.name}</span>
            <span className={styles.cardPath} title={item.path}>{item.path}</span>
        </div>
        <button className={styles.cardRemove}
            onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove">×</button>
    </div>
);

/* ─── Main ───────────────────────────────────────────────── */
const ImageAnnotator = forwardRef((props, ref) => {
    const [imageLibrary, setImageLibrary] = useState([]);
    const [imageStates, setImageStates] = useState({});
    const [activeImageId, setActiveImageId] = useState(null);
    const [displaySize, setDisplaySize] = useState({ w: 800, h: 600 });

    const [tool, setTool] = useState(TOOLS.SELECT);
    const [selectedId, setSelectedId] = useState(null);
    const [drawing, setDrawing] = useState(false);
    const [currentShape, setCurrentShape] = useState(null);
    const [polyPoints, setPolyPoints] = useState([]);
    const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
    const [scale, setScale] = useState(1);
    const [strokeColor, setStrokeColor] = useState("#ef4444");
    const [fillColor, setFillColor] = useState("transparent");
    const [strokeWidth, setStrokeWidth] = useState(3);
    const [eraserSize, setEraserSize] = useState(20);
    const [canvasDragOver, setCanvasDragOver] = useState(false);
    const [eraserPos, setEraserPos] = useState(null);
    const [liveEraserStroke, setLiveEraserStroke] = useState(null);
    const [stageDims, setStageDims] = useState({ w: 800, h: 600 });

    const primaryDownRef = useRef(false);
    const eraserStrokeRef = useRef(null);
    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const serialRef = useRef(0);
    const fileKeysRef = useRef(new Set());

    /* ── Derived ── */
    const activeImage = imageLibrary.find(i => i.id === activeImageId) ?? null;
    const emptyState = { annotations: [], history: [[]], historyStep: 0 };
    const activeState = activeImageId ? (imageStates[activeImageId] ?? emptyState) : emptyState;
    const { annotations, history, historyStep } = activeState;

    const visibleAnnCount = (id) =>
        (imageStates[id]?.annotations ?? []).filter(a => a != null && a.type !== "eraser").length;

    /* ── History ── */
    const pushHistory = useCallback((newAnns) => {
        if (!activeImageId) return;
        setImageStates(prev => {
            const cur = prev[activeImageId] ?? emptyState;
            const newHist = cur.history.slice(0, cur.historyStep + 1).concat([newAnns]);
            return { ...prev, [activeImageId]: { annotations: newAnns, history: newHist, historyStep: newHist.length - 1 } };
        });
    }, [activeImageId]);

    const undo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates(prev => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep === 0) return prev;
            const step = cur.historyStep - 1;
            return { ...prev, [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step } };
        });
        setSelectedId(null);
    }, [activeImageId]);

    const redo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates(prev => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep >= cur.history.length - 1) return prev;
            const step = cur.historyStep + 1;
            return { ...prev, [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step } };
        });
    }, [activeImageId]);

    /* ── Transformer: attach to real Konva node by id ── */
    useEffect(() => {
        if (!transformerRef.current || !stageRef.current) return;
        if (selectedId && tool === TOOLS.SELECT) {
            const node = stageRef.current.findOne(`#${selectedId}`);
            if (node) {
                transformerRef.current.nodes([node]);
                transformerRef.current.getLayer().batchDraw();
                return;
            }
        }
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
    }, [selectedId, tool, annotations]);

    /* ── TransformEnd: bake scale into geometry ── */
    const handleTransformEnd = useCallback((annId) => {
        const node = stageRef.current?.findOne(`#${annId}`);
        if (!node) return;
        const ann = annotations.find(a => a.id === annId);
        if (!ann) return;

        const newX = node.x();
        const newY = node.y();
        const newRot = node.rotation();
        const sx = node.scaleX();
        const sy = node.scaleY();

        let patch = { x: newX, y: newY, rotation: newRot, scaleX: 1, scaleY: 1 };

        if (ann.type === "rect") {
            patch.width = ann.width * sx;
            patch.height = ann.height * sy;
        } else if (ann.type === "circle") {
            patch.radius = ann.radius * Math.max(sx, sy);
        } else if (ann.type === "line" || ann.type === "brush" || ann.type === "polygon") {
            // For polyline types, bake the scale into the points array and reset node scale
            const pts = ann.points;
            const baked = [];
            for (let i = 0; i < pts.length; i += 2) {
                baked.push(pts[i] * sx, pts[i + 1] * sy);
            }
            patch.points = baked;
        }

        // Reset node scale immediately
        node.scaleX(1); node.scaleY(1);

        pushHistory(annotations.map(a => a.id === annId ? { ...a, ...patch } : a));
    }, [annotations, pushHistory]);

    /* ── Register image entry ── */
    const registerImage = useCallback((htmlImg, name, path, fileKey) => {
        return new Promise(resolve => {
            serialRef.current += 1;
            const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            // thumbnail
            const tc = document.createElement("canvas");
            tc.width = 80; tc.height = 60;
            const tctx = tc.getContext("2d");
            const r = Math.min(80 / htmlImg.naturalWidth, 60 / htmlImg.naturalHeight);
            tctx.drawImage(htmlImg, (80 - htmlImg.naturalWidth * r) / 2, (60 - htmlImg.naturalHeight * r) / 2, htmlImg.naturalWidth * r, htmlImg.naturalHeight * r);
            const thumbSrc = tc.toDataURL("image/jpeg", 0.7);
            IMG_STORE.set(id, htmlImg);
            const entry = {
                id, serial: serialRef.current, name, path, thumbSrc,
                naturalW: htmlImg.naturalWidth, naturalH: htmlImg.naturalHeight, fileKey
            };
            setImageLibrary(prev => [...prev, entry]);
            setImageStates(prev => ({ ...prev, [id]: { annotations: [], history: [[]], historyStep: 0 } }));
            resolve(entry);
        });
    }, []);

    /* ── Load files (fix #2: folder-aware key; fix #3: TIFF) ── */
    const loadFiles = useCallback(async (files) => {
        const sorted = Array.from(files)
            .filter(f => f.type.startsWith("image/") || /\.tiff?$/i.test(f.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const file of sorted) {
            const fk = makeFileKey(file);
            if (fileKeysRef.current.has(fk)) continue;
            fileKeysRef.current.add(fk);
            try {
                const htmlImg = await decodeImageFile(file);
                await registerImage(htmlImg, file.name, file.webkitRelativePath || file.name, fk);
            } catch (err) {
                console.warn("Could not load:", file.name, err);
                fileKeysRef.current.delete(fk);
            }
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
    }, [registerImage]);

    /* ── Fix #4: expose addImageFromBase64 via ref ── */
    const addImageFromBase64 = useCallback(async (base64, mimeType = "image/png", name = "api-image.png") => {
        try {
            const htmlImg = await decodeBase64Image(base64, mimeType);
            const fk = `b64__${name}__${base64.length}__${base64.slice(-16)}`;
            if (fileKeysRef.current.has(fk)) return null;
            fileKeysRef.current.add(fk);
            return await registerImage(htmlImg, name, name, fk);
        } catch (err) { console.error("addImageFromBase64:", err); return null; }
    }, [registerImage]);

    useImperativeHandle(ref, () => ({ addImageFromBase64 }), [addImageFromBase64]);

    /* ── Activate image ── */
    const activateImage = useCallback((item) => {
        const el = canvasRef.current;
        const cw = el ? el.clientWidth : window.innerWidth - 450;
        const ch = el ? el.clientHeight : window.innerHeight - 40;
        const ratio = Math.min(cw / item.naturalW, ch / item.naturalH, 1);
        setDisplaySize({ w: Math.round(item.naturalW * ratio), h: Math.round(item.naturalH * ratio) });
        setActiveImageId(item.id);
        setSelectedId(null); setPolyPoints([]);
        setScale(1); setStagePos({ x: 0, y: 0 });
        setDrawing(false); setCurrentShape(null);
        eraserStrokeRef.current = null; setLiveEraserStroke(null);
    }, []);

    /* ── Remove ── */
    const removeImage = useCallback((id) => {
        const item = imageLibrary.find(i => i.id === id);
        if (item) fileKeysRef.current.delete(item.fileKey);
        IMG_STORE.delete(id);
        setImageLibrary(prev => prev.filter(i => i.id !== id));
        setImageStates(prev => { const n = { ...prev }; delete n[id]; return n; });
        if (activeImageId === id) setActiveImageId(null);
    }, [imageLibrary, activeImageId]);

    /* ── Panel drag ── */
    const handlePanelDragStart = (e, id) => {
        e.dataTransfer.setData("application/x-imageid", id);
        e.dataTransfer.effectAllowed = "copy";
    };
    const handleCanvasDragOver = e => { e.preventDefault(); setCanvasDragOver(true); };
    const handleCanvasDragLeave = () => setCanvasDragOver(false);
    const handleCanvasDrop = e => {
        e.preventDefault(); setCanvasDragOver(false);
        const id = e.dataTransfer.getData("application/x-imageid");
        const item = imageLibrary.find(i => i.id === id);
        if (item) activateImage(item);
        else if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    };
    const handlePanelDrop = e => { e.preventDefault(); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); };

    /* ── Pointer helpers ── */
    const getImagePos = useCallback(() => {
        const stage = stageRef.current; if (!stage) return { x: 0, y: 0 };
        const ptr = stage.getPointerPosition();
        return { x: (ptr.x - stage.x()) / scale, y: (ptr.y - stage.y()) / scale };
    }, [scale]);

    /* ── Mouse handlers ── */
    const handleMouseDown = useCallback(e => {
        if (!activeImage) return;
        primaryDownRef.current = !e.evt || e.evt.button === 0;
        if (!primaryDownRef.current) return;

        if (tool === TOOLS.SELECT) {
            const onBg = e.target === e.target.getStage() || e.target.getClassName() === "Image";
            if (onBg) setSelectedId(null);
            return;
        }
        if (tool === TOOLS.POLYGON) return;
        setDrawing(true);

        if (tool === TOOLS.ERASER) {
            const pos = getImagePos();
            setEraserPos(pos);
            const size = eraserSize / scale;
            const stroke = { id: nextId(), type: "eraser", points: [pos.x, pos.y], size };
            eraserStrokeRef.current = stroke;
            setLiveEraserStroke(stroke);
            return;
        }

        const pos = getImagePos();
        if (tool === TOOLS.RECT) setCurrentShape({ id: nextId(), type: "rect", x: pos.x, y: pos.y, width: 0, height: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.CIRCLE) setCurrentShape({ id: nextId(), type: "circle", x: pos.x, y: pos.y, radius: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.LINE) setCurrentShape({ id: nextId(), type: "line", points: [pos.x, pos.y, pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
        else if (tool === TOOLS.BRUSH) setCurrentShape({ id: nextId(), type: "brush", points: [pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
    }, [activeImage, tool, strokeColor, strokeWidth, fillColor, scale, eraserSize, getImagePos]);

    const handleMouseMove = useCallback(() => {
        if (tool === TOOLS.ERASER) {
            const pos = getImagePos();
            setEraserPos(pos);
            if (drawing && eraserStrokeRef.current) {
                const updated = { ...eraserStrokeRef.current, points: [...eraserStrokeRef.current.points, pos.x, pos.y] };
                eraserStrokeRef.current = updated;
                setLiveEraserStroke({ ...updated });
            }
            return;
        }
        if (!drawing || !currentShape) return;
        const pos = getImagePos();
        if (tool === TOOLS.RECT) setCurrentShape(s => ({ ...s, width: pos.x - s.x, height: pos.y - s.y }));
        else if (tool === TOOLS.CIRCLE) { const dx = pos.x - currentShape.x, dy = pos.y - currentShape.y; setCurrentShape(s => ({ ...s, radius: Math.sqrt(dx * dx + dy * dy) })); }
        else if (tool === TOOLS.LINE) setCurrentShape(s => ({ ...s, points: [s.points[0], s.points[1], pos.x, pos.y] }));
        else if (tool === TOOLS.BRUSH) setCurrentShape(s => ({ ...s, points: [...s.points, pos.x, pos.y] }));
    }, [drawing, tool, currentShape, getImagePos]);

    const handleMouseUp = useCallback(() => {
        if (!drawing) return;
        setDrawing(false);

        if (tool === TOOLS.ERASER) {
            const fin = eraserStrokeRef.current;
            eraserStrokeRef.current = null;
            setLiveEraserStroke(null);
            if (fin) {
                setImageStates(prev => {
                    const cur = prev[activeImageId] ?? emptyState;
                    const newAnns = [...cur.annotations, fin];
                    const newHist = cur.history.slice(0, cur.historyStep + 1).concat([newAnns]);
                    return { ...prev, [activeImageId]: { annotations: newAnns, history: newHist, historyStep: newHist.length - 1 } };
                });
            }
            return;
        }

        if (!currentShape) return;
        const MIN = 3;
        if (currentShape.type === "rect" && (Math.abs(currentShape.width) < MIN || Math.abs(currentShape.height) < MIN)) { setCurrentShape(null); return; }
        if (currentShape.type === "circle" && currentShape.radius < MIN) { setCurrentShape(null); return; }
        if (currentShape.type === "brush") {
            const p = currentShape.points;
            if (p.length < 4 || Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) < MIN) { setCurrentShape(null); return; }
        }
        if (currentShape.type === "line") {
            const p = currentShape.points;
            if (Math.hypot(p[2] - p[0], p[3] - p[1]) < MIN) { setCurrentShape(null); return; }
        }
        pushHistory([...annotations, currentShape]);
        setCurrentShape(null);
    }, [drawing, tool, currentShape, annotations, activeImageId, pushHistory]);

    const handleStageClick = useCallback(e => {
        if (!primaryDownRef.current) return;
        if (tool !== TOOLS.POLYGON) return;
        const pos = getImagePos();
        if (e.evt.detail === 2) {
            if (polyPoints.length >= 6)
                pushHistory([...annotations, { id: nextId(), type: "polygon", points: [...polyPoints], stroke: strokeColor, strokeWidth, fill: fillColor, closed: true, x: 0, y: 0 }]);
            setPolyPoints([]);
        } else {
            setPolyPoints(pts => [...pts, pos.x, pos.y]);
        }
    }, [tool, polyPoints, annotations, strokeColor, strokeWidth, fillColor, pushHistory, getImagePos]);

    const deleteSelected = useCallback(() => {
        if (!selectedId) return;
        pushHistory(annotations.filter(a => a.id !== selectedId));
        setSelectedId(null);
    }, [selectedId, annotations, pushHistory]);

    /* ── Keyboard ── */
    useEffect(() => {
        const onKey = e => {
            if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") { e.preventDefault(); undo(); }
            if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
            if (e.key === "Escape") { setPolyPoints([]); setDrawing(false); setCurrentShape(null); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [deleteSelected, undo, redo]);

    /* ── Wheel zoom ── */
    useEffect(() => {
        const el = canvasRef.current; if (!el) return;
        const onWheel = e => {
            e.preventDefault();
            if (!stageRef.current || !activeImage) return;
            const dir = e.deltaY < 0 ? 1 : -1;
            const newScale = Math.min(10, Math.max(0.05, dir > 0 ? scale * 1.08 : scale / 1.08));
            const cw = el.clientWidth, ch = el.clientHeight;
            const iw = displaySize.w * newScale, ih = displaySize.h * newScale;
            let nx, ny;
            if (iw <= cw && ih <= ch) { nx = (cw - iw) / 2; ny = (ch - ih) / 2; }
            else {
                const ptr = stageRef.current.getPointerPosition() ?? { x: cw / 2, y: ch / 2 };
                const ix = (ptr.x - stagePos.x) / scale, iy = (ptr.y - stagePos.y) / scale;
                nx = Math.max(Math.min(0, cw - iw), Math.min(0, ptr.x - ix * newScale));
                ny = Math.max(Math.min(0, ch - ih), Math.min(0, ptr.y - iy * newScale));
            }
            setScale(newScale); setStagePos({ x: nx, y: ny });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scale, stagePos, displaySize, activeImage]);

    const handleZoomBtn = delta => {
        const el = canvasRef.current;
        const ns = Math.min(10, Math.max(0.05, scale + delta));
        const cw = el?.clientWidth ?? 800, ch = el?.clientHeight ?? 600;
        const iw = displaySize.w * ns, ih = displaySize.h * ns;
        setScale(ns);
        setStagePos({
            x: iw <= cw ? (cw - iw) / 2 : Math.max(cw - iw, Math.min(0, stagePos.x)),
            y: ih <= ch ? (ch - ih) / 2 : Math.max(ch - ih, Math.min(0, stagePos.y)),
        });
    };

    /* ── ResizeObserver ── */
    useEffect(() => {
        const el = canvasRef.current; if (!el) return;
        const ro = new ResizeObserver(() => setStageDims({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        setStageDims({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);

    /* ── Fix #1: Render real Konva shapes in SELECT mode so Transformer works ─
     * In SELECT mode, render each annotation as a real Konva node with full
     * drag/transform support. The FlatCanvas underneath is slightly faded
     * so selected handles are visible.
     */
    const nonEraserAnns = annotations.filter(a => a != null && a.type !== "eraser");

    const renderSelectableShape = (ann) => {
        const common = {
            id: ann.id,
            key: ann.id,
            stroke: ann.stroke,
            strokeWidth: ann.strokeWidth,
            strokeScaleEnabled: false,
            fill: ann.fill ?? "transparent",
            rotation: ann.rotation ?? 0,
            scaleX: ann.scaleX ?? 1,
            scaleY: ann.scaleY ?? 1,
            draggable: true,
            onClick: e => { if (e.evt.button !== 0) return; setSelectedId(ann.id); },
            onTap: () => setSelectedId(ann.id),
            onDragEnd: e => {
                pushHistory(annotations.map(a =>
                    a.id === ann.id ? { ...a, x: e.target.x(), y: e.target.y() } : a
                ));
            },
            onTransformEnd: () => handleTransformEnd(ann.id),
        };

        if (ann.type === "rect")
            return <Rect key={ann.id} {...common} x={ann.x ?? 0} y={ann.y ?? 0} width={ann.width} height={ann.height} />;
        if (ann.type === "circle")
            return <Circle key={ann.id} {...common} x={ann.x ?? 0} y={ann.y ?? 0} radius={ann.radius} />;
        if (ann.type === "line")
            return <Line key={ann.id} {...common} x={ann.x ?? 0} y={ann.y ?? 0} points={ann.points} lineCap="round" />;
        if (ann.type === "brush")
            return <Line key={ann.id} {...common} x={ann.x ?? 0} y={ann.y ?? 0} points={ann.points} tension={0.5} lineCap="round" lineJoin="round" />;
        if (ann.type === "polygon")
            return <Line key={ann.id} {...common} x={ann.x ?? 0} y={ann.y ?? 0} points={ann.points} closed={ann.closed} />;
        return null;
    };

    const getCursor = () => {
        if (tool === TOOLS.ERASER) return "none";
        if (tool === TOOLS.SELECT) return "default";
        return "crosshair";
    };

    const isSelect = tool === TOOLS.SELECT;

    return (
        <div className={styles.root}>

            {/* ── Left toolbar ── */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarTop}>
                    <div className={styles.logoMark}>IA</div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Tools</span>
                        {Object.values(TOOLS).map(t => (
                            <button key={t}
                                className={`${styles.toolBtn} ${tool === t ? styles.active : ""}`}
                                onClick={() => {
                                    setTool(t); setPolyPoints([]); setDrawing(false); setCurrentShape(null);
                                    if (t !== TOOLS.ERASER) setEraserPos(null);
                                }}
                                title={t}
                            >
                                <span className={styles.toolIcon}>{TOOL_ICONS[t]}</span>
                                <span className={styles.toolLabel}>{t}</span>
                            </button>
                        ))}
                    </div>

                    <div className={styles.divider} />

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Stroke color</span>
                        <div className={styles.colorGrid}>
                            {STROKE_COLORS.map(c => (
                                <button key={c} className={`${styles.colorDot} ${strokeColor === c ? styles.colorActive : ""}`}
                                    style={{ "--dot-color": c }} onClick={() => setStrokeColor(c)} />
                            ))}
                        </div>
                    </div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Fill color</span>
                        <div className={styles.colorGrid}>
                            {FILL_COLORS.map(c => (
                                <button key={c}
                                    className={`${styles.colorDot} ${fillColor === c ? styles.colorActive : ""} ${c === "transparent" ? styles.colorTransparent : ""}`}
                                    style={{ "--dot-color": c === "transparent" ? "#2a2a30" : c }}
                                    onClick={() => setFillColor(c)} title={c === "transparent" ? "No fill" : c} />
                            ))}
                        </div>
                    </div>

                    {tool !== TOOLS.ERASER && (
                        <div className={styles.toolGroup}>
                            <span className={styles.groupLabel}>Stroke — {strokeWidth}px</span>
                            <input type="range" min="1" max="20" value={strokeWidth}
                                onChange={e => setStrokeWidth(Number(e.target.value))} className={styles.slider} />
                        </div>
                    )}

                    {tool === TOOLS.ERASER && (
                        <div className={styles.toolGroup}>
                            <span className={styles.groupLabel}>Eraser size — {eraserSize}px</span>
                            <input type="range" min="4" max="120" value={eraserSize}
                                onChange={e => setEraserSize(Number(e.target.value))} className={styles.slider} />
                        </div>
                    )}

                    <div className={styles.divider} />

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Zoom — {Math.round(scale * 100)}%</span>
                        <div className={styles.zoomRow}>
                            <button className={styles.zoomBtn} onClick={() => handleZoomBtn(-0.15)}>−</button>
                            <button className={styles.zoomBtn} onClick={() => { setScale(1); setStagePos({ x: 0, y: 0 }); }}>1:1</button>
                            <button className={styles.zoomBtn} onClick={() => handleZoomBtn(+0.15)}>+</button>
                        </div>
                    </div>
                </div>

                <div className={styles.sidebarBottom}>
                    <div className={styles.historyRow}>
                        <button className={styles.histBtn} onClick={undo} disabled={historyStep === 0} title="Undo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
                        </button>
                        <button className={styles.histBtn} onClick={redo} disabled={historyStep >= history.length - 1} title="Redo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
                        </button>
                        <button className={`${styles.histBtn} ${styles.deleteBtn}`} onClick={deleteSelected} disabled={!selectedId} title="Delete">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                        </button>
                    </div>
                    <div className={styles.hint}>
                        {tool === TOOLS.POLYGON ? "Click · Dbl-click to close" :
                            tool === TOOLS.ERASER ? "Drag to erase · size slider controls brush" :
                                "Del · Ctrl+Z/Y · Scroll zoom"}
                    </div>
                </div>
            </aside>

            {/* ── Canvas ── */}
            <main
                ref={canvasRef}
                className={`${styles.canvas} ${canvasDragOver ? styles.canvasDragOver : ""}`}
                style={{ cursor: getCursor() }}
                onDragOver={handleCanvasDragOver}
                onDragLeave={handleCanvasDragLeave}
                onDrop={handleCanvasDrop}
            >
                {!activeImage ? (
                    <div className={styles.empty}>
                        <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5" width="56" height="56">
                            <rect x="6" y="6" width="52" height="52" rx="6" strokeDasharray="4 3" />
                            <path d="M22 32h20M32 22v20" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        <p>Drag an image from the panel<br />onto the canvas to start annotating</p>
                    </div>
                ) : (
                    <Stage
                        ref={stageRef}
                        width={stageDims.w} height={stageDims.h}
                        x={stagePos.x} y={stagePos.y}
                        scaleX={scale} scaleY={scale}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={() => { if (drawing) handleMouseUp(); setEraserPos(null); setLiveEraserStroke(null); }}
                        onClick={handleStageClick}
                        style={{ display: "block" }}
                    >
                        <Layer>
                            {/* FlatCanvas: image + committed eraser strokes composite.
                  In SELECT mode, annotations are rendered as real Konva nodes
                  on top, so FlatCanvas only needs to show the image + eraser holes.
                  In non-select drawing modes, FlatCanvas shows everything. */}
                            <FlatCanvas
                                imgId={activeImageId}
                                displayW={displaySize.w}
                                displayH={displaySize.h}
                                annotations={isSelect ? annotations.filter(a => a != null && a.type === "eraser") : annotations}
                                liveEraserStroke={liveEraserStroke}
                            />

                            {/* In SELECT mode: render real Konva shapes so Transformer works */}
                            {isSelect && nonEraserAnns.map(renderSelectableShape)}

                            {/* In drawing modes: show in-progress shape preview */}
                            {!isSelect && currentShape && (() => {
                                const p = {
                                    stroke: currentShape.stroke, strokeWidth: currentShape.strokeWidth,
                                    strokeScaleEnabled: false, fill: currentShape.fill ?? "transparent", listening: false,
                                };
                                if (currentShape.type === "rect")
                                    return <Rect key="cur" {...p} x={currentShape.x} y={currentShape.y} width={currentShape.width} height={currentShape.height} />;
                                if (currentShape.type === "circle")
                                    return <Circle key="cur" {...p} x={currentShape.x} y={currentShape.y} radius={currentShape.radius} />;
                                if (currentShape.type === "line")
                                    return <Line key="cur" {...p} points={currentShape.points} lineCap="round" />;
                                if (currentShape.type === "brush")
                                    return <Line key="cur" {...p} points={currentShape.points} tension={0.5} lineCap="round" lineJoin="round" />;
                                return null;
                            })()}

                            {/* Polygon in-progress */}
                            {polyPoints.length >= 2 && (
                                <Line key="poly-preview"
                                    points={polyPoints} stroke={strokeColor} strokeWidth={strokeWidth}
                                    strokeScaleEnabled={false} fill="transparent" listening={false} />
                            )}

                            <Transformer ref={transformerRef} keepRatio={false}
                                boundBoxFunc={(o, n) => (n.width < 5 || n.height < 5 ? o : n)} />

                            {/* Eraser square cursor */}
                            {tool === TOOLS.ERASER && eraserPos && (
                                <Rect
                                    x={eraserPos.x - eraserSize / scale} y={eraserPos.y - eraserSize / scale}
                                    width={eraserSize / scale * 2} height={eraserSize / scale * 2}
                                    stroke="rgba(255,255,255,0.95)" strokeWidth={1 / scale}
                                    strokeScaleEnabled={false} fill="rgba(255,255,255,0.07)"
                                    dash={[4 / scale, 3 / scale]} listening={false} perfectDrawEnabled={false} />
                            )}
                        </Layer>
                    </Stage>
                )}

                {canvasDragOver && (
                    <div className={styles.dropOverlay}>
                        <div className={styles.dropMsg}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="36" height="36">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <path d="m21 15-5-5L5 21" />
                            </svg>
                            <span>Drop to open</span>
                        </div>
                    </div>
                )}
            </main>

            {/* ── Right panel ── */}
            <aside className={styles.panel} onDragOver={e => e.preventDefault()} onDrop={handlePanelDrop}>
                <div className={styles.panelHeader}>
                    <span className={styles.panelTitle}>Images</span>
                    {imageLibrary.length > 0 && <span className={styles.panelCount}>{imageLibrary.length}</span>}
                </div>

                <button className={styles.addBtn} onClick={() => fileInputRef.current.click()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add images
                </button>
                {/* Fix #3: accept tiff; value reset after selection so re-add works */}
                <input ref={fileInputRef} type="file" accept="image/*,.tif,.tiff" multiple
                    onChange={e => loadFiles(e.target.files)} className={styles.hidden} />

                <div className={styles.panelList}>
                    {imageLibrary.length === 0 ? (
                        <div className={styles.panelEmpty}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" width="30" height="30">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            <p>Drop images here<br />or click Add<br />.tif/.tiff supported</p>
                        </div>
                    ) : (
                        imageLibrary.map(item => (
                            <ImageCard key={item.id}
                                item={{ ...item, annotationCount: visibleAnnCount(item.id) }}
                                isActive={activeImageId === item.id}
                                onSelect={() => activateImage(item)}
                                onDragStart={e => handlePanelDragStart(e, item.id)}
                                onRemove={() => removeImage(item.id)}
                            />
                        ))
                    )}
                </div>

                {activeImage && (
                    <div className={styles.panelFooter}>
                        <div className={styles.footerRow}><span className={styles.footerLabel}>File</span><span className={styles.footerVal} title={activeImage.name}>{activeImage.name}</span></div>
                        <div className={styles.footerRow}><span className={styles.footerLabel}>Annotations</span><span className={styles.footerVal}>{visibleAnnCount(activeImageId)}</span></div>
                        <div className={styles.footerRow}><span className={styles.footerLabel}>Resolution</span><span className={styles.footerVal}>{activeImage.naturalW}×{activeImage.naturalH}</span></div>
                        <div className={styles.footerRow}><span className={styles.footerLabel}>Zoom</span><span className={styles.footerVal}>{Math.round(scale * 100)}%</span></div>
                    </div>
                )}
            </aside>
        </div>
    );
});

ImageAnnotator.displayName = "ImageAnnotator";
export default ImageAnnotator;