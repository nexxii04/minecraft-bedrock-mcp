import { randomUUID } from 'node:crypto';

import type { Logger } from '../logger.js';
import type {
  ActionResult,
  BlockPosition,
  CommandOutputMessage,
  DomainEvent,
  EntitySnapshot,
  ItemStack,
  Rotation,
  Vec3,
} from '../types.js';
import type { BedrockClient } from './client.js';
import {
  buildChatPacket,
  buildCommandRequestPacket,
  buildDropItemTransaction,
  buildInteractPacket,
  buildItemReleaseTransaction,
  buildItemUseOnAirTransaction,
  buildItemUseOnBlockTransaction,
  buildItemUseOnEntityTransaction,
  buildMovePlayerPacket,
  buildPlayerActionPacket,
  buildPlayerAuthInputPacket,
  buildPlayerHotbarPacket,
  buildRequestChunkRadiusPacket,
  buildWireItem,
  type CommandOriginType,
  type InputData,
  type OutgoingChatType,
  type PlayerAction,
  type WireItem,
} from './packets.js';
import {
  blockCenter,
  blockKey,
  closestFace,
  distance,
  faceTowards,
  offsetByFace,
  rotationToLookAt,
  toBlockPosition,
  type BlockFace,
} from './vec3.js';

/**
 * High-level actions: turn "break this block" into the right Bedrock packets and
 * wait for the server to agree.
 *
 * Every action reports two independent flags: `ok` (packets left the socket) and
 * `confirmed` (the server produced observable evidence it acted). Evidence is
 * packet-specific — breaking by `update_block`, moving by a server position,
 * health by `set_health`. Where the protocol offers no acknowledgement, the
 * action returns `confirmed: false` plus a warning.
 */

export interface ActionOptions {
  timeoutMs?: number;
}

export interface SendChatOptions extends ActionOptions {
  type?: OutgoingChatType;
  /** How long to wait for our own message to be echoed back by the server. */
  echoTimeoutMs?: number;
}

export interface MoveToOptions extends ActionOptions {
  /**
   * Which packet carries the position. `both` (default) sends `player_auth_input`
   * then `move_player` in teleport mode: modern servers apply the former, some
   * only read the latter, so sending both covers either.
   */
  mode?: 'teleport' | 'auth_input' | 'both';
  rotation?: Rotation;
  onGround?: boolean;
  /** How close the server-reported position must be to count as confirmed. */
  tolerance?: number;
}

export interface WalkToOptions extends ActionOptions {
  /** Blocks per step. Smaller steps look more like walking, at one packet each. */
  stepLength?: number;
  /** How close to the target counts as arrived. */
  tolerance?: number;
  /** Pause between steps, in ms, so the server sees them as separate ticks. */
  stepIntervalMs?: number;
  /** Hard cap on packets, so a walk cannot run forever. */
  maxSteps?: number;
  /** Rotation to hold while walking; defaults to facing the target. */
  rotation?: Rotation;
  /** Keep the starting Y instead of following the straight line to the target. */
  keepY?: boolean;
  /** Stop early if the server contradicts a step with a correction. */
  abortOnCorrection?: boolean;
}

export interface WalkStep {
  index: number;
  position: Vec3;
  tick: number;
  /** Distance left to the target after this step. */
  remaining: number;
}

export interface WalkToResult extends ActionResult {
  detail: {
    from: Vec3;
    target: Vec3;
    finalPosition: Vec3;
    distance: number;
    remaining: number;
    reached: boolean;
    steps: number;
    maxSteps: number;
    stepLength: number;
    /** Position the server pushed us to mid-walk, when it contradicted a step. */
    correction: { position: Vec3; at: number } | null;
    trail: WalkStep[];
  };
}

export interface RunCommandOptions extends ActionOptions {
  /** Correlation id sent with the request; a random UUID when omitted. */
  requestId?: string;
  /**
   * Wait for the server's `command_output` reply. Set false for commands known to
   * be silent (some servers never answer `/say`): the call becomes fire-and-forget
   * and always reports `confirmed: false`.
   */
  waitForOutput?: boolean;
  /** Origin identity; defaults to the UUID the library used at login. */
  originUuid?: string;
  originType?: CommandOriginType;
  /** Mark the request internal. The vanilla client sends false. */
  internal?: boolean;
  /** Protocol `version` field. Overridden only for protocol archaeology. */
  version?: string;
}

export interface BreakBlockOptions extends ActionOptions {
  /** `survival` mines with start/stop break; `creative` destroys in one packet. */
  mode?: 'auto' | 'survival' | 'creative';
  face?: BlockFace;
}

export interface PlaceBlockOptions extends ActionOptions {
  /**
   * The block the player clicks; the new block appears on `face` of it.
   * Defaults to a neighbour of `position` that we have actually seen.
   */
  against?: BlockPosition;
  face?: BlockFace;
  /** Hotbar slot (0-8) whose item should be placed. Defaults to the held item. */
  hotbarSlot?: number;
  /** Explicit item runtime id, when the held item is unknown. */
  itemNetworkId?: number;
}

export interface EntityTargetOptions extends ActionOptions {
  /** Prefer the entity with this runtime id. */
  runtimeId?: number;
  /** Otherwise pick the nearest entity of this type, e.g. `minecraft:zombie`. */
  entityType?: string;
  /** Or the nearest player with this name. */
  username?: string;
  /** Maximum distance for automatic target selection, in blocks. */
  reach?: number;
}

export interface AttackEntityOptions extends EntityTargetOptions {
  /** Swing the arm as well, so other clients animate the hit. */
  swing?: boolean;
}

