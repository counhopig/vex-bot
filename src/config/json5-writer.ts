/**
 * Shared JSON5 serializer for config files.
 *
 * Vex config files are stored as JSON5 (.json5) so users can edit them with
 * comments and trailing commas. The serializer preserves JS-identifier keys
 * unquoted, drops `undefined` values, and emits a stable, hand-readable layout.
 *
 * Both the CLI `onboard` wizard and the WebSocket `config.save` handler write
 * the same config file, so they share this writer to keep formatting in sync.
 */

const IDENTIFIER_KEY = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Serialize a value to JSON5 text.
 *
 * @param value - Plain object/array/scalar. Functions and `undefined` are
 *   dropped; `null` is emitted as `null`.
 * @param indent - Current indentation level (2 spaces per level). Defaults to 0.
 */
export function toJson5(value: unknown, indent = 0): string {
	const spaces = "  ".repeat(indent);
	const innerSpaces = "  ".repeat(indent + 1);

	if (value === null || value === undefined) {
		return "null";
	}

	if (typeof value === "string") {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		const items = value.map((item) => `${innerSpaces}${toJson5(item, indent + 1)}`);
		return `[\n${items.join(",\n")}\n${spaces}]`;
	}

	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, v]) => v !== undefined,
		);
		if (entries.length === 0) return "{}";

		const items = entries.map(([key, v]) => {
			const safeKey = IDENTIFIER_KEY.test(key) ? key : `"${key}"`;
			return `${innerSpaces}${safeKey}: ${toJson5(v, indent + 1)}`;
		});

		return `{\n${items.join(",\n")}\n${spaces}}`;
	}

	return String(value);
}
