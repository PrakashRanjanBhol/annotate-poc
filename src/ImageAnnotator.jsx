/**
 * ImageAnnotator.jsx — clean rewrite
 *
 * Eraser approach: All annotations (including eraser strokes) are flattened
 * onto a single offscreen <canvas> using Canvas 2D compositing.
 * Eraser strokes use "destination-out" which correctly removes pixels from
 * whatever was drawn before them on the SAME canvas context.
 * The flattened canvas bitmap is then displayed as a Konva Image.
 *
 * This is the only approach that gives true pixel-accurate partial erasing
 * within the Konva/React environment.
 */

import React, {
    useState, useRef, useEffect, useCallback,
    useImperativeHandle, forwardRef, useMemo,
} from "react";
import {
    Stage, Layer, Image as KonvaImage,
    Rect, Circle, Line, Transformer,
} from "react-konva";
import styles from "./ImageAnnotator.module.css";

/* ─── Module-level stores ────────────────────────────── */
const IMG_STORE = new Map();   // id → HTMLImageElement (never GC'd)

/* ─── Tools ──────────────────────────────────────────── */
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

const makeFileKey = (file) =>
    `${file.webkitRelativePath || file.name}__${file.size}__${file.lastModified}`;

/* ─── Draw all annotations onto a 2D canvas context ─────
 * This is the single source of truth for what the canvas shows.
 * Eraser strokes use "destination-out" on the same context, so they
 * correctly erase only pixels within their path — nothing more.
 */
/* ─── FlatCanvas: image-safe erasing via two offscreen canvases ─────
 *
 * Canvas A (annCanvas)  — transparent background, annotations only.
 *                         Eraser strokes use destination-out HERE,
 *                         so they remove annotation pixels only.
 * Canvas B (outCanvas)  — final composite:
 *                         1. draw base image
 *                         2. draw annCanvas on top (source-over)
 *
 * The base image is never touched by the eraser.
 */
