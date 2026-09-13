import type { AgentProvider } from './types/chat.js';

export type ModelMode = 'fable' | 'sonnet' | 'opus' | 'haiku';
export type CodexPreset = 'supersol' | 'superastra';

export interface ModelConfig {
  value: ModelMode;
  label: string;
  description: string;
  color: string;
  hoverColor: string;
}

export const MODELS: Record<ModelMode, ModelConfig> = {
  fable: {
    value: 'fable',
    label: 'Fable 5',
    description: 'Fable 5 (most intelligent)',
    color: '#a855f7',
    hoverColor: '#c084fc',
  },
  sonnet: {
    value: 'sonnet',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 (smarter)',
    // Theme-safe neutral gray — same white-on-white fix as EFFORT_LEVELS.high
    // (currently unrendered, but keep no invisible-on-light sentinels around).
    color: '#6b7280',
    hoverColor: '#9ca3af',
  },
  opus: {
    value: 'opus',
    label: 'Opus 4.8',
    description: 'Opus 4.8 (most capable)',
    color: '#f59e0b',
    hoverColor: '#fbbf24',
  },
  haiku: {
    value: 'haiku',
    label: 'Haiku (faster)',
    description: 'Haiku (faster)',
    color: '#3b82f6',
    hoverColor: '#60a5fa',
  },
} as const;

export const DEFAULT_MODEL_MODE: ModelMode = 'opus';

export const MODEL_MODES: readonly ModelMode[] = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export const CODEX_PRESETS: Record<
  CodexPreset,
  Omit<ModelConfig, 'value'> & { value: CodexPreset }
> = {
  supersol: {
    value: 'supersol',
    label: 'SuperSol',
    description: 'Codex through the supersol CLI preset',
    color: '#6b7280',
    hoverColor: '#9ca3af',
  },
  superastra: {
    value: 'superastra',
    label: 'SuperAstra',
    description: 'Codex through the superastra CLI preset',
    color: '#f59e0b',
    hoverColor: '#fbbf24',
  },
};

export const CODEX_PRESET_IDS: readonly CodexPreset[] = ['supersol', 'superastra'] as const;
export const DEFAULT_CODEX_PRESET: CodexPreset = 'supersol';

export function getCodexPresetForModel(model?: string | null): CodexPreset {
  if (model === 'gpt-6-astra') return 'superastra';
  return DEFAULT_CODEX_PRESET;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description: string;
}

export function getAgentModelOptions(provider: AgentProvider = 'claude'): AgentModelOption[] {
  return provider === 'codex'
    ? CODEX_PRESET_IDS.map((id) => ({
        id,
        label: CODEX_PRESETS[id].label,
        description: CODEX_PRESETS[id].description,
      }))
    : MODEL_MODES.map((id) => ({
        id,
        label: MODELS[id].label,
        description: MODELS[id].description,
      }));
}

export function getAgentModelLabel(provider: AgentProvider | undefined, model: string): string {
  if (provider === 'codex') return CODEX_PRESETS[model as CodexPreset]?.label ?? model;
  return MODELS[model as ModelMode]?.label ?? model;
}

// Anthropic API model IDs for direct Anthropic SDK calls.
// Claude Agent SDK sessions receive the ModelMode alias directly so the SDK can
// resolve the default version for each model family.
export const MODEL_IDS: Record<ModelMode, string> = {
  fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
} as const;

export function isModelMode(value: string): value is ModelMode {
  return MODEL_MODES.includes(value as ModelMode);
}

export function getModelConfig(mode: ModelMode): ModelConfig {
  return MODELS[mode];
}

export function getModelId(mode: ModelMode): string {
  return MODEL_IDS[mode];
}

export function getNextModel(current: ModelMode): ModelMode {
  const currentIndex = MODEL_MODES.indexOf(current);
  return MODEL_MODES[(currentIndex + 1) % MODEL_MODES.length];
}
