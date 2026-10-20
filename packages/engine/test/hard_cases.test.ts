import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Atom, Cursor, Operation } from "../src/types";
import { IncrementalTimeline } from "../src/incremental";
import { appendEdit, appendRedo, appendUndo, analyzeLog, nextEffectId, type Log } from "../src/log";
import { materialize } from "../src/replay";
import { currentTimeline, newSession, submitOperations, submitUndo } from "../src/session";
import { effectDisplay } from "../src/timemap";
import { atomEndingAt, atomStartingAt, FACTS, makeFixture } from "./fixtures/transcript";
import { captionOp, cutOp, span, WHITE } from "./helpers";

const { ctx, atoms } = makeFixture();
const U = 1_000_000;

describe("hard case: caption added, its sentence cut, the cut restored", () => {
  it("the caption goes inactive (but stays in the log), the user is told, and restoring brings it back in place", () => {
    const first = atomStartingAt(atoms, FACTS.honestly.startUs);
    const last = atomEndingAt(atoms, FACTS.honestly.endUs);
    let s = submitOperations(ctx, newSession(), "caption the sentence", [captionOp(nextEffectId([]), first.id, last.id, "Great speed")]).state;
    expect(effectDisplay(ctx, currentTimeline(ctx, s), currentTimeline(ctx, s).effects[0]!)).toMatchObject({ startUs: 90 * U, endUs: 92 * U });

    const cut = submitOperations(ctx, s, "remove that sentence", [cutOp(ctx, 90 * U, 92 * U)]);
    s = cut.state;
    expect(cut.answer.warnings.join(" ")).toMatch(/caption "Great speed" is hidden/);
    expect(currentTimeline(ctx, s).effects).toHaveLength(1); // not deleted
    expect(currentTimeline(ctx, s).effects[0]!.state).toBe("inactive");
    expect(s.log.filter((e) => e.kind === "edit" && e.op.type === "add_effect")).toHaveLength(1); // still in the log

    const back = submitOperations(ctx, s, "put that sentence back", [{ type: "restore", targetGroup: 2 }]);
    const tl = currentTimeline(ctx, back.state);
    expect(tl.effects[0]!.state).toBe("active");
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toEqual({ startUs: 90 * U, endUs: 92 * U, extended: false });
    expect(back.answer.durationUs).toBe(200 * U);
  });

  it("the same works through undo instead of restore", () => {
    const first = atomStartingAt(atoms, FACTS.honestly.startUs);
    const last = atomEndingAt(atoms, FACTS.honestly.endUs);
    let s = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", first.id, last.id, "x")]).state;
    s = submitOperations(ctx, s, "cut", [cutOp(ctx, 90 * U, 92 * U)]).state;
    s = submitUndo(ctx, s, "undo").state;
    expect(currentTimeline(ctx, s).effects[0]!.state).toBe("active");
  });
});

describe("hard case: cut before, speed over and restore all leave the caption on its words", () => {
  it("a cut before it and a 2x speed change just before it move it to the right edited time", () => {
    const first = atomStartingAt(atoms, FACTS.welcome.startUs);
    const last = atomEndingAt(atoms, FACTS.welcome.endUs);
    let s = submitOperations(ctx, newSession(), "caption", [captionOp("fx_0_0", first.id, last.id, "W")]).state;
    s = submitOperations(ctx, s, "cut", [cutOp(ctx, 0, 30 * U)]).state;
    s = submitOperations(ctx, s, "speed", [{ type: "set_speed", span: span(ctx, 40 * U, 48 * U), rate: { num: 2, den: 1 } }]).state;
    const tl = currentTimeline(ctx, s);
    // 12 s edited start is unchanged by a speed change that begins at source 40 (edited 10) -> caption starts at 10 + (42-40)/2 = 11 s
    expect(effectDisplay(ctx, tl, tl.effects[0]!)).toEqual({ startUs: 11 * U, endUs: 12 * U, extended: false });
    expect(tl.effects[0]!.range).toEqual({ from: first.id, to: last.id });
  });
});

// ---------------------------------------------------------------------------
// property tests
// ---------------------------------------------------------------------------

function cursorAt(i: number): Cursor {
  if (i >= atoms.length) {
    const lastAtom = atoms[atoms.length - 1] as Atom;
    return { atom: lastAtom.id, offsetUs: lastAtom.endUs - lastAtom.startUs };
  }
  return { atom: atoms[i]!.id, offsetUs: 0 };
}

type Cmd =
  | { t: "cut"; a: number; b: number }
  | { t: "speed"; a: number; b: number; r: number }
  | { t: "caption"; a: number; b: number }
  | { t: "recolor"; pick: number }
  | { t: "undo" }
  | { t: "redo" };

const RATES = [
  { num: 1, den: 2 },
  { num: 1, den: 1 },
  { num: 2, den: 1 },
  { num: 3, den: 1 },
  { num: 4, den: 1 },
];

const pair = fc.tuple(fc.integer({ min: 0, max: atoms.length - 1 }), fc.integer({ min: 1, max: atoms.length })).filter(([a, b]) => a < b);

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 4, arbitrary: pair.map(([a, b]) => ({ t: "cut" as const, a, b })) },
  { weight: 3, arbitrary: fc.tuple(pair, fc.integer({ min: 0, max: RATES.length - 1 })).map(([[a, b], r]) => ({ t: "speed" as const, a, b, r })) },
  { weight: 3, arbitrary: pair.map(([a, b]) => ({ t: "caption" as const, a, b: Math.min(b - 1, atoms.length - 1) })).filter((c) => c.a <= c.b) },
  { weight: 1, arbitrary: fc.nat(10).map((pick) => ({ t: "recolor" as const, pick })) },
  { weight: 2, arbitrary: fc.constant({ t: "undo" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "redo" as const }) },
);