export interface InteractEntityOptions extends EntityTargetOptions {
  /**
   * `use` sends an item-use-on-entity transaction (feed, shear, trade).
   * `hover` only sends the lightweight `interact` packet.
   */
  mode?: 'use' | 'hover';
}

export interface DropItemOptions extends ActionOptions {
  /** Inventory slot; 0-8 is the hotbar. Defaults to the held slot. */
  slot?: number;
  count?: number;
}

export interface BreakBlockResult extends ActionResult {
  detail: { position: BlockPosition; blockRuntimeId: number | null; mode: 'survival' | 'creative' };
}

export interface RunCommandResult extends ActionResult {
  detail: {
    command: string;
    requestId: string;
    /** True when the server's `command_output` was seen and matched this request. */
    acknowledged: boolean;
    /**
     * `null` when no reply arrived. Otherwise true only when every message
     * reported success — a well-formed reply can still describe a rejection.
     */
    succeeded: boolean | null;
    outputType: string | null;
    successCount: number | null;
    messages: CommandOutputMessage[];
    /** The messages joined and stripped of `§` colour codes, ready to quote. */
    output: string;
  };
}

const DEFAULT_TOLERANCE = 0.5;

/** Real servers reject commands longer than 512 characters. */
const MAX_COMMAND_LENGTH = 512;

export class BedrockActions {
  private readonly client: BedrockClient;
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly defaultEchoTimeoutMs: number;

  constructor(options: { client: BedrockClient; logger: Logger; actionTimeoutMs: number; chatEchoTimeoutMs: number }) {
    this.client = options.client;
    this.logger = options.logger.child({ component: 'bedrock-actions', session: options.client.sessionId });
    this.defaultTimeoutMs = options.actionTimeoutMs;
    this.defaultEchoTimeoutMs = options.chatEchoTimeoutMs;
  }

  private get session(): BedrockClient['session'] {
    return this.client.session;
  }

  /**
   * Sends a chat message.
   *
   * Servers need not echo a message back to its author, so `confirmed` means
   * "we saw our own line return"; to prove acceptance, look for a server reply
   * (command output, system line) instead.
   */
  async sendChat(message: string, options: SendChatOptions = {}): Promise<ActionResult> {
    if (message.trim() === '') throw new Error('sendChat requires a non-empty message');
    const startedAt = Date.now();

    const echo = this.client.waitForDomainEvent(
      (event) => event.type === 'chat' && event.chat.fromSelf && event.chat.message.includes(message.slice(0, 32)),
      options.echoTimeoutMs ?? this.defaultEchoTimeoutMs,
      'own chat echo',
    );

    this.client.send(
      'text',
      buildChatPacket({
        message,
        sourceName: this.session.connection.username,
        ...(options.type !== undefined ? { type: options.type } : {}),
      }),
    );

    const echoed = await echo;
    return this.finish('send_chat', startedAt, {
      confirmed: echoed !== null,
      evidence:
        echoed !== null
          ? 'server echoed the message back to us'
          : 'no echo observed (servers are not required to echo to the author); the packet was sent',
      warnings: echoed !== null ? [] : ['chat acceptance was not acknowledged by the server within the echo window'],
      detail: { message },
    });
  }

  /**
   * Runs a server command as this player and waits for the reply.
   *
   * Uses `command_request` (not a `/`-prefixed `text` packet) because only it is
   * specified to return output. Confirmation is a `command_output` matching the
   * request id, or the uuid when the server leaves the id empty. A reply is not
   * success: many commands answer with a failure line, so `detail.succeeded`
   * reports what the server said. Silent commands (`/say`) never reply, so they
   * return `confirmed: false` with a warning.
   */
  async runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
    const trimmed = command.trim();
    if (trimmed === '') throw new Error('runCommand requires a non-empty command');
    if (trimmed.length > MAX_COMMAND_LENGTH) {
      throw new Error(
        `Bedrock rejects commands longer than ${String(MAX_COMMAND_LENGTH)} characters; this one is ${String(trimmed.length)}`,
      );
    }

    const startedAt = Date.now();
    const requestId = options.requestId ?? randomUUID();
    const originUuid = options.originUuid ?? this.client.playerUuid ?? '00000000-0000-0000-0000-000000000000';
    const waitForOutput = options.waitForOutput ?? true;

    const ack = waitForOutput
      ? this.client.waitForDomainEvent(
          (event) =>
            event.type === 'command_executed' &&
            // Some servers leave the request id empty; fall back to the uuid.
            (event.requestId === requestId || (event.requestId === '' && event.uuid === originUuid)),
          options.timeoutMs ?? this.defaultTimeoutMs,
          'command output',
        )
      : null;

    this.client.send(
      'command_request',
      buildCommandRequestPacket({
        command: trimmed,
        uuid: originUuid,
        requestId,
        playerEntityId: this.playerUniqueId(),
        ...(options.originType !== undefined ? { originType: options.originType } : {}),
        ...(options.internal !== undefined ? { internal: options.internal } : {}),
        ...(options.version !== undefined ? { version: options.version } : {}),
      }) as unknown as Record<string, unknown>,
    );

    const acknowledged = ack === null ? null : await ack;
    const output = acknowledged !== null && acknowledged.type === 'command_executed' ? acknowledged : null;
    const succeeded = output === null ? null : output.messages.length > 0 && output.messages.every((message) => message.success);

