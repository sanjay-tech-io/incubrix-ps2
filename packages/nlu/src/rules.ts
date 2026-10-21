import {
  EngineError, analyzeLog, checkSpeed, atomAt, atomPos, cursorToUs, editedToSource, findEffect, findTopicParts, formatTime, nextEffectId, phraseRanges,
  planMoveEdited, planProtectPause, planRemoveFillers, planRemoveSilences, planUpdateCaption, resolveEditedRange, resolveOriginalRange, snapPoint, sourceToEdited,
  timelinePieces, usToCursor, currentTimeline,
  type Atom, type AtomRange, type CaptionPatch, type Effect, type EngineContext, type Operation, type PendingQuestion, type Span, type TimePolicy, type Timeline,
} from "@incubrix/engine";
import { findRange, findTimeAfter, parseTimeAt, tokenize, wordsToDigits } from "./time.ts";
import type { InstructionParser, ParseInput, Parsed } from "./types.ts";

/**
 * The deterministic rule-based parser: no network, no key, no clock. Same text + same session state => same output.
 * It only builds structured operations with engine helpers. When it is not sure what a DESTRUCTIVE instruction
 * means it asks (clarify); when it cannot understand at all it rejects. It never guesses.
 */
export const RULES_VERSION = "1";

const WHITE = { color: "#ffffff", sizePt: 32, bold: true };
const COLORS: Record<string, string> = {
  red: "#ff0000", blue: "#0000ff", green: "#00ff00", yellow: "#ffff00", white: "#ffffff", black: "#000000", orange: "#ffa500", purple: "#800080", pink: "#ffc0cb",
};
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };
const CUT_VERB = /\b(cut|remove|delete|trim|drop|take out|get rid of|erase)\b/;
const SIZE_STEP_PT = 8;
const CAPTION_WORDS_WINDOW_US = 2_500_000;

interface Env {
  ctx: EngineContext;
  input: ParseInput;
  tl: Timeline;
  policy: TimePolicy;
  /** Edit operations already produced by earlier parts of the same instruction (effect ids must not collide). */
  offset: number;
  raw: string;
  /** Lower-case text with quoted strings replaced by a marker. */
  body: string;
  quoted: string[];
}

const plan = (env: Env, operations: Operation[], warnings: string[] = [], nothingToDo?: string): Parsed =>
  nothingToDo === undefined ? { kind: "plan", operations, warnings, timePolicy: env.policy } : { kind: "plan", operations, warnings, timePolicy: env.policy, nothingToDo };
const reject = (env: Env, reason: string, warnings: string[] = []): Parsed => ({ kind: "reject", reason, timePolicy: env.policy, warnings });
const clarify = (env: Env, question: string, options: PendingQuestion["options"], warnings: string[] = []): Parsed => ({ kind: "clarify", question, options, timePolicy: env.policy, warnings });

const durationOf = (env: Env): number => (env.policy === "original" ? env.ctx.source.durationUs : env.tl.durationUs);

