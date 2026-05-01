import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** What we actually paint with — `dark` or `light`. */
export type Theme = "light" | "dark";

/**
 * What the user *picks*. `system` means "follow the OS"; the
 * effective {@link Theme} is then resolved against
 * `prefers-color-scheme` and updated live when the OS toggles.
 */
export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  /** Resolved theme — always `light` or `dark`, never `system`. */
  theme: Theme;
  /** User-chosen mode. `system` resolves on the fly. */
  mode: ThemeMode;
  /** Set the mode (and persist). */
  setMode: (next: ThemeMode) => void;
  /**
   * Set an explicit theme (resolves to a concrete `light`/`dark`
   * mode). Kept for back-compat with the old binary toggle UI.
   */
  setTheme: (theme: Theme) => void;
  /** Flip between light and dark, leaving `system` mode if currently active. */
  toggle: () => void;
}

const STORAGE_KEY = "zen-tools.theme";
const LIGHT_MEDIA = "(prefers-color-scheme: light)";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  // First-launch default: respect the OS rather than picking dark
  // arbitrarily.
  return "system";
}

function readSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(LIGHT_MEDIA).matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/** Wrap the app so descendants can read/toggle the theme. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readInitialMode());
  const [systemTheme, setSystemTheme] = useState<Theme>(() =>
    readSystemTheme(),
  );

  // When the OS theme flips and we're in `system` mode the UI must
  // follow live. The listener fires regardless of mode; we just swap
  // an internal value that gets folded into the resolved `theme`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(LIGHT_MEDIA);
    const onChange = () =>
      setSystemTheme(mql.matches ? "light" : "dark");
    if (mql.addEventListener) {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Older Safari fallback.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const theme: Theme = mode === "system" ? systemTheme : mode;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = useCallback(
    (next: ThemeMode) => setModeState(next),
    [],
  );
  const setTheme = useCallback(
    (next: Theme) => setModeState(next),
    [],
  );
  const toggle = useCallback(
    () => setModeState((prev) => {
      const current = prev === "system" ? readSystemTheme() : prev;
      return current === "dark" ? "light" : "dark";
    }),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, mode, setMode, setTheme, toggle }),
    [theme, mode, setMode, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Read the current theme + setters. Throws if used outside the provider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
