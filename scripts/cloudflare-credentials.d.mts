export declare const cloudflareCredentialNames: readonly string[];
export declare const workerSecretNames: readonly string[];
export declare function withoutCloudflareCredentials(environment: NodeJS.ProcessEnv, preserveCiWranglerCredentials?: boolean): NodeJS.ProcessEnv;
export declare function withoutWorkerSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function nonPublishingCloudflareEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
