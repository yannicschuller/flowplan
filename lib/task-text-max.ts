// The longest task text that is stored and keyed. A module of its own so
// that doc-tasks and personal-tasks, which import each other, can both use
// it while the other is still loading.
export const TASK_TEXT_MAX = 500;