function spansFor(env: Env, startUs: number, endUs: number): { spans: Span[]; warnings: string[] } {
  return env.policy === "original" ? resolveOriginalRange(env.ctx, startUs, endUs) : resolveEditedRange(env.ctx, env.tl, startUs, endUs);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "1.5" -> 3/2, "2" -> 2/1 (lowest terms, up to 3 decimals). */
function rateOf(text: string): { num: number; den: number } | null {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const den = 10 ** (m[2]?.length ?? 0);
  const num = Number(m[1] + (m[2] ?? ""));
  if (num === 0) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function editedLabel(env: Env, atom: Atom): string {
  const pieces = timelinePieces(env.ctx, env.tl);
  const e = sourceToEdited(pieces, atom.startUs);
  return e === null ? `original ${formatTime(atom.startUs)} (currently cut)` : formatTime(e);
}

function contextWords(ctx: EngineContext, r: AtomRange, before = 3, after = 5): string {
  const words = ctx.index.atoms.filter((a) => a.kind === "word");
  const a = words.findIndex((w) => w.id === r.from);
  const b = words.findIndex((w) => w.id === r.to);
  return words.slice(Math.max(0, a - before), b + after + 1).map((w) => w.text).join(" ");
}

/** Phrase occurrences that still play in the edited timeline (a mention that was cut is not offered), or all of them for "original". */
function liveRanges(env: Env, phrase: string): AtomRange[] {
  const all = phraseRanges(env.ctx, phrase);
  if (env.policy === "original") return all;
  const pieces = timelinePieces(env.ctx, env.tl);
  return all.filter((r) => sourceToEdited(pieces, env.ctx.index.atoms[atomPos(env.ctx.index, r.from)]!.startUs) !== null);
}

function rangeOptions(env: Env, ranges: AtomRange[], what: string, make: (r: AtomRange) => { operations: Operation[]; warnings: string[] }): Parsed {
  const options: PendingQuestion["options"] = ranges.map((r, i) => {
    const first = env.ctx.index.atoms[atomPos(env.ctx.index, r.from)]!;
    const m = make(r);
    return { label: `#${i + 1} at ${editedLabel(env, first)}: "${contextWords(env.ctx, r)}"`, operations: m.operations, warnings: m.warnings };
  });
  return clarify(env, `${what} appears ${ranges.length} times. Which one?`, options);
}

// ---------------------------------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------------------------------

function cutGroups(env: Env): { group: number; ops: Operation[] }[] {
  const an = analyzeLog(env.input.state.log);
  return an.active
    .filter((g) => !an.neutralized.has(g))
    .map((g) => ({ group: g, ops: an.opsByGroup.get(g) ?? [] }))
    .filter(({ ops }) => ops.some((o) => o.type === "cut" || o.type === "keep_only"));
}

function groupLabel(env: Env, g: { group: number; ops: Operation[] }): string {
  const cuts = g.ops.filter((o): o is Extract<Operation, { type: "cut" }> => o.type === "cut");
  if (cuts.length === 0) return `edit ${g.group}: kept only part of the video`;
  const lo = Math.min(...cuts.map((c) => cursorToUs(env.ctx.index, c.span.start, env.ctx.fps)));
  const hi = Math.max(...cuts.map((c) => cursorToUs(env.ctx.index, c.span.end, env.ctx.fps, "end")));
  return `edit ${g.group}: removed original ${formatTime(lo)}-${formatTime(hi)}`;
}

const restoreOp = (g: number): Operation => ({ type: "restore", targetGroup: g });

function handleRestore(env: Env, which: "intro" | "outro" | "any" | number | { fromEnd: number }, extraWarnings: string[] = []): Parsed {
  const groups = cutGroups(env);
  if (typeof which === "number") {
    return plan(env, [restoreOp(which)], extraWarnings); // the engine rejects a group that does not exist or is not in effect
  }
  let cands = groups;
  if (which === "intro") cands = groups.filter((g) => g.ops.some((o) => o.type === "cut" && cursorToUs(env.ctx.index, o.span.start, env.ctx.fps) === 0));
  if (which === "outro") cands = groups.filter((g) => g.ops.some((o) => o.type === "cut" && cursorToUs(env.ctx.index, o.span.end, env.ctx.fps, "end") === env.ctx.source.durationUs));
  if (typeof which === "object") {
    const g = groups[groups.length - which.fromEnd];
    if (!g) return reject(env, `There are only ${groups.length} cut(s) in effect, so there is no cut number ${which.fromEnd} from the end.`);
    return plan(env, [restoreOp(g.group)], [`Restoring ${groupLabel(env, g)}. Everything else (captions, speed, music) is left as it is.`, ...extraWarnings]);
  }
  if (cands.length === 0) {
    return reject(env, which === "any" ? "Nothing has been removed (no cut is in effect), so there is nothing to put back." : `No cut of the ${which} is in effect, so there is nothing to put back.`);
  }
  if (cands.length === 1) return plan(env, [restoreOp(cands[0]!.group)], [`Restoring ${groupLabel(env, cands[0]!)}.`, ...extraWarnings]);
  return clarify(env, "Several cuts are in effect. Which one should I put back?", cands.map((g) => ({ label: groupLabel(env, g), operations: [restoreOp(g.group)], warnings: [] })));
}

function handleCaptionStyle(env: Env, patchFor: (e: Effect) => CaptionPatch, describe: string): Parsed {
  const found = findEffect(env.tl, "caption");
  if (found.kind === "none") return reject(env, `There is no caption to change (${describe}). Add one first, for example: add a caption "Hello" on "welcome".`);
  if (found.kind === "one") return plan(env, [planUpdateCaption(found.effect, patchFor(found.effect))]);
  return clarify(
    env,
    `There are ${found.candidates.length} captions. Which one?`,
    found.candidates.map((e) => ({
      label: `caption "${e.params.kind === "caption" ? e.params.text : ""}" (${e.id})`,
      operations: [planUpdateCaption(e, patchFor(e))],
      warnings: [],
    })),
  );
}

function captionAnchorByTime(env: Env, tUs: number): AtomRange | string {
  const dur = durationOf(env);
  if (tUs >= dur) return `The ${env.policy === "original" ? "original" : "edited"} video lasts ${formatTime(dur)}, so I cannot add a caption at ${formatTime(tUs)}.`;
  const src = env.policy === "original" ? tUs : editedToSource(timelinePieces(env.ctx, env.tl), tUs);
  const atoms = env.ctx.index.atoms;
  let i = atomPos(env.ctx.index, atomAt(env.ctx.index, src).id);
  while (i < atoms.length && atoms[i]!.kind !== "word") i++;
  if (i >= atoms.length) return `There are no spoken words after ${formatTime(tUs)} to anchor a caption to.`;
  let j = i;
  while (j + 1 < atoms.length && atoms[j + 1]!.startUs < atoms[i]!.startUs + CAPTION_WORDS_WINDOW_US) j++;
  while (atoms[j]!.kind !== "word") j--;
  return { from: atoms[i]!.id, to: atoms[j]!.id };
}

function handleAddCaption(env: Env): Parsed {
  const text = env.quoted[0]!;
  const addOp = (range: AtomRange): Operation => ({ type: "add_effect", effectId: nextEffectId(env.input.state.log, env.offset), range, params: { kind: "caption", text, style: WHITE, position: "bottom" } });
  if (env.quoted[1] !== undefined) {
    const ranges = liveRanges(env, env.quoted[1]);
    if (ranges.length === 0) return reject(env, `I could not find the words "${env.quoted[1]}" in the video, so there is nothing to put the caption on.`);
    if (ranges.length === 1) return plan(env, [addOp(ranges[0]!)]);
    return rangeOptions(env, ranges, `"${env.quoted[1]}"`, (r) => ({ operations: [addOp(r)], warnings: [] }));
  }
  const at = findTimeAfter(tokenize(wordsToDigits(env.body)), ["at", "around", "from"]);
  if (at) {
    const r = captionAnchorByTime(env, at.us);
    return typeof r === "string" ? reject(env, r) : plan(env, [addOp(r)], at.warnings);
  }
  return reject(env, 'Tell me where the caption goes: on which words (add a caption "Hello" on "welcome to the channel") or at what time (at 0:30).');
}

function handleEffectWords(env: Env, kind: "mute" | "bleep"): Parsed {
  let phrase = env.quoted[0];
  if (phrase === undefined) {
    const m = /\b(?:word|words|saying|says|say|phrase)\s+(.+)$/.exec(env.body);
    phrase = m?.[1]?.replace(/^(the|a|an)\s+/, "").trim();
  }
  if (!phrase) return reject(env, `Tell me which words to ${kind}, for example: ${kind} "word".`);
  const ranges = liveRanges(env, phrase);
  if (ranges.length === 0) return reject(env, `I could not find "${phrase}" in the video.`);
  const ops: Operation[] = ranges.map((range, i) => ({ type: "add_effect", effectId: nextEffectId(env.input.state.log, env.offset + i), range, params: { kind } }));
  return plan(env, ops, ranges.length > 1 ? [`"${phrase}" occurs ${ranges.length} times; all of them are ${kind === "mute" ? "muted" : "bleeped"}.`] : []);
}

function handleSpeed(env: Env, tokens: string[]): Parsed {
  const range = findRange(tokens, durationOf(env));
  const slow = /\b(slow|slower)\b/.test(env.body);
  const m = /(\d+(?:\.\d+)?)\s*(?:x|times|×)/.exec(env.body);
  let rate: { num: number; den: number } | null = null;
  if (m) {
    const r = rateOf(m[1]!);
    if (!r) return reject(env, `${m[1]}x is not a valid speed.`);
    const byFactor = /\bby\b\s*\d/.test(env.body) || !/\bto\b\s*\d/.test(env.body);
    rate = slow && byFactor ? { num: r.den, den: r.num } : r; // "slow down by 2x" = half speed; "slow down to 0.5x" = 0.5x
  } else if (/\bdouble\b/.test(env.body)) rate = { num: 2, den: 1 };
  else if (/\bhalf (the )?speed\b/.test(env.body)) rate = { num: 1, den: 2 };

  const make = (r: { num: number; den: number }, spans: Span[]): Operation[] => spans.map((span) => ({ type: "set_speed", span, rate: r }));
  // Check the allowed range here too (not only when the engine validates the log), so one impossible part of a multi-part instruction is named and the rest still applies.
  if (rate) checkSpeed(rate, env.ctx.limits);
  if (range && rate) {
    const res = spansFor(env, range.startUs, range.endUs);
    return plan(env, make(rate, res.spans), [...range.warnings, ...res.warnings]);
  }
  const whole = spansFor(env, 0, durationOf(env));
  if (!range && rate) {
    return clarify(env, "Which part should I change the speed of?", [{ label: "the whole video", operations: make(rate, whole.spans), warnings: whole.warnings }]);
  }
  if (range && !rate) {
    const res = spansFor(env, range.startUs, range.endUs);
    const rates = slow ? [{ num: 3, den: 4 }, { num: 1, den: 2 }] : [{ num: 3, den: 2 }, { num: 2, den: 1 }];
    return clarify(env, "How much?", rates.map((r) => ({ label: `${r.num / r.den}x`, operations: make(r, res.spans), warnings: res.warnings })));
  }
  return reject(env, 'Say which part and how much, for example: speed up 1:00-1:30 by 2x.');
}

function handleMove(env: Env, tokens: string[]): Parsed {
  if (env.policy === "original") return reject(env, "Moving a section uses the current (edited) timeline; say the times as they are now, without 'original'.");
  const range = findRange(tokens, env.tl.durationUs);
  if (!range) return reject(env, "Say which section to move, for example: move 0:30-0:40 to the end.");
  const rest = tokens.slice(range.next);
  const idx = rest.findIndex((t) => t === "to" || t === "before");
  const afterWord = rest[idx + 1];
  let target: number | null | undefined;
  if (idx >= 0 && (afterWord === "end" || (afterWord === "the" && rest[idx + 2] === "end"))) target = null;
  else if (idx >= 0 && (afterWord === "start" || afterWord === "beginning" || (afterWord === "the" && (rest[idx + 2] === "start" || rest[idx + 2] === "beginning")))) target = 0;
  else if (idx >= 0) target = parseTimeAt(rest, idx + 1)?.us;
  if (target === undefined) return reject(env, "Say where to move it: to the end, to the start, or to a time (move 0:30-0:40 to 1:00).");
  const p = planMoveEdited(env.ctx, env.tl, range.startUs, range.endUs, target);
  return plan(env, p.operations, [...range.warnings, ...p.warnings]);
}

function handleTopicRemove(env: Env, topicText: string): Parsed {
  const words = topicText.split(/\s+/).filter((w) => w && !["the", "a", "an", "my", "our", "i", "we", "talk", "talking", "about", "on", "of"].includes(w));
  const topic = words[words.length - 1];
  if (!topic) return reject(env, "Say what the part is about, for example: remove the part about pricing.");
  const parts = findTopicParts(env.ctx, env.tl, topic);
  if (parts.length === 0) return reject(env, `No part of the current video mentions "${topic}".`);
  const op = (p: (typeof parts)[number]): Operation => ({ type: "cut", span: p.span, reason: "user" });
  if (parts.length === 1) return plan(env, [op(parts[0]!)], parts[0]!.warnings);
  return clarify(
    env,
    `"${topic}" is mentioned ${parts.length} times. Which part should I remove?`,
    parts.map((p) => ({ label: `#${p.index} at ${formatTime(p.editedStartUs)}: "${p.snippet}"`, operations: [op(p)], warnings: p.warnings })),
  );
}

function handleEverything(env: Env, dir: "after" | "before", phrase: string): Parsed {
  const ranges = liveRanges(env, phrase);
  if (ranges.length === 0) return reject(env, `I could not find "${phrase}" in the video.`);
  const idx = env.ctx.index;
  const make = (r: AtomRange): { operations: Operation[]; warnings: string[] } | string => {
    const first = idx.atoms[atomPos(idx, r.from)]!;
    const last = idx.atoms[atomPos(idx, r.to)]!;
    const boundary = snapPoint(env.ctx, dir === "after" ? last.endUs : first.startUs);
    const lo = dir === "after" ? boundary.us : 0;
    const hi = dir === "after" ? idx.durationUs : boundary.us;
    if (hi <= lo) return `There is nothing ${dir} "${phrase}" to remove.`;
    const span: Span = { start: usToCursor(idx, lo, env.ctx.fps), end: usToCursor(idx, hi, env.ctx.fps) };
    return { operations: [{ type: "cut", span, reason: "user" }], warnings: boundary.warning ? [boundary.warning] : [] };
  };
  if (ranges.length === 1) {
    const m = make(ranges[0]!);
    return typeof m === "string" ? reject(env, m) : plan(env, m.operations, m.warnings);
  }
  const usable = ranges.filter((r) => typeof make(r) !== "string");
  if (usable.length === 0) return reject(env, `There is nothing ${dir} "${phrase}" to remove.`);
  return rangeOptions(env, usable, `"${phrase}"`, (r) => make(r) as { operations: Operation[]; warnings: string[] });
}

function handleSilences(env: Env, tokens: string[]): Parsed {
  const t = findTimeAfter(tokens, ["than", "over", "above", "exceeding", "beyond"]) ?? findTimeAfter(tokens, ["longer"]);
  if (t) {
    const p = planRemoveSilences(env.ctx, env.tl, { minUs: t.us });
    return plan(env, p.operations, [...t.warnings, ...p.warnings], `No silence is longer than ${formatTime(t.us)}.`);
  }
  const options = [500_000, 1_000_000, 2_000_000]
    .map((minUs) => ({ minUs, p: planRemoveSilences(env.ctx, env.tl, { minUs }) }))
    .filter((o) => o.p.operations.length > 0)
    .map((o) => ({ label: `silences longer than ${o.minUs / 1_000_000} s (${o.p.operations.length} cut${o.p.operations.length === 1 ? "" : "s"})`, operations: o.p.operations, warnings: o.p.warnings }));
  if (options.length === 0) return reject(env, "There are no silences longer than half a second to remove.");
  return clarify(env, "Remove silences longer than how many seconds?", options);
}

function handleCutRange(env: Env, tokens: string[]): Parsed {
  if (/\beverything\b|\bwhole video\b|\bentire video\b|\ball of it\b/.test(env.body) && !findRange(tokens, durationOf(env))) {
    const res = spansFor(env, 0, durationOf(env));
    return plan(env, res.spans.map((span) => ({ type: "cut", span, reason: "user" })), res.warnings);
  }
  const range = findRange(tokens, durationOf(env));
  if (!range) return reject(env, "I did not understand what to remove. Give a time range (remove 0:30-0:40, cut the first 30 seconds), a topic (remove the part about pricing) or a phrase (remove everything after \"thanks\").");
  const res = spansFor(env, range.startUs, range.endUs);
  return plan(env, res.spans.map((span) => ({ type: "cut", span, reason: "user" })), [...range.warnings, ...res.warnings]);
}

// ---------------------------------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------------------------------

function chooseIndex(text: string): number | null {
  const t = text.toLowerCase().trim().replace(/[.!]+$/, "");
  const m = /^(?:the |option |number |no\.? |#)?(\d+|first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)(?: one| option| part| mention| choice)?$/.exec(t);
  if (!m) return null;
  const w = m[1]!;
  if (w === "last") return -1;
  return /^\d+$/.test(w) ? Number(w) : ORDINALS[w]!;
}

function parseOne(input: ParseInput, offset: number): Parsed {
  const { ctx, state } = input;
  const tl = currentTimeline(ctx, state);
  const raw = input.text.trim();
  const quoted: string[] = [];
  const stripped = raw.replace(/["“]([^"”]+)["”]/g, (_m, q: string) => (quoted.push(q.trim()), "§"));
  let body = stripped.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  const policy: TimePolicy = /\boriginal\b/.test(body) ? "original" : "current";
  body = body.replace(/\b(in |at |from |on )?the original( video| timeline| time| times)?\b/g, " ").replace(/\boriginal\b/g, " ").replace(/\s+/g, " ").trim();
  const env: Env = { ctx, input, tl, policy, offset, raw, body, quoted };
  const tokens = tokenize(wordsToDigits(body));

  // 0. answer to an open question
  const pending = state.conversation.at(-1)?.pending ?? null;
  const reply = input.answer ?? (pending ? chooseIndex(raw) ?? undefined : undefined);
  if (reply !== undefined && pending) {
    const n = typeof reply === "number" ? reply : chooseIndex(String(reply));
    if (n === null || n === 0) return reject(env, `I could not read "${String(reply)}" as a choice. Pick a number from 1 to ${pending.options.length}.`);
    const idx = n === -1 ? pending.options.length - 1 : n - 1;
    return { kind: "choose", choice: idx, timePolicy: policy };
  }
  if (input.answer !== undefined && !pending) return reject(env, "There is no open question to answer.");

  // 1. undo / redo
  if (/^(undo|undo that|undo it|undo the last (edit|change|step|thing)|go back|revert|take that back)$/.test(body)) return { kind: "undo", timePolicy: policy, warnings: [] };
  if (/^(redo|redo that|redo it|do it again)$/.test(body)) return { kind: "redo", timePolicy: policy, warnings: [] };
  const nth = /\bundo (?:the )?(second.to.last|2nd.to.last|last|previous|third.to.last|first) (cut|removal|deletion)\b/.exec(body);
  if (nth) {
    const fromEnd = /second|2nd/.test(nth[1]!) ? 2 : /third/.test(nth[1]!) ? 3 : nth[1] === "first" ? Number.MAX_SAFE_INTEGER : 1;
    const groups = cutGroups(env);
    const k = fromEnd === Number.MAX_SAFE_INTEGER ? groups.length : fromEnd;
    return handleRestore(env, { fromEnd: k }, /\bmusic\b/.test(body) ? ["Music is not touched by this."] : []);
  }

  // 2. restore
  if (/\brestore\b|\b(put|bring|get|give)\b.*\bback\b/.test(body)) {
    const edit = /\bedit (\d+)\b/.exec(body);
    if (edit) return handleRestore(env, Number(edit[1]));
    if (/\bintro\b|\bbeginning\b|\bopening\b/.test(body)) return handleRestore(env, "intro");
    if (/\boutro\b|\bending\b/.test(body)) return handleRestore(env, "outro");
    return handleRestore(env, "any");
  }

  // 3. fillers / silences / pauses
  if (CUT_VERB.test(body) && /\b(fillers?|filler words?|ums?|uhs?|um and uh|hesitations?)\b/.test(body)) {
    const p = planRemoveFillers(ctx, tl);
    return plan(env, p.operations, p.warnings, "No filler words were found.");
  }
  if (/\b(keep|protect|pin|preserve)\b/.test(body) && /\bpause\b/.test(body)) {
    const at = findTimeAfter(tokens, ["at"]);
    if (!at) return reject(env, "Say which pause to keep, for example: keep the pause at 0:12.");
    return plan(env, [planProtectPause(ctx, tl, at.us)], at.warnings);
  }
  if (CUT_VERB.test(body) && /\b(silences?|pauses?|dead air|gaps?)\b/.test(body)) return handleSilences(env, tokens);

  // 4. captions
  if (/\b(caption|captions|subtitles?)\b/.test(body)) {
    const plural = /\b(captions|subtitles)\b/.test(body);
    if (/\b(remove|delete|clear|turn off|disable|get rid of)\b/.test(body)) {
      if (plural && tl.autoCaption) return plan(env, [{ type: "clear_auto_caption" }]);
      const found = findEffect(tl, "caption");
      if (found.kind === "none") return reject(env, "There is no caption to remove.");
      if (found.kind === "one") return plan(env, [{ type: "remove_effect", effectId: found.effect.id }]);
      return clarify(env, `There are ${found.candidates.length} captions. Which one should I remove?`, found.candidates.map((e) => ({ label: `caption "${e.params.kind === "caption" ? e.params.text : ""}" (${e.id})`, operations: [{ type: "remove_effect" as const, effectId: e.id }], warnings: [] })));
    }
    if (quoted.length > 0 && /\b(add|put|create|insert|make|write|show)\b/.test(body) && !/\b(change|rename)\b/.test(body)) return handleAddCaption(env);
    if (/\b(change|set|rename|replace)\b/.test(body) && quoted.length === 1 && /\bto\b/.test(body)) return handleCaptionStyle(env, () => ({ text: quoted[0]! }), "text");
    if (quoted.length === 0 && /\b(add|turn on|enable|generate|put|create)\b/.test(body)) return plan(env, [{ type: "auto_caption", style: WHITE }]);
  }
  const styleWords = /\b(red|blue|green|yellow|white|black|orange|purple|pink|bigger|larger|smaller|bold|top|bottom|center|centre|middle)\b|#[0-9a-f]{6}\b/.exec(body);
  if ((/\b(caption|subtitle)\b/.test(body) || /^make (it|that|this) /.test(body)) && styleWords && /\b(make|change|set|turn|move|put)\b/.test(body)) {
    const patch = (e: Effect): CaptionPatch => {
      const p: CaptionPatch = {};
      const color = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(body)) ?? null;
      const hex = /#[0-9a-f]{6}\b/.exec(body)?.[0];
      if (color) p.color = COLORS[color]!;
      if (hex) p.color = hex;
      const size = e.params.kind === "caption" ? e.params.style.sizePt : 32;
      if (/\b(bigger|larger)\b/.test(body)) p.sizePt = size + SIZE_STEP_PT;
      if (/\bsmaller\b/.test(body)) p.sizePt = Math.max(8, size - SIZE_STEP_PT);
      if (/\bbold\b/.test(body)) p.bold = !/\b(not|un)bold\b|\bno bold\b/.test(body);
      if (/\btop\b/.test(body)) p.position = "top";
      if (/\bbottom\b/.test(body)) p.position = "bottom";
      if (/\b(center|centre|middle)\b/.test(body)) p.position = "center";
      return p;
    };
    return handleCaptionStyle(env, patch, styleWords[0]!);
  }

  // 5. mute / bleep
  if (/\b(mute|silence out)\b/.test(body) && !/\bsilences\b/.test(body)) return handleEffectWords(env, "mute");
  if (/\b(bleep|beep|censor)\b/.test(body)) return handleEffectWords(env, "bleep");

  // 6. speed
  if (/\b(speed|slow|faster|slower|double speed|half speed)\b|\bat \d+(\.\d+)?\s*x\b/.test(body)) return handleSpeed(env, tokens);

  // 7. keep only
  if (/\bkeep only\b|\bonly keep\b|\bkeep just\b|\bjust keep\b/.test(body)) {
    const range = findRange(tokens, durationOf(env));
    if (!range) return reject(env, "Say which part to keep, for example: keep only 0:30-1:30.");
    const res = spansFor(env, range.startUs, range.endUs);
    const span: Span = { start: res.spans[0]!.start, end: res.spans[res.spans.length - 1]!.end };
    return plan(env, [{ type: "keep_only", span }], [...range.warnings, ...res.warnings, ...(res.spans.length > 1 ? ["The range crossed removed material; everything between its ends is kept."] : [])]);
  }

  // 8. move
  if (/\bmove\b/.test(body)) return handleMove(env, tokens);

  // 9. removal by topic / phrase / range
  if (CUT_VERB.test(body)) {
    const ev = /\beverything (after|before)\b\s*(.*)$/.exec(body);
    if (ev) {
      const phrase = quoted[0] ?? ev[2]!.replace(/^(i|we|you|he|she|they)\s+(say|says|said|saying|mention|mentions)\s*/, "").replace(/^(when|the (word|phrase|words)|where)\s+/, "").replace(/\s*§$/, "").trim();
      if (phrase && phrase !== "§" && !findRange(tokens, durationOf(env)) && !parseTimeAt(tokens, tokens.indexOf(ev[1]!) + 1)) return handleEverything(env, ev[1] as "after" | "before", phrase);
    }
    const topic = /\b(?:part|parts|section|sections|bit|bits|segment|portion|mention|mentions)\b.*?\b(?:about|on|regarding|mentioning|where i talk about|where i mention)\s+(.+)$/.exec(body);
    if (topic) return handleTopicRemove(env, quoted[0] ?? topic[1]!);
    return handleCutRange(env, tokens);
  }

  return reject(env, `I did not understand "${raw}". Examples: cut 0:30-0:40; remove the part about pricing; speed up 1:00-1:30 by 2x; add a caption "Hi" on "welcome"; make that caption red; remove filler words; undo.`);
}

const SPLIT = /\s*(?:;|\.\s+(?=[A-Za-z])|,?\s+and then\s+|,?\s+then\s+|,\s+and\s+(?=(?:cut|remove|delete|speed|slow|add|make|mute|bleep|move|keep)\b))\s*/i;

export function splitParts(text: string): string[] {
  // Do not split inside quotes.
  const marks: string[] = [];
  const guarded = text.replace(/["“][^"”]*["”]/g, (m) => (marks.push(m), `@@Q${marks.length - 1}@@`));
  return guarded
    .split(SPLIT)
    .map((p) => p.replace(/@@Q(\d+)@@/g, (_m, i: string) => marks[Number(i)]!).trim())
    .filter((p) => p.length > 0);
}

export class RulesParser implements InstructionParser {
  readonly name = "rules";
  readonly version = RULES_VERSION;

  parse(input: ParseInput): Parsed {
    const hasPending = (input.state.conversation.at(-1)?.pending ?? null) !== null;
    const parts = hasPending || input.answer !== undefined ? [input.text] : splitParts(input.text);
    if (parts.length <= 1) return this.one(input, 0);

    // Multi-part: every part is resolved against the SAME starting timeline and all that can be applied becomes ONE edit
    // (one undo group). Parts that cannot be applied are named in the warnings; nothing is silently dropped.
    const ops: Operation[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    let policy: TimePolicy | null = null;
    let applied = 0;
    parts.forEach((part, i) => {
      const r = this.one({ ...input, text: part }, ops.length);
      if (r.kind === "plan" && r.operations.length > 0) {
        applied++;
        ops.push(...r.operations);
        warnings.push(...r.warnings);
        policy ??= r.timePolicy;
      } else if (r.kind === "plan") notes.push(`Part ${i + 1} ("${part}") was not applied: ${r.nothingToDo ?? "nothing to change"}`);
      else if (r.kind === "reject") notes.push(`Part ${i + 1} ("${part}") was not applied: ${r.reason}`);
      else if (r.kind === "clarify") notes.push(`Part ${i + 1} ("${part}") was not applied: it needs a choice (${r.question}). Send it on its own.`);
      else notes.push(`Part ${i + 1} ("${part}") was not applied: undo, redo and answers cannot be combined with other parts.`);
    });
    const tp: TimePolicy = policy ?? "current";
    if (applied === 0) return { kind: "reject", reason: `None of the ${parts.length} parts could be applied. ${notes.join(" ")}`, timePolicy: tp, warnings: [] };
    return { kind: "plan", operations: ops, warnings: [`Applied ${applied} of ${parts.length} parts.`, ...notes, ...warnings], timePolicy: tp };
  }

  private one(input: ParseInput, offset: number): Parsed {
    try {
      return parseOne(input, offset);
    } catch (e) {
      // An engine refusal while resolving (out of range, inside speech...) is a normal rejection, never a crash.
      if (e instanceof EngineError) return { kind: "reject", reason: e.reason, timePolicy: /\boriginal\b/i.test(input.text) ? "original" : "current", warnings: [] };
      throw e;
    }
  }
}
