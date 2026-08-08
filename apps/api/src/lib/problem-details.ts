import type { FastifyReply } from "fastify";

/** RFC 9457 problem-details shape (spec 14.11 / CLAUDE.md 7.5). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code?: string;
  traceId?: string;
  validationErrors?: unknown;
}

export interface ProblemDetailsInput {
  status: number;
  title: string;
  detail: string;
  instance: string;
  code?: string;
  traceId?: string;
  validationErrors?: unknown;
}

/** Pure builder — the actual reply-sending is a thin wrapper so this shape can be unit-tested without a Fastify instance. */
export function buildProblemDetails(input: ProblemDetailsInput): ProblemDetails {
  const problem: ProblemDetails = {
    type: "about:blank",
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance: input.instance,
  };
  if (input.code !== undefined) problem.code = input.code;
  if (input.traceId !== undefined) problem.traceId = input.traceId;
  if (input.validationErrors !== undefined) problem.validationErrors = input.validationErrors;
  return problem;
}

export function sendProblem(reply: FastifyReply, input: ProblemDetailsInput): void {
  reply.code(input.status).type("application/problem+json").send(buildProblemDetails(input));
}
