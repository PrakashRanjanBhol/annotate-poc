/**
 * ImageAnnotator.jsx — prop-driven, single-image mode
 *
 * CHANGES FROM PREVIOUS VERSION:
 * 1. The right-side image library panel has been removed.
 *    The canvas is the only thing in the work area now.
 *
 * 2. The image to annotate is supplied via the `image` prop:
 *      <ImageAnnotator image={{
 *          datasetId:          "1",
 *          datatype:           "Base",
 *          filename:           "file2.png",
 *          id:                 "something",
 *          originalClassName:  "something",
 *          predictionScore:    0.1,
 *          split:              "something",
 *          suggestedLabel:     "Something" | null,
 *          url:                "http://imagepath" | "data:image/png;base64,..." | raw base64,
 *          userLabel:          "Something" | null,
 *      }} />
 *
 *    The `url` field can be:
 *      - a remote http(s) URL          → fetched via <img crossOrigin>
 *      - a data: URL                   → loaded directly
 *      - a raw base64 string (no `data:` prefix) → wrapped with a guessed mime type
 *      - a TIFF over http or data url  → decoded with utif
 *
 * 3. When the prop changes, the component loads the new image and makes it
 *    the active image automatically. All existing annotation / history /
 *    eraser logic still operates on a single internal image record.
 *
 * Everything else (drawing, transformer, eraser-in-shape-local-space,
 * loadAnnotations, save payload) is unchanged.
 */

import React, {
    useState, useRef, useEffect, useCallback, useMemo,
    useImperativeHandle, forwardRef,
} from "react";
import {
    Stage, Layer, Image as KonvaImage,
    Rect, Ellipse, Line, Transformer,
} from "react-konva";
import * as UTIF from "utif";
import styles from "./ImageAnnotator.module.css";

/* ─── Module-level stores ────────────────────────────── */
const IMG_STORE = new Map();   // id → HTMLImageElement (never GC'd)

/* ─── Tools ──────────────────────────────────────────── */
const TOOLS = {
    SELECT: "select", RECT: "rect", CIRCLE: "circle",
    LINE: "line", POLYGON: "polygon", BRUSH: "brush", ARC: "arc", ERASER: "eraser",
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
    [TOOLS.ARC]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 19 C5 19 5 5 12 5 C19 5 19 19 19 19 Z" strokeLinejoin="round" />
        </svg>
    ),
    [TOOLS.ERASER]: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 20H7L3 16l11-11 6 6-4 4" />
            <path d="m6.7 6.7 10.6 10.6" />
        </svg>
    ),
};

const STROKE_COLORS = [
    /* row 1 — reds / oranges */
    "#ef4444", "#dc2626", "#f97316", "#ea580c",
    /* row 2 — yellows / greens */
    "#eab308", "#ca8a04", "#22c55e", "#16a34a",
    /* row 3 — blues / purples */
    "#3b82f6", "#2563eb", "#a855f7", "#7c3aed",
    /* row 4 — pinks / cyans */
    "#ec4899", "#db2777", "#06b6d4", "#0891b2",
    /* row 5 — neutrals */
    "#ffffff", "#94a3b8", "#475569", "#000000",
];

const FILL_COLORS = [
    /* row 1 — no fill + reds */
    "transparent", "#ef444466", "#dc262666", "#f9731666",
    /* row 2 — oranges / yellows */
    "#ea580c66", "#eab30866", "#ca8a0466", "#22c55e66",
    /* row 3 — greens / blues */
    "#16a34a66", "#3b82f666", "#2563eb66", "#a855f766",
    /* row 4 — purples / pinks */
    "#7c3aed66", "#ec489966", "#db277766", "#06b6d466",
    /* row 5 — cyans / neutrals */
    "#0891b266", "#ffffff66", "#94a3b866", "#47556966",
];

let annCounter = 0;
const nextId = () => `ann-${++annCounter}`;

/* ─── Canvas 2D shape renderer ───────────────────────────────────────────────
 * (unchanged — eraser is stored in shape-local space; see top of file)
 * --------------------------------------------------------------------------*/

function rotateLocal(px, py, angleDeg) {
    const r = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    return [px * cos - py * sin, px * sin + py * cos];
}

function absToLocal(px, py, ox, oy, rot) {
    return rotateLocal(px - ox, py - oy, -(rot ?? 0));
}

function getShapePivot(ann) {
    if (ann.type === "rect") {
        const w = Math.abs(ann.width), h = Math.abs(ann.height);
        return { ox: ann.x + w / 2, oy: ann.y + h / 2 };
    }
    if (ann.type === "circle") {
        return { ox: ann.x, oy: ann.y };
    }
    return { ox: ann.x ?? 0, oy: ann.y ?? 0 };
}

function eraserStrokeToLocal(stroke, ann) {
    const { ox, oy } = getShapePivot(ann);
    const rot = ann.rotation ?? 0;
    const localPts = [];
    for (let i = 0; i < stroke.points.length; i += 2) {
        const [lx, ly] = absToLocal(stroke.points[i], stroke.points[i + 1], ox, oy, rot);
        localPts.push(lx, ly);
    }
    return { points: localPts, size: stroke.size };
}

function drawAnnOnCtx(ctx, ann, canvasW, canvasH) {
    if (!ann || !ann.type) return;
    const hasEraserStrokes = ann.eraserStrokes && ann.eraserStrokes.length > 0;

    if (hasEraserStrokes) {
        const tmp = document.createElement("canvas");
        tmp.width = canvasW || ctx.canvas.width;
        tmp.height = canvasH || ctx.canvas.height;
        const tCtx = tmp.getContext("2d");
        _drawShapeOnCtx(tCtx, ann);
        _applyEraserInLocalSpace(tCtx, ann);
        ctx.drawImage(tmp, 0, 0);
    } else {
        _drawShapeOnCtx(ctx, ann);
    }
}

function _applyEraserInLocalSpace(ctx, ann) {
    if (!ann.eraserStrokes || ann.eraserStrokes.length === 0) return;
    const rot = (ann.rotation ?? 0) * Math.PI / 180;

    for (const es of ann.eraserStrokes) {
        const pts = es.points;
        if (!pts || pts.length < 2) continue;

        ctx.save();
        if (ann.type === "rect") {
            const w = Math.abs(ann.width), h = Math.abs(ann.height);
            const ox = ann.x + w / 2, oy = ann.y + h / 2;
            ctx.translate(ox, oy);
            ctx.rotate(rot);
        } else if (ann.type === "circle") {
            ctx.translate(ann.x, ann.y);
            ctx.rotate(rot);
        } else {
            ctx.translate(ann.x ?? 0, ann.y ?? 0);
            ctx.rotate(rot);
        }

        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.lineWidth = es.size * 2;
        ctx.lineCap = "square";
        ctx.lineJoin = "miter";

        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.stroke();

        if (pts.length === 2) {
            ctx.fillStyle = "rgba(0,0,0,1)";
            ctx.fillRect(pts[0] - es.size, pts[1] - es.size, es.size * 2, es.size * 2);
        }
        ctx.restore();
    }
}

function _drawShapeOnCtx(ctx, ann) {
    ctx.save();
    ctx.globalAlpha = ann.opacity ?? 1;
    const hasFill = ann.fill && ann.fill !== "transparent";

    if (ann.type === "rect") {
        const w = Math.abs(ann.width);
        const h = Math.abs(ann.height);
        const cx = ann.x + w / 2;
        const cy = ann.y + h / 2;
        ctx.translate(cx, cy);
        ctx.rotate(((ann.rotation ?? 0) * Math.PI) / 180);
        ctx.translate(-cx, -cy);
        ctx.beginPath();
        ctx.rect(ann.x, ann.y, w, h);
        if (hasFill) { ctx.fillStyle = ann.fill; ctx.fill(); }
        ctx.strokeStyle = ann.stroke; ctx.lineWidth = ann.strokeWidth;
        ctx.stroke();

    } else if (ann.type === "circle") {
        const rx = Math.abs(ann.radiusX ?? ann.radius ?? 0);
        const ry = Math.abs(ann.radiusY ?? ann.radius ?? 0);
        ctx.translate(ann.x, ann.y);
        ctx.rotate(((ann.rotation ?? 0) * Math.PI) / 180);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        if (hasFill) { ctx.fillStyle = ann.fill; ctx.fill(); }
        ctx.strokeStyle = ann.stroke; ctx.lineWidth = ann.strokeWidth;
        ctx.stroke();

    } else if (
        ann.type === "line" || ann.type === "brush" ||
        ann.type === "arc" || ann.type === "polygon"
    ) {
        const cx = ann.x ?? 0, cy = ann.y ?? 0;
        const pts = ann.points;
        if (!pts || pts.length < 2) { ctx.restore(); return; }
        ctx.translate(cx, cy);
        ctx.rotate(((ann.rotation ?? 0) * Math.PI) / 180);
        ctx.translate(-cx, -cy);
        ctx.beginPath();
        ctx.moveTo(pts[0] + cx, pts[1] + cy);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] + cx, pts[i + 1] + cy);
        if (ann.type === "arc" || ann.type === "polygon") ctx.closePath();
        if (hasFill) { ctx.fillStyle = ann.fill; ctx.fill(); }
        ctx.strokeStyle = ann.stroke;
        ctx.lineWidth = ann.strokeWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
    }
    ctx.restore();
}

