import type { Rule, Scope } from "eslint";
import type * as ESTree from "estree";

type Fn = ESTree.ArrowFunctionExpression | ESTree.FunctionExpression;

function isEmptyAnswer(node: ESTree.Node | null | undefined): boolean {
 if (node === null || node === undefined) return false;
 switch (node.type) {
  case "Literal": return node.value === null || node.value === false;
  case "Identifier": return node.name === "undefined";
  case "ArrayExpression": return node.elements.length === 0;
  case "ObjectExpression": return node.properties.length === 0;
  default: return false;
 }
}

function returnsInOwnBody(body: ESTree.Node): ESTree.ReturnStatement[] {
 const found: ESTree.ReturnStatement[] = [];
 const visit = (node: ESTree.Node): void => {
  if (node.type === "ReturnStatement") found.push(node);
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
  for (const [key, value] of Object.entries(node)) {
   if (key === "parent") continue;
   const children: unknown[] = Array.isArray(value) ? value : [value];
   for (const child of children) {
    if (typeof child === "object" && child !== null && typeof (child as { type?: unknown }).type === "string") visit(child as ESTree.Node);
   }
  }
 };
 visit(body);
 return found;
}

const unread = (variables: Scope.Variable[]): boolean => variables.every((v) => v.references.length === 0);

export const noSilentCatch: Rule.RuleModule = {
 meta: {
  type: "problem",
  docs: { description: "A caught failure must not come back as an empty answer" },
  messages: {
   silent:
    "A failure becomes an empty answer here, so the caller reads 'none' or 'no' when the read failed (#515, #221). Rethrow, return a value that says the read failed, or test the error (ENOENT, a status) and return empty only for that case.",
  },
  schema: [],
 },
 create(context) {
  const source = context.sourceCode;
  const reportEmptyReturns = (body: ESTree.Node) => {
   for (const ret of returnsInOwnBody(body)) {
    if (isEmptyAnswer(ret.argument)) context.report({ node: ret, messageId: "silent" });
   }
  };
  return {
   CatchClause(node) {
    if (node.param !== null && !unread(source.getDeclaredVariables(node))) return;
    reportEmptyReturns(node.body);
   },
   CallExpression(node) {
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier" || callee.property.name !== "catch") return;
    const handler = node.arguments.at(0);
    if (handler === undefined) return;
    if (handler.type !== "ArrowFunctionExpression" && handler.type !== "FunctionExpression") return;
    const fn: Fn = handler;
    if (!unread(source.getDeclaredVariables(fn))) return;
    if (fn.body.type === "BlockStatement") reportEmptyReturns(fn.body);
    else if (isEmptyAnswer(fn.body)) context.report({ node: fn.body, messageId: "silent" });
   },
  };
 },
};
