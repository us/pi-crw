/**
 * Minimal ambient declaration for the pi extension API.
 *
 * The real types ship with `@earendil-works/pi-coding-agent`. pi's loader
 * resolves that import at runtime via its `virtualModules` mechanism, and the
 * import in `src/crw.ts` is `import type` only (fully erased at build time), so
 * this package deliberately does NOT depend on pi's package. This shim exists
 * purely so `tsc --noEmit` can typecheck the extension in CI in isolation.
 *
 * Only the surface this extension actually uses is modeled.
 */
declare module "@earendil-works/pi-coding-agent" {
	export type TextContent = { type: "text"; text: string };
	export type ToolContent = TextContent | { type: "image"; [k: string]: unknown };

	export interface AgentToolResult<D = unknown> {
		content: ToolContent[];
		details: D;
		terminate?: boolean;
	}

	export interface ToolDefinition {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		executionMode?: "parallel" | "serial";
		execute(
			toolCallId: string,
			params: Record<string, unknown> & { [k: string]: any },
			signal?: AbortSignal,
			onUpdate?: (chunk: unknown) => void,
			ctx?: unknown,
		): Promise<AgentToolResult>;
	}

	export interface ExtensionAPI {
		registerTool(def: ToolDefinition): void;
		on(event: string, handler: (...args: unknown[]) => void): void;
		registerCommand(...args: unknown[]): void;
	}
}
