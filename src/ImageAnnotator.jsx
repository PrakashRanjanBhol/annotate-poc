import React, { useState, useRef, useEffect, useCallback } from "react";
import {
    Stage,
    Layer,
    Image as KonvaImage,
    Rect,
    Circle,
    Line,
    Transformer,
} from "react-konva";
import useImage from "use-image";
import styles from "./ImageAnnotator.module.css";

/* ─── Constants ──────────────────────────────────────── */

const TOOLS = {
    SELECT: "select",
    RECT: "rect",
    CIRCLE: "circle",
    LINE: "line",
    POLYGON: "polygon",
    BRUSH: "brush",
};

const TOOL_ICONS = {
    [TOOLS.SELECT]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 3l14 9-7 1-4 7L5 3z" />
        </svg>
    ),
    [TOOLS.RECT]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="1" />
        </svg>
    ),
    [TOOLS.CIRCLE]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
        </svg>
    ),
    [TOOLS.LINE]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="20" x2="20" y2="4" />
        </svg>
    ),
    [TOOLS.POLYGON]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12,3 21,9 18,20 6,20 3,9" />
        </svg>
    ),
    [TOOLS.BRUSH]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 2v3.5" />
            <path d="M21 17a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-2z" />
        </svg>
    ),
};

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#ffffff"];

let annCounter = 0;
const nextId = () => `ann-${++annCounter}`;

/* ─── CanvasImage ────────────────────────────────────── */

const CanvasImage = ({ src }) => {
    const [image] = useImage(src, "anonymous");
    return <KonvaImage image={image} x={0} y={0} listening={false} />;
};

/* ─── ImageCard ──────────────────────────────────────── */

const ImageCard = ({ item, isActive, onSelect, onDragStart, onRemove }) => (
    <div
        className={`${styles.imageCard} ${isActive ? styles.imageCardActive : ""}`}
        onClick={onSelect}
        draggable
        onDragStart={onDragStart}
        title={`${item.name} — drag to canvas`}
    >
        <div className={styles.cardThumbWrap}>
            <img src={item.src} alt={item.name} className={styles.cardThumb} draggable={false} />
            {item.annotationCount > 0 && (
                <span className={styles.cardBadge}>{item.annotationCount}</span>
            )}
        </div>
        <span className={styles.cardName}>{item.name}</span>
        <button
            className={styles.cardRemove}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove from library"
        >×</button>
    </div>
);

/* ─── Main ───────────────────────────────────────────── */

