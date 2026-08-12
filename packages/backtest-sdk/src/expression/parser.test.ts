import { describe, expect, it } from "vitest";
import { ExpressionSyntaxError } from "./lexer.js";
import { parseExpression } from "./parser.js";

describe("parseExpression", () => {
  it("parses a crossover call", () => {
    const ast = parseExpression("ta.crossover(ta.sma(close, 3), ta.sma(close, 7))");
    expect(ast).toEqual({
      kind: "Call",
      callee: "ta.crossover",
      args: [
        { kind: "Call", callee: "ta.sma", args: [{ kind: "Identifier", name: "close" }, { kind: "Number", value: 3 }] },
        { kind: "Call", callee: "ta.sma", args: [{ kind: "Identifier", name: "close" }, { kind: "Number", value: 7 }] },
      ],
    });
  });

  it("parses comparisons and logical operators with correct precedence", () => {
    const ast = parseExpression("close > open and not (volume < 100)");
    expect(ast).toEqual({
      kind: "Binary",
      operator: "and",
      left: { kind: "Binary", operator: ">", left: { kind: "Identifier", name: "close" }, right: { kind: "Identifier", name: "open" } },
      right: {
        kind: "Unary",
        operator: "not",
        operand: { kind: "Binary", operator: "<", left: { kind: "Identifier", name: "volume" }, right: { kind: "Number", value: 100 } },
      },
    });
  });

  it("parses boolean literals", () => {
    expect(parseExpression("false")).toEqual({ kind: "Bool", value: false });
    expect(parseExpression("true")).toEqual({ kind: "Bool", value: true });
  });

  it("respects arithmetic precedence", () => {
    const ast = parseExpression("close + 1 * 2");
    expect(ast).toEqual({
      kind: "Binary",
      operator: "+",
      left: { kind: "Identifier", name: "close" },
      right: { kind: "Binary", operator: "*", left: { kind: "Number", value: 1 }, right: { kind: "Number", value: 2 } },
    });
  });

  it("throws ExpressionSyntaxError on malformed input", () => {
    expect(() => parseExpression("close >")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("ta.sma(close, 3")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("close $ open")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("close > open )")).toThrow(ExpressionSyntaxError);
  });

  it("parses a historical-offset suffix on a call result", () => {
    const ast = parseExpression("ta.highest(high, 20)[1]");
    expect(ast).toEqual({
      kind: "Offset",
      offset: 1,
      expr: {
        kind: "Call",
        callee: "ta.highest",
        args: [{ kind: "Identifier", name: "high" }, { kind: "Number", value: 20 }],
      },
    });
  });

  it("parses a historical-offset suffix on a bare identifier", () => {
    expect(parseExpression("close[1]")).toEqual({ kind: "Offset", offset: 1, expr: { kind: "Identifier", name: "close" } });
  });

  it("chains repeated offsets", () => {
    expect(parseExpression("close[1][2]")).toEqual({
      kind: "Offset",
      offset: 2,
      expr: { kind: "Offset", offset: 1, expr: { kind: "Identifier", name: "close" } },
    });
  });

  it("rejects a negative or non-integer offset", () => {
    expect(() => parseExpression("close[-1]")).toThrow(ExpressionSyntaxError);
    expect(() => parseExpression("close[1.5]")).toThrow(ExpressionSyntaxError);
  });

  it("rejects an unclosed offset bracket", () => {
    expect(() => parseExpression("close[1")).toThrow(ExpressionSyntaxError);
  });
});
