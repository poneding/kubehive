import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { TextSearchController } from "./text-search";
import "@xterm/xterm/css/xterm.css";
import "./container-terminal.css";

const darkTheme: ITheme = {
  background: "#090c0f",
  foreground: "#c3ccd3",
  cursor: "#5bd9a1",
  cursorAccent: "#090c0f",
  selectionBackground: "#31584699",
  black: "#161a1f",
  red: "#f07178",
  green: "#5bd9a1",
  yellow: "#e6c56b",
  blue: "#69a7e8",
  magenta: "#c792ea",
  cyan: "#5ccfe6",
  white: "#d8dee9",
  brightBlack: "#66707a",
  brightRed: "#ff8b92",
  brightGreen: "#74e7b3",
  brightYellow: "#f5d97f",
  brightBlue: "#82b8ef",
  brightMagenta: "#d8a8f0",
  brightCyan: "#7adcf0",
  brightWhite: "#f3f5f7",
};

const lightTheme: ITheme = {
  background: "#f4f6f8",
  foreground: "#25313a",
  cursor: "#08794e",
  cursorAccent: "#f4f6f8",
  selectionBackground: "#9acbb5aa",
  black: "#26313a",
  red: "#b6424b",
  green: "#08794e",
  yellow: "#8b6a00",
  blue: "#2869a8",
  magenta: "#80539b",
  cyan: "#137a86",
  white: "#e4e8eb",
  brightBlack: "#687580",
  brightRed: "#cf5961",
  brightGreen: "#159866",
  brightYellow: "#a9840a",
  brightBlue: "#3d82c4",
  brightMagenta: "#9669ae",
  brightCyan: "#278f9b",
  brightWhite: "#ffffff",
};

export function ContainerTerminal({
  sessionId,
  output,
  connected,
  theme,
  fontFamily,
  fontSize,
  search,
  onInput,
  onResize,
  onFind,
}: {
  sessionId: string;
  output: string;
  connected: boolean;
  theme: "light" | "dark";
  fontFamily: string;
  fontSize: number;
  search: TextSearchController;
  onInput: (data: string) => void;
  onResize: (columns: number, rows: number) => void;
  onFind: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const lastOutputRef = useRef("");
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const findRef = useRef(onFind);

  inputRef.current = onInput;
  resizeRef.current = onResize;
  findRef.current = onFind;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily,
      fontSize,
      lineHeight: 1.25,
      scrollback: 10_000,
      smoothScrollDuration: 100,
      theme: theme === "light" ? lightTheme : darkTheme,
      allowTransparency: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2_000 });
    terminal.loadAddon(fit);
    terminal.loadAddon(searchAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = searchAddon;

    const inputDisposable = terminal.onData((data) => inputRef.current(data));
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        findRef.current();
        return false;
      }
      return true;
    });
    const fitTerminal = () => {
      try {
        fit.fit();
        resizeRef.current(terminal.cols, terminal.rows);
      } catch {
        // The host can be temporarily hidden while switching sessions.
      }
    };
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    const frame = window.requestAnimationFrame(() => { fitTerminal(); terminal.focus(); });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      lastOutputRef.current = "";
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.theme = theme === "light" ? lightTheme : darkTheme;
    terminal.options.disableStdin = !connected;
    fitRef.current?.fit();
    if (connected) terminal.focus();
  }, [connected, fontFamily, fontSize, theme, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const previous = lastOutputRef.current;
    if (!output.startsWith(previous)) {
      terminal.reset();
      if (output) terminal.write(output);
    } else {
      const chunk = output.slice(previous.length);
      if (chunk) terminal.write(chunk);
    }
    lastOutputRef.current = output;
  }, [output, sessionId]);

  useEffect(() => {
    const addon = searchRef.current;
    if (!addon) return;
    const frame = window.requestAnimationFrame(() => {
      addon.clearDecorations();
      if (!search.query) return;
      const options = {
        caseSensitive: search.caseSensitive,
        regex: search.regularExpression,
        wholeWord: search.wholeWord,
        incremental: true,
        decorations: theme === "light" ? {
          matchBackground: "#f5dc8c",
          matchBorder: "#b58d22",
          matchOverviewRuler: "#b58d22",
          activeMatchBackground: "#e2ad2f",
          activeMatchBorder: "#7e5b00",
          activeMatchColorOverviewRuler: "#7e5b00",
        } : {
          matchBackground: "#7f6724",
          matchBorder: "#c6a744",
          matchOverviewRuler: "#c6a744",
          activeMatchBackground: "#f1c75b",
          activeMatchBorder: "#ffe59d",
          activeMatchColorOverviewRuler: "#ffe59d",
        },
      };
      addon.findNext(search.query, options);
      for (let index = 0; index < Math.min(search.currentIndex, 2_000); index += 1) addon.findNext(search.query, options);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [output, search.query, search.currentIndex, search.caseSensitive, search.regularExpression, search.wholeWord, theme]);

  return <div ref={hostRef} className="container-terminal" aria-label="Container terminal" data-session-id={sessionId}/>;
}

export default ContainerTerminal;
