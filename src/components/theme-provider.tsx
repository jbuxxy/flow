"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const ThemeContext = createContext<{
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (t: Theme) => void;
}>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

const STORAGE_KEY = "flow-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function readSystemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializers instead of an effect-based sync on mount — the inline
  // script in layout.tsx already applied the right DOM class before paint,
  // and nothing here renders differently between server and first client
  // paint (ProfileMenu's theme buttons are behind a closed-by-default
  // dropdown), so there's no hydration mismatch to worry about.
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  // Tracks the *live* OS preference, updated only from the matchMedia
  // "change" listener below — separate from `theme` itself so picking
  // "system" keeps following the OS after the initial read, not just once.
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(readSystemPrefersDark);

  const resolvedTheme: "light" | "dark" = theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  // Synchronize the DOM class with the resolved theme — a genuine
  // external-system side effect, not a setState mirror.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  // Subscribe to OS theme changes; setState only happens inside the
  // listener callback (reacting to a real external change), not in the
  // effect body itself.
  useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY);
    function onChange(e: MediaQueryListEvent) {
      setSystemPrefersDark(e.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  function setTheme(next: Theme) {
    setThemeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore (private browsing etc.)
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
