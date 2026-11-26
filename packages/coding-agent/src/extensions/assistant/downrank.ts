/**
 * Automatic downranking: when the user repeatedly mutes or deletes items from one source stream,
 * new items from that stream skip the bubble and land in the inbox's ignored group. The rule is
 * recomputed from a rolling window, so a stream recovers on its own once the corrections age out.
 */

export interface StreamSignal {
	server: string;
	stream: string;
	notified: number;
	negative: number;
}

export const DOWNRANK_WINDOW_DAYS = 7;
/** Enough delivered items to judge a stream, and enough corrections to call it noise. */
export const DOWNRANK_MIN_NOTIFIED = 4;
export const DOWNRANK_MIN_NEGATIVE = 3;
export const DOWNRANK_RATIO = 0.5;

export function streamKey(server: string, stream: string): string {
	return `${server}\u0000${stream}`;
}

/** Streams whose negative ratio crossed the threshold in the window. */
export function downrankedStreams(signals: readonly StreamSignal[]): StreamSignal[] {
	return signals.filter(
		(signal) =>
			signal.notified >= DOWNRANK_MIN_NOTIFIED &&
			signal.negative >= DOWNRANK_MIN_NEGATIVE &&
			signal.negative / signal.notified >= DOWNRANK_RATIO,
	);
}
