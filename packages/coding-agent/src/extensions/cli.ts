/** Option kinds for `CliArgs`: boolean, single value, or repeatable value. */
export type OptionKind = "flag" | "value" | "multi";

/**
 * Parse `--name value` / `--name=value` options against an explicit spec, so a typo is an error
 * instead of being consumed as a value. Flags are stored as `true` in `values`, values as strings,
 * and repeatable options collect into `multi`.
 */
export class CliArgs {
	readonly positionals: string[] = [];
	readonly values = new Map<string, string | true>();
	readonly multi = new Map<string, string[]>();

	constructor(args: readonly string[], spec: Record<string, OptionKind>, hint = "") {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index] ?? "";
			if (!arg.startsWith("--")) {
				this.positionals.push(arg);
				continue;
			}
			const eq = arg.indexOf("=");
			const name = arg.slice(2, eq === -1 ? undefined : eq).trim();
			if (!name) throw new Error(`invalid option ${arg}${hint}`);
			const kind = spec[name];
			if (!kind) throw new Error(`unknown option ${arg}${hint}`);
			if (kind === "flag") {
				if (eq !== -1) throw new Error(`--${name} does not take a value`);
				this.values.set(name, true);
				continue;
			}
			const value = eq === -1 ? args[++index] : arg.slice(eq + 1);
			if (value === undefined) throw new Error(`--${name} requires a value`);
			if (kind === "multi") {
				const list = this.multi.get(name) ?? [];
				list.push(value);
				this.multi.set(name, list);
			} else {
				this.values.set(name, value);
			}
		}
	}

	has(name: string): boolean {
		return this.values.has(name) || this.multi.has(name);
	}

	flag(name: string): boolean {
		return this.values.get(name) === true;
	}

	value(name: string): string | undefined {
		const value = this.values.get(name);
		return typeof value === "string" ? value : undefined;
	}

	valuesOf(name: string): string[] {
		return this.multi.get(name) ?? [];
	}
}

/** One output path for both modes: JSON when `--json` is set, the human text otherwise. */
export function makeOutput(log: (line: string) => void, json: boolean): (value: unknown, human: () => string) => void {
	return (value, human) => log(json ? JSON.stringify(value) : human());
}
