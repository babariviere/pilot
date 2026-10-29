/** Syntax only. No compiler configuration, imports, plugins or repository code are executed. */
import { parse } from "@babel/parser";

type Node = Record<string, unknown> & { type: string; start: number; end: number };
export interface Declaration {
	name: string;
	kind: string;
	start: number;
	end: number;
	extentStart: number;
	extentEnd: number;
	container?: string;
}

function node(value: unknown): value is Node {
	return !!value && typeof value === "object" && "type" in value && "start" in value && "end" in value;
}

function bindings(value: unknown): Node[] {
	const pending = [value];
	const found: Node[] = [];
	while (pending.length) {
		const item = pending.pop();
		if (!node(item)) continue;
		if (item.type === "Identifier") found.push(item);
		else if (item.type === "RestElement") pending.push(item.argument);
		else if (item.type === "AssignmentPattern") pending.push(item.left);
		else if (item.type === "ObjectPattern" && Array.isArray(item.properties)) {
			for (const property of item.properties)
				if (node(property)) pending.push(property.type === "RestElement" ? property.argument : property.value);
		} else if (item.type === "ArrayPattern" && Array.isArray(item.elements)) pending.push(...item.elements);
	}
	return found;
}

const NAMED = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"TSDeclareFunction",
	"ClassDeclaration",
	"ClassExpression",
	"TSInterfaceDeclaration",
	"TSTypeAliasDeclaration",
	"TSEnumDeclaration",
	"TSModuleDeclaration",
]);
const MEMBERS = new Set([
	"ClassMethod",
	"ClassPrivateMethod",
	"ObjectMethod",
	"TSMethodSignature",
	"ClassProperty",
	"ClassPrivateProperty",
	"ClassAccessorProperty",
	"TSPropertySignature",
	"TSEnumMember",
]);

export function parseDeclarations(text: string, path: string): Declaration[] {
	const typescript = /\.(?:ts|tsx|mts|cts)$/.test(path);
	const jsx = /\.(?:tsx|jsx)$/.test(path);
	const ast = parse(text, {
		sourceType: "unambiguous",
		plugins: [...(typescript ? ["typescript" as const] : []), ...(jsx ? ["jsx" as const] : [])],
		attachComment: false,
		errorRecovery: false,
	});
	const declarations: Declaration[] = [];
	const pending: Array<{ value: unknown; container?: string }> = [{ value: ast.program }];
	while (pending.length) {
		const { value, container } = pending.pop()!;
		if (!node(value)) continue;
		let names: Node[] = [];
		if (NAMED.has(value.type) && node(value.id)) names = [value.id];
		else if (value.type === "VariableDeclarator") names = bindings(value.id);
		else if (MEMBERS.has(value.type) && !value.computed && node(value.key ?? value.id))
			names = [value.key ?? value.id] as Node[];
		let childContainer = container;
		for (const nameNode of names) {
			const name =
				nameNode.type === "PrivateName" && node(nameNode.id)
					? `#${nameNode.id.name}`
					: (nameNode.name ?? nameNode.value);
			if (typeof name !== "string") continue;
			declarations.push({
				name,
				kind: value.type,
				start: nameNode.start,
				end: nameNode.end,
				extentStart: value.start,
				extentEnd: value.end,
				container,
			});
			childContainer = name;
		}
		for (const [key, child] of Object.entries(value)) {
			if (["loc", "extra", "comments", "tokens"].includes(key)) continue;
			if (Array.isArray(child)) {
				for (let i = child.length - 1; i >= 0; i--)
					if (node(child[i])) pending.push({ value: child[i], container: childContainer });
			} else if (node(child)) pending.push({ value: child, container: childContainer });
		}
	}
	return declarations.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function supportedSyntax(path: string): boolean {
	return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path);
}
