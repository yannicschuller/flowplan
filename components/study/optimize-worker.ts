// The FSRS optimisation in a Web Worker (docs/specs/flashcards.md §23),
// started by the dialog "Parameter optimieren" (components/study/
// optimize.tsx): the page stays responsive while the weights are fitted to
// the person's log. In: the log, the weights in use and the costs; out:
// progress, then the fitted weights with the fit of each set and the
// recommended retention – nothing leaves the browser but what the page
// then stores (the 21 numbers and the fit).
import { evaluate, optimize, recommendRetention, type ReviewCosts, type TrainingCard } from "@/lib/fsrs/optimize";

export type OptimizeJob = { cards: TrainingCard[]; current: number[] | null; costs: ReviewCosts; maxInterval: number };
export type OptimizeMessage =
  | { type: "progress"; value: number }
  | {
      type: "done";
      weights: number[];
      fits: { defaults: ReturnType<typeof evaluate>; current: ReturnType<typeof evaluate> | null; fitted: ReturnType<typeof evaluate> };
      retention: number;
    }
  | { type: "error"; message: string };

const post = (message: OptimizeMessage) => (self as unknown as { postMessage: (m: OptimizeMessage) => void }).postMessage(message);
self.addEventListener("message", (event: MessageEvent<OptimizeJob>) => {
  try {
    const { cards, current, costs, maxInterval } = event.data;
    post({ type: "progress", value: 0.02 });
    // 90 % of the time is the fit; the rest the retention's simulation.
    const result = optimize(cards, { onProgress: (done) => post({ type: "progress", value: 0.05 + done * 0.85 }) });
    const retention = recommendRetention(result.weights, costs, maxInterval);
    post({
      type: "done",
      weights: result.weights,
      fits: { defaults: result.before, current: current ? evaluate(cards, current) : null, fitted: result.after },
      retention,
    });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
