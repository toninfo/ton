/** Loads `ton kb` only when the command runs (see main.ts). */
export const loadKbCommand = () => import("./cli.ts");