describe("property: incremental application equals a full replay", () => {
  it("after every command of a random edit/undo/redo sequence, snapshots agree with replaying the log", () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { minLength: 1, maxLength: 25 }), (cmds) => {
        let log: Log = [];
        const inc = new IncrementalTimeline(ctx);
        for (const c of cmds) {
          if (c.t === "undo" || c.t === "redo") {
            const an = analyzeLog(log);
            const possible = c.t === "undo" ? an.active.length > 0 : an.redo.length > 0;
            // The incremental engine must agree on WHETHER the step is possible (e.g. redo after a new edit is not).
            expect(c.t === "undo" ? inc.undo() : inc.redo()).toBe(possible);
            if (!possible) continue; // the session layer rejects these before logging
            log = c.t === "undo" ? appendUndo(log) : appendRedo(log);
          } else {
            let op: Operation;
            if (c.t === "cut") op = { type: "cut", span: { start: cursorAt(c.a), end: cursorAt(c.b) }, reason: "user" };
            else if (c.t === "speed") op = { type: "set_speed", span: { start: cursorAt(c.a), end: cursorAt(c.b) }, rate: RATES[c.r]! };
            else if (c.t === "caption") op = captionOp(nextEffectId(log), atoms[c.a]!.id, atoms[c.b]!.id, `c${c.a}`, WHITE);
            else {
              const effects = materialize(ctx, log).effects;
              if (effects.length === 0) continue;
              const e = effects[c.pick % effects.length]!;
              op = { type: "update_effect", effectId: e.id, params: { kind: "caption", text: "recolored", style: { ...WHITE, color: "#ff0000" } } };
            }
            const appended = appendEdit(log, [op]);
            log = appended.log;
            expect(inc.edit([op])).toBe(appended.group);
          }
          expect(inc.timeline()).toEqual(materialize(ctx, log));
        }
      }),
      { numRuns: 150, seed: 20261020 },
    );
  });
});

describe("property: how a cut is split does not matter", () => {
  it("cutting [a,c) equals cutting [a,b) then [b,c): same timeline", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: atoms.length - 3 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (a, w1, w2) => {
        const b = Math.min(atoms.length - 1, a + w1);
        const c = Math.min(atoms.length, b + w2);
        fc.pre(a < b && b < c);
        const op = (x: number, y: number): Operation => ({ type: "cut", span: { start: cursorAt(x), end: cursorAt(y) }, reason: "user" });
        const whole = materialize(ctx, appendEdit([], [op(a, c)]).log);
        const split = materialize(ctx, appendEdit(appendEdit([], [op(a, b)]).log, [op(b, c)]).log);
        expect(split.durationUs).toBe(whole.durationUs);
        expect(split.segments.map((s) => s.span)).toEqual(whole.segments.map((s) => s.span));
      }),
      { numRuns: 100, seed: 7 },
    );
  });
});

describe("property: the session path (caches, incremental priming) equals a fresh full replay", () => {
  type SCmd = Cmd | { t: "restore"; g: number };
  const sCmd: fc.Arbitrary<SCmd> = fc.oneof({ weight: 6, arbitrary: cmdArb }, { weight: 2, arbitrary: fc.integer({ min: 1, max: 8 }).map((g) => ({ t: "restore" as const, g })) });

  it("after every turn of a random session (edits, undo, redo, restore, rejected turns), the cached timeline equals a replay on a brand-new engine", async () => {
    const { submitOperations, submitRedo, submitUndo, newSession, currentTimeline } = await import("../src/session");
    fc.assert(
      fc.property(fc.array(sCmd, { minLength: 1, maxLength: 20 }), (cmds) => {
        let s = newSession();
        for (const c of cmds) {
          if (c.t === "undo") s = submitUndo(ctx, s, "undo").state;
          else if (c.t === "redo") s = submitRedo(ctx, s, "redo").state;
          else {
            let op: Operation;
            if (c.t === "restore") op = { type: "restore", targetGroup: c.g };
            else if (c.t === "cut") op = { type: "cut", span: { start: cursorAt(c.a), end: cursorAt(c.b) }, reason: "user" };
            else if (c.t === "speed") op = { type: "set_speed", span: { start: cursorAt(c.a), end: cursorAt(c.b) }, rate: RATES[c.r]! };
            else if (c.t === "caption") op = captionOp(nextEffectId(s.log), atoms[c.a]!.id, atoms[c.b]!.id, `c${c.a}`, WHITE);
            else {
              const effects = currentTimeline(ctx, s).effects;
              if (effects.length === 0) continue;
              op = { type: "update_effect", effectId: effects[c.pick % effects.length]!.id, params: { kind: "caption", text: "r", style: { ...WHITE, color: "#ff0000" } } };
            }
            s = submitOperations(ctx, s, "x", [op]).state;
          }
          const fresh = makeFixture().ctx; // different context object: no cache can be shared
          expect(currentTimeline(ctx, s)).toEqual(materialize(fresh, [...s.log]));
        }
      }),
      { numRuns: 100, seed: 424242 },
    );
  });
});
