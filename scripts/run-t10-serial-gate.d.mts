export type SerialGateStage = { label: string; command: string; args: string[] };
export type SerialGateContext = {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Internal lock ownership hook used by the default detached-stage runner. */
  updateActiveStage?: (stage?: {
    pid: number;
    processStartIdentity: string | null;
    leaderExitedBeforeRegistration?: true;
  }) => Promise<void>;
};
export declare const T10_SERIAL_GATE_STAGES: SerialGateStage[];
export declare function forwardSerialGateOutput(source: { pause(): unknown; resume(): unknown }, destination: { write(chunk: string | Uint8Array): boolean; once(event: "drain", listener: () => void): unknown }, chunk: string | Uint8Array): void;
export declare function runSerialGate(options?: {
  cwd?: string;
  lockPath?: string;
  stages?: SerialGateStage[];
  timeoutMs?: number;
  executeStage?: (stage: SerialGateStage, context: SerialGateContext) => Promise<void>;
  cleanup?: () => Promise<void>;
  finalCleanup?: (context: Omit<SerialGateContext, "signal">) => Promise<void>;
  signal?: AbortSignal;
  stop?: (child: import("node:child_process").ChildProcess | undefined) => Promise<void>;
  writeOwner?: (path: string, data: string, encoding: BufferEncoding) => Promise<unknown>;
  renameLock?: (from: string, to: string) => Promise<unknown>;
  removePending?: (path: string, options: { recursive: true; force: false }) => Promise<unknown>;
}): Promise<void>;
