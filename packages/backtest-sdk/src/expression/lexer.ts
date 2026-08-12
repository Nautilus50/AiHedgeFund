export type TokenType =
  | "NUMBER"
  | "IDENT"
  | "AND"
  | "OR"
  | "NOT"
  | "TRUE"
  | "FALSE"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "GT"
  | "LT"
  | "GTE"
  | "LTE"
  | "EQ"
  | "NEQ"
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

export class ExpressionSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = "ExpressionSyntaxError";
  }
}

const KEYWORDS: Record<string, TokenType> = {
  and: "AND",
  or: "OR",
  not: "NOT",
  true: "TRUE",
  false: "FALSE",
};

/** Matches `close`, `ta.sma`, `fastLength`, etc. — a dotted identifier chain. */
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUMBER_PATTERN = /^\d+(\.\d+)?/;

/**
 * Tokenizes a subset of Pine boolean-expression syntax — the SDL's
 * `signals.longEntry` / `shortEntry` strings (CLAUDE.md 12; the SDL treats
 * these as opaque Pine text, this is the runner's own constrained grammar
 * for evaluating them without a full Pine parser).
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    if (char === undefined) break;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    const rest = source.slice(i);

    const numberMatch = NUMBER_PATTERN.exec(rest);
    if (numberMatch?.[0] !== undefined) {
      tokens.push({ type: "NUMBER", value: numberMatch[0], position: i });
      i += numberMatch[0].length;
      continue;
    }

    const identMatch = IDENT_PATTERN.exec(rest);
    if (identMatch?.[0] !== undefined) {
      const value = identMatch[0];
      const keyword = KEYWORDS[value.toLowerCase()];
      tokens.push({ type: keyword ?? "IDENT", value, position: i });
      i += value.length;
      continue;
    }

    if (char === ">" && source[i + 1] === "=") {
      tokens.push({ type: "GTE", value: ">=", position: i });
      i += 2;
      continue;
    }
    if (char === "<" && source[i + 1] === "=") {
      tokens.push({ type: "LTE", value: "<=", position: i });
      i += 2;
      continue;
    }
    if (char === "=" && source[i + 1] === "=") {
      tokens.push({ type: "EQ", value: "==", position: i });
      i += 2;
      continue;
    }
    if (char === "!" && source[i + 1] === "=") {
      tokens.push({ type: "NEQ", value: "!=", position: i });
      i += 2;
      continue;
    }

    const singleCharTokens: Record<string, TokenType> = {
      ">": "GT",
      "<": "LT",
      "+": "PLUS",
      "-": "MINUS",
      "*": "STAR",
      "/": "SLASH",
      "(": "LPAREN",
      ")": "RPAREN",
      "[": "LBRACKET",
      "]": "RBRACKET",
      ",": "COMMA",
    };
    const type = singleCharTokens[char];
    if (type !== undefined) {
      tokens.push({ type, value: char, position: i });
      i++;
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character "${char}".`, i);
  }

  tokens.push({ type: "EOF", value: "", position: source.length });
  return tokens;
}
