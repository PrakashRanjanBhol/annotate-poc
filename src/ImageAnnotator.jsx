import React, { useState, useRef, useEffect, useCallback } from "react";
import {
    Stage, Layer, Image as KonvaImage,
    Rect, Circle, Line, Transformer,
} from "react-konva";
import useImage from "use-image";
import styles from "./ImageAnnotator.module.css";

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
const FILL_COLORS = ["transparent", "#ef444455", "#f9731655", "#eab30855", "#22c55e55", "#3b82f655", "#a855f755", "#ec4899554"];

let annCounter = 0;
const nextId = () => `ann-${++annCounter}`;

/* ─── helpers ────────────────────────────────────────── */

// Compute file hash (name + size + lastModified) for duplicate detection
const fileKey = (file) => `${file.name}__${file.size}__${file.lastModified}`;

/* ─── CanvasImage ────────────────────────────────────── */
// Use a stable HTMLImageElement to avoid reload on re-render
const CanvasImage = React.memo(({ htmlImg }) => {
    return <KonvaImage image={htmlImg} x={0} y={0} listening={false} />;
});

/* ─── ImageCard ──────────────────────────────────────── */
const ImageCard = ({ item, isActive, onSelect, onDragStart, onRemove }) => (
    <div
        className={`${styles.imageCard} ${isActive ? styles.imageCardActive : ""}`}
        onClick={onSelect}
        draggable
        onDragStart={onDragStart}
        title={`${item.path} — drag to canvas`}
    >
        <span className={styles.cardSerial}>{item.serial}</span>
        <div className={styles.cardThumbWrap}>
            <img src={item.src} alt={item.name} className={styles.cardThumb} draggable={false} />
            {item.annotationCount > 0 && (
                <span className={styles.cardBadge}>{item.annotationCount}</span>
            )}
        </div>
        <div className={styles.cardInfo}>
            <span className={styles.cardName}>{item.name}</span>
            <span className={styles.cardPath} title={item.path}>{item.path}</span>
        </div>
        <button className={styles.cardRemove} onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove">×</button>
    </div>
);

