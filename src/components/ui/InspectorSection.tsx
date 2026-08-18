import { type ReactNode } from 'react';

interface InspectorSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function InspectorSection({ title, children }: InspectorSectionProps) {
  return (
    <div className="border-b border-outline-variant/10">
      <div className="px-3 py-2">
        <h4 className="font-label-caps text-label-caps text-on-surface-variant mb-2">{title}</h4>
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

interface InspectorFieldProps {
  label: string;
  children: ReactNode;
}

export function InspectorField({ label, children }: InspectorFieldProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-on-surface-variant shrink-0">{label}</span>
      {children}
    </div>
  );
}

interface NumberInputProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  className?: string;
}

export function NumberInput({ value, onChange, step = 0.1, className = '' }: NumberInputProps) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={`bg-surface-low border border-outline-variant/20 rounded px-2 py-1 text-xs font-mono text-on-surface focus:border-primary/50 focus:outline-none w-20 ${className}`}
    />
  );
}

interface ColorInputProps {
  value: string;
  onChange: (v: string) => void;
}

export function ColorInput({ value, onChange }: ColorInputProps) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-7 h-7 rounded border border-outline-variant/20 bg-transparent cursor-pointer"
      />
      <span className="text-xs font-mono text-on-surface-variant">{value}</span>
    </div>
  );
}

interface SliderInputProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function SliderInput({ value, onChange, min = 0, max = 1, step = 0.01 }: SliderInputProps) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-primary h-1"
      />
      <span className="text-xs font-mono text-on-surface-variant w-8 text-right">{value.toFixed(2)}</span>
    </div>
  );
}
