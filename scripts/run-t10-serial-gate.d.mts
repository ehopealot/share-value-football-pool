export type SerialGateStage = { label: string; command: string; args: string[] };
export type SerialGateContext = { cwd: string; timeoutMs: number; signal?: AbortSignal };
export declare const T10_SERIAL_GATE_STAGES: SerialGateStage[];
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
}): Promise<void>;
