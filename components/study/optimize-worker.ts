// The FSRS optimisation in a Web Worker (docs/specs/flashcards.md §23),
// started by the dialog "Parameter optimieren" (components/study/
// optimize.tsx): the page stays responsive while the weights are fitted to
// the person's log. In: the log, the weights in use, the costs and the deck
// for the workload (#344); out: progress, then the fitted weights with the
// fit of each set, the recommended retention and the workload per desired
// retention – nothing leaves the browser but what the page then stores
// (the 21 numbers and the fit). A second kind of job only simulates the
// workload again (another time budget).
import { evaluate, optimize, workload, type ReviewCosts, type SimDeck, type TrainingCard, type WorkloadPoint } from "@/lib/fsrs/optimize";

export type OptimizeJob =
  | { kind?: "optimize"; cards: TrainingCard[]; current: number[] | null; costs: ReviewCosts; maxInterval: number; deck: SimDeck }
  | { kind: "workload"; weights: number[]; costs: ReviewCosts; maxInterval: number; deck: SimDeck };
export type OptimizeMessage =
  | { type: "progress"; value: number }
  | {
      type: "done";
      weights: number[];
      fits: { defaults: ReturnType<typeof evaluate>; current: ReturnType<typeof evaluate> | null; fitted: ReturnType<typeof evaluate> };
      retention: number;
      curve: WorkloadPoint[];
    }
  | { type: "workload"; retention: number; curve: WorkloadPoint[] }
  | { type: "error"; message: string };

const post = (message: OptimizeMessage) => (self as unknown as { postMessage: (m: OptimizeMessage) => void }).postMessage(message);
self.addEventListener("message", (event: MessageEvent<OptimizeJob>) => {
  void (async () => {
    try {
      const job = event.data;
      if (job.kind === "workload") {
        const { curve, recommended } = await workload(job.weights, job.deck, job.costs, job.maxInterval);
        post({ type: "workload", retention: recommended, curve });
        return;
      }
      const { cards, current, costs, maxInterval, deck } = job;
      post({ type: "progress", value: 0.02 });
      // 85 % of the time is the fit; the rest the workload's simulation.
      const result = optimize(cards, { onProgress: (done) => post({ type: "progress", value: 0.05 + done * 0.8 }) });
      let simulated = 0;
      const { curve, recommended } = await workload(result.weights, deck, costs, maxInterval, async () => {
        simulated++;
        post({ type: "progress", value: 0.85 + (simulated / 26) * 0.15 });
      });
      post({
        type: "done",
        weights: result.weights,
        fits: { defaults: result.before, current: current ? evaluate(cards, current) : null, fitted: result.after },
        retention: recommended,
        curve,
      });
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
});
