/**
 * RPC contract exposed by the coordinator on the three port planes.
 *
 * Reconstructed from the original's `rpc/coordinator*` modules: the renderer
 * DATA session carries user-facing methods (sendPrompt, broadcastToAgents,
 * groups, subagents, workflows, automations, channels, shared rooms,
 * forever-box, teach-recording, ...); the MAIN DATA session carries host
 * supervision state for the Electron main process; the CONTROL session
 * carries lifecycle (hello/ping) plus the WebAuthn provider.
 *
 * Method names are the original wire names; `kind` mirrors the original
 * `RpcMethod` shape (frame kind used on the port transport).
 */

export interface RpcMethod<Args = unknown, Result = unknown> {
  readonly name: string;
  readonly kind: "request";
  args: Args;
  result: Result;
}

export interface CoordinatorRpcContract {
  // ---- renderer DATA plane (user-facing) ----
  readonly sendPrompt: RpcMethod<
    {
      sessionId: string;
      prompt: string;
      clientNonce?: string;
      priority?: boolean;
    },
    { accepted: boolean; turnId?: string }
  >;
  readonly broadcastToAgents: RpcMethod<
    { agentIds?: string[]; text: string },
    { delivered: number }
  >;
  readonly createGroup: RpcMethod<{ name: string }, { groupId: string }>;
  readonly setGroupMembers: RpcMethod<{ groupId: string; memberIds: string[] }, { ok: boolean }>;
  readonly getSubagents: RpcMethod<unknown, { subagents: unknown[] }>;
  readonly getAsyncTasks: RpcMethod<unknown, { tasks: unknown[] }>;
  readonly listChannels: RpcMethod<unknown, { channels: string[] }>;
  readonly sharedRooms: RpcMethod<unknown, { rooms: unknown[] }>;
  readonly foreverBox: RpcMethod<unknown, { items: unknown[] }>;
  readonly teachRecording: RpcMethod<unknown, { recording: boolean }>;

  // ---- MAIN DATA plane (host supervision) ----
  readonly hostStatus: RpcMethod<unknown, { pid: number | null; healthy: boolean }>;
  readonly restartHost: RpcMethod<unknown, { ok: boolean }>;

  // ---- CONTROL plane (lifecycle + WebAuthn) ----
  readonly hello: RpcMethod<{ version: number }, { version: number }>;
  readonly ping: RpcMethod<unknown, { pong: true }>;
  readonly webauthnMakeCredential: RpcMethod<unknown, { credentialId: string }>;
  readonly webauthnGetAssertion: RpcMethod<unknown, { signature: string }>;
}

export const COORDINATOR_METHOD_NAMES: ReadonlySet<string> = new Set([
  "sendPrompt",
  "broadcastToAgents",
  "createGroup",
  "setGroupMembers",
  "getSubagents",
  "getAsyncTasks",
  "listChannels",
  "sharedRooms",
  "foreverBox",
  "teachRecording",
  "hostStatus",
  "restartHost",
  "hello",
  "ping",
  "webauthnMakeCredential",
  "webauthnGetAssertion",
]);
