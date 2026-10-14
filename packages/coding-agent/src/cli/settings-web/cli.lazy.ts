/** Loads `ton settings` only when the command runs (see main.ts). */
export const loadSettingsCommand = () => import("./cli.ts");
