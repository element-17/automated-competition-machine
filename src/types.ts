import { z } from 'zod';

export const Deliverable = z.object({ type: z.string(), quantity: z.string().nullable().default(null), formats: z.array(z.string()).default([]), limits: z.array(z.string()).default([]), naming: z.string().nullable().default(null), attachments: z.array(z.string()).default([]), submission: z.string().nullable().default(null), official_template: z.string().nullable().default(null) });
export const Brief = z.object({ title: z.string(), edition: z.string().nullable().default(null), eligibility: z.string().nullable().default(null), deadline: z.string().nullable().default(null), ai_rules: z.string().nullable().default(null), scoring: z.string().nullable().default(null), deliverables: z.array(Deliverable).default([]), requires_idea: z.boolean().nullable().default(null), missing: z.array(z.string()).default([]), citations: z.array(z.object({field:z.string(),url:z.string(),quote:z.string()})).default([]) });
export type Brief = z.infer<typeof Brief>;
export type Evidence = { id: string; competitionId: string; url: string; title: string; text: string; fetchedAt: string; kind: string };
export type ModelRole = 'writer' | 'reviewer';
export interface ModelGateway { generate(role: ModelRole, prompt: string): Promise<string>; search(query: string): Promise<{url: string; title: string; snippet: string}[]>; }
export type Job = { id: string; competitionId: string; kind: string; state: string; createdAt: string; updatedAt: string; input: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; calls: number; maxCalls: number };