    const warnings: string[] = [];
    if (output === null && !waitForOutput) {
      warnings.push('waitForOutput was disabled, so the command may have run with no way to tell from this response');
    } else if (output === null) {
      warnings.push(
        'the server sent no command_output within the timeout: the command may have run silently (some commands never reply), may have been rejected, or we may lack permission for it',
      );
    } else if (succeeded === false) {
      warnings.push('the server answered with an unsuccessful result; see detail.messages for its own wording');
    }

    return {
      ...this.finish('run_command', startedAt, {
        confirmed: output !== null,
        evidence:
          output !== null
            ? `server sent command_output for request ${requestId} (${String(output.messages.length)} message(s), output_type "${output.outputType}")`
            : waitForOutput
              ? 'no command_output observed for this request'
              : 'command_request was sent without waiting for a reply',
        warnings,
      }),
      detail: {
        command: trimmed,
        requestId,
        acknowledged: output !== null,
        succeeded,
        outputType: output?.outputType ?? null,
        successCount: output?.successCount ?? null,
        messages: output?.messages ?? [],
        output: output === null ? '' : outputPlainText(output.messages),
      },
    };
  }

  /**
   * Reports a new position for the player and records it locally.
   *
   * Bedrock has no "walk" primitive and the library has no pathfinding: this is a
   * direct position report. A server that validates movement either accepts it or
   * pushes back with a correction, and a correction is itself confirmation.
   *
   * The move is recorded locally as a `self_report` event so later block actions
   * aim at the right coordinates, but `confirmed` is set only by a
   * *server-originated* position — our own report is excluded from the waiter, so
   * "we told the server" is never reported as "the server agreed". `confirmed:
   * false` means "unverified", which is normal on servers that broadcast movement
   * only to other viewers.
   */
  async moveTo(position: Vec3, options: MoveToOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const origin = this.requirePosition();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const rotation = options.rotation ?? rotationToLookAt(origin, position);
    const mode = options.mode ?? 'both';
    const onGround = options.onGround ?? true;

    const ack = this.client.waitForDomainEvent(
      (event) =>
        event.type === 'position_updated' &&
        // Exclude our own report, or the action would confirm itself.
        event.source !== 'self_report' &&
        distance(event.position, position) <= tolerance,
      options.timeoutMs ?? this.defaultTimeoutMs,
      'position acknowledgement',
    );

    if (mode === 'auth_input' || mode === 'both') {
      this.client.send(
        'player_auth_input',
        buildPlayerAuthInputPacket({
          position,
          rotation,
          tick: this.session.tick,
        }) as unknown as Record<string, unknown>,
      );
    }

    if (mode === 'teleport' || mode === 'both') {
      this.client.send(
        'move_player',
        buildMovePlayerPacket({
          runtimeId: runtimeEntityId,
          position,
          rotation,
          mode: 'teleport',
          onGround,
          tick: this.session.tick,
        }) as unknown as Record<string, unknown>,
      );
    }

    this.session.reportSelfPosition(position, rotation, onGround);

    const acknowledged = await ack;

    return this.finish('move_to', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged !== null
          ? `server reported our position at ${formatPosition(position)} (${acknowledged.type === 'position_updated' ? acknowledged.source : acknowledged.type})`
          : 'no server-side position report arrived; the position was recorded locally as a self report',
      warnings:
        acknowledged !== null
          ? []
          : [
              'the server did not report a position back. This is normal on servers that treat the client as authoritative over its own position and only broadcast movement to other viewers, so it is not proof the move failed — but it is not proof it worked either. Verify with a second session (get_nearby_entities) or with an effect of the new position.',
            ],
      detail: {
        requested: position,
        mode,
        tolerance,
        sessionPosition: this.session.position,
        positionSource: acknowledged === null ? 'self_report' : 'server',
      },
    });
  }

  /**
   * Walks to a position in steps, one `player_auth_input` per step.
   *
   * Not pathfinding: steps go in a straight line through terrain. It is a real
   * movement loop (increasing ticks, per-step displacement) so servers see a
   * player move rather than teleport. Use `move_to` to just "be over there".
   *
   * Confirmation matches `move_to`: the server broadcasts movement to other
   * viewers and does not echo it, so `confirmed: false` is honest and a second
   * session verifies. A correction is the one case where the mover hears back.
   *
   * `input_data` is deliberately left empty: its direction flags duplicate
   * `move_vector` and their axis convention is unverified against a server.
   */
  async walkTo(target: Vec3, options: WalkToOptions = {}): Promise<WalkToResult> {
    const startedAt = Date.now();
    const from = this.requirePosition();
    const stepLength = Math.max(0.5, options.stepLength ?? 2);
    const tolerance = options.tolerance ?? 0.5;
    const stepIntervalMs = Math.max(0, options.stepIntervalMs ?? 50);
    const totalDistance = distance(from, target);
    const maxSteps = Math.max(1, Math.min(options.maxSteps ?? 64, Math.ceil(totalDistance / stepLength) + 1));
    const rotation = options.rotation ?? rotationToLookAt(from, target);
    const keepY = options.keepY ?? true;
    const trail: WalkStep[] = [];

    // Collect corrections for the whole walk: a server correction is evidence it
    // read our movement. A list (not a `let`) keeps control-flow analysis honest —
    // a listener-only assignment would read as `null` and disable abortOnCorrection.
    const corrections: { position: Vec3; at: number }[] = [];
    const onEvent = (event: DomainEvent): void => {
      if (event.type !== 'position_updated') return;
      if (event.source !== 'server_correction' && event.source !== 'teleport') return;
      corrections.push({ position: event.position, at: event.at });
    };
    this.client.on('event', onEvent);

    let current = from;
    let tick = this.session.tick;
    try {
      for (let index = 0; index < maxSteps; index += 1) {
        const remaining = distance(current, target);
        if (remaining <= tolerance) break;

        const next = stepToward(current, target, Math.min(stepLength, remaining), keepY);
        tick += 1;
        const dx = next.x - current.x;
        const dz = next.z - current.z;
        const magnitude = Math.hypot(dx, dz);
        const moveVector = magnitude > 0 ? { x: dx / magnitude, z: dz / magnitude } : { x: 0, z: 0 };

        this.client.send(
          'player_auth_input',
          buildPlayerAuthInputPacket({
            position: next,
            rotation,
            tick,
            moveVector,
            delta: { x: dx, y: next.y - current.y, z: dz },
          }) as unknown as Record<string, unknown>,
        );
        // Record locally, or later block actions keep aiming at the start.
        this.session.reportSelfPosition(next, rotation, true);
        current = next;
        trail.push({ index, position: next, tick, remaining: distance(next, target) });

        if (corrections.length > 0 && options.abortOnCorrection === true) break;
        if (stepIntervalMs > 0 && index + 1 < maxSteps) await sleep(stepIntervalMs);
      }
      // Keep the session tick ahead of the last packet, so it is never reused.
      this.session.tick = tick;
    } finally {
      this.client.off('event', onEvent);
    }

    const remaining = distance(current, target);
    const reached = remaining <= tolerance;
    const correction = corrections[corrections.length - 1] ?? null;

    return {
      ...this.finish('walk_to', startedAt, {
        confirmed: correction !== null,
        evidence:
          correction !== null
            ? `the server corrected our position to ${formatPosition(correction.position)} during the walk, so it is reading our movement`
            : `sent ${String(trail.length)} authoritative-input step(s) towards ${formatPosition(target)}; no server-side position report arrived`,
        warnings:
          correction !== null
            ? []
            : [
                ...(reached
                  ? []
                  : [
                      'the walk stopped short of the target. That is what a step cap or a straight line through terrain looks like; raise maxSteps, or check whether the terrain between the two points is walkable.',
                    ]),
                'the server never reported our position back, which is normal on servers that broadcast movement only to other viewers. It is not proof the walk failed, and not proof it worked either.',
              ],
      }),
      detail: {
        from,
        target,
        finalPosition: this.session.position ?? current,
        distance: totalDistance,
        remaining,
        reached,
        steps: trail.length,
        maxSteps,
        stepLength,
        correction,
        trail,
      },
    };
  }

  /** Points the player's head at a position without changing where they stand. */
  async lookAt(target: Vec3, options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const origin = this.requirePosition();
    const rotation = rotationToLookAt(origin, target);

    this.client.send(
      'move_player',
      buildMovePlayerPacket({
        runtimeId: runtimeEntityId,
        position: origin,
        rotation,
        mode: 'rotation',
        onGround: this.session.onGround ?? true,
        tick: this.session.tick,
      }) as unknown as Record<string, unknown>,
    );

    // Rotation has no ack of its own; unconfirmed unless the server echoes.
    const ack = await this.client.waitForDomainEvent(
      (event) => event.type === 'position_updated' && event.source !== 'self_report',
      options.timeoutMs ?? Math.min(this.defaultTimeoutMs, 1500),
      'rotation acknowledgement',
    );

    this.session.rotation = rotation;

    return this.finish('look_at', startedAt, {
      confirmed: ack !== null,
      evidence: ack !== null ? 'server echoed a position/rotation update' : 'rotation is client-side; servers rarely acknowledge it',
      warnings: ack === null ? ['rotation applies locally and may not be reflected server-side until the next movement packet'] : [],
      detail: { rotation, target },
    });
  }

  /**
   * Sets yaw/pitch/head yaw explicitly, keeping the current position.
   *
   * Equivalent to `lookAt` but takes angles directly, for scripts that already
   * know which way they want to face.
   */
  async setRotation(rotation: Rotation, options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const origin = this.requirePosition();

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'position_updated' && event.source !== 'self_report',
      options.timeoutMs ?? Math.min(this.defaultTimeoutMs, 1500),
      'rotation acknowledgement',
    );

    this.client.send(
      'move_player',
      buildMovePlayerPacket({
        runtimeId: runtimeEntityId,
        position: origin,
        rotation,
        mode: 'rotation',
        onGround: this.session.onGround ?? true,
        tick: this.session.tick,
      }) as unknown as Record<string, unknown>,
    );

    // Mirror locally so later actions use the new orientation even without an echo.
    this.session.rotation = rotation;

    const acknowledged = await ack;
    return this.finish('set_rotation', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged !== null ? 'server echoed a position/rotation update' : 'rotation is client-side; servers rarely acknowledge it',
      warnings: acknowledged === null ? ['the rotation is applied locally and will be carried by the next movement packet'] : [],
      detail: { rotation },
    });
  }

  /** Jumps once. Confirmed when the server-reported Y actually rises. */
  async jump(options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const before = this.requirePosition();

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'position_updated' && event.position.y > before.y + 0.05,
      options.timeoutMs ?? this.defaultTimeoutMs,
      'jump acknowledgement',
    );

    this.client.send(
      'player_action',
      buildPlayerActionPacket({
        runtimeEntityId,
        action: 'jump',
        position: toBlockPosition(before),
        face: 'up',
      }) as unknown as Record<string, unknown>,
    );

    this.client.send(
      'player_auth_input',
      buildPlayerAuthInputPacket({
        position: before,
        rotation: this.session.rotation ?? { yaw: 0, pitch: 0, headYaw: 0 },
        tick: this.session.tick,
        inputData: ['jumping', 'start_jumping'] satisfies InputData[],
      }) as unknown as Record<string, unknown>,
    );

    const acknowledged = await ack;
    return this.finish('jump', startedAt, {
      confirmed: acknowledged !== null,
      evidence: acknowledged !== null ? 'server reported a higher Y position' : 'no vertical movement observed',
      warnings:
        acknowledged !== null
          ? []
          : ['the server did not report any vertical movement; we may be in a ceiling, in water, or movement is server-authoritative'],
      detail: { from: before },
    });
  }

  /**
   * Breaks a block and waits for the server's `update_block` for that coordinate.
   *
   * Survival uses a three-part sequence (`start_break`, `crack_break` stream,
   * `stop_break`); creative uses a single `creative_player_destroy_block`.
   */
  async breakBlock(position: BlockPosition, options: BreakBlockOptions = {}): Promise<BreakBlockResult> {
    const startedAt = Date.now();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const origin = this.requirePosition();
    const mode = this.resolveBreakMode(options.mode);
    const face = options.face ?? closestFace(position, origin);

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'block_updated' && sameBlock(event.position, position),
      options.timeoutMs ?? this.defaultTimeoutMs,
      'block break acknowledgement',
    );

    if (mode === 'creative') {
      this.client.send(
        'player_action',
        buildPlayerActionPacket({
          runtimeEntityId,
          action: 'creative_player_destroy_block',
          position,
          resultPosition: position,
          face,
        }) as unknown as Record<string, unknown>,
      );
    } else {
      this.client.send(
        'player_action',
        buildPlayerActionPacket({
          runtimeEntityId,
          action: 'start_break',
          position,
          resultPosition: position,
          face,
        }) as unknown as Record<string, unknown>,
      );
      this.client.send(
        'player_action',
        buildPlayerActionPacket({
          runtimeEntityId,
          action: 'stop_break',
          position,
          resultPosition: position,
          face,
        }) as unknown as Record<string, unknown>,
      );
    }

    const acknowledged = await ack;
    const blockRuntimeId = acknowledged !== null && acknowledged.type === 'block_updated' ? acknowledged.blockRuntimeId : null;
    const broke = blockRuntimeId === 0;

    const warnings: string[] = [];
    if (acknowledged === null) {
      warnings.push(
        'no block update arrived for this coordinate: the block may be unbreakable, out of reach, or the server may require survival mining progress we cannot simulate without tick-level timing',
      );
    } else if (!broke) {
      warnings.push(`the server reported block runtime id ${blockRuntimeId} at that position rather than air (0)`);
    }

    return {
      ...this.finish('break_block', startedAt, {
        confirmed: acknowledged !== null,
        evidence: acknowledged !== null ? `server sent update_block for ${formatBlock(position)}` : 'no block update observed',
        warnings,
      }),
      detail: { position, blockRuntimeId, mode },
    };
  }

  /**
   * Places a block from the held item.
   *
   * `position` is where the new block should end up. The "use item" transaction
   * is relative to a *clicked* block, so the clicked neighbour is derived from the
   * block cache.
   */
  async placeBlock(position: BlockPosition, options: PlaceBlockOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const origin = this.requirePosition();
    const hotbarSlot = options.hotbarSlot ?? this.session.selectedHotbarSlot ?? 0;
    const held = this.resolveHeldItem(hotbarSlot, options.itemNetworkId);

    const { against, face } = this.resolvePlaceTarget(position, options);

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'block_updated' && sameBlock(event.position, position),
      options.timeoutMs ?? this.defaultTimeoutMs,
      'block place acknowledgement',
    );

    this.client.send(
      'inventory_transaction',
      buildItemUseOnBlockTransaction({
        blockPosition: against,
        face,
        hotbarSlot,
        heldItem: held,
        playerPosition: origin,
        blockRuntimeId: this.session.getTrackedBlock(against)?.blockRuntimeId ?? 0,
      }) as unknown as Record<string, unknown>,
    );

    const acknowledged = await ack;
    const warnings: string[] = [];
    if (acknowledged === null) {
      warnings.push(
        'no block update arrived: the target may be occupied, the held item may not be placeable, or the position may be out of reach/reach-validated',
      );
    }

    return this.finish('place_block', startedAt, {
      confirmed: acknowledged !== null,
      evidence: acknowledged !== null ? `server sent update_block for ${formatBlock(position)}` : 'no block update observed',
      warnings,
      detail: { position, against, face, hotbarSlot, itemNetworkId: held.network_id },
    });
  }

  /** Cancels an in-progress break (used to unstick a session after a failure). */
  // eslint-disable-next-line @typescript-eslint/require-await -- awaitable API, synchronous body
  async abortBreak(position?: BlockPosition, options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const target = position ?? toBlockPosition(this.requirePosition());
    this.client.send(
      'player_action',
      buildPlayerActionPacket({
        runtimeEntityId,
        action: 'abort_break',
        position: target,
        resultPosition: target,
        face: closestFace(target, this.requirePosition()),
      }) as unknown as Record<string, unknown>,
    );
    void options;
    return this.finish('abort_break', startedAt, {
      confirmed: false,
      evidence: 'abort_break is fire-and-forget; there is no acknowledgement packet',
      warnings: [],
      detail: { position: target },
    });
  }

  /** Asks the server to widen the chunk radius it streams to us. */
  async requestChunkRadius(chunkRadius: number, options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'chunk_radius_accepted',
      options.timeoutMs ?? this.defaultTimeoutMs,
      'chunk radius acknowledgement',
    );
    this.client.queue('request_chunk_radius', buildRequestChunkRadiusPacket({ chunkRadius }));
    const acknowledged = await ack;
    const granted = acknowledged !== null && acknowledged.type === 'chunk_radius_accepted' ? acknowledged.chunkRadius : null;
    return this.finish('request_chunk_radius', startedAt, {
      confirmed: acknowledged !== null,
      evidence: acknowledged !== null ? `server granted chunk radius ${granted}` : 'no chunk_radius_update observed',
      warnings:
        acknowledged !== null && granted !== null && granted < chunkRadius
          ? [`server granted ${granted}, less than the requested ${chunkRadius}`]
          : [],
      detail: { requested: chunkRadius, granted },
    });
  }

  /**
   * Attacks an entity via `inventory_transaction` / `item_use_on_entity`.
   * Confirmed by the entity's `health` metadata dropping or it disappearing.
   */
  async attackEntity(options: AttackEntityOptions): Promise<ActionResult> {
    const startedAt = Date.now();
    const origin = this.requirePosition();
    const entity = this.resolveEntityTarget(options);
    const hotbarSlot = this.session.selectedHotbarSlot ?? 0;
    const held = this.resolveHeldItem(hotbarSlot);

    const ack = this.client.waitForDomainEvent(
      (event) => {
        if (event.type === 'entity_removed') return event.runtimeId === entity.runtimeId;
        if (event.type === 'entity_metadata') return event.runtimeId === entity.runtimeId && 'health' in event.metadata;
        return false;
      },
      options.timeoutMs ?? this.defaultTimeoutMs,
      'attack acknowledgement',
    );

    this.client.send(
      'inventory_transaction',
      buildItemUseOnEntityTransaction({
        entityRuntimeId: entity.runtimeId,
        actionType: 'attack',
        hotbarSlot,
        heldItem: held,
        playerPosition: origin,
      }) as unknown as Record<string, unknown>,
    );

    if (options.swing !== false) {
      this.client.send('animate', {
        action_id: 'swing_arm',
        runtime_entity_id: BigInt(this.requireRuntimeEntityId()),
        data: 0,
        has_swing_source: false,
      });
    }

    const acknowledged = await ack;
    return this.finish('attack_entity', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged === null
          ? 'no damage or removal event observed for the target'
          : acknowledged.type === 'entity_removed'
            ? 'target was removed from the world'
            : 'target metadata reported a health change',
      warnings:
        acknowledged === null
          ? ['the target was not visibly damaged: it may be out of reach, invulnerable, friendly, or protected by the server']
          : [],
      detail: { target: entity, distance: Number(distance(entity.position, origin).toFixed(3)), hotbarSlot },
    });
  }

  /**
   * Interacts with an entity: `use` = item-use transaction, `hover` = `interact`.
   * The protocol has no acknowledgement, so `confirmed` is only true on an
   * observable side effect.
   */
  async interactEntity(options: InteractEntityOptions): Promise<ActionResult> {
    const startedAt = Date.now();
    const origin = this.requirePosition();
    const entity = this.resolveEntityTarget(options);
    const mode = options.mode ?? 'use';

    const ack = this.client.waitForDomainEvent(
      (event) =>
        (event.type === 'entity_metadata' && event.runtimeId === entity.runtimeId) ||
        event.type === 'inventory_slot' ||
        event.type === 'chat',
      options.timeoutMs ?? this.defaultTimeoutMs,
      'interaction acknowledgement',
    );

    if (mode === 'hover') {
      this.client.send(
        'interact',
        buildInteractPacket({
          actionId: 'mouse_over_entity',
          targetEntityId: entity.runtimeId,
          position: entity.position,
        }),
      );
    } else {
      const hotbarSlot = this.session.selectedHotbarSlot ?? 0;
      this.client.send(
        'inventory_transaction',
        buildItemUseOnEntityTransaction({
          entityRuntimeId: entity.runtimeId,
          actionType: 'interact',
          hotbarSlot,
          heldItem: this.resolveHeldItem(hotbarSlot),
          playerPosition: origin,
        }) as unknown as Record<string, unknown>,
      );
    }

    const acknowledged = await ack;
    return this.finish('interact_entity', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged !== null
          ? `server produced a follow-up ${acknowledged.type} event`
          : 'interactions have no dedicated acknowledgement packet',
      warnings: acknowledged === null ? ['no side effect observed; the interaction may or may not have been accepted'] : [],
      detail: { target: entity, mode, distance: Number(distance(entity.position, origin).toFixed(3)) },
    });
  }

  /** Selects a hotbar slot (0-8). Confirmed when the server echoes `mob_equipment`. */
  async equipItem(slot: number, options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
      throw new Error(`equipItem expects a hotbar slot between 0 and 8, received ${slot}`);
    }
    const item = this.session.getInventory('inventory').find((candidate) => candidate.slot === slot) ?? null;
    const warnings: string[] = [];
    if (item === null) warnings.push(`hotbar slot ${slot} is empty according to our inventory snapshot`);

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'inventory_slot' || event.type === 'inventory_updated',
      options.timeoutMs ?? Math.min(this.defaultTimeoutMs, 1500),
      'equip acknowledgement',
    );

    this.client.send('player_hotbar', buildPlayerHotbarPacket({ selectedSlot: slot }));
    this.session.selectedHotbarSlot = slot;

    const acknowledged = await ack;
    return this.finish('equip_item', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged !== null ? 'server sent an inventory update after the hotbar change' : 'hotbar selection is mostly client-side',
      warnings,
      detail: { slot, item },
    });
  }

  /**
   * Drops part (or all) of a stack.
   *
   * There is no "drop" packet: this sends a `normal` inventory transaction with
   * source `world_interaction`. Confirmed by the slot emptying.
   */
  async dropItem(options: DropItemOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const slot = options.slot ?? this.session.selectedHotbarSlot ?? 0;
    const item = this.session.getInventory('inventory').find((candidate) => candidate.slot === slot) ?? null;
    if (item === null) {
      throw new Error(`Cannot drop from slot ${slot}: our inventory snapshot shows it as empty`);
    }
    const count = options.count ?? item.count;
    if (count <= 0 || count > item.count) {
      throw new Error(`Cannot drop ${count} items from a stack of ${item.count}`);
    }

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'inventory_slot' && event.slot === slot,
      options.timeoutMs ?? this.defaultTimeoutMs,
      'drop acknowledgement',
    );

    const held = buildWireItem({
      networkId: item.networkId,
      count,
      metadata: item.metadata,
      blockRuntimeId: item.blockRuntimeId,
      ...(item.stackId !== undefined ? { stackId: item.stackId } : {}),
    });

    this.client.send(
      'inventory_transaction',
      buildDropItemTransaction({
        slot,
        item: held,
      }) as unknown as Record<string, unknown>,
    );

    const acknowledged = await ack;
    return this.finish('drop_item', startedAt, {
      confirmed: acknowledged !== null,
      evidence: acknowledged !== null ? `server updated slot ${slot}` : 'no inventory update observed',
      warnings: acknowledged === null ? ['the drop may have been rejected by server-authoritative inventory'] : [],
      detail: { slot, count, itemNetworkId: item.networkId },
    });
  }

  /** Uses the held item in the air (start using, then release). */
  async useHeldItem(options: ActionOptions = {}): Promise<ActionResult> {
    const startedAt = Date.now();
    const origin = this.requirePosition();
    const runtimeEntityId = this.requireRuntimeEntityId();
    const hotbarSlot = this.session.selectedHotbarSlot ?? 0;
    const held = this.resolveHeldItem(hotbarSlot);

    const ack = this.client.waitForDomainEvent(
      (event) => event.type === 'health_changed' || event.type === 'inventory_slot',
      options.timeoutMs ?? this.defaultTimeoutMs,
      'item use acknowledgement',
    );

    this.client.send(
      'player_action',
      buildPlayerActionPacket({
        runtimeEntityId,
        action: 'start_using_item' satisfies PlayerAction,
        position: toBlockPosition(origin),
        face: 'up',
      }) as unknown as Record<string, unknown>,
    );
    this.client.send(
      'inventory_transaction',
      buildItemUseOnAirTransaction({
        hotbarSlot,
        heldItem: held,
        playerPosition: origin,
      }) as unknown as Record<string, unknown>,
    );
    this.client.send(
      'inventory_transaction',
      buildItemReleaseTransaction({
        actionType: 'consume',
        hotbarSlot,
        heldItem: held,
        headPosition: { x: origin.x, y: origin.y + 1.62, z: origin.z },
      }) as unknown as Record<string, unknown>,
    );

    const acknowledged = await ack;
    return this.finish('use_held_item', startedAt, {
      confirmed: acknowledged !== null,
      evidence:
        acknowledged !== null ? `server produced a follow-up ${acknowledged.type} event` : 'no consumption or inventory change observed',
      warnings: acknowledged === null ? ['the item may not be consumable, or the use was rejected'] : [],
      detail: { hotbarSlot, itemNetworkId: held.network_id },
    });
  }

  /**
   * Sends a hand-built packet. Only reachable when `MCBE_ENABLE_RAW_PACKET_TOOL`
   * is on; bypasses every safety net.
   */
  sendRawPacket(
    packetName: string,
    params: Record<string, unknown>,
    options: { queue?: boolean; dryRun?: boolean } = {},
  ): { sent: boolean; dryRun: boolean; packet: string; error: string | null } {
    if (options.dryRun === true) {
      const serializable = this.client.canSerialize(packetName, params);
      return {
        sent: false,
        dryRun: true,
        packet: packetName,
        error: serializable.ok ? null : serializable.error,
      };
    }
    if (options.queue === true) this.client.queue(packetName, params);
    else this.client.send(packetName, params);
    return { sent: true, dryRun: false, packet: packetName, error: null };
  }

  private finish(
    action: string,
    startedAt: number,
    outcome: { confirmed: boolean; evidence: string; warnings: string[]; detail?: Record<string, unknown> },
  ): ActionResult {
    const result: ActionResult = {
      action,
      ok: true,
      confirmed: outcome.confirmed,
      evidence: outcome.evidence,
      warnings: outcome.warnings,
      elapsedMs: Date.now() - startedAt,
    };
    if (outcome.detail !== undefined) result.detail = outcome.detail;
    this.logger.debug({ action, confirmed: result.confirmed, elapsedMs: result.elapsedMs, warnings: result.warnings }, 'action completed');
    return result;
  }

  private requirePosition(): Vec3 {
    const position = this.session.position;
    if (position === null) {
      throw new Error(
        'Player position is unknown. The session has not received a start_game packet yet — call connect_to_server and wait for the spawn, or read the bedrock://session/{id}/state resource.',
      );
    }
    return position;
  }

  private requireRuntimeEntityId(): number {
    const runtimeEntityId = this.session.runtimeEntityId;
    if (runtimeEntityId === null) {
      throw new Error('Runtime entity id is unknown; the session has not finished joining yet.');
    }
    return runtimeEntityId;
  }

  /**
   * The player's unique entity id as a bigint, or 0 before `start_game`.
   *
   * Stored as a decimal string because `li64` exceeds a double's precision, so it
   * is parsed, not widened. Commands do not require it, so an unknown id degrades
   * to 0 rather than blocking.
   */
  private playerUniqueId(): bigint {
    const raw = this.session.entityId;
    if (raw === null) return 0n;
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }

  private resolveBreakMode(requested: BreakBlockOptions['mode']): 'survival' | 'creative' {
    if (requested === 'survival' || requested === 'creative') return requested;
    return this.session.gameMode === 'creative' ? 'creative' : 'survival';
  }

  /**
   * Picks the block to click and its face. With no hint, scans the six neighbours
   * for a non-air one, preferring `down` so "place on the ground" works on an
   * empty cache.
   */
  private resolvePlaceTarget(position: BlockPosition, options: PlaceBlockOptions): { against: BlockPosition; face: BlockFace } {
    if (options.against !== undefined) {
      if (options.face !== undefined) return { against: options.against, face: options.face };
      const derived = faceTowards(options.against, position);
      return { against: options.against, face: derived ?? 'up' };
    }

    const faces: BlockFace[] = ['down', 'up', 'north', 'south', 'west', 'east'];
    const known: { against: BlockPosition; face: BlockFace; solid: boolean }[] = [];
    for (const face of faces) {
      const neighbour = offsetByFace(position, face);
      const tracked = this.session.blocks.get(blockKey(neighbour));
      if (tracked === undefined) continue;
      known.push({ against: neighbour, face, solid: tracked.blockRuntimeId !== 0 });
    }

    const solid = known.find((candidate) => candidate.solid);
    if (solid !== undefined) return { against: solid.against, face: solid.face };

    const below = offsetByFace(position, 'down');
    return { against: below, face: 'up' };
  }

  private resolveHeldItem(hotbarSlot: number, explicitNetworkId?: number): WireItem {
    if (explicitNetworkId !== undefined) {
      return buildWireItem({ networkId: explicitNetworkId, count: 1 });
    }
    const item: ItemStack | null = this.session.getInventory('inventory').find((candidate) => candidate.slot === hotbarSlot) ?? null;
    if (item === null) {
      const held = this.session.getHeldItem();
      if (held === null) {
        throw new Error(
          `No item in hotbar slot ${hotbarSlot} and our inventory snapshot is empty for that slot. Pass itemNetworkId explicitly, or equip a slot that holds an item (see bedrock://session/{id}/inventory).`,
        );
      }
      return this.toWireItem(held);
    }
    return this.toWireItem(item);
  }

  private toWireItem(item: ItemStack): WireItem {
    return buildWireItem({
      networkId: item.networkId,
      count: item.count,
      metadata: item.metadata,
      blockRuntimeId: item.blockRuntimeId,
      ...(item.stackId !== undefined ? { stackId: item.stackId } : {}),
    });
  }

  /**
   * Resolves an entity target from a runtime id, type name or username. Automatic
   * selection is range-limited: guessing across distance is worse than failing.
   */
  private resolveEntityTarget(options: EntityTargetOptions): EntitySnapshot {
    const origin = this.requirePosition();

    if (options.runtimeId !== undefined) {
      const entity = this.session.entities.get(options.runtimeId);
      if (entity === undefined) {
        throw new Error(
          `No tracked entity with runtime id ${options.runtimeId}. Tracked entities: ${this.session.entities.size}. Use get_nearby_entities to list them.`,
        );
      }
      return entity;
    }

    if (options.entityType === undefined && options.username === undefined) {
      throw new Error('Provide runtimeId, entityType or username to select a target entity');
    }

    const reach = options.reach ?? 6;
    let best: EntitySnapshot | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entity of this.session.entities.values()) {
      if (options.entityType !== undefined && entity.type !== options.entityType) continue;
      if (options.username !== undefined && entity.username !== options.username) continue;
      const entityDistance = distance(entity.position, origin);
      if (entityDistance > reach) continue;
      if (entityDistance < bestDistance) {
        best = entity;
        bestDistance = entityDistance;
      }
    }

    if (best === null) {
      throw new Error(
        `No entity matching ${options.entityType ?? options.username} within ${reach} blocks. Use get_nearby_entities to see what is actually in range.`,
      );
    }
    return best;
  }
}

