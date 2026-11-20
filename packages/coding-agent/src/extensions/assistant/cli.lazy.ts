/** Loads `ton assistant` only when the command runs (see main.ts). */
export const loadAssistantCommand = () => import("./cli.ts");
