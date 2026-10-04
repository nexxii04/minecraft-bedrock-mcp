import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { TextResult } from './context.js';

/**
 * A tool definition, independent of the SDK.
 *
 * `run_action_sequence` must execute tools programmatically, so declaring tools
 * against this registry gives one implementation with two consumers: the MCP
 * binding and in-process invocation, so the scripted and interactive paths cannot
 * drift apart.
 */

export type ToolHandler<Args> = (args: Args) => Promise<TextResult> | TextResult;

/** The part of a tool declaration that is metadata rather than behaviour. */
export interface ToolConfig {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
}

export interface ToolDefinition<Args = unknown> extends ToolConfig {
  handler: ToolHandler<Args>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never>>();

  define<Args>(config: ToolConfig, handler: ToolHandler<Args>): void {
    if (this.tools.has(config.name)) {
      throw new Error(`Tool "${config.name}" is already registered`);
    }
    this.tools.set(config.name, { ...config, handler });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition<never> | undefined {
    return this.tools.get(name);
  }

  /** Tool names, sorted, for error messages and the `list_tools` helper. */
  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Every registered definition, for documentation and introspection. */
  definitions(): ToolDefinition<never>[] {
    return [...this.tools.values()];
  }

  /**
   * Runs a tool by name with an unvalidated argument object. Arguments *are*
   * validated against the tool's own schema, so the scenario runner cannot smuggle
   * in input the interactive path would reject.
   */
  async invoke(name: string, rawArgs: unknown): Promise<TextResult> {
    const definition = this.tools.get(name);
    if (definition === undefined) {
      throw new Error(`Unknown tool "${name}". Available tools: ${this.names().join(', ')}`);
    }
    const parsed = z.object(definition.inputSchema).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      throw new Error(`Invalid arguments for tool "${name}": ${details}`);
    }
    return await definition.handler(parsed.data as never);
  }

  /**
   * Attaches every registered tool to the MCP server. The casts are confined to
   * this method: the SDK types schema shapes generically while the registry erases
   * the argument type to store heterogeneous tools side by side.
   */
  bind(server: McpServer): void {
    for (const definition of this.tools.values()) {
      const config: {
        title: string;
        description: string;
        inputSchema: z.ZodRawShape;
        annotations?: ToolAnnotations;
      } = {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
      };
      if (definition.annotations !== undefined) config.annotations = definition.annotations;

      server.registerTool(
        definition.name,
        config as unknown as Parameters<McpServer['registerTool']>[1],
        async (args: Record<string, unknown>) => await definition.handler(args as never),
      );
    }
  }
}
