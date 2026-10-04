import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../../src/config.js';
import { createNoopLogger } from '../../src/logger.js';
import type { McpContext } from '../../src/mcp/context.js';
import { ToolRegistry } from '../../src/mcp/registry.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { registerCommandTools } from '../../src/mcp/tools/commands.js';
import { registerMovementTools } from '../../src/mcp/tools/movement.js';
import { registerQaTools } from '../../src/mcp/tools/qa.js';
import { registerRawTools } from '../../src/mcp/tools/raw.js';
import type { AgentSession } from '../../src/session-manager.js';
import type { CommandDescriptor, SessionSnapshot } from '../../src/types.js';

/**
 * Tests for the MCP surface itself: the tool registry, the tools' declarations and
 * the QA assertion/scenario engine. They run without a Bedrock connection by stubbing
 * the session the tools see — possible because tools go through the session manager,
 * so the seam is testable.
 */

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    connection: {
      state: 'initialized',
      host: '127.0.0.1',
      port: 19132,
      username: 'UnitAgent',
      offline: true,
      version: '1.26.51',
      protocolVersion: 900,
      raknetBackend: 'jsp-raknet',
      connectedAt: Date.now(),
      lastDisconnectReason: null,
      reconnectAttempts: 0,
      nextReconnectAt: null,
      packetsReceived: 42,
      packetsSent: 7,
      lastPacketAt: Date.now(),
    },
    entityId: '1',
    runtimeEntityId: 1,
    position: { x: 1, y: 64, z: -2 },
    rotation: { yaw: 90, pitch: 0, headYaw: 90 },
    onGround: true,
    dimension: 'overworld',
    gameMode: 'creative',
    health: 20,
    isAlive: true,
    worldName: 'Unit World',
    serverVersion: '1.26.51',
    permissionLevel: 'operator',
    serverAuthoritative: { inventory: false, blockBreaking: true },
    chunkRadius: 8,
    chunksLoaded: 12,
    tick: 100,
    itemRegistrySize: 5,
    biomesNamed: 7,
    undecodablePackets: 0,
    lastUndecodablePacket: null,
    commandCount: 2,
    chunksTracked: 3,
    chunksDecoded: 12,
    chunksFailed: 0,
    trackedEntities: 2,
    trackedBlocks: 4,
    knownPlayers: 1,
    inventorySlots: 3,
    selectedHotbarSlot: 0,
    uptimeMs: 1000,
    ...overrides,
  };
}

/**
 * A session stub with only the surface the MCP tools touch. The async-looking
 * methods return plain promises rather than being declared `async`.
 */
function makeStubSession(snapshot: SessionSnapshot = makeSnapshot()): AgentSession {
  const events: unknown[] = [];
  return {
    id: 'default',
    createdAt: Date.now(),
    effective: loadConfig({}).defaults,
    client: {
      sessionId: 'default',
      session: {
        state: snapshot.connection.state,
        snapshot: () => snapshot,
        getEventLog: () => [],
        getChatLog: () => [],
        commands: new Map(),
      },
      waitForDomainEvent: () => Promise.resolve(events.shift() ?? null),
      isConnected: true,
    },
    actions: {
      sendChat: () => Promise.resolve({ action: 'send_chat', ok: true, confirmed: false, evidence: '', warnings: [], elapsedMs: 1 }),
    },
  } as unknown as AgentSession;
}

function makeContext(options: { snapshot?: SessionSnapshot; rawTool?: boolean } = {}): McpContext {
  const session = makeStubSession(options.snapshot ?? makeSnapshot());
  const config = loadConfig(options.rawTool === true ? { MCBE_ENABLE_RAW_PACKET_TOOL: 'true' } : {});
  return {
    config,
    logger: createNoopLogger(),
    version: '0.0.0-test',
    manager: {
      defaultSessionId: 'default',
      maxSessions: config.maxSessions,
      size: 1,
      get: (id?: string) => (id === undefined || id === 'default' ? session : undefined),
      require: (id?: string) => {
        if (id === undefined || id === 'default') return session;
        throw new Error(`No session "${id}". Existing sessions: default`);
      },
      list: () => [
        {
          id: 'default',
          state: session.client.session.state,
          host: session.client.session.snapshot().connection.host,
          port: session.client.session.snapshot().connection.port,
          username: session.client.session.snapshot().connection.username,
          version: '1.26.51',
          connectedAt: Date.now(),
          runtimeEntityId: 1,
          position: session.client.session.snapshot().position,
          createdAt: Date.now(),
        },
      ],
    },
  } as unknown as McpContext;
}

