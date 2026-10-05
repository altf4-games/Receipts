"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("receipts:theme");
      const t = saved === "light" || saved === "dark" ? saved : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      setTheme(t);
      document.documentElement.dataset.theme = t;
    } catch { /* storage unavailable: follow the system */ }
  }, []);
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("receipts:theme", t); } catch { /* ignore */ }
  };
  return <button onClick={flip} className="underline" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? "Light" : "Dark"}</button>;
}