export default function ImageAnnotator() {
    const [imageLibrary, setImageLibrary] = useState([]);
    const [imageStates, setImageStates] = useState({});
    const [activeImageId, setActiveImageId] = useState(null);
    const [imageSize, setImageSize] = useState({ width: 800, height: 500 });

    const [tool, setTool] = useState(TOOLS.SELECT);
    const [selectedId, setSelectedId] = useState(null);
    const [drawing, setDrawing] = useState(false);
    const [currentShape, setCurrentShape] = useState(null);
    const [polyPoints, setPolyPoints] = useState([]);
    const [scale, setScale] = useState(1);
    const [color, setColor] = useState("#ef4444");
    const [strokeWidth, setStrokeWidth] = useState(3);
    const [canvasDragOver, setCanvasDragOver] = useState(false);

    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const fileInputRef = useRef(null);
    const canvasRef = useRef(null);

    /* Derived */
    const activeImage = imageLibrary.find((i) => i.id === activeImageId) ?? null;
    const emptyState = { annotations: [], history: [[]], historyStep: 0 };
    const activeState = activeImageId ? (imageStates[activeImageId] ?? emptyState) : emptyState;
    const { annotations, history, historyStep } = activeState;

    /* Per-image state helpers */
    const patchActive = useCallback((patch) => {
        if (!activeImageId) return;
        setImageStates((prev) => ({ ...prev, [activeImageId]: { ...(prev[activeImageId] ?? emptyState), ...patch } }));
    }, [activeImageId]);

    const pushHistory = useCallback((newAnnotations) => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            const newHist = cur.history.slice(0, cur.historyStep + 1).concat([newAnnotations]);
            return { ...prev, [activeImageId]: { annotations: newAnnotations, history: newHist, historyStep: newHist.length - 1 } };
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

    /* Transformer sync */
    useEffect(() => {
        if (!transformerRef.current || !stageRef.current) return;
        if (selectedId && tool === TOOLS.SELECT) {
            const node = stageRef.current.findOne(`#${selectedId}`);
            if (node) { transformerRef.current.nodes([node]); transformerRef.current.getLayer().batchDraw(); return; }
        }
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
    }, [selectedId, tool, annotations]);

    /* Load files */
    const loadFiles = (files) => {
        Array.from(files).forEach((file) => {
            if (!file.type.startsWith("image/")) return;
            const src = URL.createObjectURL(file);
            const img = new window.Image();
            img.onload = () => {
                const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                setImageLibrary((prev) => [...prev, { id, name: file.name, src, naturalW: img.naturalWidth, naturalH: img.naturalHeight }]);
                setImageStates((prev) => ({ ...prev, [id]: { annotations: [], history: [[]], historyStep: 0 } }));
            };
            img.src = src;
        });
    };

    /* Activate image (fit to canvas viewport) */
    const activateImage = useCallback((item) => {
        const el = canvasRef.current;
        const maxW = el ? el.clientWidth - 64 : window.innerWidth - 500;
        const maxH = el ? el.clientHeight - 64 : window.innerHeight - 120;
        const ratio = Math.min(maxW / item.naturalW, maxH / item.naturalH, 1);
        setImageSize({ width: Math.round(item.naturalW * ratio), height: Math.round(item.naturalH * ratio) });
        setActiveImageId(item.id);
        setSelectedId(null);
        setPolyPoints([]);
        setScale(1);
    }, []);

    /* Panel drag start */
    const handlePanelDragStart = (e, id) => {
        e.dataTransfer.setData("application/x-imageid", id);
        e.dataTransfer.effectAllowed = "copy";
    };

    /* Canvas drop zone */
    const handleCanvasDragOver = (e) => { e.preventDefault(); setCanvasDragOver(true); };
    const handleCanvasDragLeave = () => setCanvasDragOver(false);
    const handleCanvasDrop = (e) => {
        e.preventDefault();
        setCanvasDragOver(false);
        const id = e.dataTransfer.getData("application/x-imageid");
        const item = imageLibrary.find((i) => i.id === id);
        if (item) activateImage(item);
        // Also accept raw file drops onto canvas
        if (!item && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    };

    /* Panel file drop */
    const handlePanelDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
    };

    /* Remove from library */
    const removeImage = (id) => {
        setImageLibrary((prev) => prev.filter((i) => i.id !== id));
        setImageStates((prev) => { const n = { ...prev }; delete n[id]; return n; });
        if (activeImageId === id) setActiveImageId(null);
    };

    /* Drawing */
    const getPos = () => {
        const pos = stageRef.current.getPointerPosition();
        return { x: pos.x / scale, y: pos.y / scale };
    };

    const handleMouseDown = (e) => {
        if (!activeImage) return;
        if (tool === TOOLS.SELECT) {
            if (e.target === e.target.getStage() || e.target.getClassName() === "Image") setSelectedId(null);
            return;
        }
        if (tool === TOOLS.POLYGON) return;
        const pos = getPos();
        setDrawing(true);
        if (tool === TOOLS.RECT) setCurrentShape({ id: nextId(), type: "rect", x: pos.x, y: pos.y, width: 0, height: 0, stroke: color, strokeWidth });
        else if (tool === TOOLS.CIRCLE) setCurrentShape({ id: nextId(), type: "circle", x: pos.x, y: pos.y, radius: 0, stroke: color, strokeWidth });
        else if (tool === TOOLS.LINE) setCurrentShape({ id: nextId(), type: "line", points: [pos.x, pos.y, pos.x, pos.y], stroke: color, strokeWidth });
        else if (tool === TOOLS.BRUSH) setCurrentShape({ id: nextId(), type: "brush", points: [pos.x, pos.y], stroke: color, strokeWidth });
    };

    const handleMouseMove = () => {
        if (!drawing || !currentShape) return;
        const pos = getPos();
        if (tool === TOOLS.RECT) setCurrentShape((s) => ({ ...s, width: pos.x - s.x, height: pos.y - s.y }));
        else if (tool === TOOLS.CIRCLE) { const dx = pos.x - currentShape.x, dy = pos.y - currentShape.y; setCurrentShape((s) => ({ ...s, radius: Math.sqrt(dx * dx + dy * dy) })); }
        else if (tool === TOOLS.LINE) setCurrentShape((s) => ({ ...s, points: [s.points[0], s.points[1], pos.x, pos.y] }));
        else if (tool === TOOLS.BRUSH) setCurrentShape((s) => ({ ...s, points: [...s.points, pos.x, pos.y] }));
    };

    const handleMouseUp = () => {
        if (!drawing || !currentShape) return;
        setDrawing(false);
        pushHistory([...annotations, currentShape]);
        setCurrentShape(null);
    };

    const handleStageClick = (e) => {
        if (tool !== TOOLS.POLYGON) return;
        const pos = getPos();
        if (e.evt.detail === 2) {
            if (polyPoints.length >= 6) pushHistory([...annotations, { id: nextId(), type: "polygon", points: polyPoints, stroke: color, strokeWidth, closed: true }]);
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

    const handleZoom = (d) => setScale((s) => parseFloat(Math.min(4, Math.max(0.2, s + d)).toFixed(2)));

    /* Render shapes */
    const renderAnn = (ann) => {
        const p = {
            id: ann.id, key: ann.id, stroke: ann.stroke, strokeWidth: ann.strokeWidth, fill: "transparent",
            draggable: tool === TOOLS.SELECT,
            onClick: () => tool === TOOLS.SELECT && setSelectedId(ann.id),
            onTap: () => tool === TOOLS.SELECT && setSelectedId(ann.id),
            onDragEnd: (e) => pushHistory(annotations.map((a) => a.id === ann.id ? { ...a, x: e.target.x(), y: e.target.y() } : a)),
        };
        if (ann.type === "rect") return <Rect   {...p} x={ann.x} y={ann.y} width={ann.width} height={ann.height} />;
        if (ann.type === "circle") return <Circle {...p} x={ann.x} y={ann.y} radius={ann.radius} />;
        if (ann.type === "line") return <Line   {...p} points={ann.points} lineCap="round" />;
        if (ann.type === "brush") return <Line   {...p} points={ann.points} tension={0.5} lineCap="round" lineJoin="round" />;
        if (ann.type === "polygon") return <Line   {...p} points={ann.points} closed={ann.closed} />;
        return null;
    };

    const renderCurrent = () => {
        if (!currentShape) return null;
        const p = { key: "cur", stroke: currentShape.stroke, strokeWidth: currentShape.strokeWidth, fill: "transparent", listening: false };
        if (currentShape.type === "rect") return <Rect   {...p} x={currentShape.x} y={currentShape.y} width={currentShape.width} height={currentShape.height} />;
        if (currentShape.type === "circle") return <Circle {...p} x={currentShape.x} y={currentShape.y} radius={currentShape.radius} />;
        if (currentShape.type === "line") return <Line   {...p} points={currentShape.points} lineCap="round" />;
        if (currentShape.type === "brush") return <Line   {...p} points={currentShape.points} tension={0.5} lineCap="round" lineJoin="round" />;
        return null;
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
                                onClick={() => { setTool(t); setPolyPoints([]); }} title={t}>
                                <span className={styles.toolIcon}>{TOOL_ICONS[t]}</span>
                                <span className={styles.toolLabel}>{t}</span>
                            </button>
                        ))}
                    </div>

                    <div className={styles.divider} />

                    <div className={styles.toolGroup}>
                        <span className={styles.groupLabel}>Color</span>
                        <div className={styles.colorGrid}>
                            {COLORS.map((c) => (
                                <button key={c} className={`${styles.colorDot} ${color === c ? styles.colorActive : ""}`}
                                    style={{ "--dot-color": c }} onClick={() => setColor(c)} />
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
                            <button className={styles.zoomBtn} onClick={() => handleZoom(-0.1)}>−</button>
                            <button className={styles.zoomBtn} onClick={() => setScale(1)}>1:1</button>
                            <button className={styles.zoomBtn} onClick={() => handleZoom(+0.1)}>+</button>
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
                        {tool === TOOLS.POLYGON ? "Click · Dbl-click to close" : "Del · Ctrl+Z · Ctrl+Y"}
                    </div>
                </div>
            </aside>

            {/* ── Canvas ── */}
            <main
                ref={canvasRef}
                className={`${styles.canvas} ${canvasDragOver ? styles.canvasDragOver : ""}`}
                style={{ cursor: tool === TOOLS.SELECT ? "default" : "crosshair" }}
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
                    <div className={styles.stageWrap} style={{ width: imageSize.width * scale, height: imageSize.height * scale }}>
                        <Stage
                            ref={stageRef}
                            width={imageSize.width * scale} height={imageSize.height * scale}
                            scaleX={scale} scaleY={scale}
                            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp} onClick={handleStageClick}
                        >
                            <Layer>
                                <CanvasImage src={activeImage.src} />
                                {annotations.map(renderAnn)}
                                {renderCurrent()}
                                {polyPoints.length >= 2 && (
                                    <Line points={polyPoints} stroke={color} strokeWidth={strokeWidth} fill="transparent" listening={false} />
                                )}
                                <Transformer ref={transformerRef}
                                    boundBoxFunc={(o, n) => (n.width < 5 || n.height < 5 ? o : n)} />
                            </Layer>
                        </Stage>
                    </div>
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

            {/* ── Right image panel ── */}
            <aside
                className={styles.panel}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handlePanelDrop}
            >
                {/* Header */}
                <div className={styles.panelHeader}>
                    <span className={styles.panelTitle}>Images</span>
                    {imageLibrary.length > 0 && (
                        <span className={styles.panelCount}>{imageLibrary.length}</span>
                    )}
                </div>

                {/* Add button */}
                <button className={styles.addBtn} onClick={() => fileInputRef.current.click()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="13" height="13">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add images
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple
                    onChange={(e) => loadFiles(e.target.files)} className={styles.hidden} />

                {/* List */}
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

                {/* Footer info */}
                {activeImage && (
                    <div className={styles.panelFooter}>
                        <div className={styles.footerRow}>
                            <span className={styles.footerLabel}>Active</span>
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
                    </div>
                )}
            </aside>
        </div>
    );
}