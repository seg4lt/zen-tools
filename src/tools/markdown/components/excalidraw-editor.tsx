/**
 * Excalidraw drawing pane.
 *
 * Mounted by `MarkdownView` instead of the CodeMirror markdown editor
 * when the active tab's `kind === "excalidraw"`.  This file is the
 * **default export** so it can be loaded via `React.lazy()` — the
 * `@excalidraw/excalidraw` package weighs ~3 MB and we don't want it
 * in the main bundle.
 *
 * Lifecycle:
 * 1. On mount: `fetch(convertFileSrc(path))` for the file's bytes
 *    (works for both `.excalidraw.svg` text and `.excalidraw.png`
 *    binary; `loadFromBlob` inspects the MIME type itself).  Empty
 *    file → fresh empty scene.  Otherwise → `loadFromBlob` to
 *    restore the embedded scene.
 * 2. The `<Excalidraw>` component drives the canvas.  Its
 *    `onChange` callback hands us the live `{ elements, appState,
 *    files }` triplet, which we stash in a ref so the Cmd+S handler
 *    can serialise on demand without forcing React re-renders.
 * 3. First user edit fires `onDirty()` to flip the header dirty dot.
 * 4. Cmd+S calls either `exportToSvg` (for `.excalidraw.svg` paths)
 *    or `exportToBlob({ mimeType: "image/png" })` (for
 *    `.excalidraw.png` paths) with `appState.exportEmbedScene: true`.
 *    The serialised result — a string for SVG or a `Uint8Array` for
 *    PNG — is handed to `onSave(...)`; the store's
 *    `saveCurrent(overrideContent)` routes it to `writeFile` /
 *    `writeBytes` accordingly.
 *
 * The drawing data never lives in `tab.doc` — that string would
 * bounce through the reducer on every reducer pass and cost megabytes
 * of churn.  We treat the Excalidraw canvas as an out-of-band
 * authority and only round-trip the SVG bytes at read/save time.
 */

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  getCommonBounds,
  getNonDeletedElements,
  loadFromBlob,
  newElementWith,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawArrowElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Activity,
  Boxes,
  Copy,
  Database,
  Eye,
  EyeOff,
  Trash2,
  GripVertical,
  Layers3,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Presentation,
  FileText,
  Network,
  Search,
  Server,
  Shield,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { terminalSetTrafficLightsHidden } from "@/tools/terminal/lib/tauri";
import architectureComponentsLibraryRaw from "@/assets/excalidraw-libraries/architecture-components.excalidrawlib?raw";
import awsLibraryRaw from "@/assets/excalidraw-libraries/aws.excalidrawlib?raw";
import basicUxLibraryRaw from "@/assets/excalidraw-libraries/basic-ux.excalidrawlib?raw";
import devopsLibraryRaw from "@/assets/excalidraw-libraries/devops.excalidrawlib?raw";
import formsLibraryRaw from "@/assets/excalidraw-libraries/forms.excalidrawlib?raw";
import softwareArchitectureLibraryRaw from "@/assets/excalidraw-libraries/software-architecture.excalidrawlib?raw";
import softwareLogosLibraryRaw from "@/assets/excalidraw-libraries/software-logos.excalidrawlib?raw";
import stickyNotesLibraryRaw from "@/assets/excalidraw-libraries/sticky-notes.excalidrawlib?raw";
import systemDesignLibraryRaw from "@/assets/excalidraw-libraries/system-design.excalidrawlib?raw";
import umlErLibraryRaw from "@/assets/excalidraw-libraries/uml-er.excalidrawlib?raw";
import webKitLibraryRaw from "@/assets/excalidraw-libraries/web-kit.excalidrawlib?raw";

interface ExcalidrawEditorProps {
  /** Absolute path of the open `*.excalidraw.svg` *or*
   *  `*.excalidraw.png` file.  The trailing extension chooses which
   *  exporter the Cmd+S handler uses (SVG → text, PNG → binary). */
  path: string;
  /** Called on the first user-driven edit so the header can flip the
   *  dirty dot.  Called once per "load → first edit" cycle; the
   *  parent decides what to do with subsequent calls. */
  onDirty: () => void;
  /** Called from the local Cmd+S handler with the freshly serialised
   *  scene.  The host's `saveCurrent(...)` routes a `string` through
   *  `writeFile` (text, used for the SVG path) and a `Uint8Array`
   *  through `writeBytes` (binary, used for the PNG path). */
  onSave: (data: string | Uint8Array) => void;
  /** Called 500 ms after the last user edit with the serialized scene. */
  onAutoSave: (data: string | Uint8Array) => void;
  /** `"dark"` or `"light"` — passed straight through to Excalidraw. */
  theme: "light" | "dark";
}

/** Shape of the live drawing state — kept in a ref, not in React. */
interface LiveScene {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}

interface PresentationFrame {
  id: string;
  name: string | null;
  hidden: boolean;
}

interface AnimatedArrowPath {
  id: string;
  path: string;
  color: string;
  direction: "forward" | "reverse" | "both";
  speed: FlowSpeed;
  density: FlowDensity;
}

type FlowSpeed = "slow" | "normal" | "fast";
type FlowDensity = "sparse" | "normal" | "dense";
type FlowDirection = "auto" | "forward" | "reverse" | "both";
type ConnectorType =
  | "request"
  | "event"
  | "data"
  | "replication"
  | "network"
  | "control"
  | "trust";

interface FlowStyle {
  speed: FlowSpeed;
  density: FlowDensity;
  direction: FlowDirection;
  color: string | null;
  connectorType: ConnectorType;
  protocol: string;
}

interface ArchitectureService {
  provider: "AWS" | "Azure" | "Data" | "Generic";
  service: string;
  category: "compute" | "storage" | "database" | "network" | "security" | "messaging";
}

interface BundledLibraryItem {
  id: string;
  name: string;
  source: string;
  elements: readonly Record<string, unknown>[];
}

function parseLibraryItems(
  raw: string,
  source: BundledLibraryItem["source"],
): BundledLibraryItem[] {
  const parsed = JSON.parse(raw) as {
    libraryItems?: Array<{
      id: string;
      name?: string;
      elements: readonly Record<string, unknown>[];
    }>;
    library?: Array<readonly Record<string, unknown>[]>;
  };
  const modernItems = (parsed.libraryItems ?? []).map((item, index) => ({
    id: `${source}-${item.id}`,
    name: item.name?.trim() || `${source} icon ${index + 1}`,
    source,
    elements: item.elements,
  }));
  const legacyItems = (parsed.library ?? []).map((elements, index) => {
    const label = elements.find(
      (element) => element.type === "text" && typeof element.text === "string",
    )?.text;
    return {
      id: `${source}-legacy-${index}`,
      name:
        typeof label === "string" && label.trim()
          ? label.trim().split("\n")[0]
          : `${source} icon ${index + 1}`,
      source,
      elements,
    };
  });
  return [...modernItems, ...legacyItems];
}

const BUNDLED_LIBRARY_ITEMS = [
  ...parseLibraryItems(softwareArchitectureLibraryRaw, "Software Architecture"),
  ...parseLibraryItems(systemDesignLibraryRaw, "System Design Components"),
  ...parseLibraryItems(architectureComponentsLibraryRaw, "Architecture Components"),
  ...parseLibraryItems(softwareLogosLibraryRaw, "Software Logos"),
  ...parseLibraryItems(awsLibraryRaw, "AWS"),
  ...parseLibraryItems(umlErLibraryRaw, "UML & ER"),
  ...parseLibraryItems(formsLibraryRaw, "Forms"),
  ...parseLibraryItems(basicUxLibraryRaw, "Basic UX"),
  ...parseLibraryItems(devopsLibraryRaw, "DevOps"),
  ...parseLibraryItems(stickyNotesLibraryRaw, "Sticky Notes"),
  ...parseLibraryItems(webKitLibraryRaw, "Web Kit"),
];

function LibraryItemThumbnail({
  item,
  theme,
}: {
  item: BundledLibraryItem;
  theme: "light" | "dark";
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    let nearViewport = false;
    let rendering = false;
    const releasePreview = () => {
      if (!objectUrl) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      setSource(null);
    };
    const renderPreview = async () => {
      if (rendering || objectUrl || cancelled || !nearViewport) return;
      rendering = true;
      const elements = restoreElements(item.elements as never, null);
      try {
        const svg = await exportToSvg({
          elements,
          appState: {
            exportBackground: false,
            viewBackgroundColor: "transparent",
            theme,
            exportWithDarkMode: theme === "dark",
          } as AppState,
          files: {},
          exportPadding: 8,
        });
        if (cancelled || !nearViewport) return;
        objectUrl = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(svg)], {
            type: "image/svg+xml",
          }),
        );
        setSource(objectUrl);
      } finally {
        rendering = false;
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        nearViewport = entries.some((entry) => entry.isIntersecting);
        if (nearViewport) void renderPreview();
        else releasePreview();
      },
      { rootMargin: "240px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item, theme]);

  return (
    <span ref={hostRef} className="zen-excalidraw-library-thumbnail">
      {source ? <img src={source} alt="" /> : <Loader2 aria-hidden="true" />}
    </span>
  );
}

function LibraryResultsSentinel({
  hasMore,
  page,
  onVisible,
}: {
  hasMore: boolean;
  page: number;
  onVisible: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onVisibleRef.current();
        }
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, page]);

  if (!hasMore) return null;
  return (
    <div ref={sentinelRef} className="zen-excalidraw-library-sentinel">
      <Loader2 aria-hidden="true" />
      <span>Loading more diagrams…</span>
    </div>
  );
}

