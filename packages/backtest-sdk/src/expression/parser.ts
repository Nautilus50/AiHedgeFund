import type { BinaryOperator, ExpressionNode } from "./ast.js";
import { ExpressionSyntaxError, tokenize, type Token, type TokenType } from "./lexer.js";

class Cursor {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) {
      throw new ExpressionSyntaxError("Unexpected end of expression.", -1);
    }
    return token;
  }

  advance(): Token {
    const token = this.peek();
    this.index++;
    return token;
  }

  check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  expect(type: TokenType, description: string): Token {
    if (!this.check(type)) {
      const token = this.peek();
      throw new ExpressionSyntaxError(`Expected ${description} but found "${token.value || token.type}".`, token.position);
    }
    return this.advance();
  }
}

const COMPARISON_OPERATORS: Partial<Record<TokenType, BinaryOperator>> = {
  GT: ">",
  LT: "<",
  GTE: ">=",
  LTE: "<=",
  EQ: "==",
  NEQ: "!=",
};

function parseOr(cursor: Cursor): ExpressionNode {
  let left = parseAnd(cursor);
  while (cursor.check("OR")) {
    cursor.advance();
    const right = parseAnd(cursor);
    left = { kind: "Binary", operator: "or", left, right };
  }
  return left;
}

function parseAnd(cursor: Cursor): ExpressionNode {
  let left = parseNot(cursor);
  while (cursor.check("AND")) {
    cursor.advance();
    const right = parseNot(cursor);
    left = { kind: "Binary", operator: "and", left, right };
  }
  return left;
}

function parseNot(cursor: Cursor): ExpressionNode {
  if (cursor.check("NOT")) {
    cursor.advance();
    return { kind: "Unary", operator: "not", operand: parseNot(cursor) };
  }
  return parseComparison(cursor);
}

function parseComparison(cursor: Cursor): ExpressionNode {
  const left = parseAdditive(cursor);
  const operator = COMPARISON_OPERATORS[cursor.peek().type];
  if (operator === undefined) {
    return left;
  }
  cursor.advance();
  const right = parseAdditive(cursor);
  return { kind: "Binary", operator, left, right };
}

function parseAdditive(cursor: Cursor): ExpressionNode {
  let left = parseMultiplicative(cursor);
  while (cursor.check("PLUS") || cursor.check("MINUS")) {
    const op = cursor.advance();
    const right = parseMultiplicative(cursor);
    left = { kind: "Binary", operator: op.type === "PLUS" ? "+" : "-", left, right };
  }
  return left;
}

function parseMultiplicative(cursor: Cursor): ExpressionNode {
  let left = parseUnary(cursor);
  while (cursor.check("STAR") || cursor.check("SLASH")) {
    const op = cursor.advance();
    const right = parseUnary(cursor);
    left = { kind: "Binary", operator: op.type === "STAR" ? "*" : "/", left, right };
  }
  return left;
}

function parseUnary(cursor: Cursor): ExpressionNode {
  if (cursor.check("MINUS")) {
    cursor.advance();
    return { kind: "Unary", operator: "-", operand: parseUnary(cursor) };
  }
  return parsePostfix(cursor);
}

/** Handles Pine's `expr[n]` historical-offset suffix, e.g. `ta.highest(high, len)[1]`. Chainable: `x[1][2]`. */
function parsePostfix(cursor: Cursor): ExpressionNode {
  let expr = parsePrimary(cursor);
  while (cursor.check("LBRACKET")) {
    cursor.advance();
    const offsetToken = cursor.expect("NUMBER", "an offset (e.g. \"1\")");
    cursor.expect("RBRACKET", "\"]\"");
    const offset = Number(offsetToken.value);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ExpressionSyntaxError(`Historical offset must be a non-negative integer, got "${offsetToken.value}".`, offsetToken.position);
    }
    expr = { kind: "Offset", expr, offset };
  }
  return expr;
}

function parseArgs(cursor: Cursor): ExpressionNode[] {
  const args: ExpressionNode[] = [];
  if (cursor.check("RPAREN")) {
    return args;
  }
  args.push(parseOr(cursor));
  while (cursor.check("COMMA")) {
    cursor.advance();
    args.push(parseOr(cursor));
  }
  return args;
}

function parsePrimary(cursor: Cursor): ExpressionNode {
  const token = cursor.peek();

  if (token.type === "NUMBER") {
    cursor.advance();
    return { kind: "Number", value: Number(token.value) };
  }

  if (token.type === "TRUE" || token.type === "FALSE") {
    cursor.advance();
    return { kind: "Bool", value: token.type === "TRUE" };
  }

  if (token.type === "LPAREN") {
    cursor.advance();
    const inner = parseOr(cursor);
    cursor.expect("RPAREN", "\")\"");
    return inner;
  }

  if (token.type === "IDENT") {
    cursor.advance();
    if (cursor.check("LPAREN")) {
      cursor.advance();
      const args = parseArgs(cursor);
      cursor.expect("RPAREN", "\")\"");
      return { kind: "Call", callee: token.value, args };
    }
    return { kind: "Identifier", name: token.value };
  }

  throw new ExpressionSyntaxError(`Unexpected token "${token.value || token.type}".`, token.position);
}

/** Parses one SDL signal expression into an AST. Throws {@link ExpressionSyntaxError} on invalid syntax. */
export function parseExpression(source: string): ExpressionNode {
  const cursor = new Cursor(tokenize(source));
  const expression = parseOr(cursor);
  cursor.expect("EOF", "end of expression");
  return expression;
}
