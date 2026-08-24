import { Command, Search } from "lucide-react";
import { useState } from "react";
import { navGroups, type CustomResourceDefinition } from "../data";
import { tr } from "../i18n";
import { resourceLabel, type AppLanguage } from "../preferences";
import type { CustomResourceNavEntry } from "./types";

function CommandPalette({ language, customResources, onClose, onNavigate, onTerminal, onCreate }: { language: AppLanguage; customResources: CustomResourceNavEntry[]; onClose: () => void; onNavigate: (item: string, crd?: Pick<CustomResourceDefinition, "name" | "kind">) => void; onTerminal: () => void; onCreate: () => void }) {
  const [query, setQuery] = useState("");
  const commands = [
    ...navGroups.flatMap((group) => group.items).map((item) => ({ label: tr(language, "goTo", { resource: resourceLabel(language, item) }), run: () => onNavigate(item) })),
    ...customResources.map((entry) => ({ label: tr(language, "goTo", { resource: entry.label }), run: () => onNavigate("Custom Resource Definitions", { name: entry.name, kind: entry.kind }) })),
    { label: tr(language, "openClusterTerminal"), run: onTerminal },
    { label: tr(language, "createResource"), run: onCreate },
  ].filter((command) => command.label.toLowerCase().includes(query.toLowerCase())).slice(0, 12);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="command-modal" onMouseDown={(event) => event.stopPropagation()}><div className="command-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && commands[0]) { commands[0].run(); onClose(); } }} placeholder={tr(language, "commandSearch")} /><kbd>ESC</kbd></div><p>{query ? tr(language, "results") : tr(language, "quickActions")}</p>{commands.map((command) => <button key={command.label} onClick={() => { command.run(); onClose(); }}><span className="command-key"><Command size={14} /></span>{command.label}<kbd>↵</kbd></button>)}{commands.length === 0 && <div className="related-empty">{tr(language, "noMatchingCommand")}</div>}</div></div>;
}

export { CommandPalette };
