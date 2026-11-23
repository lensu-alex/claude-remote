"use client";

import { EFFORTS, MODELS, type Option } from "@/lib/models";
import type { RunChoice } from "@/lib/types";
import { Sheet } from "./Sheet";

function Choices({ label, options, value, onPick }: { label: string; options: Option[]; value: string; onPick: (value: string) => void }) {
  return (
    <>
      <h3 className="sheet-label">{label}</h3>
      <div className="chips" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value || "default"}
            type="button"
            className={option.value === value ? "chip is-on" : "chip"}
            aria-pressed={option.value === value}
            onClick={() => onPick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Picks the model and effort for the messages sent from here on. "Default" leaves it to the laptop. */
export function RunSheet({ value, onChange, onClose }: { value: RunChoice; onChange: (next: RunChoice) => void; onClose: () => void }) {
  return (
    <Sheet title="Model and Effort" onClose={onClose}>
      <Choices label="Model" options={MODELS} value={value.model} onPick={(model) => onChange({ ...value, model })} />
      <Choices label="Effort" options={EFFORTS} value={value.effort} onPick={(effort) => onChange({ ...value, effort })} />
      <p className="sheet-note">
        Default uses what the laptop is set to. More effort thinks longer and uses more of your plan&apos;s limit.
      </p>
      <div className="sheet-buttons">
        <button type="button" className="button button-tint" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