/* ─── UnifiedCanvas ───────────────────────────────────────────────────────── */
const UnifiedCanvas = React.memo(({
    imgId, displayW, displayH, shapeAnnotations, liveEraserStroke,
}) => {
    const outCanvasRef = useRef(null);
    const [drawVersion, setDrawVersion] = useState(0);

    useEffect(() => {
        if (!outCanvasRef.current) outCanvasRef.current = document.createElement("canvas");
        outCanvasRef.current.width = displayW;
        outCanvasRef.current.height = displayH;
    }, [displayW, displayH]);

    useEffect(() => {
        const htmlImg = IMG_STORE.get(imgId);
        if (!htmlImg || !outCanvasRef.current) return;

        const ctx = outCanvasRef.current.getContext("2d");
        ctx.clearRect(0, 0, displayW, displayH);

        /* Layer 1 — original image */
        ctx.drawImage(htmlImg, 0, 0, displayW, displayH);

        /* Layer 2 — shapes */
        for (const ann of shapeAnnotations) {
            drawAnnOnCtx(ctx, ann, displayW, displayH);
        }

        /* Layer 3 — live eraser preview */
        if (liveEraserStroke) {
            const pts = liveEraserStroke.points;
            if (pts && pts.length >= 2) {
                const tmp = document.createElement("canvas");
                tmp.width = displayW;
                tmp.height = displayH;
                const tCtx = tmp.getContext("2d");
                for (const ann of shapeAnnotations) {
                    drawAnnOnCtx(tCtx, ann, displayW, displayH);
                }
                tCtx.save();
                tCtx.globalCompositeOperation = "destination-out";
                tCtx.strokeStyle = "rgba(0,0,0,1)";
                tCtx.lineWidth = liveEraserStroke.size * 2;
                tCtx.lineCap = "square";
                tCtx.lineJoin = "miter";
                tCtx.beginPath();
                tCtx.moveTo(pts[0], pts[1]);
                for (let i = 2; i < pts.length; i += 2) tCtx.lineTo(pts[i], pts[i + 1]);
                tCtx.stroke();
                if (pts.length === 2) {
                    tCtx.fillStyle = "rgba(0,0,0,1)";
                    tCtx.fillRect(
                        pts[0] - liveEraserStroke.size, pts[1] - liveEraserStroke.size,
                        liveEraserStroke.size * 2, liveEraserStroke.size * 2
                    );
                }
                tCtx.restore();

                ctx.clearRect(0, 0, displayW, displayH);
                ctx.drawImage(htmlImg, 0, 0, displayW, displayH);
                ctx.drawImage(tmp, 0, 0);
            }
        }

        setDrawVersion(v => v + 1);
    }, [imgId, displayW, displayH, shapeAnnotations, liveEraserStroke]);

    if (!outCanvasRef.current) return null;
    return (
        <KonvaImage
            key={drawVersion}
            image={outCanvasRef.current}
            x={0} y={0}
            width={displayW} height={displayH}
            listening={false}
        />
    );
});

/* ─── Eraser overlap helpers ────────────────────────────────────────────── */
function annBBox(ann) {
    if (ann.type === "rect") {
        const w = Math.abs(ann.width), h = Math.abs(ann.height);
        return { minX: ann.x, minY: ann.y, maxX: ann.x + w, maxY: ann.y + h };
    }
    if (ann.type === "circle") {
        const rx = Math.abs(ann.radiusX ?? ann.radius ?? 0);
        const ry = Math.abs(ann.radiusY ?? ann.radius ?? 0);
        return { minX: ann.x - rx, minY: ann.y - ry, maxX: ann.x + rx, maxY: ann.y + ry };
    }
    if (ann.type === "line" || ann.type === "brush" ||
        ann.type === "arc" || ann.type === "polygon") {
        const cx = ann.x ?? 0, cy = ann.y ?? 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < ann.points.length; i += 2) {
            const ax = ann.points[i] + cx, ay = ann.points[i + 1] + cy;
            if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
            if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
        }
        return { minX, minY, maxX, maxY };
    }
    return null;
}

function eraserTouchesAnn(stroke, ann) {
    const bbox = annBBox(ann);
    if (!bbox) return false;
    const s = stroke.size ?? 0;
    const ex = {
        minX: bbox.minX - s, minY: bbox.minY - s,
        maxX: bbox.maxX + s, maxY: bbox.maxY + s
    };
    const pts = stroke.points;
    for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] >= ex.minX && pts[i] <= ex.maxX &&
            pts[i + 1] >= ex.minY && pts[i + 1] <= ex.maxY) return true;
    }
    return false;
}

/* ─── Centroid helpers ──────────────────────────────────────────────────── */
function pointsCentroid(pts) {
    let sx = 0, sy = 0;
    const n = pts.length / 2;
    for (let i = 0; i < pts.length; i += 2) { sx += pts[i]; sy += pts[i + 1]; }
    return { cx: sx / n, cy: sy / n };
}

function pointsToCentroidRelative(pts) {
    const { cx, cy } = pointsCentroid(pts);
    const relPts = pts.map((v, i) => i % 2 === 0 ? v - cx : v - cy);
    return { cx, cy, relPts };
}

/* ─── KonvaAnnotation — invisible hit-target ─────────────────────────────── */
const KonvaAnnotation = ({
    ann, isSelected, tool, onSelect, onDragEnd, onTransformEnd,
}) => {
    const isSelectable = tool === TOOLS.SELECT;
    const common = {
        id: ann.id,
        opacity: 0,
        stroke: ann.stroke,
        strokeWidth: ann.strokeWidth,
        strokeScaleEnabled: false,
        fill: ann.fill ?? "transparent",
        listening: isSelectable,
        draggable: isSelectable,
        onClick: (e) => { if (e.evt.button !== 0) return; onSelect(ann.id); },
        onTap: () => onSelect(ann.id),
        onDragEnd,
        onTransformEnd,
        rotation: ann.rotation ?? 0,
    };

    if (ann.type === "rect") {
        const w = Math.abs(ann.width);
        const h = Math.abs(ann.height);
        return (
            <Rect
                {...common}
                x={ann.x + w / 2}
                y={ann.y + h / 2}
                width={w}
                height={h}
                offsetX={w / 2}
                offsetY={h / 2}
            />
        );
    }

    if (ann.type === "circle") {
        const rx = ann.radiusX ?? ann.radius ?? 0;
        const ry = ann.radiusY ?? ann.radius ?? 0;
        return (
            <Ellipse
                {...common}
                x={ann.x}
                y={ann.y}
                radiusX={Math.abs(rx)}
                radiusY={Math.abs(ry)}
            />
        );
    }

    if (ann.type === "line") {
        return (
            <Line
                {...common}
                x={ann.x ?? 0} y={ann.y ?? 0}
                points={ann.points}
                lineCap="round"
                hitStrokeWidth={Math.max(ann.strokeWidth, 10)}
            />
        );
    }

    if (ann.type === "brush") {
        return (
            <Line
                {...common}
                x={ann.x ?? 0} y={ann.y ?? 0}
                points={ann.points}
                tension={0.5}
                lineCap="round"
                lineJoin="round"
                hitStrokeWidth={Math.max(ann.strokeWidth, 10)}
            />
        );
    }

    if (ann.type === "arc") {
        return (
            <Line
                {...common}
                x={ann.x ?? 0} y={ann.y ?? 0}
                points={ann.points}
                tension={0.4}
                lineCap="round"
                lineJoin="round"
                closed={true}
                hitStrokeWidth={Math.max(ann.strokeWidth, 10)}
            />
        );
    }

    if (ann.type === "polygon") {
        return (
            <Line
                {...common}
                x={ann.x ?? 0} y={ann.y ?? 0}
                points={ann.points}
                closed={ann.closed ?? true}
                hitStrokeWidth={Math.max(ann.strokeWidth, 10)}
            />
        );
    }

    return null;
};

