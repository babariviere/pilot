/** Conservative lexical binding analysis on the shared Babel AST. No type/runtime resolver. */
import type { CallFrame } from "./call-path-contract.ts";
import type { SourceHit } from "./exploration-contract.ts";
import { bindings, node, type SyntaxNode } from "./exploration-parser.ts";

export interface Binding {
	frame?: CallFrame;
	imported?: { source: string; name: string };
	written?: boolean;
}
export interface Scope {
	parent?: Scope;
	functionScope: boolean;
	sloppyBlock?: boolean;
	bindings: Map<string, Binding[]>;
}
export interface SyntaxCall {
	from: CallFrame;
	site: SourceHit;
	scope: Scope;
	name?: string;
}
export interface CallModule {
	path: string;
	scope: Scope;
	frames: CallFrame[];
	calls: SyntaxCall[];
	exports: Map<string, string[]>;
	unsafe: boolean;
}

export function lookup(scope: Scope, name: string): Binding[] | undefined {
	for (let current: Scope | undefined = scope; current; current = current.parent) {
		const found = current.bindings.get(name);
		if (found) return found;
	}
	return undefined;
}

const FUNCTIONS = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
]);
const SCOPES = new Set([
	"BlockStatement",
	"CatchClause",
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"SwitchStatement",
	"StaticBlock",
	"ClassDeclaration",
	"ClassExpression",
]);

export class GraphLimit extends Error {}