const ARCHITECTURE_SERVICES: ArchitectureService[] = [
  { provider: "AWS", service: "EC2", category: "compute" },
  { provider: "AWS", service: "Lambda", category: "compute" },
  { provider: "AWS", service: "ECS / EKS", category: "compute" },
  { provider: "AWS", service: "S3", category: "storage" },
  { provider: "AWS", service: "RDS", category: "database" },
  { provider: "AWS", service: "DynamoDB", category: "database" },
  { provider: "AWS", service: "API Gateway", category: "network" },
  { provider: "AWS", service: "CloudFront", category: "network" },
  { provider: "AWS", service: "VPC", category: "network" },
  { provider: "AWS", service: "SQS / SNS", category: "messaging" },
  { provider: "AWS", service: "IAM", category: "security" },
  { provider: "AWS", service: "Secrets Manager", category: "security" },
  { provider: "Azure", service: "Virtual Machines", category: "compute" },
  { provider: "Azure", service: "Functions", category: "compute" },
  { provider: "Azure", service: "AKS", category: "compute" },
  { provider: "Azure", service: "Blob Storage", category: "storage" },
  { provider: "Azure", service: "Azure SQL", category: "database" },
  { provider: "Azure", service: "Cosmos DB", category: "database" },
  { provider: "Azure", service: "API Management", category: "network" },
  { provider: "Azure", service: "VNet", category: "network" },
  { provider: "Azure", service: "Service Bus", category: "messaging" },
  { provider: "Azure", service: "Key Vault", category: "security" },
  { provider: "Data", service: "PostgreSQL", category: "database" },
  { provider: "Data", service: "MySQL", category: "database" },
  { provider: "Data", service: "MongoDB", category: "database" },
  { provider: "Data", service: "Redis", category: "database" },
  { provider: "Data", service: "Kafka", category: "messaging" },
  { provider: "Data", service: "Elasticsearch", category: "database" },
  { provider: "Generic", service: "Service", category: "compute" },
  { provider: "Generic", service: "Database", category: "database" },
  { provider: "Generic", service: "Queue", category: "messaging" },
  { provider: "Generic", service: "Network", category: "network" },
  { provider: "Generic", service: "Trust Boundary", category: "security" },
];

const ARCHITECTURE_NODE_KEY = "zenToolsArchitectureNode";
const ARCHITECTURE_INSTANCE_KEY = "zenToolsArchitectureInstance";
const MARKDOWN_CARD_KEY = "zenToolsMarkdownCard";

function ArchitectureCategoryIcon({ category }: { category: ArchitectureService["category"] }) {
  if (category === "database") return <Database aria-hidden="true" />;
  if (category === "network") return <Network aria-hidden="true" />;
  if (category === "security") return <Shield aria-hidden="true" />;
  if (category === "messaging") return <Boxes aria-hidden="true" />;
  return <Server aria-hidden="true" />;
}

function architectureIconLabel(service: ArchitectureService): string {
  const serviceName = service.service.toLowerCase();
  if (serviceName.includes("lambda") || serviceName.includes("functions")) return "λ";
  if (serviceName.includes("kafka") || serviceName.includes("queue") || serviceName.includes("sqs")) return "⇄";
  if (serviceName.includes("s3") || serviceName.includes("blob")) return "▤";
  if (service.category === "database") return "DB";
  if (service.category === "network") return "⇆";
  if (service.category === "security") return "◇";
  if (service.category === "messaging") return "⇝";
  return serviceName.includes("container") || serviceName.includes("eks") || serviceName.includes("aks")
    ? "▦"
    : "▣";
}

function markdownToCanvasText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("> [!IMPORTANT]")) return "⚠  IMPORTANT";
      if (line.startsWith("> [!NOTE]")) return "ⓘ  NOTE";
      if (line.startsWith("> ")) return `│ ${line.slice(2)}`;
      if (/^[-*] /.test(line)) return `• ${line.slice(2)}`;
      if (/^#{1,3} /.test(line)) return line.replace(/^#{1,3} /, "").toUpperCase();
      return line
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^!\[([^\]]*)\]\(.+\)$/, "🖼  $1");
    })
    .join("\n");
}

function createMarkdownCardElements(markdown: string, x: number, y: number) {
  const canvasText = markdownToCanvasText(markdown);
  const lines = canvasText.split("\n");
  const longestLine = Math.max(20, ...lines.map((line) => line.length));
  const width = Math.min(720, Math.max(360, longestLine * 9 + 48));
  const height = Math.min(640, Math.max(180, lines.length * 24 + 48));
  const groupId = `markdown-card-${crypto.randomUUID()}`;
  return convertToExcalidrawElements(
    [
      {
        type: "rectangle",
        x,
        y,
        width,
        height,
        backgroundColor: "#ffffff",
        strokeColor: "#6965db",
        fillStyle: "solid",
        strokeWidth: 2,
        roundness: { type: 3 },
        groupIds: [groupId],
        customData: {
          [MARKDOWN_CARD_KEY]: markdown,
          zenToolsMarkdownBaseWidth: width,
        },
      },
      {
        type: "text",
        x: x + 24,
        y: y + 22,
        text: canvasText,
        fontSize: 18,
        strokeColor: "#202124",
        groupIds: [groupId],
      },
    ] as unknown as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: true },
  );
}

const PRESENTATION_ORDER_KEY = "zenToolsPresentationOrder";
const PRESENTATION_HIDDEN_KEY = "zenToolsPresentationHidden";
const ANIMATED_ARROW_KEY = "zenToolsAnimatedArrow";
const FLOW_SPEED_KEY = "zenToolsFlowSpeed";
const FLOW_DENSITY_KEY = "zenToolsFlowDensity";
const FLOW_DIRECTION_KEY = "zenToolsFlowDirection";
const FLOW_COLOR_KEY = "zenToolsFlowColor";
const CONNECTOR_TYPE_KEY = "zenToolsConnectorType";
const CONNECTOR_PROTOCOL_KEY = "zenToolsConnectorProtocol";
const DEFAULT_FLOW_STYLE: FlowStyle = {
  speed: "normal",
  density: "normal",
  direction: "auto",
  color: null,
  connectorType: "request",
  protocol: "",
};
const POINTY_ARROWHEADS = new Set([
  "arrow",
  "triangle",
  "triangle_outline",
]);

type OrderedArrowElement = OrderedExcalidrawElement & ExcalidrawArrowElement;

function isDirectionalArrow(
  element: OrderedExcalidrawElement,
): element is OrderedArrowElement {
  return (
    !element.isDeleted &&
    element.type === "arrow" &&
    (POINTY_ARROWHEADS.has(element.startArrowhead ?? "") ||
      POINTY_ARROWHEADS.has(element.endArrowhead ?? ""))
  );
}

function flowStyleFromArrow(arrow: OrderedArrowElement): FlowStyle {
  const speed = arrow.customData?.[FLOW_SPEED_KEY];
  const density = arrow.customData?.[FLOW_DENSITY_KEY];
  const direction = arrow.customData?.[FLOW_DIRECTION_KEY];
  const color = arrow.customData?.[FLOW_COLOR_KEY];
  const connectorType = arrow.customData?.[CONNECTOR_TYPE_KEY];
  return {
    speed:
      speed === "slow" || speed === "fast" || speed === "normal"
        ? speed
        : "normal",
    density:
      density === "sparse" || density === "dense" || density === "normal"
        ? density
        : "normal",
    direction:
      direction === "forward" ||
      direction === "reverse" ||
      direction === "both" ||
      direction === "auto"
        ? direction
        : "auto",
    color: typeof color === "string" ? color : null,
    connectorType:
      connectorType === "event" ||
      connectorType === "data" ||
      connectorType === "replication" ||
      connectorType === "network" ||
      connectorType === "control" ||
      connectorType === "trust" ||
      connectorType === "request"
        ? connectorType
        : "request",
    protocol:
      typeof arrow.customData?.[CONNECTOR_PROTOCOL_KEY] === "string"
        ? arrow.customData[CONNECTOR_PROTOCOL_KEY]
        : "",
  };
}

function orderedPresentationFrames(
  elements: readonly OrderedExcalidrawElement[],
  preferredOrder?: readonly string[],
): PresentationFrame[] {
  const preferredRank = preferredOrder
    ? new Map(preferredOrder.map((id, index) => [id, index]))
    : null;
  return elements
    .map((element, sceneIndex) => ({ element, sceneIndex }))
    .filter(
      ({ element }) =>
        !element.isDeleted &&
        (element.type === "frame" || element.type === "magicframe"),
    )
    .sort((a, b) => {
      if (preferredRank) {
        const aPreferred = preferredRank.get(a.element.id) ?? Infinity;
        const bPreferred = preferredRank.get(b.element.id) ?? Infinity;
        if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      }
      const aOrder = a.element.customData?.[PRESENTATION_ORDER_KEY];
      const bOrder = b.element.customData?.[PRESENTATION_ORDER_KEY];
      const aRank = typeof aOrder === "number" ? aOrder : Infinity;
      const bRank = typeof bOrder === "number" ? bOrder : Infinity;
      return aRank - bRank || a.sceneIndex - b.sceneIndex;
    })
    .map(({ element }) => ({
      id: element.id,
      name:
        element.type === "frame" || element.type === "magicframe"
          ? element.name
          : null,
      hidden: element.customData?.[PRESENTATION_HIDDEN_KEY] === true,
    }));
}

