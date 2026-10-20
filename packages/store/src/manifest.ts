// Every result ships a manifest (CLAUDE.md): what produced it, with which settings, how long it took, what it cost,
// what to be careful about, who owns the rights and what is AI-made.

export interface ManifestInput {
  providers: Record<string, unknown>;
  settings: Record<string, unknown>;
  timings: Record<string, number | null>;
  cpuSeconds: number;
  warnings: string[];
  rights: string | null;
  aiGeneratedInput: boolean;
  aiFlags: Record<string, boolean>;
}

// Licence facts, copied from SOURCES.md (where the evidence files are named). "unchecked" is kept as it is there.
export const SOFTWARE_LICENCES = {
  "faster-whisper": "MIT (code); weights Systran/faster-whisper-* MIT; training data unchecked",
  "sherpa-onnx": "Apache-2.0 (code); pyannote segmentation-3.0 ONNX MIT; WeSpeaker ResNet34 Apache-2.0; training data unchecked",
  engine: "own code",
} as const;

export function buildManifest(i: ManifestInput) {
  return {
    providers: i.providers,
    settings: i.settings,
    // No random source exists anywhere in the path (engine and rules parser are pure), so there is no seed to report.
    seed: null,
    timings: i.timings,
    cost_estimate: {
      basis: "CPU seconds used on this VM (process CPU time of the service plus the CPU-bound ASR/diarization seconds reported by the ASR service)",
      cpu_seconds: Math.round(i.cpuSeconds * 1000) / 1000,
      usd: null,
      note: "No price per CPU second is configured, so no money figure is given.",
    },
    warnings: i.warnings,
    rights: { source_media: i.rights ?? "not stated by the uploader", software: SOFTWARE_LICENCES, reference: "SOURCES.md" },
    ai_generated: { input_media_marked_ai_generated: i.aiGeneratedInput, ...i.aiFlags },
  };
}

export type Manifest = ReturnType<typeof buildManifest>;