const FlatCanvas = React.memo(({ imgId, displayW, displayH, annotations, liveEraserStroke }) => {
    const annCanvasRef = useRef(null);   // annotation layer (transparent bg)
    const outCanvasRef = useRef(null);   // final composited output
    const [imageBitmap, setImageBitmap] = useState(null);

    // Create / resize both canvases when display size changes
    useEffect(() => {
        if (!annCanvasRef.current) annCanvasRef.current = document.createElement("canvas");
        if (!outCanvasRef.current) outCanvasRef.current = document.createElement("canvas");
        annCanvasRef.current.width = displayW;
        annCanvasRef.current.height = displayH;
        outCanvasRef.current.width = displayW;
        outCanvasRef.current.height = displayH;
    }, [displayW, displayH]);

    // Redraw whenever image, annotations, or live eraser stroke changes
    useEffect(() => {
        const htmlImg = IMG_STORE.get(imgId);
        if (!htmlImg || !annCanvasRef.current || !outCanvasRef.current) return;

        // ── Step 1: draw annotations onto transparent canvas ──────────────
        const annCtx = annCanvasRef.current.getContext("2d");
        annCtx.clearRect(0, 0, displayW, displayH);          // fully transparent

        // Combine committed annotations + the live eraser stroke (if any)
        const allStrokes = liveEraserStroke
            ? [...annotations, liveEraserStroke]
            : annotations;

        for (const ann of allStrokes) {
            // Guard against null/undefined entries from async state batching
            if (!ann || !ann.type) continue;

            annCtx.save();
            const ox = ann.x ?? 0;
            const oy = ann.y ?? 0;

            if (ann.type === "eraser") {
                // destination-out removes pixels from annCanvas only — image is safe
                annCtx.globalCompositeOperation = "destination-out";
                annCtx.strokeStyle = "rgba(0,0,0,1)";
                annCtx.lineWidth = ann.size * 2;
                annCtx.lineCap = "square";
                annCtx.lineJoin = "miter";
                const pts = ann.points;
                if (pts && pts.length >= 2) {
                    annCtx.beginPath();
                    annCtx.moveTo(pts[0], pts[1]);
                    for (let i = 2; i < pts.length; i += 2) annCtx.lineTo(pts[i], pts[i + 1]);
                    annCtx.stroke();
                    if (pts.length === 2) {
                        // single click — fill a square so a static click also erases
                        annCtx.fillStyle = "rgba(0,0,0,1)";
                        annCtx.fillRect(pts[0] - ann.size, pts[1] - ann.size, ann.size * 2, ann.size * 2);
                    }
                }
                annCtx.restore();
                continue;
            }

            // All other annotations: source-over on the annotation canvas
            annCtx.globalCompositeOperation = "source-over";
            annCtx.strokeStyle = ann.stroke || "#ef4444";
            annCtx.lineWidth = ann.strokeWidth || 3;
            const hasFill = ann.fill && ann.fill !== "transparent";
            if (hasFill) annCtx.fillStyle = ann.fill;

            // Rotation / scale transform
            if (ann.rotation || (ann.scaleX !== undefined && ann.scaleX !== 1) || (ann.scaleY !== undefined && ann.scaleY !== 1)) {
                const cx = (ann.x ?? 0) + (ann.width ?? ann.radius ?? 0) / 2;
                const cy = (ann.y ?? 0) + (ann.height ?? ann.radius ?? 0) / 2;
                annCtx.translate(cx, cy);
                annCtx.rotate(((ann.rotation ?? 0) * Math.PI) / 180);
                annCtx.scale(ann.scaleX ?? 1, ann.scaleY ?? 1);
                annCtx.translate(-cx, -cy);
            }

            if (ann.type === "rect") {
                annCtx.beginPath();
                annCtx.rect(ann.x ?? 0, ann.y ?? 0, ann.width, ann.height);
                if (hasFill) annCtx.fill();
                annCtx.stroke();
            } else if (ann.type === "circle") {
                annCtx.beginPath();
                annCtx.arc(ann.x ?? 0, ann.y ?? 0, ann.radius, 0, Math.PI * 2);
                if (hasFill) annCtx.fill();
                annCtx.stroke();
            } else if (ann.type === "line") {
                const pts = ann.points;
                if (pts && pts.length >= 4) {
                    annCtx.beginPath(); annCtx.lineCap = "round";
                    annCtx.moveTo(pts[0] + ox, pts[1] + oy);
                    annCtx.lineTo(pts[2] + ox, pts[3] + oy);
                    annCtx.stroke();
                }
            } else if (ann.type === "brush") {
                const pts = ann.points;
                if (pts && pts.length >= 2) {
                    annCtx.beginPath(); annCtx.lineCap = "round"; annCtx.lineJoin = "round";
                    annCtx.moveTo(pts[0] + ox, pts[1] + oy);
                    for (let i = 2; i < pts.length; i += 2) annCtx.lineTo(pts[i] + ox, pts[i + 1] + oy);
                    annCtx.stroke();
                }
            } else if (ann.type === "polygon") {
                const pts = ann.points;
                if (pts && pts.length >= 4) {
                    annCtx.beginPath();
                    annCtx.moveTo(pts[0] + ox, pts[1] + oy);
                    for (let i = 2; i < pts.length; i += 2) annCtx.lineTo(pts[i] + ox, pts[i + 1] + oy);
                    if (ann.closed) annCtx.closePath();
                    if (hasFill) annCtx.fill();
                    annCtx.stroke();
                }
            }

            annCtx.restore();
        }

        // ── Step 2: composite image + annotation canvas → output canvas ───
        const outCtx = outCanvasRef.current.getContext("2d");
        outCtx.clearRect(0, 0, displayW, displayH);
        outCtx.drawImage(htmlImg, 0, 0, displayW, displayH);               // base image (never erased)
        outCtx.drawImage(annCanvasRef.current, 0, 0, displayW, displayH);  // annotations on top

        // ── Step 3: hand the finished bitmap to Konva ──────────────────────
        createImageBitmap(outCanvasRef.current).then(setImageBitmap);
    }, [imgId, displayW, displayH, annotations, liveEraserStroke]);

    if (!imageBitmap) return null;

    return (
        <KonvaImage
            image={imageBitmap}
            x={0} y={0}
            width={displayW} height={displayH}
            listening={false}
        />
    );
});