function sameFrames(
  a: readonly PresentationFrame[],
  b: readonly PresentationFrame[],
): boolean {
  return (
    a.length === b.length &&
    a.every((frame, index) => {
      const other = b[index];
      return (
        frame.id === other?.id &&
        frame.name === other.name &&
        frame.hidden === other.hidden
      );
    })
  );
}

function sameFlowStyle(a: FlowStyle, b: FlowStyle): boolean {
  return (
    a.speed === b.speed &&
    a.density === b.density &&
    a.direction === b.direction &&
    a.color === b.color &&
    a.connectorType === b.connectorType &&
    a.protocol === b.protocol
  );
}

function flowPathFromPoints(
  points: readonly { x: number; y: number }[],
  curved: boolean,
): string {
  const first = points[0];
  if (!first) return "";
  if (!curved || points.length < 3) {
    return `M ${first.x} ${first.y} ${points
      .slice(1)
      .map((point) => `L ${point.x} ${point.y}`)
      .join(" ")}`;
  }
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    path += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

export default function ExcalidrawEditor({
  path,
  onDirty,
  onSave,
  onAutoSave,
  theme,
}: ExcalidrawEditorProps) {
  const [initialData, setInitialData] = useState<
    ExcalidrawInitialDataState | null | undefined
  >(undefined); // `undefined` = still loading
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [presentationFrameIds, setPresentationFrameIds] = useState<string[]>(
    [],
  );
  const [presentationIndex, setPresentationIndex] = useState(0);
  const [frames, setFrames] = useState<PresentationFrame[]>([]);
  const [frameThumbnails, setFrameThumbnails] = useState<
    Record<string, string>
  >({});
  const [framePanelOpen, setFramePanelOpen] = useState(false);
  const [architecturePanelOpen, setArchitecturePanelOpen] = useState(false);
  const [architectureQuery, setArchitectureQuery] = useState("");
  const [libraryResultLimit, setLibraryResultLimit] = useState(48);
  const [selectedDrilldownElementId, setSelectedDrilldownElementId] =
    useState<string | null>(null);
  const [selectedMarkdownCardId, setSelectedMarkdownCardId] =
    useState<string | null>(null);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [selectedDirectionalArrowIds, setSelectedDirectionalArrowIds] =
    useState<string[]>([]);
  const [selectedArrowsAnimated, setSelectedArrowsAnimated] = useState(false);
  const [currentArrowAnimation, setCurrentArrowAnimation] = useState(false);
  const [currentFlowStyle, setCurrentFlowStyle] =
    useState<FlowStyle>(DEFAULT_FLOW_STYLE);
  const [selectedFlowStyle, setSelectedFlowStyle] =
    useState<FlowStyle>(DEFAULT_FLOW_STYLE);
  const [arrowStyleControlVisible, setArrowStyleControlVisible] =
    useState(false);
  const [animatedArrowPaths, setAnimatedArrowPaths] = useState<
    AnimatedArrowPath[]
  >([]);
  const [animationControlHost, setAnimationControlHost] =
    useState<HTMLElement | null>(null);
  const draggedFrameIdRef = useRef<string | null>(null);
  const manualFrameOrderRef = useRef<string[] | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const framesRef = useRef<PresentationFrame[]>([]);
  const currentArrowAnimationRef = useRef(false);
  const currentFlowStyleRef = useRef<FlowStyle>(DEFAULT_FLOW_STYLE);
  const processedDirectionalArrowIdsRef = useRef<Set<string>>(new Set());
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailUrlsRef = useRef<string[]>([]);
  const lastSpacePressRef = useRef(0);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const sceneRef = useRef<LiveScene | null>(null);
  const fullscreenBeforePresentationRef = useRef(false);
  const dirtiedRef = useRef(false);
  const readyRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAutoSaveRef = useRef(onAutoSave);

  useEffect(() => {
    onAutoSaveRef.current = onAutoSave;
  }, [onAutoSave]);

  useEffect(() => {
    setLibraryResultLimit(48);
  }, [architectureQuery]);

  useEffect(() => {
    if (!selectedMarkdownCardId) {
      setMarkdownDraft("");
      return;
    }
    const element = sceneRef.current?.elements.find(
      (candidate) => candidate.id === selectedMarkdownCardId,
    );
    const markdown = element?.customData?.[MARKDOWN_CARD_KEY];
    setMarkdownDraft(typeof markdown === "string" ? markdown : "");
  }, [selectedMarkdownCardId]);

  const serializeScene = useCallback(
    async (scene: LiveScene): Promise<string | Uint8Array> => {
      const isPng = path.toLowerCase().endsWith(".excalidraw.png");
      const exportAppState = {
        ...scene.appState,
        exportEmbedScene: true,
      };
      if (isPng) {
        const blob = await exportToBlob({
          elements: scene.elements,
          appState: exportAppState,
          files: scene.files,
          mimeType: "image/png",
        });
        return new Uint8Array(await blob.arrayBuffer());
      }
      const svgEl = await exportToSvg({
        elements: scene.elements,
        appState: exportAppState,
        files: scene.files,
      });
      return new XMLSerializer().serializeToString(svgEl);
    },
    [path],
  );

  const focusPresentationSlide = useCallback(
    (index: number, frameIds: readonly string[] = presentationFrameIds) => {
      const api = apiRef.current;
      if (!api) return;
      const elements = api.getSceneElements();
      const target =
        frameIds.length > 0
          ? elements.find((element) => element.id === frameIds[index])
          : elements;
      if (!target || (Array.isArray(target) && target.length === 0)) return;
      api.scrollToContent(target, {
        fitToViewport: true,
        viewportZoomFactor: 0.94,
        animate: true,
        duration: 250,
      });
    },
    [presentationFrameIds],
  );

  const focusAfterFullscreenLayout = useCallback(
    (index: number, frameIds: readonly string[]) => {
      // Fullscreen changes Excalidraw's measured viewport. Wait for both the
      // React commit and Excalidraw's resize observer before fitting a frame.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => focusPresentationSlide(index, frameIds));
      });
    },
    [focusPresentationSlide],
  );

  const startPresentation = useCallback(() => {
    const frameIds = frames
      .filter((frame) => !frame.hidden)
      .map((frame) => frame.id);
    setPresentationFrameIds(frameIds);
    setPresentationIndex(0);
    fullscreenBeforePresentationRef.current = fullscreen;
    setFullscreen(true);
    setPresentationMode(true);
    focusAfterFullscreenLayout(0, frameIds);
  }, [focusAfterFullscreenLayout, frames, fullscreen]);

  const refreshFrameThumbnails = useCallback((scene: LiveScene) => {
    if (thumbnailTimerRef.current !== null) {
      clearTimeout(thumbnailTimerRef.current);
    }
    thumbnailTimerRef.current = setTimeout(() => {
      thumbnailTimerRef.current = null;
      const visibleElements = getNonDeletedElements(scene.elements);
      const frameElements = visibleElements.filter(
        (element) =>
          (element.type === "frame" || element.type === "magicframe"),
      );
      void Promise.all(
        frameElements.map(async (frame) => {
          // Use the same raster path as Excalidraw's PNG export. Passing the
          // whole scene plus exportingFrame lets Excalidraw perform its own
          // overlap, clipping, ordering, image, and font handling.
          const blob = await exportToBlob({
            elements: visibleElements,
            appState: {
              ...scene.appState,
              exportBackground: true,
              exportEmbedScene: false,
            },
            files: scene.files,
            mimeType: "image/png",
            exportPadding: 0,
            exportingFrame: frame,
            maxWidthOrHeight: 320,
          });
          return [
            frame.id,
            URL.createObjectURL(blob),
          ] as const;
        }),
      )
        .then((entries) => {
          const previousUrls = thumbnailUrlsRef.current;
          thumbnailUrlsRef.current = entries.map(([, url]) => url);
          setFrameThumbnails(Object.fromEntries(entries));
          previousUrls.forEach((url) => URL.revokeObjectURL(url));
        })
        .catch((err) =>
          console.error("[excalidraw] frame thumbnail failed", err),
        );
    }, 350);
  }, []);

  const exitPresentation = useCallback(() => {
    setPresentationMode(false);
    setFullscreen(fullscreenBeforePresentationRef.current);
    setPresentationFrameIds([]);
    setPresentationIndex(0);
  }, []);

  const goToPresentationSlide = useCallback(
    (nextIndex: number) => {
      const slideCount = Math.max(1, presentationFrameIds.length);
      const clamped = Math.min(slideCount - 1, Math.max(0, nextIndex));
      setPresentationIndex(clamped);
      focusPresentationSlide(clamped);
    },
    [focusPresentationSlide, presentationFrameIds.length],
  );

  const persistFrameOrder = useCallback((orderedIds: readonly string[]) => {
    const api = apiRef.current;
    if (!api) return;
    const orderById = new Map(orderedIds.map((id, index) => [id, index]));
    const nextElements = api
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        const order = orderById.get(element.id);
        if (
          order === undefined ||
          (element.type !== "frame" && element.type !== "magicframe")
        ) {
          return element;
        }
        return newElementWith(element, {
          customData: {
            ...element.customData,
            [PRESENTATION_ORDER_KEY]: order,
          },
        });
      });
    // Keep the manual order authoritative while Excalidraw publishes the
    // update. Its first callback can otherwise contain the pre-update custom
    // data and immediately snap the organizer back to its old order.
    manualFrameOrderRef.current = [...orderedIds];
    const reorderedFrames = orderedIds
      .map((id) => framesRef.current.find((frame) => frame.id === id))
      .filter((frame): frame is PresentationFrame => Boolean(frame));
    framesRef.current = reorderedFrames;
    setFrames(reorderedFrames);
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  const toggleAnimatedArrows = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const selectedIds = new Set(selectedDirectionalArrowIds);
    const enabled =
      selectedDirectionalArrowIds.length > 0
        ? !selectedArrowsAnimated
        : !currentArrowAnimationRef.current;
    currentArrowAnimationRef.current = enabled;
    setCurrentArrowAnimation(enabled);
    if (selectedIds.size === 0) return;
    const nextElements = api
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (!selectedIds.has(element.id) || element.type !== "arrow") {
          return element;
        }
        return newElementWith(element, {
          customData: {
            ...element.customData,
            [ANIMATED_ARROW_KEY]: enabled,
          },
        });
      });
    api.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, [selectedArrowsAnimated, selectedDirectionalArrowIds]);

  const updateFlowStyle = useCallback(
    (patch: Partial<FlowStyle>) => {
      const api = apiRef.current;
      if (!api) return;
      const base =
        selectedDirectionalArrowIds.length > 0
          ? selectedFlowStyle
          : currentFlowStyleRef.current;
      const nextStyle = { ...base, ...patch };
      currentFlowStyleRef.current = nextStyle;
      setCurrentFlowStyle(nextStyle);
      setSelectedFlowStyle(nextStyle);
      if (selectedDirectionalArrowIds.length === 0) return;
      const selectedIds = new Set(selectedDirectionalArrowIds);
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted().map((element) =>
          selectedIds.has(element.id) && element.type === "arrow"
            ? newElementWith(element, {
                customData: {
                  ...element.customData,
                  [FLOW_SPEED_KEY]: nextStyle.speed,
                  [FLOW_DENSITY_KEY]: nextStyle.density,
                  [FLOW_DIRECTION_KEY]: nextStyle.direction,
                  [FLOW_COLOR_KEY]: nextStyle.color,
                  [CONNECTOR_TYPE_KEY]: nextStyle.connectorType,
                  [CONNECTOR_PROTOCOL_KEY]: nextStyle.protocol,
                },
              })
            : element,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [selectedDirectionalArrowIds, selectedFlowStyle],
  );

  const moveFrame = useCallback(
    (frameId: string, targetIndex: number) => {
      const currentFrames = framesRef.current;
      const currentIndex = currentFrames.findIndex(
        (frame) => frame.id === frameId,
      );
      if (currentIndex < 0) return;
      const clamped = Math.max(
        0,
        Math.min(currentFrames.length - 1, targetIndex),
      );
      if (currentIndex === clamped) return;
      const reordered = [...currentFrames];
      const [moved] = reordered.splice(currentIndex, 1);
      reordered.splice(clamped, 0, moved);
      persistFrameOrder(reordered.map((frame) => frame.id));
    },
    [persistFrameOrder],
  );

  // Track the pointer globally and resolve the row under its coordinates.
  // This does not depend on pointerenter/HTML drag events, both of which can
  // be swallowed by Excalidraw's canvas pointer capture in a webview.
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const draggedId = draggedFrameIdRef.current;
      const host = editorHostRef.current;
      if (!draggedId || !host) return;
      const rows = Array.from(
        host.querySelectorAll<HTMLElement>("[data-presentation-frame-id]"),
      );
      if (rows.length === 0) return;
      const target = rows.reduce((nearest, row) => {
        const rowRect = row.getBoundingClientRect();
        const nearestRect = nearest.getBoundingClientRect();
        const rowDistance = Math.abs(
          event.clientY - (rowRect.top + rowRect.height / 2),
        );
        const nearestDistance = Math.abs(
          event.clientY - (nearestRect.top + nearestRect.height / 2),
        );
        return rowDistance < nearestDistance ? row : nearest;
      });
      const targetId = target.dataset.presentationFrameId;
      const targetIndex = framesRef.current.findIndex(
        (frame) => frame.id === targetId,
      );
      if (targetIndex >= 0) moveFrame(draggedId, targetIndex);
    };
    const clearDraggedFrame = () => {
      draggedFrameIdRef.current = null;
      document.body.classList.remove("zen-excalidraw-frame-dragging");
    };
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", clearDraggedFrame, true);
    window.addEventListener("pointercancel", clearDraggedFrame, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", clearDraggedFrame, true);
      window.removeEventListener("pointercancel", clearDraggedFrame, true);
      clearDraggedFrame();
    };
  }, [moveFrame]);

  // Excalidraw does not expose a property-panel extension API. Mount our
  // control immediately after its native Stroke style fieldset so animation
  // behaves like an element style instead of unrelated app chrome.
  useEffect(() => {
    if (!arrowStyleControlVisible) {
      setAnimationControlHost(null);
      return;
    }
    const editorHost = editorHostRef.current;
    if (!editorHost) return;
    let portalHost: HTMLElement | null = null;
    const mountControl = () => {
      const panel = editorHost.querySelector<HTMLElement>(
        ".selected-shape-actions",
      );
      if (!panel) {
        if (portalHost && !portalHost.isConnected) {
          portalHost = null;
          setAnimationControlHost(null);
        }
        return;
      }
      const strokeFieldset = Array.from(panel.querySelectorAll("fieldset")).find(
        (fieldset) =>
          fieldset.querySelector("legend")?.textContent?.trim() ===
          "Stroke style",
      );
      if (!strokeFieldset) return;
      const existing = panel.querySelector<HTMLElement>(
        ".zen-excalidraw-animation-control-host",
      );
      const nextHost = existing ?? document.createElement("div");
      nextHost.className = "zen-excalidraw-animation-control-host";
      if (!existing) strokeFieldset.insertAdjacentElement("afterend", nextHost);
      if (portalHost !== nextHost) {
        portalHost = nextHost;
        setAnimationControlHost(nextHost);
      }
    };
    mountControl();
    const observer = new MutationObserver(mountControl);
    observer.observe(editorHost, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      portalHost?.remove();
    };
  }, [arrowStyleControlVisible]);

  const focusFrame = useCallback((frameId: string) => {
    const api = apiRef.current;
    const frame = api
      ?.getSceneElements()
      .find((element) => element.id === frameId);
    if (!api || !frame) return;
    api.scrollToContent(frame, {
      fitToViewport: true,
      viewportZoomFactor: 0.8,
      animate: true,
      duration: 200,
    });
  }, []);

  const navigateToDetailFrame = useCallback(
    (frameId: string) => {
      const presentationTarget = presentationFrameIds.indexOf(frameId);
      if (presentationMode && presentationTarget >= 0) {
        goToPresentationSlide(presentationTarget);
        return;
      }
      focusFrame(frameId);
    },
    [
      focusFrame,
      goToPresentationSlide,
      presentationFrameIds,
      presentationMode,
    ],
  );

  const toggleFrameHidden = useCallback((frameId: string) => {
    const api = apiRef.current;
    const current = framesRef.current.find((frame) => frame.id === frameId);
    if (!api || !current) return;
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frameId
          ? newElementWith(element, {
              customData: {
                ...element.customData,
                [PRESENTATION_HIDDEN_KEY]: !current.hidden,
              },
            })
          : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  const duplicateFrame = useCallback((frameId: string) => {
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({
      appState: { selectedElementIds: { [frameId]: true } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    requestAnimationFrame(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          code: "KeyD",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }, []);

  const deleteFrame = useCallback((frameId: string) => {
    const api = apiRef.current;
    if (!api || !window.confirm("Delete this frame and everything inside it?")) {
      return;
    }
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((element) =>
        element.id === frameId || element.frameId === frameId
          ? newElementWith(element, { isDeleted: true })
          : element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  const sceneCenter = useCallback(() => {
    const api = apiRef.current;
    const rect = editorHostRef.current?.getBoundingClientRect();
    if (!api || !rect) return { x: 100, y: 100 };
    return viewportCoordsToSceneCoords(
      { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 },
      api.getAppState(),
    );
  }, []);

  const insertArchitectureService = useCallback(
    (service: ArchitectureService) => {
      const api = apiRef.current;
      if (!api) return;
      const center = sceneCenter();
      const providerColor =
        service.provider === "AWS"
          ? "#ff9900"
          : service.provider === "Azure"
            ? "#168ddd"
            : service.provider === "Data"
              ? "#2f9e44"
              : "#6965db";
      const groupId = `architecture-${crypto.randomUUID()}`;
      const skeleton = [
        {
          type: "rectangle",
          x: center.x - 120,
          y: center.y - 48,
          width: 240,
          height: 96,
          backgroundColor: "#ffffff",
          strokeColor: providerColor,
          fillStyle: "solid",
          strokeWidth: 2,
          roundness: { type: 3 },
          groupIds: [groupId],
          customData: {
            [ARCHITECTURE_NODE_KEY]: true,
            provider: service.provider,
            service: service.service,
            category: service.category,
            detailFrameId: "",
          },
        },
        {
          type: "rectangle",
          x: center.x - 108,
          y: center.y - 36,
          width: 72,
          height: 72,
          backgroundColor: providerColor,
          strokeColor: providerColor,
          fillStyle: "solid",
          roundness: { type: 3 },
          groupIds: [groupId],
          label: {
            text: architectureIconLabel(service),
            fontSize: 24,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: "#ffffff",
          },
        },
        {
          type: "text",
          x: center.x - 22,
          y: center.y - 24,
          text: `${service.service}\n${service.provider}`,
          fontSize: 18,
          strokeColor: "#1b1b1f",
          groupIds: [groupId],
        },
      ] as unknown as Parameters<typeof convertToExcalidrawElements>[0];
      const created = convertToExcalidrawElements(skeleton, {
        regenerateIds: true,
      });
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...created],
        appState: {
          selectedElementIds: Object.fromEntries(
            created.map((element) => [element.id, true]),
          ),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setArchitecturePanelOpen(false);
    },
    [sceneCenter],
  );

  const insertLibraryItem = useCallback(
    (item: BundledLibraryItem) => {
      const api = apiRef.current;
      if (!api) return;
      const restored = restoreElements(item.elements as never, null);
      if (restored.length === 0) return;
      const [minX, minY, maxX, maxY] = getCommonBounds(restored);
      const center = sceneCenter();
      const offsetX = center.x - (minX + maxX) / 2;
      const offsetY = center.y - (minY + maxY) / 2;
      const idMap = new Map(
        restored.map((element) => [element.id, crypto.randomUUID()]),
      );
      const groupIds = new Set(restored.flatMap((element) => element.groupIds));
      const groupMap = new Map(
        [...groupIds].map((groupId) => [groupId, crypto.randomUUID()]),
      );
      const architectureInstanceId = crypto.randomUUID();
      const created = restored.map((element) => {
        const clone = structuredClone(element);
        return {
          ...clone,
          id: idMap.get(element.id) ?? crypto.randomUUID(),
          x: element.x + offsetX,
          y: element.y + offsetY,
          groupIds: element.groupIds.map(
            (groupId) => groupMap.get(groupId) ?? groupId,
          ),
          frameId: element.frameId ? (idMap.get(element.frameId) ?? null) : null,
          containerId:
            element.type === "text" && element.containerId
              ? (idMap.get(element.containerId) ?? null)
              : element.type === "text"
                ? null
                : undefined,
          boundElements: element.boundElements?.map((binding) => ({
            ...binding,
            id: idMap.get(binding.id) ?? binding.id,
          })) ?? null,
          startBinding:
            (element.type === "arrow" || element.type === "line") &&
            element.startBinding
              ? {
                  ...element.startBinding,
                  elementId:
                    idMap.get(element.startBinding.elementId) ??
                    element.startBinding.elementId,
                }
              : null,
          endBinding:
            (element.type === "arrow" || element.type === "line") &&
            element.endBinding
              ? {
                  ...element.endBinding,
                  elementId:
                    idMap.get(element.endBinding.elementId) ??
                    element.endBinding.elementId,
                }
              : null,
          version: 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          updated: Date.now(),
          customData: {
            ...element.customData,
            [ARCHITECTURE_NODE_KEY]: true,
            [ARCHITECTURE_INSTANCE_KEY]: architectureInstanceId,
            provider: item.source,
            service: item.name,
            detailFrameId: "",
          },
        } as unknown as OrderedExcalidrawElement;
      });
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...created],
        appState: {
          selectedElementIds: Object.fromEntries(
            created.map((element) => [element.id, true]),
          ),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setArchitecturePanelOpen(false);
    },
    [sceneCenter],
  );

  const insertMarkdownCard = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const center = sceneCenter();
    const created = createMarkdownCardElements(
      "# Architecture note\n\n- Add context\n- Document decisions\n\n> [!IMPORTANT]\n> Capture risks and constraints.",
      center.x - 180,
      center.y - 120,
    );
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...created],
      appState: {
        selectedElementIds: Object.fromEntries(
          created.map((element) => [element.id, true]),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, [sceneCenter]);

  const updateElementCustomData = useCallback(
    (elementId: string, patch: Record<string, unknown>) => {
      const api = apiRef.current;
      if (!api) return;
      const elements = api.getSceneElementsIncludingDeleted();
      const target = elements.find((element) => element.id === elementId);
      const architectureInstance =
        target?.customData?.[ARCHITECTURE_INSTANCE_KEY];
      const targetGroups = new Set(target?.groupIds ?? []);
      api.updateScene({
        elements: elements.map((element) =>
          element.id === elementId ||
          (typeof architectureInstance === "string" &&
            element.customData?.[ARCHITECTURE_INSTANCE_KEY] ===
              architectureInstance) ||
          (architectureInstance === undefined &&
            element.groupIds.some((groupId) => targetGroups.has(groupId)))
            ? newElementWith(element, {
                customData: { ...element.customData, ...patch },
              })
            : element,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [],
  );

  const commitMarkdownCard = useCallback(() => {
    if (!selectedMarkdownCardId) return;
    const api = apiRef.current;
    if (!api) return;
    const allElements = api.getSceneElementsIncludingDeleted();
    const card = allElements.find(
      (element) => element.id === selectedMarkdownCardId,
    );
    if (!card) return;
    const groupId = card.groupIds[0];
    const created = createMarkdownCardElements(markdownDraft, card.x, card.y);
    api.updateScene({
      elements: [
        ...allElements.map((element) =>
          element.id === selectedMarkdownCardId ||
          (groupId && element.groupIds.includes(groupId))
            ? newElementWith(element, { isDeleted: true })
            : element,
        ),
        ...created,
      ],
      appState: {
        selectedElementIds: Object.fromEntries(
          created.map((element) => [element.id, true]),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, [markdownDraft, selectedMarkdownCardId]);

  const pasteImageIntoMarkdown = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const image = Array.from(event.clipboardData.files).find((file) =>
        file.type.startsWith("image/"),
      );
      if (!image) return;
      event.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const api = apiRef.current;
        const card = api
          ?.getSceneElements()
          .find((element) => element.id === selectedMarkdownCardId);
        if (!api || !card || !dataUrl) return;
        const fileId = crypto.randomUUID();
        api.addFiles([
          {
            id: fileId,
            dataURL: dataUrl,
            mimeType: image.type,
            created: Date.now(),
          } as unknown as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0][number],
        ]);
        const preview = new Image();
        preview.onload = () => {
          const maxWidth = Math.max(160, card.width * 0.8);
          const scale = Math.min(1, maxWidth / Math.max(1, preview.width));
          const width = Math.max(80, preview.width * scale);
          const height = Math.max(80, preview.height * scale);
          const created = convertToExcalidrawElements(
            [
              {
                type: "image",
                x: card.x + (card.width - width) / 2,
                y: card.y + card.height + 24,
                width,
                height,
                fileId,
                status: "saved",
                scale: [1, 1],
              },
            ] as unknown as Parameters<typeof convertToExcalidrawElements>[0],
            { regenerateIds: true },
          );
          api.updateScene({
            elements: [...api.getSceneElementsIncludingDeleted(), ...created],
            appState: {
              selectedElementIds: { [created[0].id]: true },
            },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
        };
        preview.src = dataUrl;
      };
      reader.readAsDataURL(image);
    },
    [selectedMarkdownCardId],
  );

  // Excalidraw fires onChange while restoring initialData. Give that
  // mount-time callback a frame to settle so opening a drawing never
  // counts as an edit or schedules an overwrite.
  useEffect(() => {
    readyRef.current = false;
    if (initialData === undefined) return;
    const frame = requestAnimationFrame(() => {
      readyRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialData, path]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
      }
      if (thumbnailTimerRef.current !== null) {
        clearTimeout(thumbnailTimerRef.current);
      }
      thumbnailUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      thumbnailUrlsRef.current = [];
    };
  }, []);

  // Match the terminal's app-viewport mode on macOS: HTML covers the whole
  // webview and AppKit's traffic lights are hidden until the user exits.
  useEffect(() => {
    void terminalSetTrafficLightsHidden(fullscreen).catch((err) =>
      console.error("[excalidraw] set traffic lights hidden failed", err),
    );
    return () => {
      if (!fullscreen) return;
      void terminalSetTrafficLightsHidden(false).catch((err) =>
        console.error("[excalidraw] restore traffic lights failed", err),
      );
    };
  }, [fullscreen]);

  // ────────────────────────────────────────────────────────────────
  // Load the file's bytes off disk and turn them into an Excalidraw
  // initial-data object.  Re-runs only when `path` changes — the
  // caller remounts on a tab switch already, but this guard keeps
  // the read out of every render.
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    dirtiedRef.current = false;
    setPresentationMode(false);
    setFullscreen(false);
    fullscreenBeforePresentationRef.current = false;
    setPresentationFrameIds([]);
    setPresentationIndex(0);
    setFrames([]);
    framesRef.current = [];
    setFrameThumbnails({});
    setFramePanelOpen(false);
    setArchitecturePanelOpen(false);
    setSelectedDrilldownElementId(null);
    setSelectedMarkdownCardId(null);
    manualFrameOrderRef.current = null;
    setSelectedDirectionalArrowIds([]);
    setSelectedArrowsAnimated(false);
    setAnimatedArrowPaths([]);
    processedDirectionalArrowIdsRef.current = new Set();
    setLoadError(null);

    async function load() {
      try {
        // Fetch via the asset protocol — works for both `.excalidraw.svg`
        // and `.excalidraw.png` without a separate text/bytes
        // round-trip.  An empty file (newly-created via "New file")
        // comes back with `blob.size === 0` and we start with a
        // fresh empty scene.
        const res = await fetch(convertFileSrc(path));
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`fetch ${path}: HTTP ${res.status}`);
        }
        const blob = await res.blob();
        if (cancelled) return;

        if (blob.size === 0) {
          setInitialData(null);
          return;
        }

        const restored = await loadFromBlob(blob, null, null);
        if (cancelled) return;
        setInitialData({
          elements: restored.elements,
          appState: restored.appState,
          files: restored.files,
        });
      } catch (err) {
        if (cancelled) return;
        // Most common failure: file isn't an Excalidraw-flavoured
        // file (no embedded scene).  Fall back to an empty scene so
        // the user can still draw — saving overwrites the broken
        // file.
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[excalidraw] loadFromBlob failed", path, err);
        setLoadError(message);
        setInitialData(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // ────────────────────────────────────────────────────────────────
  // Cmd+S / Ctrl+S handler.  We deliberately bind on `window` in the
  // capture phase: Excalidraw's own keymap also reacts to Cmd+S
  // (showing its export dialog), and capture-phase + preventDefault
  // wins the race.  Bound only while this editor is mounted.
  // ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping = Boolean(
        target?.closest("input, textarea, [contenteditable='true']"),
      );

      if (e.key === "Escape" && architecturePanelOpen) {
        e.preventDefault();
        e.stopPropagation();
        setArchitecturePanelOpen(false);
        return;
      }

      if (
        !presentationMode &&
        !isTyping &&
        e.key === " " &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const now = performance.now();
        if (now - lastSpacePressRef.current <= 350) {
          e.preventDefault();
          e.stopPropagation();
          lastSpacePressRef.current = 0;
          setArchitectureQuery("");
          setArchitecturePanelOpen(true);
          return;
        }
        lastSpacePressRef.current = now;
      }

      const isPresentationToggle =
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "r";
      if (isPresentationToggle) {
        // `viewModeEnabled` is controlled by React. Handle Excalidraw's
        // standard shortcut here so its internal action cannot race the prop
        // and create a setState feedback loop.
        e.preventDefault();
        e.stopPropagation();
        if (presentationMode) exitPresentation();
        else startPresentation();
        return;
      }

      if (e.key === "Escape" && (presentationMode || fullscreen)) {
        e.preventDefault();
        e.stopPropagation();
        if (presentationMode) exitPresentation();
        else setFullscreen(false);
        return;
      }

      if (presentationMode) {
        const isNext =
          e.key === "ArrowRight" ||
          e.key === "ArrowDown" ||
          e.key === "PageDown" ||
          e.key === " ";
        const isPrevious =
          e.key === "ArrowLeft" ||
          e.key === "ArrowUp" ||
          e.key === "PageUp";
        if (isNext || isPrevious) {
          e.preventDefault();
          e.stopPropagation();
          goToPresentationSlide(
            presentationIndex + (isNext ? 1 : -1),
          );
        }
        return;
      }

      const isSave =
        (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s";
      if (!isSave) return;
      const scene = sceneRef.current;
      if (!scene) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        onSave(await serializeScene(scene));
      } catch (err) {
        console.error("[excalidraw] export failed", err);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    architecturePanelOpen,
    exitPresentation,
    fullscreen,
    goToPresentationSlide,
    onSave,
    path,
    presentationIndex,
    presentationMode,
    serializeScene,
    startPresentation,
  ]);

  // ────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────
  if (initialData === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> loading drawing…
      </div>
    );
  }

  const flowAnimationEnabled =
    selectedDirectionalArrowIds.length > 0
      ? selectedArrowsAnimated
      : currentArrowAnimation;
  const displayedFlowStyle =
    selectedDirectionalArrowIds.length > 0
      ? selectedFlowStyle
      : currentFlowStyle;
  const selectedArrowStrokeColor = selectedDirectionalArrowIds
    .map((id) =>
      sceneRef.current?.elements.find((element) => element.id === id),
    )
    .find(Boolean)?.strokeColor;
  const selectedDrilldownElement = sceneRef.current?.elements.find(
    (element) => element.id === selectedDrilldownElementId,
  );
  const filteredArchitectureServices = ARCHITECTURE_SERVICES.filter(
    (service) =>
      `${service.provider} ${service.service} ${service.category}`
        .toLowerCase()
        .includes(architectureQuery.trim().toLowerCase()),
  );
  const normalizedArchitectureQuery = architectureQuery.trim().toLowerCase();
  const matchingLibraryItems = BUNDLED_LIBRARY_ITEMS.filter((item) =>
    `${item.source} ${item.name}`
      .toLowerCase()
      .includes(normalizedArchitectureQuery),
  );
  const filteredLibraryItems = matchingLibraryItems.slice(
    0,
    libraryResultLimit,
  );

  return (
    <div
      ref={editorHostRef}
      className={`relative h-full w-full${
        fullscreen ? " zen-excalidraw-fullscreen" : ""
      }`}
      data-tauri-drag-region={false}
    >
      {loadError ? (
        <div className="absolute left-2 top-2 z-10 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10px] text-destructive">
          load: {loadError}
        </div>
      ) : null}
      <div
        className="zen-excalidraw-controls"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {presentationMode ? (
          <>
            <button
              type="button"
              className="zen-excalidraw-control-button zen-excalidraw-icon-button"
              title="Previous frame (←)"
              aria-label="Previous presentation frame"
              disabled={presentationIndex === 0}
              onClick={() => goToPresentationSlide(presentationIndex - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span className="zen-excalidraw-slide-count">
              {presentationIndex + 1} /{" "}
              {Math.max(1, presentationFrameIds.length)}
            </span>
            <button
              type="button"
              className="zen-excalidraw-control-button zen-excalidraw-icon-button"
              title="Next frame (→ or Space)"
              aria-label="Next presentation frame"
              disabled={
                presentationIndex >=
                Math.max(1, presentationFrameIds.length) - 1
              }
              onClick={() => goToPresentationSlide(presentationIndex + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
            <button
              type="button"
              className="zen-excalidraw-control-button"
              title="Exit presentation (Escape)"
              onClick={exitPresentation}
            >
              <Pencil aria-hidden="true" />
              <span>Edit</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="zen-excalidraw-control-button"
              title="Order presentation frames"
              aria-expanded={framePanelOpen}
              onClick={() => setFramePanelOpen((current) => !current)}
            >
              <Layers3 aria-hidden="true" />
              <span>Frames{frames.length > 0 ? ` ${frames.length}` : ""}</span>
            </button>
            <button
              type="button"
              className="zen-excalidraw-control-button zen-excalidraw-icon-button"
              title={
                fullscreen ? "Exit fullscreen canvas (Escape)" : "Fullscreen canvas"
              }
              aria-label={
                fullscreen ? "Exit fullscreen canvas" : "Enter fullscreen canvas"
              }
              onClick={() => setFullscreen((current) => !current)}
            >
              {fullscreen ? (
                <Minimize2 aria-hidden="true" />
              ) : (
                <Maximize2 aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="zen-excalidraw-control-button"
              title="Present frames (Alt+R)"
              onClick={startPresentation}
            >
              <Presentation aria-hidden="true" />
              <span>Present</span>
            </button>
          </>
        )}
      </div>
      {architecturePanelOpen && !presentationMode ? (
        <div
          className="zen-excalidraw-action-backdrop"
          onPointerDown={() => setArchitecturePanelOpen(false)}
        >
          <div
            className="zen-excalidraw-action-palette"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="zen-excalidraw-architecture-search">
              <Search aria-hidden="true" />
              <input
                autoFocus
                value={architectureQuery}
                placeholder="Search AWS, architecture, UML, wireframes, logos…"
                onChange={(event) => setArchitectureQuery(event.target.value)}
              />
              <kbd>esc</kbd>
            </div>
            <div className="zen-excalidraw-action-content">
              <div className="zen-excalidraw-action-section-title">Actions</div>
              <div className="zen-excalidraw-action-list">
                {"markdown card note".includes(architectureQuery.trim().toLowerCase()) ? (
                  <button
                    type="button"
                    onClick={() => {
                      insertMarkdownCard();
                      setArchitecturePanelOpen(false);
                    }}
                  >
                    <span className="zen-excalidraw-action-icon"><FileText aria-hidden="true" /></span>
                    <span><strong>Markdown card</strong><small>Rendered notes, lists, callouts, and pasted images</small></span>
                  </button>
                ) : null}
                {"presentation frames organize slides".includes(architectureQuery.trim().toLowerCase()) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFramePanelOpen(true);
                      setArchitecturePanelOpen(false);
                    }}
                  >
                    <span className="zen-excalidraw-action-icon"><Layers3 aria-hidden="true" /></span>
                    <span><strong>Organize frames</strong><small>Reorder and manage presentation slides</small></span>
                  </button>
                ) : null}
              </div>
              <div className="zen-excalidraw-action-section-title">
                Official Excalidraw library icons
                <span>
                  {filteredLibraryItems.length} of {matchingLibraryItems.length}
                </span>
              </div>
              <div className="zen-excalidraw-architecture-grid">
                {filteredLibraryItems.map((item) => {
                  const color =
                    item.source === "AWS"
                      ? "#ff9900"
                      : item.source === "Sticky Notes"
                        ? "#f59f00"
                        : item.source === "UML & ER"
                          ? "#2f9e44"
                          : item.source === "DevOps"
                            ? "#168ddd"
                            : item.source === "Software Logos"
                              ? "#d6336c"
                              : "#6965db";
                  return (
                    <button
                      key={item.id}
                      type="button"
                      style={{ "--architecture-color": color } as React.CSSProperties}
                      onClick={() => insertLibraryItem(item)}
                    >
                      <LibraryItemThumbnail item={item} theme={theme} />
                      <span>{item.name}</span>
                      <small>{item.source}</small>
                    </button>
                  );
                })}
              </div>
              <LibraryResultsSentinel
                hasMore={filteredLibraryItems.length < matchingLibraryItems.length}
                page={libraryResultLimit}
                onVisible={() =>
                  setLibraryResultLimit((current) =>
                    Math.min(current + 48, matchingLibraryItems.length),
                  )
                }
              />
              <div className="zen-excalidraw-action-section-title">Quick labeled templates</div>
              <div className="zen-excalidraw-architecture-grid">
                {filteredArchitectureServices.map((service) => (
                  <button
                    key={`${service.provider}-${service.service}`}
                    type="button"
                    style={{ "--architecture-color": service.provider === "AWS" ? "#ff9900" : service.provider === "Azure" ? "#168ddd" : service.provider === "Data" ? "#2f9e44" : "#6965db" } as React.CSSProperties}
                    onClick={() => insertArchitectureService(service)}
                  >
                    <span className="zen-excalidraw-service-icon">
                      <ArchitectureCategoryIcon category={service.category} />
                      <em>{architectureIconLabel(service)}</em>
                    </span>
                    <span>{service.service}</span>
                    <small>{service.provider}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="zen-excalidraw-action-hint">Open anywhere on the canvas with <kbd>space</kbd> <kbd>space</kbd></div>
          </div>
        </div>
      ) : null}
      {selectedDrilldownElement &&
      !selectedMarkdownCardId &&
      !presentationMode ? (
        <div className="zen-excalidraw-inspector-panel">
          <div className="zen-excalidraw-inspector-title">Drill-down</div>
          <label>
            <span>Detail frame</span>
            <select
              value={String(
                selectedDrilldownElement.customData?.detailFrameId ?? "",
              )}
              onChange={(event) =>
                updateElementCustomData(selectedDrilldownElement.id, {
                  detailFrameId: event.target.value,
                })
              }
            >
              <option value="">None</option>
              {frames.map((frame, index) => (
                <option key={frame.id} value={frame.id}>
                  {frame.name || `Frame ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          {selectedDrilldownElement.customData?.detailFrameId ? (
            <>
              <button
                type="button"
                onClick={() =>
                  navigateToDetailFrame(
                    String(
                      selectedDrilldownElement.customData?.detailFrameId,
                    ),
                  )
                }
              >
                Open detail frame
              </button>
              <small className="zen-excalidraw-drilldown-hint">
                Click while presenting · ⌘/Ctrl-click while editing
              </small>
            </>
          ) : null}
        </div>
      ) : null}
      {selectedMarkdownCardId && !presentationMode ? (
        <div className="zen-excalidraw-markdown-inspector">
          <div className="zen-excalidraw-inspector-title">Markdown card</div>
          <textarea
            value={markdownDraft}
            onPaste={pasteImageIntoMarkdown}
            onChange={(event) => setMarkdownDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                commitMarkdownCard();
              }
            }}
          />
          <div className="zen-excalidraw-markdown-actions">
            <small>Paste images directly · ⌘Enter to apply</small>
            <button type="button" onClick={commitMarkdownCard}>Apply</button>
          </div>
        </div>
      ) : null}
      {framePanelOpen && !presentationMode ? (
        <div
          className="zen-excalidraw-frame-panel"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="zen-excalidraw-frame-panel-title">
            Presentation order
          </div>
          {frames.length === 0 ? (
            <div className="zen-excalidraw-frame-empty">
              Add frames to create slides.
            </div>
          ) : (
            <div className="zen-excalidraw-frame-list">
              {frames.map((frame, index) => (
                <div
                  key={frame.id}
                  className="zen-excalidraw-frame-row"
                  data-presentation-frame-id={frame.id}
                  onPointerDown={(event) => {
                    if ((event.target as HTMLElement).closest("button")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    draggedFrameIdRef.current = frame.id;
                    document.body.classList.add(
                      "zen-excalidraw-frame-dragging",
                    );
                  }}
                  onPointerUp={() => {
                    draggedFrameIdRef.current = null;
                  }}
                >
                  <GripVertical
                    className="zen-excalidraw-frame-grip"
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="zen-excalidraw-frame-preview"
                    title="Focus frame"
                    onClick={() => focusFrame(frame.id)}
                  >
                    {frameThumbnails[frame.id] ? (
                      <img
                        src={frameThumbnails[frame.id]}
                        alt=""
                        draggable={false}
                      />
                    ) : (
                      <span>{index + 1}</span>
                    )}
                  </button>
                  <div className="zen-excalidraw-frame-details">
                    <button
                      type="button"
                      className="zen-excalidraw-frame-name"
                      title="Focus frame"
                      onClick={() => focusFrame(frame.id)}
                    >
                      <span>{index + 1}</span>
                      <span className="zen-excalidraw-frame-name-text">
                        {frame.name?.trim() || `Frame ${index + 1}`}
                      </span>
                      {frame.hidden ? <em>Hidden</em> : null}
                    </button>
                    <div className="zen-excalidraw-frame-actions">
                      <button
                        type="button"
                        aria-label={`Move ${frame.name || `frame ${index + 1}`} up`}
                        disabled={index === 0}
                        onClick={() => moveFrame(frame.id, index - 1)}
                      >
                        <ChevronUp aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${frame.name || `frame ${index + 1}`} down`}
                        disabled={index === frames.length - 1}
                        onClick={() => moveFrame(frame.id, index + 1)}
                      >
                        <ChevronDown aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label="Duplicate frame"
                        title="Duplicate frame"
                        onClick={() => duplicateFrame(frame.id)}
                      >
                        <Copy aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={
                          frame.hidden
                            ? "Include frame in presentation"
                            : "Hide frame from presentation"
                        }
                        title={
                          frame.hidden
                            ? "Include in presentation"
                            : "Hide from presentation"
                        }
                        onClick={() => toggleFrameHidden(frame.id)}
                      >
                        {frame.hidden ? (
                          <Eye aria-hidden="true" />
                        ) : (
                          <EyeOff aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="is-destructive"
                        aria-label="Delete frame and contents"
                        title="Delete frame and contents"
                        onClick={() => deleteFrame(frame.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {animationControlHost && arrowStyleControlVisible
        ? createPortal(
            <fieldset className="zen-excalidraw-animation-control">
              <legend>Flow animation</legend>
              <div className="buttonList">
                <button
                  type="button"
                  className={flowAnimationEnabled ? "active" : undefined}
                  aria-pressed={flowAnimationEnabled}
                  title={
                    flowAnimationEnabled
                      ? "Disable directional flow animation"
                      : "Animate flow toward the arrowhead"
                  }
                  onClick={toggleAnimatedArrows}
                >
                  <Activity aria-hidden="true" />
                </button>
              </div>
              {flowAnimationEnabled ? (
                <div className="zen-excalidraw-flow-settings">
                  <label>
                    <span>Speed</span>
                    <select
                      value={displayedFlowStyle.speed}
                      onChange={(event) =>
                        updateFlowStyle({
                          speed: event.target.value as FlowSpeed,
                        })
                      }
                    >
                      <option value="slow">Slow</option>
                      <option value="normal">Normal</option>
                      <option value="fast">Fast</option>
                    </select>
                  </label>
                  <label>
                    <span>Density</span>
                    <select
                      value={displayedFlowStyle.density}
                      onChange={(event) =>
                        updateFlowStyle({
                          density: event.target.value as FlowDensity,
                        })
                      }
                    >
                      <option value="sparse">Sparse</option>
                      <option value="normal">Normal</option>
                      <option value="dense">Dense</option>
                    </select>
                  </label>
                  <label>
                    <span>Direction</span>
                    <select
                      value={displayedFlowStyle.direction}
                      onChange={(event) =>
                        updateFlowStyle({
                          direction: event.target.value as FlowDirection,
                        })
                      }
                    >
                      <option value="auto">Arrowheads</option>
                      <option value="forward">Start → end</option>
                      <option value="reverse">End → start</option>
                      <option value="both">Both</option>
                    </select>
                  </label>
                  <label>
                    <span>Connection</span>
                    <select
                      value={displayedFlowStyle.connectorType}
                      onChange={(event) =>
                        updateFlowStyle({
                          connectorType: event.target.value as ConnectorType,
                        })
                      }
                    >
                      <option value="request">Request</option>
                      <option value="event">Event</option>
                      <option value="data">Data</option>
                      <option value="replication">Replication</option>
                      <option value="network">Network</option>
                      <option value="control">Control</option>
                      <option value="trust">Trust</option>
                    </select>
                  </label>
                  <label>
                    <span>Protocol</span>
                    <input
                      type="text"
                      value={displayedFlowStyle.protocol}
                      placeholder="HTTPS, gRPC…"
                      onChange={(event) =>
                        updateFlowStyle({ protocol: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Flow color</span>
                    <span className="zen-excalidraw-flow-color-row">
                      <input
                        type="color"
                        value={
                          displayedFlowStyle.color ??
                          selectedArrowStrokeColor ??
                          "#6965db"
                        }
                        onChange={(event) =>
                          updateFlowStyle({ color: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => updateFlowStyle({ color: null })}
                      >
                        Match stroke
                      </button>
                    </span>
                  </label>
                </div>
              ) : null}
            </fieldset>,
            animationControlHost,
          )
        : null}
      {animatedArrowPaths.length > 0 ? (
        <svg
          className="zen-excalidraw-flow-overlay"
          aria-hidden="true"
          width="100%"
          height="100%"
        >
          {animatedArrowPaths.flatMap((arrow) => {
            const paths = [
              <path
                key={`${arrow.id}-primary`}
                d={arrow.path}
                className={`zen-excalidraw-flow-line is-${arrow.direction} is-${arrow.speed} is-${arrow.density}`}
                style={{ stroke: arrow.color }}
              />,
            ];
            if (arrow.direction === "both") {
              paths.push(
                <path
                  key={`${arrow.id}-reverse`}
                  d={arrow.path}
                  className={`zen-excalidraw-flow-line is-reverse is-secondary is-${arrow.speed} is-${arrow.density}`}
                  style={{ stroke: arrow.color }}
                />,
              );
            }
            return paths;
          })}
        </svg>
      ) : null}
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api;
        }}
        theme={theme}
        // Embedded Excalidraw listens on its own container by default. That
        // makes shortcuts appear broken whenever focus is still on the host
        // chrome (for example immediately after opening a drawing). Let the
        // active drawing listen at document level and focus it on mount so
        // undo/redo, tool keys, delete, copy/paste, and zoom work consistently.
        handleKeyboardGlobally
        autoFocus
        // Excalidraw+ presentation slides are a hosted product feature, but
        // the open-source editor exposes its distraction-free view mode.
        // React is the sole owner of this controlled value; the capture-phase
        // shortcut handler above handles Alt+R without an internal-state race.
        viewModeEnabled={presentationMode}
        onPointerDown={(_activeTool, pointerDownState) => {
          const hitElement = pointerDownState.hit.element;
          if (!hitElement) return;
          const sceneElements = sceneRef.current?.elements ?? [];
          const instanceId =
            hitElement.customData?.[ARCHITECTURE_INSTANCE_KEY];
          const hitGroups = new Set(hitElement.groupIds);
          const linkedElement =
            typeof hitElement.customData?.detailFrameId === "string"
              ? hitElement
              : sceneElements.find(
                  (candidate) =>
                    (typeof instanceId === "string" &&
                      candidate.customData?.[ARCHITECTURE_INSTANCE_KEY] ===
                        instanceId) ||
                    candidate.groupIds.some((groupId) =>
                      hitGroups.has(groupId),
                    ),
                );
          const detailFrameId = linkedElement?.customData?.detailFrameId;
          if (
            typeof detailFrameId !== "string" ||
            !detailFrameId ||
            (!presentationMode && !pointerDownState.withCmdOrCtrl)
          ) {
            return;
          }
          navigateToDetailFrame(detailFrameId);
        }}
        onChange={(elements, appState, files) => {
          const scene = { elements, appState, files };
          sceneRef.current = scene;
          refreshFrameThumbnails(scene);
          const selectedDrilldownElement = elements.find(
            (element) =>
              appState.selectedElementIds[element.id] &&
              element.type !== "frame" &&
              element.type !== "magicframe",
          );
          setSelectedDrilldownElementId(
            selectedDrilldownElement?.id ?? null,
          );
          const selectedMarkdownCard = elements.find(
            (element) =>
              appState.selectedElementIds[element.id] &&
              typeof element.customData?.[MARKDOWN_CARD_KEY] === "string",
          );
          setSelectedMarkdownCardId(selectedMarkdownCard?.id ?? null);
          const nextFrames = orderedPresentationFrames(
            elements,
            manualFrameOrderRef.current ?? undefined,
          );
          setFrames((current) => {
            if (sameFrames(current, nextFrames)) return current;
            framesRef.current = nextFrames;
            return nextFrames;
          });

          const selectedArrows = elements.filter(
            (element): element is OrderedArrowElement =>
              isDirectionalArrow(element) &&
              appState.selectedElementIds[element.id],
          );
          const nextSelectedIds = selectedArrows.map((arrow) => arrow.id);
          setSelectedDirectionalArrowIds((current) =>
            current.length === nextSelectedIds.length &&
            current.every((id, index) => id === nextSelectedIds[index])
              ? current
              : nextSelectedIds,
          );
          setSelectedArrowsAnimated(
            selectedArrows.length > 0 &&
              selectedArrows.every(
                (arrow) => arrow.customData?.[ANIMATED_ARROW_KEY] === true,
              ),
          );
          if (selectedArrows[0]) {
            const nextSelectedStyle = flowStyleFromArrow(selectedArrows[0]);
            setSelectedFlowStyle((current) =>
              sameFlowStyle(current, nextSelectedStyle)
                ? current
                : nextSelectedStyle,
            );
          }
          setArrowStyleControlVisible(
            selectedArrows.length > 0 || appState.activeTool.type === "arrow",
          );

          // The custom animation flag is the equivalent of Excalidraw's
          // currentItem* style fields. Newly drawn directional arrows inherit
          // it once; existing arrows are never changed merely by switching
          // tools. NEVER keeps the metadata attachment in the same undo unit
          // as creating the arrow instead of adding a second undo step.
          const newlyDrawnAnimatedIds = new Set<string>();
          for (const element of elements) {
            if (!isDirectionalArrow(element)) continue;
            if (
              appState.newElement?.id === element.id ||
              appState.multiElement?.id === element.id
            ) {
              continue;
            }
            if (!processedDirectionalArrowIdsRef.current.has(element.id)) {
              processedDirectionalArrowIdsRef.current.add(element.id);
              if (
                readyRef.current &&
                currentArrowAnimationRef.current &&
                element.customData?.[ANIMATED_ARROW_KEY] === undefined
              ) {
                newlyDrawnAnimatedIds.add(element.id);
              }
            }
          }
          if (newlyDrawnAnimatedIds.size > 0) {
            apiRef.current?.updateScene({
              elements: elements.map((element) =>
                newlyDrawnAnimatedIds.has(element.id)
                  ? newElementWith(element, {
                      customData: {
                        ...element.customData,
                        [ANIMATED_ARROW_KEY]: true,
                        [FLOW_SPEED_KEY]: currentFlowStyleRef.current.speed,
                        [FLOW_DENSITY_KEY]:
                          currentFlowStyleRef.current.density,
                        [FLOW_DIRECTION_KEY]:
                          currentFlowStyleRef.current.direction,
                        [FLOW_COLOR_KEY]: currentFlowStyleRef.current.color,
                        [CONNECTOR_TYPE_KEY]:
                          currentFlowStyleRef.current.connectorType,
                        [CONNECTOR_PROTOCOL_KEY]:
                          currentFlowStyleRef.current.protocol,
                      },
                    })
                  : element,
              ),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }

          const hostRect = editorHostRef.current?.getBoundingClientRect();
          const flowPaths = elements
            .filter(
              (element): element is OrderedArrowElement =>
                isDirectionalArrow(element) &&
                element.customData?.[ANIMATED_ARROW_KEY] === true,
            )
            .map((arrow): AnimatedArrowPath => {
              const centerX = arrow.x + arrow.width / 2;
              const centerY = arrow.y + arrow.height / 2;
              const cos = Math.cos(arrow.angle);
              const sin = Math.sin(arrow.angle);
              const points = arrow.points.map(([localX, localY]) => {
                const sceneX = arrow.x + localX;
                const sceneY = arrow.y + localY;
                const dx = sceneX - centerX;
                const dy = sceneY - centerY;
                const viewport = sceneCoordsToViewportCoords(
                  {
                    sceneX: centerX + dx * cos - dy * sin,
                    sceneY: centerY + dx * sin + dy * cos,
                  },
                  appState,
                );
                return {
                  x: viewport.x - (hostRect?.left ?? 0),
                  y: viewport.y - (hostRect?.top ?? 0),
                };
              });
              const hasStart = POINTY_ARROWHEADS.has(
                arrow.startArrowhead ?? "",
              );
              const hasEnd = POINTY_ARROWHEADS.has(arrow.endArrowhead ?? "");
              const style = flowStyleFromArrow(arrow);
              const automaticDirection =
                hasStart && hasEnd ? "both" : hasStart ? "reverse" : "forward";
              return {
                id: arrow.id,
                path: flowPathFromPoints(
                  points,
                  Boolean(arrow.roundness) && !arrow.elbowed,
                ),
                color: style.color ?? arrow.strokeColor,
                direction:
                  style.direction === "auto"
                    ? automaticDirection
                    : style.direction,
                speed: style.speed,
                density: style.density,
              };
            });
          setAnimatedArrowPaths((current) => {
            const unchanged =
              current.length === flowPaths.length &&
              current.every((path, index) => {
                const next = flowPaths[index];
                return (
                  path.id === next?.id &&
                  path.path === next.path &&
                  path.color === next.color &&
                  path.direction === next.direction &&
                  path.speed === next.speed &&
                  path.density === next.density
                );
              });
            return unchanged ? current : flowPaths;
          });
          if (!readyRef.current) return;
          if (!dirtiedRef.current) {
            dirtiedRef.current = true;
            onDirty();
          }
          if (autoSaveTimerRef.current !== null) {
            clearTimeout(autoSaveTimerRef.current);
          }
          autoSaveTimerRef.current = setTimeout(() => {
            autoSaveTimerRef.current = null;
            const latest = sceneRef.current;
            if (!latest) return;
            void serializeScene(latest)
              .then((data) => onAutoSaveRef.current(data))
              .catch((err) =>
                console.error("[excalidraw] auto-save failed", err),
              );
          }, 500);
        }}
      />
    </div>
  );
}
