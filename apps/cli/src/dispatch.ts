// ---------------------------------------------------------------------------
// Command path → implementation. A table rather than a switch so a test can
// check it against the registry in `help.ts`: a command that help advertises
// but nothing implements, or an implementation help never mentions, fails
// `dispatch.test.ts` instead of surfacing as a runtime error for whoever
// typed it.
//
// Imports stay dynamic so a command's dependencies — and the env vars they
// read — load only when that command runs.
// ---------------------------------------------------------------------------
export type CommandHandler = (rest: ReadonlyArray<string>) => void | Promise<void>;

export const HANDLERS: Readonly<Record<string, CommandHandler>> = {
  login: async (rest) => {
    const { runLoginCommand } = await import("./login");
    await runLoginCommand(rest);
  },
  "auth login": async (rest) => {
    const { runAuthLoginCommand } = await import("./auth");
    await runAuthLoginCommand(rest);
  },
  "auth logout": async () => {
    const { runAuthLogoutCommand } = await import("./auth");
    runAuthLogoutCommand();
  },
  "auth status": async () => {
    const { runAuthStatusCommand } = await import("./auth");
    runAuthStatusCommand();
  },
  "machines list": async () => {
    const { runMachinesListCommand } = await import("./machines");
    await runMachinesListCommand();
  },
  "machines reconcile": async (rest) => {
    const { runMachinesReconcileCommand } = await import("./machines");
    await runMachinesReconcileCommand(rest);
  },
};