/* ─── Overlay: interactive shapes during drawing (not yet committed) ─ */
const DrawingOverlay = ({ currentShape, polyPoints, strokeColor, strokeWidth }) => {
    // key must NOT be in the spread object — pass it directly to each element
    const p = currentShape ? {
        stroke: currentShape.stroke,
        strokeWidth: currentShape.strokeWidth,
        strokeScaleEnabled: false,
        fill: currentShape.fill ?? "transparent",
        listening: false,
    } : null;

    return (
        <>
            {currentShape && p && (() => {
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
            {polyPoints.length >= 2 && (
                <Line
                    points={polyPoints}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeScaleEnabled={false}
                    fill="transparent"
                    listening={false}
                />
            )}
        </>
    );
};

/* ─── ImageCard ──────────────────────────────────────── */
const ImageCard = ({ item, isActive, onSelect, onDragStart, onRemove }) => (
    <div
        className={`${styles.imageCard} ${isActive ? styles.imageCardActive : ""}`}
        onClick={onSelect} draggable onDragStart={onDragStart}
        title={`${item.path} — drag to canvas`}
    >
        <span className={styles.cardSerial}>{item.serial}</span>
        <div className={styles.cardThumbWrap}>
            <img src={item.thumbSrc} alt={item.name} className={styles.cardThumb} draggable={false} />
            {item.annotationCount > 0 && (
                <span className={styles.cardBadge}>{item.annotationCount}</span>
            )}
        </div>
        <div className={styles.cardInfo}>
            <span className={styles.cardName}>{item.name}</span>
            <span className={styles.cardPath} title={item.path}>{item.path}</span>
        </div>
        <button className={styles.cardRemove}
            onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove">×</button>
    </div>
);

/* ─── TIFF decoder ───────────────────────────────────── */
function decodeImageFile(file) {
    return new Promise((resolve, reject) => {
        const isTiff = /\.tiff?$/i.test(file.name) || file.type === "image/tiff";
        const reader = new FileReader();
        if (isTiff) {
            reader.onload = (ev) => {
                try {
                    if (typeof window.Tiff !== "undefined") {
                        const tiff = new window.Tiff({ buffer: ev.target.result });
                        const dataUrl = tiff.toCanvas().toDataURL("image/png");
                        const img = new window.Image();
                        img.onload = () => resolve(img);
                        img.onerror = reject;
                        img.src = dataUrl;
                    } else {
                        const img = new window.Image();
                        img.onload = () => resolve(img);
                        img.onerror = reject;
                        img.src = URL.createObjectURL(file);
                    }
                } catch (err) { reject(err); }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        } else {
            reader.onload = (ev) => {
                const img = new window.Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = ev.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        }
    });
}

function decodeBase64Image(base64, mimeType = "image/png") {
    return new Promise((resolve, reject) => {
        const prefix = base64.startsWith("data:") ? base64 : `data:${mimeType};base64,${base64}`;
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = prefix;
    });
}

/* ─── Main component ─────────────────────────────────── */
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
    const [eraserSize, setEraserSize] = useState(20);  // independent eraser size in px
    const [canvasDragOver, setCanvasDragOver] = useState(false);
    const [eraserPos, setEraserPos] = useState(null);
    const [liveEraserStroke, setLiveEraserStroke] = useState(null); // eraser stroke being drawn
    const [stageDims, setStageDims] = useState({ w: 800, h: 600 });

    const primaryDownRef = useRef(false);
    const eraserStrokeRef = useRef(null);  // live eraser stroke being drawn
    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const serialRef = useRef(0);
    const fileKeysRef = useRef(new Set());

    /* ── Derived ── */
    const activeImage = imageLibrary.find((i) => i.id === activeImageId) ?? null;
    const emptyState = { annotations: [], history: [[]], historyStep: 0 };
    const activeState = activeImageId ? (imageStates[activeImageId] ?? emptyState) : emptyState;
    const { annotations, history, historyStep } = activeState;

    // Annotation count excludes eraser strokes (they're not user annotations)
    const visibleAnnCount = (id) =>
        (imageStates[id]?.annotations ?? []).filter(a => a != null && a.type !== "eraser").length;

    /* ── History ── */
    const pushHistory = useCallback((newAnns) => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            const newHist = cur.history.slice(0, cur.historyStep + 1).concat([newAnns]);
            return { ...prev, [activeImageId]: { annotations: newAnns, history: newHist, historyStep: newHist.length - 1 } };
        });
    }, [activeImageId]);

    const undo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep === 0) return prev;
            const step = cur.historyStep - 1;
            return { ...prev, [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step } };
        });
        setSelectedId(null);
    }, [activeImageId]);

    const redo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep >= cur.history.length - 1) return prev;
            const step = cur.historyStep + 1;
            return { ...prev, [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step } };
        });
    }, [activeImageId]);

    /* ── Transformer sync ── */
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

    /* ── TransformEnd ── */
    const handleTransformEnd = useCallback((ann) => {
        const node = stageRef.current?.findOne(`#${ann.id}`);
        if (!node) return;
        const sx = node.scaleX(), sy = node.scaleY();
        let patch = { x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: 1, scaleY: 1 };
        if (ann.type === "rect") patch = { ...patch, width: Math.abs(ann.width * sx), height: Math.abs(ann.height * sy) };
        if (ann.type === "circle") patch = { ...patch, radius: Math.abs(ann.radius * sx) };
        node.scaleX(1); node.scaleY(1);
        pushHistory(annotations.map((a) => a.id === ann.id ? { ...a, ...patch } : a));
    }, [annotations, pushHistory]);

    /* ── Register image ── */
    const registerImage = useCallback((htmlImg, name, path, fileKey) => {
        return new Promise((resolve) => {
            serialRef.current += 1;
            const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            // Thumbnail
            const tc = document.createElement("canvas");
            tc.width = 80; tc.height = 60;
            const tctx = tc.getContext("2d");
            const r = Math.min(80 / htmlImg.naturalWidth, 60 / htmlImg.naturalHeight);
            const tw = htmlImg.naturalWidth * r, th = htmlImg.naturalHeight * r;
            tctx.drawImage(htmlImg, (80 - tw) / 2, (60 - th) / 2, tw, th);
            const thumbSrc = tc.toDataURL("image/jpeg", 0.7);
            IMG_STORE.set(id, htmlImg);
            const entry = {
                id, serial: serialRef.current, name, path, thumbSrc,
                naturalW: htmlImg.naturalWidth, naturalH: htmlImg.naturalHeight, fileKey
            };
            setImageLibrary((prev) => [...prev, entry]);
            setImageStates((prev) => ({ ...prev, [id]: { annotations: [], history: [[]], historyStep: 0 } }));
            resolve(entry);
        });
    }, []);

    const loadFiles = useCallback(async (files) => {
        const sorted = Array.from(files)
            .filter((f) => f.type.startsWith("image/") || /\.tiff?$/i.test(f.name))
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

    const addImageFromBase64 = useCallback(async (base64, mimeType = "image/png", name = "api-image.png") => {
        try {
            const htmlImg = await decodeBase64Image(base64, mimeType);
            const fk = `base64__${name}__${base64.slice(-32)}`;
            if (fileKeysRef.current.has(fk)) return null;
            fileKeysRef.current.add(fk);
            return await registerImage(htmlImg, name, name, fk);
        } catch (err) { console.error("addImageFromBase64:", err); return null; }
    }, [registerImage]);

    useImperativeHandle(ref, () => ({ addImageFromBase64 }), [addImageFromBase64]);

    const activateImage = useCallback((item) => {
        const el = canvasRef.current;
        const cw = el ? el.clientWidth : window.innerWidth - 450;
        const ch = el ? el.clientHeight : window.innerHeight - 40;
        const ratio = Math.min(cw / item.naturalW, ch / item.naturalH, 1);
        setDisplaySize({ w: Math.round(item.naturalW * ratio), h: Math.round(item.naturalH * ratio) });
        setActiveImageId(item.id);
        setSelectedId(null);
        setPolyPoints([]);
        setScale(1);
        setStagePos({ x: 0, y: 0 });
        setDrawing(false);
        setCurrentShape(null);
        eraserStrokeRef.current = null;
        setLiveEraserStroke(null);
    }, []);

    const removeImage = useCallback((id) => {
        const item = imageLibrary.find((i) => i.id === id);
        if (item) fileKeysRef.current.delete(item.fileKey);
        IMG_STORE.delete(id);
        setImageLibrary((prev) => prev.filter((i) => i.id !== id));
        setImageStates((prev) => { const n = { ...prev }; delete n[id]; return n; });
        if (activeImageId === id) setActiveImageId(null);
    }, [imageLibrary, activeImageId]);

    /* ── Panel drag ── */
    const handlePanelDragStart = (e, id) => {
        e.dataTransfer.setData("application/x-imageid", id);
        e.dataTransfer.effectAllowed = "copy";
    };
    const handleCanvasDragOver = (e) => { e.preventDefault(); setCanvasDragOver(true); };
    const handleCanvasDragLeave = () => setCanvasDragOver(false);
    const handleCanvasDrop = (e) => {
        e.preventDefault(); setCanvasDragOver(false);
        const id = e.dataTransfer.getData("application/x-imageid");
        const item = imageLibrary.find((i) => i.id === id);
        if (item) activateImage(item);
        else if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    };
    const handlePanelDrop = (e) => { e.preventDefault(); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); };

    /* ── Image-space pointer position ── */
    const getImagePos = useCallback(() => {
        const stage = stageRef.current;
        if (!stage) return { x: 0, y: 0 };
        const ptr = stage.getPointerPosition();
        return {
            x: (ptr.x - stage.x()) / scale,
            y: (ptr.y - stage.y()) / scale,
        };
    }, [scale]);

    /* ── Mouse handlers ── */
    const handleMouseDown = useCallback((e) => {
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
            const size = eraserSize / scale;  // half-side in image-space
            const stroke = { id: nextId(), type: "eraser", points: [pos.x, pos.y], size };
            eraserStrokeRef.current = stroke;
            setLiveEraserStroke(stroke);  // shown via FlatCanvas, NOT pushed to annotations yet
            return;
        }

        const pos = getImagePos();
        if (tool === TOOLS.RECT) setCurrentShape({ id: nextId(), type: "rect", x: pos.x, y: pos.y, width: 0, height: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.CIRCLE) setCurrentShape({ id: nextId(), type: "circle", x: pos.x, y: pos.y, radius: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.LINE) setCurrentShape({ id: nextId(), type: "line", points: [pos.x, pos.y, pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
        else if (tool === TOOLS.BRUSH) setCurrentShape({ id: nextId(), type: "brush", points: [pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
    }, [activeImage, tool, strokeColor, strokeWidth, fillColor, scale, eraserSize, activeImageId, getImagePos]);

    const handleMouseMove = useCallback(() => {
        if (tool === TOOLS.ERASER) {
            const pos = getImagePos();
            setEraserPos(pos);

            if (drawing && eraserStrokeRef.current) {
                // Append point to ref (synchronous, no batching issues)
                const updated = {
                    ...eraserStrokeRef.current,
                    points: [...eraserStrokeRef.current.points, pos.x, pos.y],
                };
                eraserStrokeRef.current = updated;
                // Update the live stroke state — FlatCanvas receives this as a prop
                // and renders it without touching the annotations array at all
                setLiveEraserStroke({ ...updated });
            }
            return;
        }

        if (!drawing || !currentShape) return;
        const pos = getImagePos();

        if (tool === TOOLS.RECT) setCurrentShape((s) => ({ ...s, width: pos.x - s.x, height: pos.y - s.y }));
        else if (tool === TOOLS.CIRCLE) {
            const dx = pos.x - currentShape.x, dy = pos.y - currentShape.y;
            setCurrentShape((s) => ({ ...s, radius: Math.sqrt(dx * dx + dy * dy) }));
        }
        else if (tool === TOOLS.LINE) setCurrentShape((s) => ({ ...s, points: [s.points[0], s.points[1], pos.x, pos.y] }));
        else if (tool === TOOLS.BRUSH) setCurrentShape((s) => ({ ...s, points: [...s.points, pos.x, pos.y] }));
    }, [drawing, tool, currentShape, activeImageId, getImagePos]);

    const handleMouseUp = useCallback(() => {
        if (!drawing) return;
        setDrawing(false);

        if (tool === TOOLS.ERASER) {
            const finishedStroke = eraserStrokeRef.current;
            eraserStrokeRef.current = null;
            setLiveEraserStroke(null);  // remove live preview
            if (finishedStroke) {
                // Atomically commit the completed eraser stroke to annotations + history
                setImageStates((prev) => {
                    const cur = prev[activeImageId] ?? emptyState;
                    const newAnns = [...cur.annotations, finishedStroke];
                    const newHist = cur.history.slice(0, cur.historyStep + 1).concat([newAnns]);
                    return { ...prev, [activeImageId]: { annotations: newAnns, history: newHist, historyStep: newHist.length - 1 } };
                });
            }
            return;
        }

        if (!currentShape) return;

        // Discard zero-size shapes from plain clicks
        const MIN = 3;
        if (currentShape.type === "rect" && (Math.abs(currentShape.width) < MIN || Math.abs(currentShape.height) < MIN)) { setCurrentShape(null); return; }
        if (currentShape.type === "circle" && currentShape.radius < MIN) { setCurrentShape(null); return; }
        if (currentShape.type === "brush") {
            const pts = currentShape.points;
            if (pts.length < 4 || Math.hypot(pts[pts.length - 2] - pts[0], pts[pts.length - 1] - pts[1]) < MIN) { setCurrentShape(null); return; }
        }
        if (currentShape.type === "line") {
            const pts = currentShape.points;
            if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < MIN) { setCurrentShape(null); return; }
        }

        pushHistory([...annotations, currentShape]);
        setCurrentShape(null);
    }, [drawing, tool, currentShape, annotations, activeImageId, pushHistory]);

    const handleStageClick = useCallback((e) => {
        if (!primaryDownRef.current) return;
        if (tool !== TOOLS.POLYGON) return;
        const pos = getImagePos();
        if (e.evt.detail === 2) {
            if (polyPoints.length >= 6)
                pushHistory([...annotations, {
                    id: nextId(), type: "polygon", points: [...polyPoints],
                    stroke: strokeColor, strokeWidth, fill: fillColor, closed: true, x: 0, y: 0
                }]);
            setPolyPoints([]);
        } else {
            setPolyPoints((pts) => [...pts, pos.x, pos.y]);
        }
    }, [tool, polyPoints, annotations, strokeColor, strokeWidth, fillColor, pushHistory, getImagePos]);

    const deleteSelected = useCallback(() => {
        if (!selectedId) return;
        pushHistory(annotations.filter((a) => a.id !== selectedId));
        setSelectedId(null);
    }, [selectedId, annotations, pushHistory]);

    useEffect(() => {
        const onKey = (e) => {
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
        const el = canvasRef.current;
        if (!el) return;
        const onWheel = (e) => {
            e.preventDefault();
            if (!stageRef.current || !activeImage) return;
            const dir = e.deltaY < 0 ? 1 : -1;
            const oldScale = scale;
            const newScale = Math.min(10, Math.max(0.05, dir > 0 ? oldScale * 1.08 : oldScale / 1.08));
            const cw = el.clientWidth, ch = el.clientHeight;
            const imgW = displaySize.w * newScale, imgH = displaySize.h * newScale;
            let nx, ny;
            if (imgW <= cw && imgH <= ch) {
                nx = (cw - imgW) / 2; ny = (ch - imgH) / 2;
            } else {
                const ptr = stageRef.current.getPointerPosition() ?? { x: cw / 2, y: ch / 2 };
                const ix = (ptr.x - stagePos.x) / oldScale;
                const iy = (ptr.y - stagePos.y) / oldScale;
                nx = Math.max(Math.min(0, cw - imgW), Math.min(0, ptr.x - ix * newScale));
                ny = Math.max(Math.min(0, ch - imgH), Math.min(0, ptr.y - iy * newScale));
            }
            setScale(newScale);
            setStagePos({ x: nx, y: ny });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scale, stagePos, displaySize, activeImage]);

    const handleZoomBtn = (delta) => {
        const el = canvasRef.current;
        const ns = Math.min(10, Math.max(0.05, scale + delta));
        const cw = el?.clientWidth ?? 800, ch = el?.clientHeight ?? 600;
        const imgW = displaySize.w * ns, imgH = displaySize.h * ns;
        setScale(ns);
        setStagePos({
            x: imgW <= cw ? (cw - imgW) / 2 : Math.max(cw - imgW, Math.min(0, stagePos.x)),
            y: imgH <= ch ? (ch - imgH) / 2 : Math.max(ch - imgH, Math.min(0, stagePos.y)),
        });
    };

    /* ── ResizeObserver for stage dims ── */
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setStageDims({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        setStageDims({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);

    /* ── Render interactive select handles (transparent rects for hit area) ── */
    // Non-eraser annotations need Konva nodes for transformer/drag
    const interactiveAnns = annotations.filter(a => a != null && a.type !== "eraser");

    const renderSelectHandle = (ann) => {
        // Invisible hit-area rect/circle/line for select tool only
        if (tool !== TOOLS.SELECT) return null;
        const common = {
            id: ann.id, key: ann.id,
            opacity: 0,  // completely invisible — FlatCanvas draws the visual
            draggable: true,
            onClick: (e) => { if (e.evt.button !== 0) return; setSelectedId(ann.id); },
            onTap: () => setSelectedId(ann.id),
            onDragEnd: (e) => {
                const nx = e.target.x(), ny = e.target.y();
                pushHistory(annotations.map((a) => a.id === ann.id ? { ...a, x: nx, y: ny } : a));
            },
            onTransformEnd: () => handleTransformEnd(ann),
        };
        // Use a covering rect as hit target for all shape types
        let x, y, w, h;
        if (ann.type === "rect") {
            x = Math.min(ann.x, ann.x + ann.width);
            y = Math.min(ann.y, ann.y + ann.height);
            w = Math.abs(ann.width); h = Math.abs(ann.height);
        } else if (ann.type === "circle") {
            x = (ann.x ?? 0) - ann.radius; y = (ann.y ?? 0) - ann.radius;
            w = ann.radius * 2; h = ann.radius * 2;
        } else if (ann.type === "line" || ann.type === "brush" || ann.type === "polygon") {
            const pts = ann.points;
            const ox = ann.x ?? 0, oy = ann.y ?? 0;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < pts.length; i += 2) {
                minX = Math.min(minX, pts[i] + ox); maxX = Math.max(maxX, pts[i] + ox);
                minY = Math.min(minY, pts[i + 1] + oy); maxY = Math.max(maxY, pts[i + 1] + oy);
            }
            x = minX; y = minY; w = maxX - minX || 4; h = maxY - minY || 4;
        } else return null;

        return (
            <Rect
                {...common}
                x={x} y={y} width={w} height={h}
                fill="transparent" stroke="transparent"
                rotation={ann.rotation ?? 0}
                scaleX={ann.scaleX ?? 1} scaleY={ann.scaleY ?? 1}
            />
        );
    };

    const getCursor = () => {
        if (tool === TOOLS.ERASER) return "none";
        if (tool === TOOLS.SELECT) return "default";
        return "crosshair";
    };

    return (
        <div className={styles.root}>
            <script src="https://cdn.jsdelivr.net/npm/tiff.js@1.0.0/tiff.min.js" />

            {/* ── Left toolbar ── */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarTop}>
                    <div className={styles.logoMark}>IA</div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Tools</span>
                        {Object.values(TOOLS).map((t) => (
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
                            {STROKE_COLORS.map((c) => (
                                <button key={c}
                                    className={`${styles.colorDot} ${strokeColor === c ? styles.colorActive : ""}`}
                                    style={{ "--dot-color": c }} onClick={() => setStrokeColor(c)} />
                            ))}
                        </div>
                    </div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Fill color</span>
                        <div className={styles.colorGrid}>
                            {FILL_COLORS.map((c) => (
                                <button key={c}
                                    className={`${styles.colorDot} ${fillColor === c ? styles.colorActive : ""} ${c === "transparent" ? styles.colorTransparent : ""}`}
                                    style={{ "--dot-color": c === "transparent" ? "#2a2a30" : c }}
                                    onClick={() => setFillColor(c)}
                                    title={c === "transparent" ? "No fill" : c}
                                />
                            ))}
                        </div>
                    </div>

                    {tool !== TOOLS.ERASER && (
                        <div className={styles.toolGroup}>
                            <span className={styles.groupLabel}>Stroke — {strokeWidth}px</span>
                            <input type="range" min="1" max="20" value={strokeWidth}
                                onChange={(e) => setStrokeWidth(Number(e.target.value))} className={styles.slider} />
                        </div>
                    )}

                    {tool === TOOLS.ERASER && (
                        <div className={styles.toolGroup}>
                            <span className={styles.groupLabel}>Eraser size — {eraserSize}px</span>
                            <input type="range" min="4" max="120" value={eraserSize}
                                onChange={(e) => setEraserSize(Number(e.target.value))} className={styles.slider} />
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
                            tool === TOOLS.ERASER ? "Drag to erase · Stroke size = eraser size" :
                                "Del · Ctrl+Z · Ctrl+Y · Scroll to zoom"}
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
                            {/* FlatCanvas composites image + all annotations (incl eraser) into one bitmap */}
                            <FlatCanvas
                                imgId={activeImageId}
                                displayW={displaySize.w}
                                displayH={displaySize.h}
                                annotations={annotations}
                                liveEraserStroke={liveEraserStroke}
                            />

                            {/* Invisible hit-area handles for select/transform (only in SELECT mode) */}
                            {tool === TOOLS.SELECT && interactiveAnns.map(renderSelectHandle)}

                            {/* In-progress shape preview (not yet committed) */}
                            <DrawingOverlay
                                currentShape={currentShape}
                                polyPoints={polyPoints}
                                strokeColor={strokeColor}
                                strokeWidth={strokeWidth}
                            />

                            <Transformer
                                ref={transformerRef}
                                keepRatio={false}
                                boundBoxFunc={(o, n) => (n.width < 5 || n.height < 5 ? o : n)}
                            />

                            {/* Eraser square cursor */}
                            {tool === TOOLS.ERASER && eraserPos && (
                                <Rect
                                    x={eraserPos.x - eraserSize / scale}
                                    y={eraserPos.y - eraserSize / scale}
                                    width={eraserSize / scale * 2}
                                    height={eraserSize / scale * 2}
                                    stroke="rgba(255,255,255,0.95)"
                                    strokeWidth={1 / scale}
                                    strokeScaleEnabled={false}
                                    fill="rgba(255,255,255,0.07)"
                                    dash={[4 / scale, 3 / scale]}
                                    listening={false}
                                    perfectDrawEnabled={false}
                                />
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
            <aside className={styles.panel} onDragOver={(e) => e.preventDefault()} onDrop={handlePanelDrop}>
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
                <input ref={fileInputRef} type="file" accept="image/*,.tif,.tiff" multiple
                    onChange={(e) => loadFiles(e.target.files)} className={styles.hidden} />

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
                        imageLibrary.map((item) => (
                            <ImageCard
                                key={item.id}
                                item={{ ...item, annotationCount: visibleAnnCount(item.id) }}
                                isActive={activeImageId === item.id}
                                onSelect={() => activateImage(item)}
                                onDragStart={(e) => handlePanelDragStart(e, item.id)}
                                onRemove={() => removeImage(item.id)}
                            />
                        ))
                    )}
                </div>

                {activeImage && (
                    <div className={styles.panelFooter}>
                        <div className={styles.footerRow}>
                            <span className={styles.footerLabel}>File</span>
                            <span className={styles.footerVal} title={activeImage.name}>{activeImage.name}</span>
                        </div>
                        <div className={styles.footerRow}>
                            <span className={styles.footerLabel}>Annotations</span>
                            <span className={styles.footerVal}>{visibleAnnCount(activeImageId)}</span>
                        </div>
                        <div className={styles.footerRow}>
                            <span className={styles.footerLabel}>Resolution</span>
                            <span className={styles.footerVal}>{activeImage.naturalW}×{activeImage.naturalH}</span>
                        </div>
                        <div className={styles.footerRow}>
                            <span className={styles.footerLabel}>Zoom</span>
                            <span className={styles.footerVal}>{Math.round(scale * 100)}%</span>
                        </div>
                    </div>
                )}
            </aside>
        </div>
    );
});

ImageAnnotator.displayName = "ImageAnnotator";
export default ImageAnnotator;