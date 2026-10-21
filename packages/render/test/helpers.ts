import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTimeline, newSession, type EngineContext, type SessionState, type Turn } from "@incubrix/engine";
import { RulesParser, runInstruction } from "@incubrix/nlu";

const parser = new RulesParser();

/** Drive the engine with plain-language instructions, as the API does. */
export function scripted(ctx: EngineContext) {
  let state: SessionState = newSession();
  return {
    say(text: string, answer?: string | number): Turn {
      const t = runInstruction(ctx, state, answer === undefined ? { text } : { text, answer }, parser);
      state = t.state;
      return t;
    },
    timeline: () => currentTimeline(ctx, state),
    get state() { return state; },
  };
}

export const tmp = (name: string): string => mkdtempSync(join(tmpdir(), `incubrix-${name}-`));