function payloadOf(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('ToolRegistry', () => {
  it('registers tools and rejects duplicates', () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'ping', title: 'Ping', description: 'pings', inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));

    expect(registry.has('ping')).toBe(true);
    expect(registry.names()).toEqual(['ping']);
    expect(() =>
      registry.define({ name: 'ping', title: 'Ping again', description: '', inputSchema: {} }, () => ({
        content: [{ type: 'text', text: '' }],
      })),
    ).toThrow(/already registered/);
  });

  it('validates arguments against the tool schema before invoking', async () => {
    const registry = new ToolRegistry();
    let received: unknown = null;
    registry.define({ name: 'echo', title: 'Echo', description: 'echoes', inputSchema: { value: z.number().int() } }, (args) => {
      received = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await registry.invoke('echo', { value: 3 });
    expect(received).toEqual({ value: 3 });
    // The handler's own text block is returned verbatim: `invoke` does not wrap
    // it in JSON, it only validates the arguments.
    expect(result.content[0]?.text).toBe('ok');

    await expect(registry.invoke('echo', { value: 'not a number' })).rejects.toThrow(/Invalid arguments for tool "echo"/);
    await expect(registry.invoke('echo', {})).rejects.toThrow(/value/);
  });

  it('names the available tools when one is missing', async () => {
    const registry = new ToolRegistry();
    registry.define({ name: 'alpha', title: '', description: '', inputSchema: {} }, () => ({
      content: [{ type: 'text', text: '' }],
    }));
    await expect(registry.invoke('beta', {})).rejects.toThrow(/Unknown tool "beta". Available tools: alpha/);
  });
});

describe('tool registration', () => {
  it('registers every tool without collisions and exposes them to MCP', () => {
    const context = makeContext();
    const { registry } = buildMcpServer({
      manager: context.manager,
      config: context.config,
      logger: context.logger,
      version: 'test',
    });

    // The tools the project brief requires, plus the QA extras.
    for (const required of [
      'connect_to_server',
      'disconnect',
      'get_connection_status',
      'send_chat',
      'move_to',
      'walk_to',
      'get_block_at',
      'find_block',
      'get_biome',
      'get_nearby_entities',
      'get_inventory',
      'break_block',
      'place_block',
      'attack_entity',
      'run_command',
      'list_commands',
      'run_action_sequence',
      'wait_for_event',
    ]) {
      expect(registry.has(required), `tool "${required}" should be registered`).toBe(true);
    }

    // Every tool must carry a description: it is the agent's only documentation.
    for (const definition of registry.definitions()) {
      expect(definition.description.length, `tool "${definition.name}" needs a description`).toBeGreaterThan(40);
      expect(definition.title.length).toBeGreaterThan(0);
      expect(Object.keys(definition.inputSchema).length).toBeGreaterThanOrEqual(0);
    }

    expect(registry.names()).toEqual([...registry.names()].sort());
  });

  it('hides the raw packet tool unless it is explicitly enabled', () => {
    const disabled = new ToolRegistry();
    registerRawTools(disabled, makeContext());
    expect(disabled.names()).toEqual([]);

    const enabled = new ToolRegistry();
    registerRawTools(enabled, makeContext({ rawTool: true }));
    expect(enabled.names()).toContain('send_raw_packet');
  });
});

