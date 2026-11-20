import { foregroundAnsi, rgbColor, styleTextWithAnsi } from "@ton/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * The header mark: "Ton" as a single bold text line, one color per letter (T brand red, o coral,
 * n yellow). The 3D easter egg still builds its voxel "T" from the pixel grid below, which keeps
 * the 4×4 model it shipped with (`r` red, `b` blue, `y` yellow, `.` transparent):
 *
 *   r r r y
 *   . b b .
 *   . b b .
 *   . b b .
 */
export type TonLogoRgb = readonly [number, number, number];

export const TON_LOGO_PIXELS: readonly string[] = ["rrry", ".bb.", ".bb.", ".bb."];

export const TON_LOGO_RGB: Record<string, TonLogoRgb> = {
	r: [183, 21, 31],
	b: [79, 142, 179],
	y: [234, 182, 93],
};

/** One color per letter of the wordmark, in order. */
const WORDMARK_LETTERS: readonly { letter: string; rgb: TonLogoRgb }[] = [
	{ letter: "T", rgb: [183, 21, 31] },
	{ letter: "o", rgb: [228, 138, 122] },
	{ letter: "n", rgb: [234, 182, 93] },
];

/** The "Ton" wordmark for the first header line. */
export function tonLogoText(): string {
	const mode = theme.getColorMode();
	return WORDMARK_LETTERS.map(({ letter, rgb }) =>
		styleTextWithAnsi(letter, foregroundAnsi(rgbColor(...rgb), mode), undefined, { bold: true }),
	).join("");
}
