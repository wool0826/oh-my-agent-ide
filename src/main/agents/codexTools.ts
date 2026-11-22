import { z } from 'zod';
import type { CodexTool } from './codexSession';

/** A tool as the Claude Agent SDK's `tool()` defines it: a zod shape for the arguments and a handler. */
export interface SdkToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler(args: any, extra: unknown): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
}

/**
 * The app's tools for a Codex session, from the same definitions its Claude sessions use: one list of tools,
 * whichever agent runs. The arguments are checked against the tool's own schema before its handler sees them.
 */
export function codexToolsFrom(defs: readonly SdkToolDef[]): CodexTool[] {
  return defs.map((d) => {
    const shape = z.object(d.inputSchema);
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(shape) as Record<string, unknown>;
    return {
      name: d.name,
      description: d.description,
      inputSchema,
      run: async (args: unknown) => {
        const parsed = shape.safeParse(args ?? {});
        if (!parsed.success) throw new Error(`Invalid arguments for ${d.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
        const r = await d.handler(parsed.data, {});
        const text = r.content.map((c) => c.text ?? '').filter(Boolean).join('\n');
        if (r.isError) throw new Error(text || `${d.name} failed`);
        return text;
      },
    };
  });
}
