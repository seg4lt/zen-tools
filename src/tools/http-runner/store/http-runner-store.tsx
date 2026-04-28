import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { HttpFile, HttpRequest, RequestResult } from "../lib/tauri";

/** Active sub-tab inside the HTTP runner. */
export type HttpRunnerSubView = "requests" | "performance";

export interface ChainStep {
  id: string;
  name: string;
}

export interface HttpRunnerState {
  /** Path of the currently-selected `.http` file. */
  selectedFilePath: string | null;
  /** Parsed contents of the selected file. */
  selectedFile: HttpFile | null;
  /** Stable id of the currently-selected request. */
  selectedRequestId: string | null;
  /** Last result keyed by stable id. */
  results: Record<string, RequestResult>;
  /** Currently-running execution chain (set by `request:chain` events). */
  chainSteps: ChainStep[];
  /** Active environment, if any. */
  activeEnv: string | null;
  /** Logs accumulated from streaming events. */
  logs: { ts: string; message: string; level: "info" | "warn" | "error" }[];
  /** Whether a request is currently in flight. */
  isRunning: boolean;
}

const initialState: HttpRunnerState = {
  selectedFilePath: null,
  selectedFile: null,
  selectedRequestId: null,
  results: {},
  chainSteps: [],
  activeEnv: null,
  logs: [],
  isRunning: false,
};

export type HttpRunnerAction =
  | { type: "selectFile"; path: string | null; file: HttpFile | null }
  | { type: "selectRequest"; id: string | null }
  | { type: "result"; result: RequestResult }
  | { type: "chain"; steps: ChainStep[] }
  | { type: "setRunning"; running: boolean }
  | { type: "setEnv"; env: string | null }
  | {
      type: "log";
      message: string;
      level?: "info" | "warn" | "error";
    }
  | { type: "clearLogs" };

function reducer(
  state: HttpRunnerState,
  action: HttpRunnerAction,
): HttpRunnerState {
  switch (action.type) {
    case "selectFile":
      return {
        ...state,
        selectedFilePath: action.path,
        selectedFile: action.file,
        selectedRequestId: null,
      };
    case "selectRequest":
      // Reset the displayed chain when the selection changes — the next
      // run command will populate it.
      return { ...state, selectedRequestId: action.id, chainSteps: [] };
    case "result": {
      const next = { ...state.results, [action.result.requestId]: action.result };
      return { ...state, results: next };
    }
    case "chain":
      return { ...state, chainSteps: action.steps };
    case "setRunning":
      return { ...state, isRunning: action.running };
    case "setEnv":
      return { ...state, activeEnv: action.env };
    case "log":
      return {
        ...state,
        logs: [
          ...state.logs.slice(-499),
          {
            ts: new Date().toISOString(),
            message: action.message,
            level: action.level ?? "info",
          },
        ],
      };
    case "clearLogs":
      return { ...state, logs: [] };
    default:
      return state;
  }
}

interface HttpRunnerContextValue {
  state: HttpRunnerState;
  dispatch: Dispatch<HttpRunnerAction>;
}

const HttpRunnerContext = createContext<HttpRunnerContextValue | null>(null);

/** Provide the HTTP runner reducer state to the subtree. */
export function HttpRunnerStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <HttpRunnerContext.Provider value={value}>
      {children}
    </HttpRunnerContext.Provider>
  );
}

/** Read the HTTP runner state + dispatcher. */
export function useHttpRunner(): HttpRunnerContextValue {
  const ctx = useContext(HttpRunnerContext);
  if (!ctx) {
    throw new Error("useHttpRunner must be used inside <HttpRunnerStoreProvider>");
  }
  return ctx;
}

/** Selector helper for components that only need the request list. */
export function useSelectedRequest(): HttpRequest | null {
  const { state } = useHttpRunner();
  if (!state.selectedFile || !state.selectedRequestId) return null;
  return (
    state.selectedFile.requests.find(
      (r) => stableId(state.selectedFile!.path, r) === state.selectedRequestId,
    ) ?? null
  );
}

/** Compute the same `stable_id` Rust uses (`source_file:name`). */
export function stableId(filePath: string, request: HttpRequest): string {
  const name = request.name ?? request.id;
  return `${filePath}:${name}`;
}
