export type BinaryOperator = "and" | "or" | ">" | "<" | ">=" | "<=" | "==" | "!=" | "+" | "-" | "*" | "/";

export interface NumberLiteralNode {
  kind: "Number";
  value: number;
}

export interface BoolLiteralNode {
  kind: "Bool";
  value: boolean;
}

/** An OHLCV field (`close`, `open`, ...) or an SDL parameter key. Resolved against context, not at parse time. */
export interface IdentifierNode {
  kind: "Identifier";
  name: string;
}

export interface CallNode {
  kind: "Call";
  /** Dotted callee, e.g. `"ta.sma"`. */
  callee: string;
  args: ExpressionNode[];
}

export interface UnaryNode {
  kind: "Unary";
  operator: "not" | "-";
  operand: ExpressionNode;
}

export interface BinaryNode {
  kind: "Binary";
  operator: BinaryOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

/** Pine's `expr[n]` — the value of `expr` `n` bars ago. `n` is always a non-negative integer literal. */
export interface OffsetNode {
  kind: "Offset";
  expr: ExpressionNode;
  offset: number;
}

export type ExpressionNode =
  | NumberLiteralNode
  | BoolLiteralNode
  | IdentifierNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | OffsetNode;