/* ─── Main ───────────────────────────────────────────── */
export default function ImageAnnotator() {
    // FIX #4: store HTMLImageElement in library so blob URL is never GC'd
    // FIX #1/#13: store fileKey for duplicate detection
    // FIX #3: images appended in order via serial
    const [imageLibrary, setImageLibrary] = useState([]);   // [{id,serial,name,path,src,htmlImg,naturalW,naturalH,fileKey}]
    const [imageStates, setImageStates] = useState({});   // {[id]: {annotations,history,historyStep}}
    const [activeImageId, setActiveImageId] = useState(null);
    const [imageSize, setImageSize] = useState({ width: 800, height: 500 });

    const [tool, setTool] = useState(TOOLS.SELECT);
    const [selectedId, setSelectedId] = useState(null);
    const [drawing, setDrawing] = useState(false);
    const [currentShape, setCurrentShape] = useState(null);
    const [polyPoints, setPolyPoints] = useState([]);
    // FIX #8: store stagePos for origin-aware zooming
    const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
    const [scale, setScale] = useState(1);
    const [strokeColor, setStrokeColor] = useState("#ef4444");
    const [fillColor, setFillColor] = useState("transparent");
    const [strokeWidth, setStrokeWidth] = useState(3);
    const [canvasDragOver, setCanvasDragOver] = useState(false);

    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);
    const serialRef = useRef(0);
    const fileKeysRef = useRef(new Set()); // FIX #1/#13

    /* ── Derived ── */
    const activeImage = imageLibrary.find((i) => i.id === activeImageId) ?? null;
    const emptyState = { annotations: [], history: [[]], historyStep: 0 };
    const activeState = activeImageId ? (imageStates[activeImageId] ?? emptyState) : emptyState;
    const { annotations, history, historyStep } = activeState;

    /* ── Per-image history ── */
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

    /* ── FIX #9: save transform (rotation, scale) on transformer change ── */
    const handleTransformEnd = useCallback((ann) => {
        if (!stageRef.current) return;
        const node = stageRef.current.findOne(`#${ann.id}`);
        if (!node) return;
        const newAttrs = {
            x: node.x(), y: node.y(),
            rotation: node.rotation(),
            scaleX: node.scaleX(), scaleY: node.scaleY(),
        };
        // FIX #10: for rect/circle keep strokeWidth independent of scale
        // We bake the visual scale into dimensions and reset scaleX/Y to 1
        let extra = {};
        if (ann.type === "rect") {
            extra = {
                width: Math.abs(ann.width * newAttrs.scaleX),
                height: Math.abs(ann.height * newAttrs.scaleY),
                scaleX: 1, scaleY: 1,
            };
        } else if (ann.type === "circle") {
            extra = {
                radius: Math.abs(ann.radius * newAttrs.scaleX),
                scaleX: 1, scaleY: 1,
            };
        }
        const updated = annotations.map((a) =>
            a.id === ann.id ? { ...a, ...newAttrs, ...extra } : a
        );
        pushHistory(updated);
        // Reset node scale after baking
        if (extra.scaleX !== undefined) { node.scaleX(1); node.scaleY(1); }
    }, [annotations, pushHistory]);

    /* ── FIX #4: Load files — keep HTMLImageElement reference alive ── */
    const loadFiles = useCallback((files) => {
        // Sort by name for FIX #3 (order)
        const sorted = Array.from(files)
            .filter((f) => f.type.startsWith("image/"))
            .sort((a, b) => a.name.localeCompare(b.name));

        sorted.forEach((file) => {
            // FIX #1/#13: skip duplicates
            const fk = fileKey(file);
            if (fileKeysRef.current.has(fk)) return;
            fileKeysRef.current.add(fk);

            const src = URL.createObjectURL(file);
            // FIX #4: create a persistent HTMLImageElement
            const htmlImg = new window.Image();
            htmlImg.onload = () => {
                serialRef.current += 1;
                const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                // FIX #2: store path
                const path = file.webkitRelativePath || file.name;
                setImageLibrary((prev) => [
                    ...prev,
                    { id, serial: serialRef.current, name: file.name, path, src, htmlImg, naturalW: htmlImg.naturalWidth, naturalH: htmlImg.naturalHeight, fileKey: fk },
                ]);
                setImageStates((prev) => ({ ...prev, [id]: { annotations: [], history: [[]], historyStep: 0 } }));
            };
            htmlImg.src = src;
        });
    }, []);

    /* ── Activate image ── */
    const activateImage = useCallback((item) => {
        const el = canvasRef.current;
        const maxW = el ? el.clientWidth - 64 : window.innerWidth - 500;
        const maxH = el ? el.clientHeight - 64 : window.innerHeight - 120;
        // FIX #6: support large images by always fitting to container
        const ratio = Math.min(maxW / item.naturalW, maxH / item.naturalH, 1);
        setImageSize({ width: Math.round(item.naturalW * ratio), height: Math.round(item.naturalH * ratio) });
        setActiveImageId(item.id);
        setSelectedId(null);
        setPolyPoints([]);
        setScale(1);
        setStagePos({ x: 0, y: 0 });
    }, []);

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

    /* ── Remove ── */
    const removeImage = (id) => {
        const item = imageLibrary.find((i) => i.id === id);
        if (item) { fileKeysRef.current.delete(item.fileKey); URL.revokeObjectURL(item.src); }
        setImageLibrary((prev) => prev.filter((i) => i.id !== id));
        setImageStates((prev) => { const n = { ...prev }; delete n[id]; return n; });
        if (activeImageId === id) setActiveImageId(null);
    };

    /* ── Drawing helpers ── */
    // FIX #5: use raw stage coordinates without scale division (stage handles its own scale)
    const getStagePointerPos = () => {
        const stage = stageRef.current;
        const ptr = stage.getPointerPosition();
        // ptr is already in screen px; convert to image-space
        return {
            x: (ptr.x - stage.x()) / scale,
            y: (ptr.y - stage.y()) / scale,
        };
    };

    const handleMouseDown = (e) => {
        if (!activeImage) return;
        // FIX #5: Only react to left mouse button (button 0); trackpad two-finger tap fires button 2
        if (e.evt && e.evt.button !== 0) return;

        if (tool === TOOLS.SELECT) {
            const onBg = e.target === e.target.getStage() || e.target.getClassName() === "Image";
            if (onBg) setSelectedId(null);
            return;
        }
        if (tool === TOOLS.POLYGON || tool === TOOLS.ERASER) return;

        const pos = getStagePointerPos();
        setDrawing(true);

        if (tool === TOOLS.RECT) setCurrentShape({ id: nextId(), type: "rect", x: pos.x, y: pos.y, width: 0, height: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.CIRCLE) setCurrentShape({ id: nextId(), type: "circle", x: pos.x, y: pos.y, radius: 0, stroke: strokeColor, strokeWidth, fill: fillColor });
        else if (tool === TOOLS.LINE) setCurrentShape({ id: nextId(), type: "line", points: [pos.x, pos.y, pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
        else if (tool === TOOLS.BRUSH) setCurrentShape({ id: nextId(), type: "brush", points: [pos.x, pos.y], stroke: strokeColor, strokeWidth, fill: "transparent" });
    };

    const handleMouseMove = (e) => {
        // FIX #11: Eraser — erase annotations under cursor
        if (tool === TOOLS.ERASER && drawing) {
            const pos = getStagePointerPos();
            const eraseRadius = strokeWidth * 6;
            const newAnns = annotations.filter((ann) => {
                if (ann.type === "rect") {
                    const cx = ann.x + ann.width / 2;
                    const cy = ann.y + ann.height / 2;
                    return Math.hypot(pos.x - cx, pos.y - cy) > eraseRadius + Math.max(Math.abs(ann.width), Math.abs(ann.height)) / 2;
                }
                if (ann.type === "circle") return Math.hypot(pos.x - ann.x, pos.y - ann.y) > ann.radius + eraseRadius;
                if (ann.type === "brush" || ann.type === "line" || ann.type === "polygon") {
                    const pts = ann.points;
                    for (let i = 0; i < pts.length - 1; i += 2) {
                        if (Math.hypot(pos.x - pts[i], pos.y - pts[i + 1]) < eraseRadius) return false;
                    }
                }
                return true;
            });
            if (newAnns.length !== annotations.length) {
                setImageStates((prev) => ({
                    ...prev,
                    [activeImageId]: { ...(prev[activeImageId] ?? emptyState), annotations: newAnns },
                }));
            }
            return;
        }

        if (!drawing || !currentShape) return;
        const pos = getStagePointerPos();

        if (tool === TOOLS.RECT) setCurrentShape((s) => ({ ...s, width: pos.x - s.x, height: pos.y - s.y }));
        else if (tool === TOOLS.CIRCLE) { const dx = pos.x - currentShape.x, dy = pos.y - currentShape.y; setCurrentShape((s) => ({ ...s, radius: Math.sqrt(dx * dx + dy * dy) })); }
        else if (tool === TOOLS.LINE) setCurrentShape((s) => ({ ...s, points: [s.points[0], s.points[1], pos.x, pos.y] }));
        else if (tool === TOOLS.BRUSH) setCurrentShape((s) => ({ ...s, points: [...s.points, pos.x, pos.y] }));
    };

    const handleMouseUp = () => {
        if (tool === TOOLS.ERASER && drawing) {
            // commit eraser stroke to history
            setDrawing(false);
            setImageStates((prev) => {
                const cur = prev[activeImageId] ?? emptyState;
                const newHist = cur.history.slice(0, cur.historyStep + 1).concat([cur.annotations]);
                return { ...prev, [activeImageId]: { ...cur, history: newHist, historyStep: newHist.length - 1 } };
            });
            return;
        }
        if (!drawing || !currentShape) return;
        setDrawing(false);
        pushHistory([...annotations, currentShape]);
        setCurrentShape(null);
    };

    const handleStageClick = (e) => {
        if (e.evt && e.evt.button !== 0) return; // FIX #5
        if (tool !== TOOLS.POLYGON) return;
        const pos = getStagePointerPos();
        if (e.evt.detail === 2) {
            if (polyPoints.length >= 6)
                pushHistory([...annotations, { id: nextId(), type: "polygon", points: polyPoints, stroke: strokeColor, strokeWidth, fill: fillColor, closed: true }]);
            setPolyPoints([]);
        } else {
            setPolyPoints((pts) => [...pts, pos.x, pos.y]);
        }
    };

    const deleteSelected = useCallback(() => {
        if (!selectedId) return;
        pushHistory(annotations.filter((a) => a.id !== selectedId));
        setSelectedId(null);
    }, [selectedId, annotations, pushHistory]);

    /* ── Keyboard ── */
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

    /* ── FIX #7/#8: Mouse-wheel zoom — centred then pointer-based ── */
    useEffect(() => {
        const el = canvasRef.current;
        if (!el) return;

        const onWheel = (e) => {
            e.preventDefault();
            const stage = stageRef.current;
            if (!stage || !activeImage) return;

            const ZOOM_FACTOR = 1.08;
            const direction = e.deltaY < 0 ? 1 : -1;
            const oldScale = scale;
            const newScaleRaw = direction > 0 ? oldScale * ZOOM_FACTOR : oldScale / ZOOM_FACTOR;
            const newScale = Math.min(8, Math.max(0.05, newScaleRaw));

            const containerW = el.clientWidth;
            const containerH = el.clientHeight;
            const imgDisplayW = imageSize.width * newScale;
            const imgDisplayH = imageSize.height * newScale;

            let newX, newY;

            if (imgDisplayW <= containerW && imgDisplayH <= containerH) {
                // FIX #8a: image fits container → keep centred
                newX = (containerW - imgDisplayW) / 2;
                newY = (containerH - imgDisplayH) / 2;
            } else {
                // FIX #8b: image overflows → zoom around mouse pointer
                const ptr = stage.getPointerPosition() ?? { x: containerW / 2, y: containerH / 2 };
                const mouseX = ptr.x;
                const mouseY = ptr.y;
                // Where does the mouse sit in image-space?
                const imgX = (mouseX - stagePos.x) / oldScale;
                const imgY = (mouseY - stagePos.y) / oldScale;
                // New stage position that keeps imgX/imgY under mouse
                newX = mouseX - imgX * newScale;
                newY = mouseY - imgY * newScale;
                // Clamp so we don't over-pan beyond edges
                const minX = Math.min(0, containerW - imgDisplayW);
                const minY = Math.min(0, containerH - imgDisplayH);
                newX = Math.max(minX, Math.min(0, newX));
                newY = Math.max(minY, Math.min(0, newY));
            }

            setScale(newScale);
            setStagePos({ x: newX, y: newY });
        };

        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scale, stagePos, imageSize, activeImage]);

    /* ── Sidebar zoom buttons (centred) ── */
    const handleZoomBtn = (delta) => {
        const el = canvasRef.current;
        const newScale = Math.min(8, Math.max(0.05, scale + delta));
        const containerW = el?.clientWidth ?? 800;
        const containerH = el?.clientHeight ?? 600;
        const imgDisplayW = imageSize.width * newScale;
        const imgDisplayH = imageSize.height * newScale;
        const newX = Math.max(Math.min(0, (containerW - imgDisplayW) / 2), Math.min(0, stagePos.x));
        const newY = Math.max(Math.min(0, (containerH - imgDisplayH) / 2), Math.min(0, stagePos.y));
        setScale(newScale);
        setStagePos({ x: newX, y: newY });
    };

    /* ── Render annotations ── */
    const renderAnn = (ann) => {
        const isDraggable = tool === TOOLS.SELECT;
        const common = {
            id: ann.id, key: ann.id,
            stroke: ann.stroke,
            // FIX #10: use strokeScaleEnabled=false so thickness stays constant when scaling
            strokeWidth: ann.strokeWidth,
            strokeScaleEnabled: false,
            fill: ann.fill ?? "transparent",
            rotation: ann.rotation ?? 0,
            scaleX: ann.scaleX ?? 1,
            scaleY: ann.scaleY ?? 1,
            draggable: isDraggable,
            onClick: (e) => { if (e.evt.button !== 0) return; if (isDraggable) setSelectedId(ann.id); },
            onTap: () => { if (isDraggable) setSelectedId(ann.id); },
            onDragEnd: (e) => {
                const updated = annotations.map((a) =>
                    a.id === ann.id ? { ...a, x: e.target.x(), y: e.target.y() } : a
                );
                pushHistory(updated);
            },
            // FIX #9: capture full transform on transform end
            onTransformEnd: () => handleTransformEnd(ann),
        };
        if (ann.type === "rect") return <Rect   {...common} x={ann.x} y={ann.y} width={ann.width} height={ann.height} />;
        if (ann.type === "circle") return <Circle {...common} x={ann.x} y={ann.y} radius={ann.radius} />;
        if (ann.type === "line") return <Line   {...common} points={ann.points} lineCap="round" />;
        if (ann.type === "brush") return <Line   {...common} points={ann.points} tension={0.5} lineCap="round" lineJoin="round" />;
        if (ann.type === "polygon") return <Line   {...common} points={ann.points} closed={ann.closed} />;
        return null;
    };

    const renderCurrent = () => {
        if (!currentShape) return null;
        const p = { key: "cur", stroke: currentShape.stroke, strokeWidth: currentShape.strokeWidth, strokeScaleEnabled: false, fill: currentShape.fill ?? "transparent", listening: false };
        if (currentShape.type === "rect") return <Rect   {...p} x={currentShape.x} y={currentShape.y} width={currentShape.width} height={currentShape.height} />;
        if (currentShape.type === "circle") return <Circle {...p} x={currentShape.x} y={currentShape.y} radius={currentShape.radius} />;
        if (currentShape.type === "line") return <Line   {...p} points={currentShape.points} lineCap="round" />;
        if (currentShape.type === "brush") return <Line   {...p} points={currentShape.points} tension={0.5} lineCap="round" lineJoin="round" />;
        return null;
    };

    const getCursor = () => {
        if (tool === TOOLS.ERASER) return "cell";
        if (tool === TOOLS.SELECT) return "default";
        return "crosshair";
    };

    return (
        <div className={styles.root}>

            {/* ── Left toolbar ── */}
            <aside className={styles.sidebar}>
                <div className={styles.sidebarTop}>
                    <div className={styles.logoMark}>IA</div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Tools</span>
                        {Object.values(TOOLS).map((t) => (
                            <button key={t} className={`${styles.toolBtn} ${tool === t ? styles.active : ""}`}
                                onClick={() => { setTool(t); setPolyPoints([]); setDrawing(false); }} title={t}>
                                <span className={styles.toolIcon}>{TOOL_ICONS[t]}</span>
                                <span className={styles.toolLabel}>{t}</span>
                            </button>
                        ))}
                    </div>

                    <div className={styles.divider} />

                    {/* FIX #12: Stroke color */}
                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Stroke color</span>
                        <div className={styles.colorGrid}>
                            {STROKE_COLORS.map((c) => (
                                <button key={c} className={`${styles.colorDot} ${strokeColor === c ? styles.colorActive : ""}`}
                                    style={{ "--dot-color": c }} onClick={() => setStrokeColor(c)} />
                            ))}
                        </div>
                    </div>

                    {/* FIX #12: Fill color */}
                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Fill color</span>
                        <div className={styles.colorGrid}>
                            {FILL_COLORS.map((c) => (
                                <button key={c}
                                    className={`${styles.colorDot} ${fillColor === c ? styles.colorActive : ""} ${c === "transparent" ? styles.colorTransparent : ""}`}
                                    style={{ "--dot-color": c === "transparent" ? "#333" : c }}
                                    onClick={() => setFillColor(c)}
                                    title={c === "transparent" ? "No fill" : c}
                                />
                            ))}
                        </div>
                    </div>

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Stroke — {strokeWidth}px</span>
                        <input type="range" min="1" max="20" value={strokeWidth}
                            onChange={(e) => setStrokeWidth(Number(e.target.value))} className={styles.slider} />
                    </div>

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
                        <button className={styles.histBtn} onClick={undo} disabled={historyStep === 0} title="Undo (Ctrl+Z)">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
                        </button>
                        <button className={styles.histBtn} onClick={redo} disabled={historyStep >= history.length - 1} title="Redo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
                        </button>
                        <button className={`${styles.histBtn} ${styles.deleteBtn}`} onClick={deleteSelected} disabled={!selectedId} title="Delete (Del)">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg>
                        </button>
                    </div>
                    <div className={styles.hint}>
                        {tool === TOOLS.POLYGON ? "Click · Dbl-click to close" :
                            tool === TOOLS.ERASER ? "Click-drag to erase" :
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
                        width={canvasRef.current?.clientWidth ?? 800}
                        height={canvasRef.current?.clientHeight ?? 600}
                        x={stagePos.x} y={stagePos.y}
                        scaleX={scale} scaleY={scale}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={() => { if (drawing && tool !== TOOLS.ERASER) handleMouseUp(); }}
                        onClick={handleStageClick}
                        style={{ display: "block" }}
                    >
                        <Layer>
                            <CanvasImage htmlImg={activeImage.htmlImg} />
                            {annotations.map(renderAnn)}
                            {renderCurrent()}
                            {polyPoints.length >= 2 && (
                                <Line points={polyPoints} stroke={strokeColor} strokeWidth={strokeWidth} strokeScaleEnabled={false} fill="transparent" listening={false} />
                            )}
                            <Transformer
                                ref={transformerRef}
                                keepRatio={false}
                                boundBoxFunc={(o, n) => (n.width < 5 || n.height < 5 ? o : n)}
                            />
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
                <input ref={fileInputRef} type="file" accept="image/*" multiple
                    onChange={(e) => loadFiles(e.target.files)} className={styles.hidden} />

                <div className={styles.panelList}>
                    {imageLibrary.length === 0 ? (
                        <div className={styles.panelEmpty}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" width="30" height="30">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            <p>Drop images here<br />or click Add</p>
                        </div>
                    ) : (
                        imageLibrary.map((item) => (
                            <ImageCard
                                key={item.id}
                                item={{ ...item, annotationCount: imageStates[item.id]?.annotations?.length ?? 0 }}
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
                            <span className={styles.footerVal}>{annotations.length}</span>
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
}