describe('run_command', () => {
  /**
   * Replaces the stub's action so the test can see what the tool forwarded. The
   * tool layer must not interpret the command — that is the action's job.
   */
  function contextWithRecorder(): {
    context: McpContext;
    calls: { command: string; options: Record<string, unknown> }[];
  } {
    const calls: { command: string; options: Record<string, unknown> }[] = [];
    const context = makeContext();
    const session = context.manager.require('default');
    (session.actions as unknown as Record<string, unknown>)['runCommand'] = (
      command: string,
      options: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ command, options });
      return Promise.resolve({
        action: 'run_command',
        ok: true,
        confirmed: true,
        evidence: 'server sent command_output for request r',
        warnings: [],
        elapsedMs: 3,
        detail: {
          command,
          requestId: 'r',
          acknowledged: true,
          succeeded: true,
          outputType: 'alloutput',
          successCount: 1,
          messages: [{ message: 'ok', success: true, parameters: [] }],
          output: 'ok',
        },
      });
    };
    return { context, calls };
  }

  it('forwards the command and options and returns the action result', async () => {
    const { context, calls } = contextWithRecorder();
    const registry = new ToolRegistry();
    registerCommandTools(registry, context);

    const result = payloadOf(await registry.invoke('run_command', { command: 'gamemode creative', timeoutMs: 5000, waitForOutput: false }));

    expect(calls).toEqual([{ command: 'gamemode creative', options: { timeoutMs: 5000, waitForOutput: false } }]);
    expect(result['sessionId']).toBe('default');
    expect(result['confirmed']).toBe(true);
    expect((result['detail'] as Record<string, unknown>)['output']).toBe('ok');
  });

  it('rejects an empty command and a command over the protocol limit', async () => {
    const { context } = contextWithRecorder();
    const registry = new ToolRegistry();
    registerCommandTools(registry, context);

    await expect(registry.invoke('run_command', { command: '' })).rejects.toThrow(/command/);
    await expect(registry.invoke('run_command', { command: 'x'.repeat(513) })).rejects.toThrow(/command/);
  });
});

describe('walk_to', () => {
  /**
   * The tool is a thin forwarder, so assert it passes through exactly the options
   * given — no invented defaults — and reports the resulting state.
   */
  function contextWithRecorder(): {
    context: McpContext;
    calls: { target: { x: number; y: number; z: number }; options: Record<string, unknown> }[];
  } {
    const calls: { target: { x: number; y: number; z: number }; options: Record<string, unknown> }[] = [];
    const context = makeContext();
    const session = context.manager.require('default');
    (session.actions as unknown as Record<string, unknown>)['walkTo'] = (
      target: { x: number; y: number; z: number },
      options: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ target, options });
      return Promise.resolve({
        action: 'walk_to',
        ok: true,
        confirmed: false,
        evidence: '',
        warnings: [],
        elapsedMs: 1,
        detail: { steps: 3, reached: true },
      });
    };
    return { context, calls };
  }

  it('forwards the target and only the options that were supplied', async () => {
    const { context, calls } = contextWithRecorder();
    const registry = new ToolRegistry();
    registerMovementTools(registry, context);

    await registry.invoke('walk_to', { x: 10, y: 64, z: -4, stepLength: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ x: 10, y: 64, z: -4 });
    // `stepLength` is forwarded; everything else stays for the action to default.
    expect(calls[0]?.options).toEqual({ stepLength: 1 });
  });

  it('passes every tunable through when the caller sets it', async () => {
    const { context, calls } = contextWithRecorder();
    const registry = new ToolRegistry();
    registerMovementTools(registry, context);

    await registry.invoke('walk_to', {
      x: 0,
      y: 64,
      z: 0,
      stepLength: 4,
      tolerance: 1,
      stepIntervalMs: 0,
      maxSteps: 8,
      keepY: false,
      abortOnCorrection: true,
      timeoutMs: 5000,
    });

    expect(calls[0]?.options).toEqual({
      stepLength: 4,
      tolerance: 1,
      stepIntervalMs: 0,
      maxSteps: 8,
      keepY: false,
      abortOnCorrection: true,
      timeoutMs: 5000,
    });
  });
});