/* ─── In-progress shape preview ─────────────────────────────────────────── */
const DrawingOverlay = ({ currentShape, polyPoints, strokeColor, strokeWidth }) => {
    if (!currentShape && polyPoints.length < 2) return null;

    const previewProps = currentShape
        ? {
            stroke: currentShape.stroke,
            strokeWidth: currentShape.strokeWidth,
            strokeScaleEnabled: false,
            fill: currentShape.fill ?? "transparent",
            opacity: currentShape.opacity ?? 1,
            listening: false,
        }
        : null;

    return (
        <>
            {currentShape && previewProps && (() => {
                if (currentShape.type === "rect") {
                    const x = currentShape.width >= 0 ? currentShape.x : currentShape.x + currentShape.width;
                    const y = currentShape.height >= 0 ? currentShape.y : currentShape.y + currentShape.height;
                    return (
                        <Rect key="cur" {...previewProps}
                            x={x} y={y}
                            width={Math.abs(currentShape.width)}
                            height={Math.abs(currentShape.height)}
                        />
                    );
                }
                if (currentShape.type === "circle") {
                    const rx = Math.abs(currentShape.radiusX ?? currentShape.radius ?? 0);
                    const ry = Math.abs(currentShape.radiusY ?? currentShape.radius ?? 0);
                    return (
                        <Ellipse key="cur" {...previewProps}
                            x={currentShape.x} y={currentShape.y}
                            radiusX={rx} radiusY={ry}
                        />
                    );
                }
                if (currentShape.type === "line")
                    return <Line key="cur" {...previewProps}
                        points={currentShape.points} lineCap="round" />;
                if (currentShape.type === "brush")
                    return <Line key="cur" {...previewProps}
                        points={currentShape.points} tension={0.5}
                        lineCap="round" lineJoin="round" />;
                if (currentShape.type === "arc")
                    return <Line key="cur" {...previewProps}
                        points={currentShape.points} tension={0.4}
                        lineCap="round" lineJoin="round"
                        closed={currentShape.points.length >= 6} />;
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

/* ─── Image loaders ───────────────────────────────────────────────────────
 * Three sources are supported:
 *   1. data: URL  ("data:image/png;base64,...")
 *   2. raw base64 (no `data:` prefix; treated as image/png by default)
 *   3. http(s) URL — fetched as <img crossOrigin="anonymous">.
 *      If the extension is .tif/.tiff (or content-type says so) we fetch
 *      as ArrayBuffer and decode through UTIF.
 * --------------------------------------------------------------------------*/

function decodeTiffArrayBuffer(buffer) {
    return new Promise((resolve, reject) => {
        try {
            const ifds = UTIF.decode(buffer);
            if (!ifds || ifds.length === 0) {
                reject(new Error("TIFF has no pages"));
                return;
            }
            UTIF.decodeImage(buffer, ifds[0]);
            const rgba = UTIF.toRGBA8(ifds[0]);
            const { width, height } = ifds[0];

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            const imgData = ctx.createImageData(width, height);
            imgData.data.set(rgba);
            ctx.putImageData(imgData, 0, 0);

            const img = new window.Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = canvas.toDataURL("image/png");
        } catch (err) { reject(err); }
    });
}

function loadImageElement(src, { crossOrigin } = {}) {
    return new Promise((resolve, reject) => {
        const img = new window.Image();
        if (crossOrigin) img.crossOrigin = crossOrigin;
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(new Error(`Image load failed: ${src.slice(0, 64)}…`));
        img.src = src;
    });
}

/**
 * Load an image from anything the API might give us:
 *   url = "http(s)://..."          → fetched
 *   url = "data:image/..."          → loaded directly
 *   url = "<base64 with no prefix>" → wrapped with data: prefix
 */
async function loadImageFromUrl(url, filename = "image") {
    if (!url) throw new Error("loadImageFromUrl: empty url");

    /* Helper — try to detect tiff from filename or url */
    const looksLikeTiff =
        /\.tiff?(\?|$)/i.test(filename) ||
        /\.tiff?(\?|$)/i.test(url);

    /* Case 1: data: URL */
    if (url.startsWith("data:")) {
        /* data:image/tiff;base64,... → decode through UTIF */
        if (/^data:image\/tiff/i.test(url) || looksLikeTiff) {
            const resp = await fetch(url);
            const buf = await resp.arrayBuffer();
            return decodeTiffArrayBuffer(buf);
        }
        return loadImageElement(url);
    }

    /* Case 2: http(s) URL */
    if (/^https?:\/\//i.test(url)) {
        if (looksLikeTiff) {
            const resp = await fetch(url, { mode: "cors" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
            const buf = await resp.arrayBuffer();
            return decodeTiffArrayBuffer(buf);
        }
        /* Use crossOrigin so the canvas remains non-tainted for export.
           If the server doesn't send CORS headers the image still renders
           but canvas readback (e.g. .toDataURL) will be blocked — that's a
           server-side fix; nothing we can do client-side. */
        return loadImageElement(url, { crossOrigin: "anonymous" });
    }

    /* Case 3: raw base64 — wrap with a guessed mime prefix */
    const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "tif" || ext === "tiff" ? "image/tiff"
            : ext === "gif" ? "image/gif"
                : ext === "webp" ? "image/webp"
                    : "image/png";

    if (mime === "image/tiff") {
        /* Convert raw base64 → bytes → ArrayBuffer for UTIF */
        const bin = atob(url);
        const buf = new ArrayBuffer(bin.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
        return decodeTiffArrayBuffer(buf);
    }
    return loadImageElement(`data:${mime};base64,${url}`);
}

/* ─── buildSavePayload ─────────────────────────────────────────────────────
 * Unchanged. Coordinates are converted from display-space → original-image
 * pixel space.
 * --------------------------------------------------------------------------*/
function buildSavePayload(imageItem, annotations, displayW, displayH) {
    const scaleX = imageItem.naturalW / displayW;
    const scaleY = imageItem.naturalH / displayH;

    const sp = (v, axis) => Math.round((axis === "x" ? scaleX : scaleY) * v * 100) / 100;

    const absOrigPts = (cx, cy, relPts) => {
        const out = [];
        for (let i = 0; i < relPts.length; i += 2) {
            out.push(
                Math.round((relPts[i] + cx) * scaleX * 100) / 100,
                Math.round((relPts[i + 1] + cy) * scaleY * 100) / 100
            );
        }
        return out;
    };

    const eraserLocalToOrigAbs = (localPts, pivotX, pivotY, rotDeg) => {
        const out = [];
        const r = (rotDeg * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        for (let i = 0; i < localPts.length; i += 2) {
            const lx = localPts[i], ly = localPts[i + 1];
            const ax = lx * cos - ly * sin + pivotX;
            const ay = lx * sin + ly * cos + pivotY;
            out.push(
                Math.round(ax * scaleX * 100) / 100,
                Math.round(ay * scaleY * 100) / 100
            );
        }
        return out;
    };

    const exportedAnnotations = annotations
        .filter(a => a != null && a.type !== "eraser" && a.type !== "baked")
        .map((ann) => {
            const base = {
                id: ann.id,
                type: ann.type,
                stroke: ann.stroke,
                strokeWidth: Math.round(ann.strokeWidth / scaleX * 100) / 100,
                fill: ann.fill ?? "transparent",
                opacity: ann.opacity ?? 1,
                rotation: ann.rotation ?? 0,
            };

            let geometry = {};

            if (ann.type === "rect") {
                const pivotX = ann.x + Math.abs(ann.width) / 2;
                const pivotY = ann.y + Math.abs(ann.height) / 2;
                geometry = {
                    x: sp(ann.x, "x"),
                    y: sp(ann.y, "y"),
                    width: sp(Math.abs(ann.width), "x"),
                    height: sp(Math.abs(ann.height), "y"),
                    centerX: sp(pivotX, "x"),
                    centerY: sp(pivotY, "y"),
                };
                if (ann.eraserStrokes?.length) {
                    geometry.eraserStrokes = ann.eraserStrokes.map(es => ({
                        size: Math.round(es.size * scaleX * 100) / 100,
                        points: eraserLocalToOrigAbs(
                            es.points, pivotX, pivotY, ann.rotation ?? 0
                        ),
                    }));
                }
            } else if (ann.type === "circle") {
                geometry = {
                    centerX: sp(ann.x, "x"),
                    centerY: sp(ann.y, "y"),
                    radiusX: sp(Math.abs(ann.radiusX ?? ann.radius ?? 0), "x"),
                    radiusY: sp(Math.abs(ann.radiusY ?? ann.radius ?? 0), "y"),
                };
                if (ann.eraserStrokes?.length) {
                    geometry.eraserStrokes = ann.eraserStrokes.map(es => ({
                        size: Math.round(es.size * scaleX * 100) / 100,
                        points: eraserLocalToOrigAbs(
                            es.points, ann.x, ann.y, ann.rotation ?? 0
                        ),
                    }));
                }
            } else if (ann.type === "line") {
                const cx = ann.x ?? 0, cy = ann.y ?? 0;
                const abs = absOrigPts(cx, cy, ann.points);
                geometry = { x1: abs[0], y1: abs[1], x2: abs[2], y2: abs[3] };
                if (ann.eraserStrokes?.length) {
                    geometry.eraserStrokes = ann.eraserStrokes.map(es => ({
                        size: Math.round(es.size * scaleX * 100) / 100,
                        points: eraserLocalToOrigAbs(
                            es.points, cx, cy, ann.rotation ?? 0
                        ),
                    }));
                }
            } else if (
                ann.type === "brush" ||
                ann.type === "arc" ||
                ann.type === "polygon"
            ) {
                const cx = ann.x ?? 0, cy = ann.y ?? 0;
                geometry = {
                    centroidX: sp(cx, "x"),
                    centroidY: sp(cy, "y"),
                    points: absOrigPts(cx, cy, ann.points),
                    closed: ann.type === "arc" || ann.type === "polygon",
                };
                if (ann.eraserStrokes?.length) {
                    geometry.eraserStrokes = ann.eraserStrokes.map(es => ({
                        size: Math.round(es.size * scaleX * 100) / 100,
                        points: eraserLocalToOrigAbs(
                            es.points, cx, cy, ann.rotation ?? 0
                        ),
                    }));
                }
            }
            return { ...base, ...geometry };
        });

    return {
        image: {
            name: imageItem.name,
            path: imageItem.path,
            naturalWidth: imageItem.naturalW,
            naturalHeight: imageItem.naturalH,
            datasetId: imageItem.datasetId ?? null,
            imageId: imageItem.externalId ?? null,
        },
        annotationCount: exportedAnnotations.length,
        annotations: exportedAnnotations,
        savedAt: new Date().toISOString(),
    };
}

/* ─── SaveModal ──────────────────────────────────────────────────────────── */
const SaveModal = ({ payload, onClose }) => {
    const { items } = payload;
    const [copied, setCopied] = useState(false);

    const totalShapes = items.reduce((s, it) => s + it.annotationCount, 0);
    const json = items.length === 1
        ? JSON.stringify(items[0], null, 2)
        : JSON.stringify({
            savedAt: new Date().toISOString(),
            totalImages: items.length,
            totalAnnotations: totalShapes,
            images: items,
        }, null, 2);

    const handleCopy = () => {
        navigator.clipboard.writeText(json).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleDownload = () => {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `annotations_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const currentMeta = items[0];

    return (
        <div className={styles.modalOverlay} onClick={onClose}>
            <div className={styles.modalBox} onClick={e => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                    <span className={styles.modalTitle}>
                        Annotations
                        <span className={styles.modalBadge}>
                            {totalShapes} shape{totalShapes !== 1 ? "s" : ""}
                        </span>
                    </span>
                    <button className={styles.modalClose} onClick={onClose} title="Close">×</button>
                </div>

                <div className={styles.modalMeta}>
                    <span>{currentMeta.image.path || currentMeta.image.name}</span>
                    <span>{currentMeta.image.naturalWidth} × {currentMeta.image.naturalHeight}px</span>
                    <span>{currentMeta.annotationCount} annotation{currentMeta.annotationCount !== 1 ? "s" : ""}</span>
                </div>

                <pre className={styles.modalPre}>{json}</pre>

                <div className={styles.modalActions}>
                    <button className={styles.modalBtn} onClick={handleCopy}>
                        {copied ? "✓ Copied" : "Copy JSON"}
                    </button>
                    <button className={`${styles.modalBtn} ${styles.modalBtnPrimary}`} onClick={handleDownload}>
                        Download .json
                    </button>
                </div>
            </div>
        </div>
    );
};

/* ─── Main component ────────────────────────────────────────────────────── */
const ImageAnnotator = forwardRef(({ image }, ref) => {
    /* Single-image record — built from the `image` prop. */
    const [imageRecord, setImageRecord] = useState(null);
    /* Per-image annotation state, keyed by internal id (kept as a map so the
       existing history / opacity / save logic can stay identical). */
    const [imageStates, setImageStates] = useState({});
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
    const [opacity, setOpacity] = useState(1);
    const [eraserSize, setEraserSize] = useState(20);
    const [eraserPos, setEraserPos] = useState(null);
    const [liveEraserStroke, setLiveEraserStroke] = useState(null);
    const [stageDims, setStageDims] = useState({ w: 800, h: 600 });
    const [saveModal, setSaveModal] = useState(null);
    const [colorPickerOpen, setColorPickerOpen] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [loading, setLoading] = useState(false);

    const colorPickerRef = useRef(null);
    const primaryDownRef = useRef(false);
    const eraserStrokeRef = useRef(null);
    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const canvasWrapRef = useRef(null);

    /* ── Derived ── */
    const activeImageId = imageRecord?.id ?? null;
    const activeImage = imageRecord;
    const emptyState = { annotations: [], history: [[]], historyStep: 0 };
    const activeState = activeImageId
        ? (imageStates[activeImageId] ?? emptyState)
        : emptyState;
    const { annotations, history, historyStep } = activeState;

    const shapeAnnotations = annotations.filter(
        a => a != null && a.type !== "eraser" && a.type !== "baked"
    );

    /* ── History helpers ── */
    const pushHistory = useCallback((newAnns) => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            const newHist = cur.history
                .slice(0, cur.historyStep + 1)
                .concat([newAnns]);
            return {
                ...prev,
                [activeImageId]: {
                    ...cur,
                    annotations: newAnns,
                    history: newHist,
                    historyStep: newHist.length - 1,
                },
            };
        });
    }, [activeImageId]);

    const undo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep === 0) return prev;
            const step = cur.historyStep - 1;
            return {
                ...prev,
                [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step },
            };
        });
        setSelectedId(null);
    }, [activeImageId]);

    const redo = useCallback(() => {
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            if (cur.historyStep >= cur.history.length - 1) return prev;
            const step = cur.historyStep + 1;
            return {
                ...prev,
                [activeImageId]: { ...cur, annotations: cur.history[step], historyStep: step },
            };
        });
    }, [activeImageId]);

    /* ── Transformer sync ── */
    useEffect(() => {
        if (!transformerRef.current || !stageRef.current) return;
        if (selectedId && tool === TOOLS.SELECT) {
            const node = stageRef.current.findOne(`#${selectedId}`);
            if (node) {
                transformerRef.current.nodes([node]);
                transformerRef.current.getLayer()?.batchDraw();
                return;
            }
        }
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
    }, [selectedId, tool, annotations]);

    /* ── Apply opacity slider change to all existing shapes ── */
    const opacityInitRef = useRef(false);
    useEffect(() => {
        if (!opacityInitRef.current) { opacityInitRef.current = true; return; }
        if (!activeImageId) return;
        setImageStates((prev) => {
            const cur = prev[activeImageId] ?? emptyState;
            const hasShapes = cur.annotations.some(
                a => a != null && a.type !== "eraser" && a.type !== "baked"
            );
            if (!hasShapes) return prev;
            const newAnns = cur.annotations.map((a) => {
                if (!a || a.type === "eraser" || a.type === "baked") return a;
                return { ...a, opacity };
            });
            const newHist = cur.history
                .slice(0, cur.historyStep + 1)
                .concat([newAnns]);
            return {
                ...prev,
                [activeImageId]: {
                    ...cur,
                    annotations: newAnns,
                    history: newHist,
                    historyStep: newHist.length - 1,
                },
            };
        });
    }, [opacity, activeImageId]);

    /* ── Transform / drag handlers ── */
    const handleTransformEnd = useCallback((ann) => {
        const node = stageRef.current?.findOne(`#${ann.id}`);
        if (!node) return;

        const sx = node.scaleX();
        const sy = node.scaleY();
        const nx = node.x();
        const ny = node.y();
        const nr = node.rotation();

        let patch = { rotation: nr, scaleX: 1, scaleY: 1 };

        const scaleLocalEraserStrokes = (strokes, scaleX, scaleY) =>
            (strokes ?? []).map(es => ({
                ...es,
                points: es.points.map((v, i) =>
                    i % 2 === 0 ? v * scaleX : v * scaleY
                ),
            }));

        if (ann.type === "rect") {
            const newW = Math.abs(ann.width) * Math.abs(sx);
            const newH = Math.abs(ann.height) * Math.abs(sy);
            patch = {
                ...patch,
                x: nx - newW / 2,
                y: ny - newH / 2,
                width: newW,
                height: newH,
                eraserStrokes: scaleLocalEraserStrokes(
                    ann.eraserStrokes, Math.abs(sx), Math.abs(sy)
                ),
            };
        } else if (ann.type === "circle") {
            const oldRx = ann.radiusX ?? ann.radius ?? 0;
            const oldRy = ann.radiusY ?? ann.radius ?? 0;
            patch = {
                ...patch,
                x: nx,
                y: ny,
                radiusX: Math.abs(oldRx) * Math.abs(sx),
                radiusY: Math.abs(oldRy) * Math.abs(sy),
                radius: Math.abs(oldRx) * Math.abs(sx),
                eraserStrokes: scaleLocalEraserStrokes(
                    ann.eraserStrokes, Math.abs(sx), Math.abs(sy)
                ),
            };
        } else if (
            ann.type === "line" ||
            ann.type === "brush" ||
            ann.type === "arc" ||
            ann.type === "polygon"
        ) {
            const scaledRelPts = ann.points.map((v, i) =>
                i % 2 === 0 ? v * sx : v * sy
            );
            patch = {
                ...patch,
                x: nx,
                y: ny,
                points: scaledRelPts,
                eraserStrokes: scaleLocalEraserStrokes(
                    ann.eraserStrokes, Math.abs(sx), Math.abs(sy)
                ),
            };
        }

        node.scaleX(1);
        node.scaleY(1);

        pushHistory(
            annotations.map((a) => a.id === ann.id ? { ...a, ...patch } : a)
        );
    }, [annotations, pushHistory]);

    const handleDragEnd = useCallback((ann, e) => {
        const node = e.target;
        const nx = node.x();
        const ny = node.y();

        let patch;
        if (ann.type === "rect") {
            patch = {
                x: nx - Math.abs(ann.width) / 2,
                y: ny - Math.abs(ann.height) / 2,
            };
        } else if (ann.type === "circle") {
            patch = { x: nx, y: ny };
        } else {
            patch = { x: nx, y: ny };
        }

        pushHistory(
            annotations.map((a) => a.id === ann.id ? { ...a, ...patch } : a)
        );
    }, [annotations, pushHistory]);

    /* ── Centering / sizing helper ── */
    const computeDisplaySize = useCallback((naturalW, naturalH) => {
        const el = canvasWrapRef.current;
        const cw = el ? el.clientWidth : window.innerWidth;
        const ch = el ? el.clientHeight : window.innerHeight - 40;
        const ratio = Math.min(cw / naturalW, ch / naturalH, 1);
        return {
            dw: Math.round(naturalW * ratio),
            dh: Math.round(naturalH * ratio),
            cw, ch,
        };
    }, []);

    /* ── Register an HTMLImage element into IMG_STORE + state ── */
    const registerImage = useCallback((htmlImg, meta) => {
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        IMG_STORE.set(id, htmlImg);

        const entry = {
            id,
            name: meta.name,
            path: meta.path ?? meta.name,
            naturalW: htmlImg.naturalWidth,
            naturalH: htmlImg.naturalHeight,
            datasetId: meta.datasetId ?? null,
            externalId: meta.externalId ?? null,
            sourceUrl: meta.sourceUrl ?? null,
        };

        setImageStates(prev => ({
            ...prev,
            [id]: { annotations: [], history: [[]], historyStep: 0 },
        }));

        return entry;
    }, []);

    /* ── Activate (size + center) — called after image loads ── */
    const activateRecord = useCallback((entry) => {
        const { dw, dh, cw, ch } = computeDisplaySize(entry.naturalW, entry.naturalH);
        setDisplaySize({ w: dw, h: dh });
        setSelectedId(null);
        setPolyPoints([]);
        setScale(1);
        setStagePos({ x: (cw - dw) / 2, y: (ch - dh) / 2 });
        setDrawing(false);
        setCurrentShape(null);
        eraserStrokeRef.current = null;
        setLiveEraserStroke(null);
        setImageStates(prev => {
            const cur = prev[entry.id] ?? emptyState;
            if (cur.displayW === dw && cur.displayH === dh) return prev;
            return { ...prev, [entry.id]: { ...cur, displayW: dw, displayH: dh } };
        });
    }, [computeDisplaySize]);

    /* ── Load the image whenever the prop changes ── */
    useEffect(() => {
        if (!image?.url) {
            setImageRecord(null);
            setLoadError(null);
            return;
        }
        let cancelled = false;
        const { url, filename = "image", id: externalId, datasetId = null } = image;

        setLoading(true);
        setLoadError(null);

        loadImageFromUrl(url, filename)
            .then((htmlImg) => {
                if (cancelled) return;
                /* Drop the previous IMG_STORE entry so we don't leak across switches */
                if (imageRecord?.id) IMG_STORE.delete(imageRecord.id);

                const entry = registerImage(htmlImg, {
                    name: filename,
                    path: filename,
                    datasetId,
                    externalId,
                    sourceUrl: url,
                });
                setImageRecord(entry);
                /* Defer activate so canvasWrapRef has up-to-date size */
                requestAnimationFrame(() => {
                    if (!cancelled) activateRecord(entry);
                });
            })
            .catch((err) => {
                if (cancelled) return;
                console.error("ImageAnnotator: failed to load image", err);
                setLoadError(err.message || String(err));
                setImageRecord(null);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
        // We deliberately omit imageRecord/registerImage/activateRecord from
        // deps — they're refs/setters or derived from prop. We only want this
        // to re-run when the prop's url/id changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [image?.url, image?.id, image?.datasetId]);

    /* ── loadAnnotations (parent can call via ref to restore from API) ── */
    const loadAnnotations = useCallback((imagePayload) => {
        if (!imagePayload?.annotations || !activeImageId) {
            console.error("loadAnnotations: no active image or missing payload");
            return;
        }
        const entry = imageRecord;
        if (!entry) return;

        /* Use the stored display size for the active image */
        const cur = imageStates[entry.id] ?? emptyState;
        const dw = cur.displayW ?? displaySize.w;
        const dh = cur.displayH ?? displaySize.h;

        const sx = dw / entry.naturalW;
        const sy = dh / entry.naturalH;

        const convertedAnnotations = imagePayload.annotations.map((ann) => {
            const base = {
                id: ann.id ?? nextId(),
                type: ann.type,
                stroke: ann.stroke,
                strokeWidth: ann.strokeWidth / sx,
                fill: ann.fill ?? "transparent",
                opacity: ann.opacity ?? 1,
                rotation: ann.rotation ?? 0,
            };

            let geometry = {};

            if (ann.type === "rect") {
                geometry = {
                    x: ann.x * sx,
                    y: ann.y * sy,
                    width: ann.width * sx,
                    height: ann.height * sy,
                };
            } else if (ann.type === "circle") {
                geometry = {
                    x: ann.centerX * sx,
                    y: ann.centerY * sy,
                    radiusX: ann.radiusX * sx,
                    radiusY: ann.radiusY * sy,
                    radius: ann.radiusX * sx,
                };
            } else if (ann.type === "line") {
                const ax1 = ann.x1 * sx, ay1 = ann.y1 * sy;
                const ax2 = ann.x2 * sx, ay2 = ann.y2 * sy;
                const { cx, cy, relPts } = pointsToCentroidRelative([ax1, ay1, ax2, ay2]);
                geometry = { x: cx, y: cy, points: relPts };
            } else if (ann.type === "brush" || ann.type === "arc" || ann.type === "polygon") {
                const scaledPts = ann.points.map((v, i) => i % 2 === 0 ? v * sx : v * sy);
                const { cx, cy, relPts } = pointsToCentroidRelative(scaledPts);
                geometry = {
                    x: cx, y: cy,
                    points: relPts,
                    closed: ann.closed ?? (ann.type !== "brush"),
                };
            }

            if (ann.eraserStrokes?.length) {
                geometry.eraserStrokes = ann.eraserStrokes.map(es => {
                    const scaledPts = es.points.map((v, i) => i % 2 === 0 ? v * sx : v * sy);
                    return eraserStrokeToLocal(
                        { points: scaledPts, size: es.size * sx },
                        { ...base, ...geometry }
                    );
                });
            }
            return { ...base, ...geometry };
        });

        setImageStates(prev => {
            const cur = prev[entry.id] ?? emptyState;
            const newHist = [[], convertedAnnotations];
            return {
                ...prev,
                [entry.id]: {
                    ...cur,
                    annotations: convertedAnnotations,
                    history: newHist,
                    historyStep: 1,
                },
            };
        });
    }, [imageRecord, imageStates, displaySize.w, displaySize.h, activeImageId]);

    /* ── getAnnotations (parent can call via ref to grab current payload) ── */
    const getAnnotations = useCallback(() => {
        if (!imageRecord) return null;
        const state = imageStates[imageRecord.id];
        if (!state) return null;
        const dw = state.displayW ?? displaySize.w;
        const dh = state.displayH ?? displaySize.h;
        return buildSavePayload(imageRecord, state.annotations, dw, dh);
    }, [imageRecord, imageStates, displaySize]);

    useImperativeHandle(ref, () => ({
        loadAnnotations,
        getAnnotations,
    }), [loadAnnotations, getAnnotations]);

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
            const targetClass = e.target.getClassName?.();
            const isBackground = e.target === stageRef.current ||
                (targetClass === "Image" && e.target.id() !== selectedId);
            if (isBackground) setSelectedId(null);
            return;
        }

        if (tool === TOOLS.POLYGON) return;

        setDrawing(true);

        if (tool === TOOLS.ERASER) {
            const pos = getImagePos();
            setEraserPos(pos);
            const size = eraserSize / scale;
            const stroke = {
                id: nextId(), type: "eraser",
                points: [pos.x, pos.y], size,
            };
            eraserStrokeRef.current = stroke;
            setLiveEraserStroke(stroke);
            return;
        }

        const pos = getImagePos();
        if (tool === TOOLS.RECT)
            setCurrentShape({
                id: nextId(), type: "rect",
                x: pos.x, y: pos.y, width: 0, height: 0,
                stroke: strokeColor, strokeWidth, fill: fillColor, opacity,
            });
        else if (tool === TOOLS.CIRCLE)
            setCurrentShape({
                id: nextId(), type: "circle",
                x: pos.x, y: pos.y,
                radiusX: 0, radiusY: 0,
                stroke: strokeColor, strokeWidth, fill: fillColor, opacity,
            });
        else if (tool === TOOLS.LINE)
            setCurrentShape({
                id: nextId(), type: "line",
                points: [pos.x, pos.y, pos.x, pos.y],
                stroke: strokeColor, strokeWidth, fill: "transparent", opacity,
            });
        else if (tool === TOOLS.BRUSH)
            setCurrentShape({
                id: nextId(), type: "brush",
                points: [pos.x, pos.y],
                stroke: strokeColor, strokeWidth, fill: "transparent", opacity,
            });
        else if (tool === TOOLS.ARC)
            setCurrentShape({
                id: nextId(), type: "arc",
                points: [pos.x, pos.y],
                stroke: strokeColor, strokeWidth,
                fill: fillColor === "transparent" ? strokeColor + "44" : fillColor,
                opacity,
            });
    }, [
        activeImage, tool, strokeColor, strokeWidth, fillColor, opacity,
        scale, eraserSize, selectedId, getImagePos,
    ]);

    const handleMouseMove = useCallback(() => {
        if (tool === TOOLS.ERASER) {
            const pos = getImagePos();
            setEraserPos(pos);
            if (drawing && eraserStrokeRef.current) {
                const updated = {
                    ...eraserStrokeRef.current,
                    points: [...eraserStrokeRef.current.points, pos.x, pos.y],
                };
                eraserStrokeRef.current = updated;
                setLiveEraserStroke({ ...updated });
            }
            return;
        }

        if (!drawing || !currentShape) return;
        const pos = getImagePos();

        if (tool === TOOLS.RECT)
            setCurrentShape((s) => ({
                ...s, width: pos.x - s.x, height: pos.y - s.y,
            }));
        else if (tool === TOOLS.CIRCLE) {
            const dx = Math.abs(pos.x - currentShape.x);
            const dy = Math.abs(pos.y - currentShape.y);
            setCurrentShape((s) => ({ ...s, radiusX: dx, radiusY: dy }));
        }
        else if (tool === TOOLS.LINE)
            setCurrentShape((s) => ({
                ...s, points: [s.points[0], s.points[1], pos.x, pos.y],
            }));
        else if (tool === TOOLS.BRUSH)
            setCurrentShape((s) => ({
                ...s, points: [...s.points, pos.x, pos.y],
            }));
        else if (tool === TOOLS.ARC)
            setCurrentShape((s) => ({
                ...s, points: [...s.points, pos.x, pos.y],
            }));
    }, [drawing, tool, currentShape, getImagePos]);

    const handleMouseUp = useCallback(() => {
        if (!drawing) return;
        setDrawing(false);

        if (tool === TOOLS.ERASER) {
            const finishedStroke = eraserStrokeRef.current;
            eraserStrokeRef.current = null;
            setLiveEraserStroke(null);
            if (!finishedStroke || !activeImageId) return;

            setImageStates((prev) => {
                const cur = prev[activeImageId] ?? emptyState;
                const newAnns = cur.annotations.map((ann) => {
                    if (!ann || ann.type === "eraser" || ann.type === "baked") return ann;
                    if (!eraserTouchesAnn(finishedStroke, ann)) return ann;
                    const localStroke = eraserStrokeToLocal(finishedStroke, ann);
                    return {
                        ...ann,
                        eraserStrokes: [...(ann.eraserStrokes ?? []), localStroke],
                    };
                });
                const newHist = cur.history
                    .slice(0, cur.historyStep + 1)
                    .concat([newAnns]);
                return {
                    ...prev,
                    [activeImageId]: {
                        ...cur,
                        annotations: newAnns,
                        history: newHist,
                        historyStep: newHist.length - 1,
                    },
                };
            });
            return;
        }

        if (!currentShape) return;

        const MIN = 3;
        if (currentShape.type === "rect" &&
            (Math.abs(currentShape.width) < MIN || Math.abs(currentShape.height) < MIN)) {
            setCurrentShape(null); return;
        }
        if (currentShape.type === "circle" &&
            (currentShape.radiusX ?? currentShape.radius ?? 0) < MIN &&
            (currentShape.radiusY ?? currentShape.radius ?? 0) < MIN) {
            setCurrentShape(null); return;
        }
        if (currentShape.type === "brush") {
            const pts = currentShape.points;
            if (pts.length < 4 ||
                Math.hypot(pts[pts.length - 2] - pts[0], pts[pts.length - 1] - pts[1]) < MIN) {
                setCurrentShape(null); return;
            }
        }
        if (currentShape.type === "arc") {
            const pts = currentShape.points;
            if (pts.length < 6) { setCurrentShape(null); return; }
        }
        if (currentShape.type === "line") {
            const pts = currentShape.points;
            if (Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < MIN) {
                setCurrentShape(null); return;
            }
        }

        let shape = currentShape;
        if (shape.type === "rect") {
            shape = {
                ...shape,
                x: shape.width >= 0 ? shape.x : shape.x + shape.width,
                y: shape.height >= 0 ? shape.y : shape.y + shape.height,
                width: Math.abs(shape.width),
                height: Math.abs(shape.height),
            };
        } else if (
            shape.type === "line" ||
            shape.type === "brush" ||
            shape.type === "arc"
        ) {
            const { cx, cy, relPts } = pointsToCentroidRelative(shape.points);
            shape = { ...shape, x: cx, y: cy, points: relPts };
        }

        pushHistory([...annotations, shape]);
        setCurrentShape(null);
    }, [drawing, tool, currentShape, annotations, activeImageId, pushHistory]);

    const handleStageClick = useCallback((e) => {
        if (!primaryDownRef.current) return;
        if (tool !== TOOLS.POLYGON) return;
        const pos = getImagePos();
        if (e.evt.detail === 2) {
            if (polyPoints.length >= 6) {
                const { cx, cy, relPts } = pointsToCentroidRelative(polyPoints);
                pushHistory([
                    ...annotations,
                    {
                        id: nextId(), type: "polygon",
                        x: cx, y: cy,
                        points: relPts,
                        stroke: strokeColor, strokeWidth,
                        fill: fillColor, closed: true, opacity,
                    },
                ]);
            }
            setPolyPoints([]);
        } else {
            setPolyPoints((pts) => [...pts, pos.x, pos.y]);
        }
    }, [tool, polyPoints, annotations, strokeColor, strokeWidth, fillColor, opacity, pushHistory, getImagePos]);

    const deleteSelected = useCallback(() => {
        if (!selectedId) return;
        pushHistory(annotations.filter((a) => a.id !== selectedId));
        setSelectedId(null);
    }, [selectedId, annotations, pushHistory]);

    const handleSave = useCallback(() => {
        if (!imageRecord) return;
        const state = imageStates[imageRecord.id];
        if (!state) return;
        const hasAnnotations = state.annotations.some(
            a => a != null && a.type !== "eraser" && a.type !== "baked"
        );
        if (!hasAnnotations) return;
        const dw = state.displayW ?? displaySize.w;
        const dh = state.displayH ?? displaySize.h;
        const payload = buildSavePayload(imageRecord, state.annotations, dw, dh);
        setSaveModal({ items: [payload] });
    }, [imageRecord, imageStates, displaySize]);

    /* ── Keyboard shortcuts ── */
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
                e.preventDefault(); undo();
            }
            if ((e.ctrlKey || e.metaKey) &&
                (e.key === "y" || (e.shiftKey && e.key === "z"))) {
                e.preventDefault(); redo();
            }
            if (e.key === "Escape") {
                setPolyPoints([]); setDrawing(false); setCurrentShape(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [deleteSelected, undo, redo]);

    /* ── Wheel zoom ── */
    useEffect(() => {
        const el = canvasWrapRef.current;
        if (!el) return;
        const onWheel = (e) => {
            e.preventDefault();
            if (!stageRef.current || !activeImage) return;
            const dir = e.deltaY < 0 ? 1 : -1;
            const oldScale = scale;
            const newScale = Math.min(
                10,
                Math.max(0.05, dir > 0 ? oldScale * 1.08 : oldScale / 1.08)
            );
            const cw = el.clientWidth, ch = el.clientHeight;
            const imgW = displaySize.w * newScale, imgH = displaySize.h * newScale;
            let nx, ny;
            if (imgW <= cw && imgH <= ch) {
                nx = (cw - imgW) / 2; ny = (ch - imgH) / 2;
            } else {
                const ptr = stageRef.current.getPointerPosition() ?? {
                    x: cw / 2, y: ch / 2,
                };
                const ix = (ptr.x - stagePos.x) / oldScale;
                const iy = (ptr.y - stagePos.y) / oldScale;
                nx = Math.max(
                    Math.min(0, cw - imgW),
                    Math.min(0, ptr.x - ix * newScale)
                );
                ny = Math.max(
                    Math.min(0, ch - imgH),
                    Math.min(0, ptr.y - iy * newScale)
                );
            }
            setScale(newScale);
            setStagePos({ x: nx, y: ny });
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scale, stagePos, displaySize, activeImage]);

    const handleZoomBtn = (delta) => {
        const el = canvasWrapRef.current;
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
        const el = canvasWrapRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() =>
            setStageDims({ w: el.clientWidth, h: el.clientHeight })
        );
        ro.observe(el);
        setStageDims({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);

    /* ── Close color picker when clicking outside ── */
    useEffect(() => {
        if (!colorPickerOpen) return;
        const onPointerDown = (e) => {
            if (colorPickerRef.current && !colorPickerRef.current.contains(e.target)) {
                setColorPickerOpen(null);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [colorPickerOpen]);

    const getCursor = () => {
        if (tool === TOOLS.ERASER) return "none";
        if (tool === TOOLS.SELECT) return "default";
        return "crosshair";
    };

    const hasAnyAnnotations = useMemo(() => annotations.some(
        a => a != null && a.type !== "eraser" && a.type !== "baked"
    ), [annotations]);

    return (
        <div className={styles.root}>

            {/* ── Top toolbar ── */}
            <header className={styles.toolbar}>

                {/* Tools */}
                <div className={styles.tbGroup}>
                    {Object.values(TOOLS).map((t) => (
                        <button
                            key={t}
                            className={`${styles.tbTool} ${tool === t ? styles.tbToolActive : ""}`}
                            onClick={() => {
                                setTool(t);
                                setPolyPoints([]);
                                setDrawing(false);
                                setCurrentShape(null);
                                if (t !== TOOLS.ERASER) setEraserPos(null);
                            }}
                            title={
                                t === TOOLS.SELECT ? "Select / Move / Resize / Rotate" :
                                    t === TOOLS.RECT ? "Rectangle" :
                                        t === TOOLS.CIRCLE ? "Ellipse / Circle" :
                                            t === TOOLS.LINE ? "Line" :
                                                t === TOOLS.POLYGON ? "Polygon — click points, dbl-click to close" :
                                                    t === TOOLS.BRUSH ? "Freehand Brush" :
                                                        t === TOOLS.ARC ? "Closed Shape / Mask" :
                                                            "Eraser"
                            }
                        >
                            <span className={styles.tbToolIcon}>{TOOL_ICONS[t]}</span>
                            <span className={styles.tbToolLabel}>{t}</span>
                        </button>
                    ))}
                </div>
                <div className={styles.tbSep} />

                {/* Color pickers */}
                <div ref={colorPickerRef} style={{ display: "contents" }}>

                    <div className={styles.tbGroup}>
                        <div className={styles.tbColorPicker}>
                            <button
                                className={`${styles.tbSwatchBtn} ${colorPickerOpen === "stroke" ? styles.tbSwatchOpen : ""}`}
                                onClick={() => setColorPickerOpen(p => p === "stroke" ? null : "stroke")}
                                title={`Stroke color: ${strokeColor}`}
                            >
                                <span
                                    className={styles.tbSwatchCircle}
                                    style={{ background: strokeColor }}
                                />
                                <span className={styles.tbColorLabel}>Stroke</span>
                                <svg viewBox="0 0 10 6" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.5 }}>
                                    <path d="M1 1l4 4 4-4" />
                                </svg>
                            </button>

                            {colorPickerOpen === "stroke" && (
                                <div className={styles.colorPanel}>
                                    <div className={styles.colorPanelTitle}>Stroke Color</div>
                                    <div className={styles.colorPanelGrid}>
                                        {STROKE_COLORS.map((c) => (
                                            <button
                                                key={c}
                                                className={`${styles.colorPanelDot} ${strokeColor === c ? styles.colorPanelDotActive : ""}`}
                                                style={{ background: c, border: c === "#ffffff" ? "1.5px solid #444" : "1.5px solid transparent" }}
                                                onClick={() => { setStrokeColor(c); setColorPickerOpen(null); }}
                                                title={c}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className={styles.tbSep} />

                    <div className={styles.tbGroup}>
                        <div className={styles.tbColorPicker}>
                            <button
                                className={`${styles.tbSwatchBtn} ${colorPickerOpen === "fill" ? styles.tbSwatchOpen : ""}`}
                                onClick={() => setColorPickerOpen(p => p === "fill" ? null : "fill")}
                                title={fillColor === "transparent" ? "Fill: None" : `Fill color: ${fillColor}`}
                            >
                                <span
                                    className={`${styles.tbSwatchCircle} ${fillColor === "transparent" ? styles.swatchTransparent : ""}`}
                                    style={{ background: fillColor === "transparent" ? "transparent" : fillColor }}
                                />
                                <span className={styles.tbColorLabel}>Fill</span>
                                <svg viewBox="0 0 10 6" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.5 }}>
                                    <path d="M1 1l4 4 4-4" />
                                </svg>
                            </button>

                            {colorPickerOpen === "fill" && (
                                <div className={styles.colorPanel}>
                                    <div className={styles.colorPanelTitle}>Fill Color</div>
                                    <div className={styles.colorPanelGrid}>
                                        {FILL_COLORS.map((c) => (
                                            <button
                                                key={c}
                                                className={`${styles.colorPanelDot} ${fillColor === c ? styles.colorPanelDotActive : ""} ${c === "transparent" ? styles.colorTransparent : ""}`}
                                                style={{
                                                    background: c === "transparent" ? "#1e1e24" : c,
                                                    border: fillColor === c ? "2px solid #fff" : "1.5px solid transparent",
                                                }}
                                                onClick={() => { setFillColor(c); setColorPickerOpen(null); }}
                                                title={c === "transparent" ? "No fill" : c}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>{/* end colorPickerRef wrapper */}
                <div className={styles.tbSep} />

                {/* Stroke width / Eraser size */}
                <div className={styles.tbGroup}>
                    {tool === TOOLS.ERASER ? (
                        <div className={styles.tbSliderBlock}>
                            <div className={styles.tbSliderRow}>
                                <input
                                    type="range" min="4" max="50" value={eraserSize}
                                    onChange={(e) => setEraserSize(Number(e.target.value))}
                                    className={styles.tbSlider}
                                />
                                <span className={styles.tbSliderVal}>{eraserSize}px</span>
                            </div>
                            <span className={styles.tbSliderLabel}>ERASER</span>
                        </div>
                    ) : (
                        <div className={styles.tbSliderBlock}>
                            <div className={styles.tbSliderRow}>
                                <input
                                    type="range" min="1" max="20" value={strokeWidth}
                                    onChange={(e) => setStrokeWidth(Number(e.target.value))}
                                    className={styles.tbSlider}
                                />
                                <span className={styles.tbSliderVal}>{strokeWidth}px</span>
                            </div>
                            <span className={styles.tbSliderLabel}>WIDTH</span>
                        </div>
                    )}
                </div>

                {tool !== TOOLS.ERASER && <div className={styles.tbSep} />}

                {tool !== TOOLS.ERASER && (
                    <div className={styles.tbGroup}>
                        <div className={styles.tbSliderBlock}>
                            <div className={styles.tbSliderRow}>
                                <input
                                    type="range" min="0" max="100" step="1"
                                    value={Math.round(opacity * 100)}
                                    onChange={(e) => setOpacity(Math.round(Number(e.target.value)) / 100)}
                                    className={styles.tbSlider}
                                />
                                <span className={styles.tbSliderVal}>{Math.round(opacity * 100)}%</span>
                            </div>
                            <span className={styles.tbSliderLabel}>OPACITY</span>
                        </div>
                    </div>
                )}
                <div className={styles.tbSep} />

                {/* Zoom */}
                <div className={styles.tbGroup}>
                    <button className={styles.tbIconBtn} onClick={() => handleZoomBtn(-0.15)} title="Zoom out">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14">
                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                    </button>
                    <span className={styles.tbZoomVal}>{Math.round(scale * 100)}%</span>
                    <button className={styles.tbIconBtn} onClick={() => handleZoomBtn(+0.15)} title="Zoom in">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14">
                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                    </button>
                    <button
                        className={styles.tbTextBtn}
                        onClick={() => {
                            const el = canvasWrapRef.current;
                            const cw = el?.clientWidth ?? 800;
                            const ch = el?.clientHeight ?? 600;
                            setScale(1);
                            setStagePos({
                                x: (cw - displaySize.w) / 2,
                                y: (ch - displaySize.h) / 2,
                            });
                        }}
                        title="Reset to 100%"
                    >
                        1:1
                    </button>
                </div>
                <div className={styles.tbSep} />

                {/* Undo / Redo / Delete */}
                <div className={styles.tbGroup}>
                    <button className={styles.tbIconBtn} onClick={undo} disabled={historyStep === 0} title="Undo (Ctrl+Z)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                            <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                        </svg>
                    </button>
                    <button className={styles.tbIconBtn} onClick={redo} disabled={historyStep >= history.length - 1} title="Redo (Ctrl+Y)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                            <path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
                        </svg>
                    </button>
                    <button className={`${styles.tbIconBtn} ${styles.tbDelete}`} onClick={deleteSelected} disabled={!selectedId} title="Delete selected (Del)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
                        </svg>
                    </button>
                </div>
                <div className={styles.tbSep} />

                {/* Save */}
                <button
                    className={styles.tbSaveBtn}
                    onClick={handleSave}
                    disabled={!hasAnyAnnotations}
                    title={hasAnyAnnotations ? "Save annotations" : "No annotations to save"}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                        <polyline points="17 21 17 13 7 13 7 21" />
                        <polyline points="7 3 7 8 15 8" />
                    </svg>
                    Save
                </button>

            </header>

            {/* ── Canvas — full width, no right panel ── */}
            <main
                ref={canvasWrapRef}
                className={styles.canvas}
                style={{ cursor: getCursor() }}
            >
                {!activeImage ? (
                    <div className={styles.empty}>
                        {loading ? (
                            <>
                                <svg viewBox="0 0 64 64" fill="none" stroke="currentColor"
                                    strokeWidth="1.5" width="44" height="44" opacity="0.4">
                                    <circle cx="32" cy="32" r="22" strokeDasharray="100 40">
                                        <animateTransform attributeName="transform" type="rotate"
                                            from="0 32 32" to="360 32 32" dur="1s" repeatCount="indefinite" />
                                    </circle>
                                </svg>
                                <div className={styles.emptySteps}>
                                    <div className={styles.emptyStep}>Loading image…</div>
                                </div>
                            </>
                        ) : loadError ? (
                            <div className={styles.emptySteps}>
                                <div className={styles.emptyStep}>
                                    Failed to load image
                                </div>
                                <div className={styles.emptyStep} style={{ fontSize: 11, color: "#888" }}>
                                    {loadError}
                                </div>
                            </div>
                        ) : (
                            <div className={styles.emptySteps}>
                                <div className={styles.emptyStep}>No image provided</div>
                            </div>
                        )}
                    </div>
                ) : (
                    <Stage
                        ref={stageRef}
                        width={stageDims.w}
                        height={stageDims.h}
                        x={stagePos.x}
                        y={stagePos.y}
                        scaleX={scale}
                        scaleY={scale}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={() => {
                            if (drawing) handleMouseUp();
                            setEraserPos(null);
                            setLiveEraserStroke(null);
                        }}
                        onClick={handleStageClick}
                        style={{ display: "block" }}
                    >
                        <Layer>
                            <UnifiedCanvas
                                imgId={activeImageId}
                                displayW={displaySize.w}
                                displayH={displaySize.h}
                                shapeAnnotations={shapeAnnotations}
                                liveEraserStroke={liveEraserStroke}
                            />

                            {shapeAnnotations.map((ann) => (
                                <KonvaAnnotation
                                    key={ann.id}
                                    ann={ann}
                                    isSelected={selectedId === ann.id}
                                    tool={tool}
                                    onSelect={setSelectedId}
                                    onDragEnd={(e) => handleDragEnd(ann, e)}
                                    onTransformEnd={() => handleTransformEnd(ann)}
                                />
                            ))}

                            <DrawingOverlay
                                currentShape={currentShape}
                                polyPoints={polyPoints}
                                strokeColor={strokeColor}
                                strokeWidth={strokeWidth}
                            />

                            <Transformer
                                ref={transformerRef}
                                keepRatio={false}
                                enabledAnchors={[
                                    "top-left", "top-center", "top-right",
                                    "middle-right", "middle-left",
                                    "bottom-left", "bottom-center", "bottom-right",
                                ]}
                                rotateEnabled={true}
                                boundBoxFunc={(oldBox, newBox) =>
                                    newBox.width < 5 || newBox.height < 5 ? oldBox : newBox
                                }
                            />

                            {tool === TOOLS.ERASER && eraserPos && (
                                <Rect
                                    x={eraserPos.x - eraserSize / scale}
                                    y={eraserPos.y - eraserSize / scale}
                                    width={(eraserSize / scale) * 2}
                                    height={(eraserSize / scale) * 2}
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
            </main>

            {/* ── Save Modal ── */}
            {saveModal && (
                <SaveModal
                    payload={saveModal}
                    onClose={() => setSaveModal(null)}
                />
            )}
        </div>
    );
});

ImageAnnotator.displayName = "ImageAnnotator";
export default ImageAnnotator;