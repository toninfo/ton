/** mailparser 无官方 types；仅声明 KB 抽取用到的子集 */
declare module "mailparser" {
	export interface AddressObject {
		text: string;
		html?: string;
		value?: Array<{ address?: string; name?: string }>;
	}

	export interface ParsedMail {
		subject?: string;
		from?: AddressObject;
		to?: AddressObject | AddressObject[];
		date?: Date;
		text?: string;
		html?: string | false;
	}

	export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