function sameBlock(a: BlockPosition, b: BlockPosition): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Moves `length` blocks along the straight line from `from` to `target`. */
function stepToward(from: Vec3, target: Vec3, length: number, keepY: boolean): Vec3 {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = target.z - from.z;
  const span = Math.hypot(dx, dy, dz);
  if (span === 0) return from;
  const scale = length / span;
  return {
    x: from.x + dx * scale,
    y: keepY ? from.y : from.y + dy * scale,
    z: from.z + dz * scale,
  };
}

/** Promise-based pause, used to space movement packets into separate ticks. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatBlock(block: BlockPosition): string {
  return `${block.x},${block.y},${block.z}`;
}

function formatPosition(position: Vec3): string {
  return `${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`;
}

/**
 * Joins command output into plain text, stripping `§` colour codes. Raw messages
 * stay in `detail.messages`.
 */
function outputPlainText(messages: CommandOutputMessage[]): string {
  return messages
    .map((message) => {
      const withParameters = message.parameters.reduce(
        (text, parameter, index) => text.replaceAll(`%${String(index + 1)}`, parameter),
        message.message,
      );
      return withParameters.replaceAll(/§./g, '');
    })
    .join('\n')
    .trim();
}

/** Re-exported so tools can describe a target without importing packet builders. */
export { blockCenter, distance, rotationToLookAt };
export type { DomainEvent };