describe('list_commands', () => {
  const catalogue: CommandDescriptor[] = [
    {
      name: 'teleport',
      description: 'Teleport to a player or coordinates',
      permissionLevel: 'any',
      aliases: ['tp'],
      overloads: ['destination:target', 'x:float y:float z:float'],
      flags: 0,
    },
    {
      name: 'give',
      description: 'Gives an item to a player',
      permissionLevel: 'any',
      aliases: [],
      overloads: ['player:target itemName:string'],
      flags: 0,
    },
    { name: 'weather', description: 'Sets the weather', permissionLevel: 'operator', aliases: [], overloads: ['type:enum'], flags: 2 },
  ];

  /** A registry over a session whose command catalogue has been seeded. */
  function registryWith(commands: CommandDescriptor[]): ToolRegistry {
    const context = makeContext();
    const session = context.manager.require('default');
    const map = (session.client.session as unknown as { commands: Map<string, CommandDescriptor> }).commands;
    for (const command of commands) map.set(command.name.toLowerCase(), command);
    const registry = new ToolRegistry();
    registerCommandTools(registry, context);
    return registry;
  }

  it('lists the whole catalogue, alphabetically, with usage and aliases', async () => {
    const payload = payloadOf(await registryWith(catalogue).invoke('list_commands', {}));

    expect(payload['total']).toBe(3);
    expect(payload['matched']).toBe(3);
    const commands = payload['commands'] as Record<string, unknown>[];
    expect(commands.map((command) => command['name'])).toEqual(['give', 'teleport', 'weather']);
    expect(commands[1]?.['aliases']).toEqual(['tp']);
    expect(commands[1]?.['usage']).toEqual(['destination:target', 'x:float y:float z:float']);
    // A zero flag is noise for an agent; a non-zero one is a real signal.
    expect(commands[0]?.['flags']).toBeUndefined();
    expect(commands[2]?.['flags']).toBe(2);
    expect(commands[2]?.['permissionLevel']).toBe('operator');
  });

  it('searches name, aliases and description, ignoring a leading slash', async () => {
    const byAlias = payloadOf(await registryWith(catalogue).invoke('list_commands', { search: '/tp' }));
    expect((byAlias['commands'] as Record<string, unknown>[]).map((command) => command['name'])).toEqual(['teleport']);

    const byDescription = payloadOf(await registryWith(catalogue).invoke('list_commands', { search: 'weather' }));
    expect((byDescription['commands'] as Record<string, unknown>[]).map((command) => command['name'])).toEqual(['weather']);
  });

  it('names real commands when nothing matches', async () => {
    const payload = payloadOf(await registryWith(catalogue).invoke('list_commands', { search: 'nosuchthing' }));
    expect(payload['matched']).toBe(0);
    expect(payload['total']).toBe(3);
    expect(String(payload['note'])).toContain('give');
  });

  it('explains an empty catalogue instead of returning a bare empty list', async () => {
    const payload = payloadOf(await registryWith([]).invoke('list_commands', { timeoutMs: 150 }));
    expect(payload['total']).toBe(0);
    expect(payload['commands']).toEqual([]);
    expect(String(payload['note'])).toContain('available_commands');
  });

  it('honours the limit without hiding the total', async () => {
    const payload = payloadOf(await registryWith(catalogue).invoke('list_commands', { limit: 1 }));
    expect(payload['total']).toBe(3);
    expect(payload['returned']).toBe(1);
    expect(payload['matched']).toBe(3);
  });
});

