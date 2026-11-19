import React from "react";
import { ArrowLeft } from "lucide-react";
import { ModeIcon } from "./ModePicker";

/** Placeholder for the AI Trader screen, which you will build later. */
export default function AiTraderMode({ onExit }: { onExit: () => void }) {
  return (
    <div className="qm">
      <div className="qm-head">
        <button className="qm-back" onClick={onExit} aria-label="Back"><ArrowLeft size={20} /></button>
        <div><h1>AI Trader</h1><p className="qm-status"><i />COMING SOON</p></div>
      </div>
      <div className="qm-card gc big ai" style={{ ["--g1" as string]: "#7a6bff", ["--g2" as string]: "#c04fd8" }}>
        <div className="qm-soon"><ModeIcon mode="ai" size={64} /><h2>AI Trader</h2><p>This mode is being built. Classic mode and Pro mode are ready to use.</p></div>
      </div>
    </div>
  );
}
