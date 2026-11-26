/** Loads `ton schedule` only when the command runs (see main.ts). */
export const loadScheduleCommand = () => import("./cli.ts");