/** Budget counts retained scopes/bindings/frames/calls, not just returned edges. */
export function callSyntax(
	path: string,
	ast: SyntaxNode,
	hit: (start: number, end: number) => SourceHit,
	consume: () => void,
): CallModule {
	const makeScope = (parent?: Scope, functionScope = false): Scope => {
		consume();
		return { parent, functionScope, bindings: new Map() };
	};
	const scope = makeScope(undefined, true);
	const module: CallModule = { path, scope, frames: [], calls: [], exports: new Map(), unsafe: false };
	const makeFrame = (value: SyntaxNode, name: string, start = value.start, end = value.end) => {
		consume();
		const location = hit(start, end);
		const frame = {
			id: `${path}:${value.type}:${value.start}:${start}:${location.contentHash}`,
			name: name.slice(0, 200),
			nameTruncated: name.length > 200,
			kind: value.type,
			location,
		};
		module.frames.push(frame);
		return frame;
	};
	const root = makeFrame(ast, "<module>", 0, 0);
	const bind = (scope: Scope, name: string, binding: Binding) => {
		consume();
		const previous = scope.bindings.get(name) ?? [];
		previous.push(binding);
		scope.bindings.set(name, previous);
	};
	const bindPattern = (scope: Scope, pattern: unknown, binding: Binding = {}) => {
		if (node(pattern) && pattern.type === "TSParameterProperty") pattern = pattern.parameter;
		for (const id of bindings(pattern)) bind(scope, String(id.name), binding);
	};
	const writes: Array<{ scope: Scope; name: string }> = [];
	const exportName = (name: string, local: string) => {
		consume();
		module.exports.set(name, [...(module.exports.get(name) ?? []), local]);
	};
	type Work = {
		value: SyntaxNode;
		scope: Scope;
		frame: CallFrame;
		alias?: SyntaxNode;
		bindingScope?: Scope;
		declarationKind?: string;
		functionBody?: boolean;
	};
	const pending: Work[] = [{ value: ast, scope, frame: root }];
	while (pending.length) {
		const work = pending.pop()!;
		const { value } = work;
		let { scope, frame } = work;
		if (value.type === "WithStatement" || value.type === "TSModuleDeclaration") module.unsafe = true;
		if (value.type === "ImportDeclaration") {
			for (const specifier of value.specifiers as SyntaxNode[]) {
				if (!node(specifier.local)) continue;
				const imported = node(specifier.imported)
					? (specifier.imported.name ?? specifier.imported.value)
					: "default";
				bind(
					scope,
					String(specifier.local.name),
					value.importKind === "type" ||
						specifier.importKind === "type" ||
						specifier.type === "ImportNamespaceSpecifier"
						? {}
						: {
								imported: {
									source: String(node(value.source) ? value.source.value : ""),
									name: String(imported),
								},
							},
				);
			}
		}
		if (value.type === "ExportNamedDeclaration" && !value.source && value.exportKind !== "type") {
			if (node(value.declaration)) {
				const declaration = value.declaration;
				if (node(declaration.id)) exportName(String(declaration.id.name), String(declaration.id.name));
				if (declaration.type === "VariableDeclaration")
					for (const item of declaration.declarations as SyntaxNode[])
						for (const id of bindings(item.id)) exportName(String(id.name), String(id.name));
			}
			for (const specifier of value.specifiers as SyntaxNode[])
				if (node(specifier.local) && node(specifier.exported) && specifier.exportKind !== "type")
					exportName(String(specifier.exported.name ?? specifier.exported.value), String(specifier.local.name));
		}
		if (
			value.type === "ExportDefaultDeclaration" &&
			node(value.declaration) &&
			value.declaration.type === "FunctionDeclaration" &&
			node(value.declaration.id)
		)
			exportName("default", String(value.declaration.id.name));
		if (value.type === "VariableDeclarator") {
			let targetScope = scope;
			if (work.declarationKind === "var")
				while (!targetScope.functionScope && targetScope.parent) targetScope = targetScope.parent;
			const callable =
				node(value.id) && value.id.type === "Identifier" && node(value.init) && FUNCTIONS.has(value.init.type);
			if (callable) {
				pending.push({
					value: value.init as SyntaxNode,
					scope,
					bindingScope: targetScope,
					frame,
					alias: value.id as SyntaxNode,
					declarationKind: work.declarationKind,
				});
				continue;
			}
			bindPattern(targetScope, value.id);
		}
		if (FUNCTIONS.has(value.type)) {
			if (value.type === "FunctionDeclaration" && ast.sourceType === "script" && scope.sloppyBlock)
				module.unsafe = true;
			const id = work.alias ?? (node(value.id) ? value.id : undefined);
			const key = !value.computed && node(value.key) ? value.key : undefined;
			const name = String(id?.name ?? key?.name ?? key?.value ?? "<anonymous>");
			frame = makeFrame(value, name, id?.start ?? key?.start ?? value.start, id?.end ?? key?.end ?? value.start);
			if (work.alias || value.type === "FunctionDeclaration") {
				if (id)
					bind(work.bindingScope ?? scope, String(id.name), {
						frame,
						written: !!work.alias && work.declarationKind !== "const",
					});
			}
			scope = makeScope(scope, true);
			if (value.type !== "ArrowFunctionExpression") bind(scope, "arguments", {});
			if (value.type === "FunctionExpression" && node(value.id)) bind(scope, String(value.id.name), { frame });
			for (const parameter of value.params as SyntaxNode[]) bindPattern(scope, parameter);
		} else if (SCOPES.has(value.type)) {
			if (value.type === "ClassDeclaration" && node(value.id)) bind(scope, String(value.id.name), {});
			scope = makeScope(
				scope,
				value.type === "StaticBlock" || (value.type === "BlockStatement" && !!work.functionBody),
			);
			scope.sloppyBlock = value.type !== "BlockStatement" || !work.functionBody;
			if (value.type === "ClassExpression" && node(value.id)) bind(scope, String(value.id.name), {});
			if (value.type === "CatchClause") bindPattern(scope, value.param);
		} else if (
			["TSDeclareFunction", "TSEnumDeclaration", "TSImportEqualsDeclaration", "TSModuleDeclaration"].includes(
				value.type,
			) &&
			node(value.id)
		) {
			bind(scope, String(value.id.name), {});
		}
		if (
			["CallExpression", "OptionalCallExpression", "NewExpression", "TaggedTemplateExpression"].includes(value.type)
		) {
			consume();
			const callee = value.callee ?? value.tag;
			const direct =
				value.type === "CallExpression" && !value.optional && node(callee) && callee.type === "Identifier";
			if (direct && callee.name === "eval") module.unsafe = true;
			module.calls.push({
				from: frame,
				scope,
				site: hit(node(callee) ? callee.start : value.start, node(callee) ? callee.end : value.end),
				...(direct ? { name: String(callee.name) } : {}),
			});
		}
		const assigned =
			value.type === "AssignmentExpression"
				? value.left
				: value.type === "UpdateExpression"
					? value.argument
					: ["ForInStatement", "ForOfStatement"].includes(value.type) &&
							node(value.left) &&
							value.left.type !== "VariableDeclaration"
						? value.left
						: undefined;
		for (const id of bindings(assigned)) {
			consume();
			writes.push({ scope, name: String(id.name) });
		}
		for (const [key, child] of Object.entries(value)) {
			if (["loc", "extra", "comments", "tokens"].includes(key)) continue;
			const children = Array.isArray(child) ? child : [child];
			for (let i = children.length - 1; i >= 0; i--) {
				const item = children[i];
				const outerEvaluation = FUNCTIONS.has(value.type) && ["key", "decorators"].includes(key);
				if (node(item))
					pending.push({
						value: item,
						scope: outerEvaluation ? work.scope : scope,
						frame: outerEvaluation ? work.frame : frame,
						declarationKind: value.type === "VariableDeclaration" ? String(value.kind) : undefined,
						functionBody: FUNCTIONS.has(value.type) && key === "body",
					});
			}
		}
	}
	for (const write of writes) for (const binding of lookup(write.scope, write.name) ?? []) binding.written = true;
	return module;
}
