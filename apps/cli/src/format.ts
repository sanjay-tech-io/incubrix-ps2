import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The session file format.
 *
 *   name: worked_example                 # optional, defaults to the file name
 *   description: free text               # optional
 *   video: media/test_single.mp4         # local path (uploaded), or an http(s) URL (the server downloads it)
 *   num_speakers: 1                      # optional hint for diarization
 *   rights: "own recording"              # optional, recorded in the manifest
 *   ai_generated: false                  # optional
 *   steps:
 *     - say: 'add a caption "Hi" on "welcome"'
 *       expect: applied                  # optional: applied | needs_clarification | rejected
 *     - say: "remove the part about pricing"
 *       expect: needs_clarification
 *     - answer: "the second one"         # reply to the open question (a number or text); `say` may be sent with it
 *       expect: applied
 *     - render: true                     # starts the render job and waits for it
 *       expect: succeeded                # optional: succeeded | failed
 *
 * Steps are plain data: this runner is an HTTP client of the API and contains no editing logic.
 */
const Status = z.enum(["applied", "needs_clarification", "rejected"]);

const Say = z.strictObject({
  say: z.string().min(1).optional(),
  answer: z.union([z.string().min(1), z.number().int().min(1)]).optional(),
  expect: Status.optional(),
  /** Optional check of the answer's duration_s (seconds, +-0.01). */
  expect_duration_s: z.number().optional(),
  /** Case-insensitive regular expressions on the answer: at least one warning matches / no warning matches / summary, question, reason, options or warnings match. */
  expect_warning: z.string().optional(),
  expect_no_warning: z.string().optional(),
  expect_text: z.string().optional(),
  /** Exact number of options in a needs_clarification answer. */
  expect_options: z.number().int().min(0).optional(),
  /** The answer's timeline_hash equals the one after the previous step (repeat instructions, clarification questions). */
  expect_hash_unchanged: z.boolean().optional(),
  note: z.string().optional(),
});
const Render = z.strictObject({
  render: z.literal(true),
  expect: z.enum(["succeeded", "failed"]).optional(),
  expect_error: z.string().optional(),
  note: z.string().optional(),
});

export const SessionDoc = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  video: z.string().min(1),
  num_speakers: z.number().int().min(1).optional(),
  rights: z.string().optional(),
  ai_generated: z.boolean().optional(),
  steps: z.array(z.union([Render, Say])).min(1),
  /** The whole session is expected to stop at video intake with this error code (e.g. NO_AUDIO_TRACK). */
  expect_intake_error: z.string().optional(),
});
export type SessionDoc = z.infer<typeof SessionDoc>;
export type SayStep = z.infer<typeof Say>;
export type RenderStep = z.infer<typeof Render>;

export function isRender(s: SayStep | RenderStep): s is RenderStep {
  return "render" in s;
}

export function loadSession(file: string): SessionDoc {
  const doc = parse(readFileSync(file, "utf8")) as unknown;
  const r = SessionDoc.safeParse(doc);
  if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  for (const [i, s] of r.data.steps.entries()) {
    if (!isRender(s) && s.say === undefined && s.answer === undefined) throw new Error(`${file}: step ${i + 1} needs say, answer or render`);
  }
  return r.data;
}