describe('assert_session_state', () => {
  function qaRegistry(context: McpContext): ToolRegistry {
    const registry = new ToolRegistry();
    registerQaTools(registry, context);
    return registry;
  }

  it('passes assertions that match the snapshot', async () => {
    const registry = qaRegistry(makeContext());
    const result = payloadOf(
      await registry.invoke('assert_session_state', {
        assertions: [
          { name: 'x', path: 'position.x', equals: 1 },
          { name: 'dimension', path: 'dimension', equals: 'overworld' },
          { name: 'health', path: 'health', atLeast: 1 },
          { name: 'y', path: 'position.y', greaterThan: 63 },
          { name: 'state', path: 'connection.state', equals: 'initialized' },
          { name: 'connected', path: 'runtimeEntityId', notEquals: null },
        ],
      }),
    );

    expect(result['success']).toBe(true);
    expect((result['assertions'] as { passed: boolean }[]).every((entry) => entry.passed)).toBe(true);
  });

  it('reads through the view named by source and reports it back', async () => {
    const registry = qaRegistry(makeContext());
    const result = payloadOf(
      await registry.invoke('assert_session_state', {
        assertions: [
          // `count` exists in the command view but not in the snapshot, so this
          // passes only if the named source is actually honoured.
          { name: 'no commands yet', source: 'command', path: 'count', equals: 0 },
          // `health` exists in the snapshot but not in the chat view: proves the
          // assertion did not silently fall back to the snapshot.
          { name: 'chat has no health', source: 'chat', path: 'health', isNull: true },
        ],
      }),
    );

    expect(result['success']).toBe(true);
    const assertions = result['assertions'] as { name: string; source: string; passed: boolean }[];
    expect(assertions.map((entry) => entry.source)).toEqual(['command', 'chat']);
    expect(assertions.every((entry) => entry.passed)).toBe(true);
  });

  it('reports exactly which assertion failed and what the value was', async () => {
    const registry = qaRegistry(makeContext());
    const result = payloadOf(
      await registry.invoke('assert_session_state', {
        assertions: [
          { name: 'wanted y 70', path: 'position.y', equals: 70 },
          { name: 'fine', path: 'health', equals: 20 },
        ],
      }),
    );

    expect(result['success']).toBe(false);
    const assertions = result['assertions'] as { name: string; passed: boolean; actual: unknown; message?: string }[];
    expect(assertions[0]?.passed).toBe(false);
    expect(assertions[0]?.actual).toBe(64);
    expect(assertions[0]?.message).toContain('64');
    expect(assertions[1]?.passed).toBe(true);
  });

  it('honours a tolerance for float comparisons', async () => {
    const context = makeContext({ snapshot: makeSnapshot({ position: { x: 1.234, y: 64, z: 0 } }) });
    const registry = qaRegistry(context);

    const strict = payloadOf(
      await registry.invoke('assert_session_state', { assertions: [{ name: 'x', path: 'position.x', equals: 1.2 }] }),
    );
    expect(strict['success']).toBe(false);

    const tolerant = payloadOf(
      await registry.invoke('assert_session_state', {
        assertions: [{ name: 'x', path: 'position.x', equals: 1.2, tolerance: 0.05 }],
      }),
    );
    expect(tolerant['success']).toBe(true);
  });

  it('fails an assertion that has no comparison at all', async () => {
    const registry = qaRegistry(makeContext());
    const result = payloadOf(await registry.invoke('assert_session_state', { assertions: [{ name: 'empty', path: 'health' }] }));

    expect(result['success']).toBe(false);
    expect((result['assertions'] as { message?: string }[])[0]?.message).toMatch(/no comparison/);
  });

  it('reports a missing path as null rather than throwing', async () => {
    const registry = qaRegistry(makeContext());
    const result = payloadOf(
      await registry.invoke('assert_session_state', { assertions: [{ name: 'nope', path: 'does.not.exist', isNull: true }] }),
    );
    expect(result['success']).toBe(true);
  });

  it('refuses to act on a session that is not in the world', async () => {
    const context = makeContext({
      snapshot: makeSnapshot({ connection: { ...makeSnapshot().connection, state: 'disconnected' } }),
    });
    const registry = qaRegistry(context);
    // Tool failures are returned as data (`isError: true`) rather than thrown,
    // so the agent can read the message instead of seeing a transport error.
    const result = await registry.invoke('assert_session_state', { assertions: [{ name: 'x', path: 'health' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not in the world yet');
  });
});

describe('run_action_sequence', () => {
  function qaRegistry(context: McpContext): ToolRegistry {
    const registry = new ToolRegistry();
    registerQaTools(registry, context);
    return registry;
  }

  it('runs a mix of real tools, the wait pseudo-step, and assertions', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    registry.define(
      {
        name: 'stub_action',
        title: 'Stub',
        description: 'a stubbed action for scenario tests',
        inputSchema: { amount: z.number().optional() },
      },
      (args) => ({
        content: [{ type: 'text', text: JSON.stringify({ confirmed: true, echo: args }) }],
      }),
    );

    const startedAt = Date.now();
    const result = payloadOf(
      await registry.invoke('run_action_sequence', {
        steps: [
          { tool: 'wait', args: { ms: 30 } },
          { tool: 'stub_action', args: { amount: 4 } },
        ],
        assertions: [{ name: 'still spawned', path: 'runtimeEntityId', equals: 1 }],
      }),
    );

    expect(result['success']).toBe(true);
    expect(result['stepsRun']).toBe(2);
    expect(result['aborted']).toBe(false);

    const steps = result['steps'] as { tool: string; ok: boolean; confirmed: boolean | null; result: unknown }[];
    expect(steps[0]?.tool).toBe('wait');
    expect(steps[0]?.confirmed).toBeNull();
    expect(steps[1]?.confirmed).toBe(true);
    expect((steps[1]?.result as { echo: { amount: number } }).echo.amount).toBe(4);
    // The wait step really waited.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it('captures unknown tools and tool errors instead of failing the whole run', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    registry.define(
      { name: 'explodes', title: 'Boom', description: 'a tool that always throws, for scenario tests', inputSchema: {} },
      () => {
        throw new Error('intentional failure');
      },
    );

    const result = payloadOf(
      await registry.invoke('run_action_sequence', {
        steps: [{ tool: 'explodes' }, { tool: 'no_such_tool' }, { tool: 'snapshot_session_state' }],
      }),
    );

    expect(result['success']).toBe(false);
    expect(result['stepsRun']).toBe(3);
    const steps = result['steps'] as { tool: string; ok: boolean }[];
    expect(steps[0]?.ok).toBe(false);
    expect(steps[1]?.ok).toBe(false);
    expect(steps[2]?.ok).toBe(true);
  });

  it('aborts on the first failure when stopOnFailure is set', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    const result = payloadOf(
      await registry.invoke('run_action_sequence', {
        stopOnFailure: true,
        steps: [{ tool: 'no_such_tool' }, { tool: 'wait', args: { ms: 1 } }],
      }),
    );

    expect(result['aborted']).toBe(true);
    expect(result['stepsRun']).toBe(1);
    expect(String(result['abortedReason'])).toContain('unknown tool');
  });

  it('stops when an action reports confirmed: false under stopOnFailure', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    registry.define(
      { name: 'unconfirmed', title: 'Unconfirmed', description: 'an action the server ignores, for scenario tests', inputSchema: {} },
      () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, confirmed: false }) }] }),
    );

    const result = payloadOf(
      await registry.invoke('run_action_sequence', {
        stopOnFailure: true,
        steps: [{ tool: 'unconfirmed' }, { tool: 'wait', args: { ms: 1 } }],
      }),
    );

    expect(result['aborted']).toBe(true);
    expect(result['stepsRun']).toBe(1);
  });

  it('passes the session id down to each step', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    const seen: unknown[] = [];
    registry.define(
      {
        name: 'spy',
        title: 'Spy',
        description: 'records the arguments it was given, for scenario tests',
        inputSchema: { sessionId: z.string().optional(), extra: z.string().optional() },
      },
      (args) => {
        seen.push(args);
        return { content: [{ type: 'text', text: JSON.stringify({ confirmed: true }) }] };
      },
    );

    await registry.invoke('run_action_sequence', {
      sessionId: 'default',
      steps: [
        { tool: 'spy', args: { extra: 'kept' } },
        { tool: 'spy', args: { sessionId: 'other' } },
      ],
    });

    expect(seen[0]).toEqual({ extra: 'kept', sessionId: 'default' });
    // An explicit sessionId in the step wins over the scenario-level one.
    expect(seen[1]).toEqual({ sessionId: 'other' });
  });

  it('evaluates assertions after each step when asked', async () => {
    const context = makeContext();
    const registry = qaRegistry(context);
    const result = payloadOf(
      await registry.invoke('run_action_sequence', {
        assertionsAfterEachStep: true,
        assertions: [{ name: 'alive', path: 'isAlive', equals: true }],
        steps: [
          { tool: 'wait', args: { ms: 1 } },
          { tool: 'wait', args: { ms: 1 } },
        ],
      }),
    );

    const runs = result['assertionsAfterEachStep'] as { afterStep: number | string; results: unknown[] }[];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.afterStep).toBe(1);
    expect(runs[1]?.afterStep).toBe(2);
  });
});
