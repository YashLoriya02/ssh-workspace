import { Command } from "@tauri-apps/plugin-shell";

export type BackendStatus =
    | "stopped"
    | "starting"
    | "connected"
    | "error";

export interface BackendMessage {
    id?: string;
    type: string;
    payload?: unknown;
}

export interface BackendState {
    status: BackendStatus;
    message?: string;
}

export interface PingResponse {
    sentAt: number;
    receivedAt: number;
    processId: number;
    platform: string;
    architecture: string;
}

export interface TerminalOutputEvent {
    terminalId: string;
    source: "stdout" | "stderr";
    encoding: "base64";
    data: string;
}

export interface TerminalClosedEvent {
    terminalId: string;
    connectionId: string;
    reason: "user" | "remote";
}

export interface TerminalErrorEvent {
    terminalId: string;
    connectionId: string;
    message: string;
}

export type RemoteFileType =
    | "directory"
    | "file"
    | "symlink"
    | "other";

export interface RemoteFileEntry {
    name: string;
    path: string;
    type: RemoteFileType;
    size: number;
    modifiedAt: number | null;
    permissions: string | null;
    uid: number | null;
    gid: number | null;
}

export interface RemoteDirectoryListing {
    path: string;
    parentPath: string | null;
    entries: RemoteFileEntry[];
}

export interface RemoteTextFileSnapshot {
    path: string;
    name: string;

    contentBase64: string;
    encoding: "utf-8";

    size: number;
    modifiedAt: number | null;
    permissions: string | null;

    revision: string;
    readOnly: boolean;
}

export type RemoteImageMimeType =
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | "image/bmp"
    | "image/x-icon";

export interface RemoteImageSnapshot {
    path: string;
    name: string;

    contentBase64: string;
    mimeType: RemoteImageMimeType;

    size: number;
    modifiedAt: number | null;
    permissions: string | null;

    revision: string;
}

export interface SaveRemoteTextFileOptions {
    connectionId: string;
    remotePath: string;

    contentBase64: string;
    expectedRevision: string;

    force?: boolean;
}

export class BackendRequestError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);

        this.name =
            "BackendRequestError";
    }
}

export type TransferStatus =
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

export interface TransferEventPayload {
    transferId: string;
    connectionId: string;

    direction: "download" | "upload";

    name: string;
    remotePath: string;
    localPath: string;

    transferredBytes: number;
    totalBytes: number;

    status: TransferStatus;
    message?: string;
}

interface SidecarChild {
    readonly pid: number;
    write(data: string | Uint8Array): Promise<void>;
    kill(): Promise<void>;
}

interface PendingRequest {
    resolve: (message: BackendMessage) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
}

export type SshAuthentication =
    | {
        type: "password";
        password: string;
    }
    | {
        type: "privateKey";
        privateKey: string;
        passphrase?: string;
    };

export interface SshConnectionConfig {
    host: string;
    port: number;
    username: string;
    authentication: SshAuthentication;

    knownHostFingerprint?: string;
}

export interface HostKeyVerifiedEvent {
    connectionId: string;

    host: string;
    port: number;

    keyType: string;
    fingerprint: string;
}

export interface HostKeyMismatchEvent {
    connectionId: string;

    host: string;
    port: number;

    keyType: string;

    expectedFingerprint: string;
    receivedFingerprint: string;
}

export interface HostKeyApprovalEvent {
    connectionId: string;
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
}

export interface ConnectionEventPayload {
    connectionId: string;
    host?: string;
    port?: number;
    username?: string;
    message?: string;
    reason?: string;
}

type StateListener = (state: BackendState) => void;
type EventListener = (message: BackendMessage) => void;
type LogListener = (message: string) => void;

export class BackendClient {
    private child: SidecarChild | null = null;
    private pendingRequests = new Map<string, PendingRequest>();

    private stateListeners = new Set<StateListener>();
    private eventListeners = new Set<EventListener>();
    private logListeners = new Set<LogListener>();

    private currentState: BackendState = {
        status: "stopped",
    };

    private readyResolve: (() => void) | null = null;
    private readyReject: ((error: Error) => void) | null = null;
    private readyTimeoutId: ReturnType<typeof setTimeout> | null = null;

    async openTerminal(
        connectionId: string,
        cols: number,
        rows: number,
        terminalId: string = crypto.randomUUID(),
    ): Promise<string> {
        const response = await this.sendRequest(
            "terminal.open",
            {
                terminalId,
                connectionId,
                cols,
                rows,
            },
        );

        if (response.type !== "terminal.opened") {
            throw new Error(
                `Expected terminal.opened but received ${response.type}.`,
            );
        }

        return terminalId;
    }

    async writeTerminal(
        terminalId: string,
        data: string,
    ): Promise<void> {
        await this.sendNotification(
            "terminal.input",
            {
                terminalId,
                data,
            },
        );
    }

    async resizeTerminal(
        terminalId: string,
        cols: number,
        rows: number,
    ): Promise<void> {
        await this.sendNotification(
            "terminal.resize",
            {
                terminalId,
                cols,
                rows,
            },
        );
    }

    async closeTerminal(
        terminalId: string,
    ): Promise<void> {
        const response = await this.sendRequest(
            "terminal.close",
            {
                terminalId,
            },
        );

        if (
            response.type !== "terminal.closeAccepted"
        ) {
            throw new Error(
                `Unexpected response: ${response.type}`,
            );
        }
    }

    subscribeToState(listener: StateListener): () => void {
        this.stateListeners.add(listener);
        listener(this.currentState);

        return () => {
            this.stateListeners.delete(listener);
        };
    }

    subscribeToEvents(listener: EventListener): () => void {
        this.eventListeners.add(listener);

        return () => {
            this.eventListeners.delete(listener);
        };
    }

    subscribeToLogs(listener: LogListener): () => void {
        this.logListeners.add(listener);

        return () => {
            this.logListeners.delete(listener);
        };
    }

    async start(): Promise<void> {
        if (this.child) {
            return;
        }

        this.updateState({
            status: "starting",
            message: "Starting backend sidecar...",
        });

        const command = Command.sidecar("binaries/ssh-sidecar");

        command.stdout.on("data", (line) => {
            this.handleStdout(line);
        });

        command.stderr.on("data", (line) => {
            this.emitLog(line);
        });

        command.on("close", ({ code, signal }) => {
            this.emitLog(
                `Sidecar closed. Code: ${String(code)}, signal: ${String(signal)}`,
            );

            const error = new Error("Backend sidecar stopped.");

            this.rejectReady(error);
            this.rejectAllPending(error);

            this.child = null;

            this.updateState({
                status: "stopped",
                message: "Backend stopped.",
            });
        });

        command.on("error", (error) => {
            const backendError = new Error(String(error));

            this.emitLog(`Sidecar error: ${backendError.message}`);
            this.rejectReady(backendError);
            this.rejectAllPending(backendError);

            this.child = null;

            this.updateState({
                status: "error",
                message: backendError.message,
            });
        });

        const readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;

            this.readyTimeoutId = setTimeout(() => {
                const timeoutError = new Error(
                    "The backend did not become ready within 10 seconds.",
                );

                this.rejectReady(timeoutError);
            }, 10_000);
        });

        try {
            this.child = await command.spawn();
            this.emitLog(`Sidecar process started with PID ${this.child.pid}.`);

            await readyPromise;
        } catch (error) {
            this.child = null;

            const backendError =
                error instanceof Error ? error : new Error(String(error));

            this.updateState({
                status: "error",
                message: backendError.message,
            });

            throw backendError;
        }
    }

    async stop(): Promise<void> {
        if (!this.child) {
            return;
        }

        const activeChild = this.child;
        this.child = null;

        this.rejectAllPending(
            new Error("Backend stopped before the request completed."),
        );

        await activeChild.kill();

        this.updateState({
            status: "stopped",
            message: "Backend stopped.",
        });
    }

    async ping(): Promise<PingResponse> {
        const sentAt = Date.now();

        const response = await this.sendRequest("system.ping", {
            sentAt,
        });

        if (response.type !== "system.pong") {
            throw new Error(
                `Expected system.pong but received ${response.type}.`,
            );
        }

        return response.payload as PingResponse;
    }

    async listRemoteDirectory(
        connectionId: string,
        path?: string,
    ): Promise<RemoteDirectoryListing> {
        const response = await this.sendRequest(
            "sftp.list",
            {
                connectionId,
                ...(path ? { path } : {}),
            },
        );

        if (response.type !== "sftp.directory") {
            throw new Error(
                `Expected sftp.directory but received ${response.type}.`,
            );
        }

        return response.payload as RemoteDirectoryListing;
    }

    async statRemotePath(
        connectionId: string,
        remotePath: string,
    ): Promise<RemoteFileEntry> {
        const response =
            await this.sendRequest(
                "sftp.stat",
                {
                    connectionId,
                    remotePath,
                },
            );

        if (
            response.type !==
            "sftp.entry"
        ) {
            throw new Error(
                `Expected sftp.entry but received ${response.type}.`,
            );
        }

        return response.payload as
            RemoteFileEntry;
    }

    async renameRemotePath(
        connectionId: string,
        sourcePath: string,
        destinationPath: string,
    ): Promise<void> {
        const response =
            await this.sendRequest(
                "sftp.rename",
                {
                    connectionId,
                    sourcePath,
                    destinationPath,
                },
            );

        if (
            response.type !==
            "sftp.renameCompleted"
        ) {
            throw new Error(
                `Expected sftp.renameCompleted but received ${response.type}.`,
            );
        }
    }

    async deleteRemoteFile(
        connectionId: string,
        remotePath: string,
    ): Promise<void> {
        const response =
            await this.sendRequest(
                "sftp.deleteFile",
                {
                    connectionId,
                    remotePath,
                },
            );

        if (
            response.type !==
            "sftp.deleteFileCompleted"
        ) {
            throw new Error(
                `Expected sftp.deleteFileCompleted but received ${response.type}.`,
            );
        }
    }

    async createRemoteDirectory(
        connectionId: string,
        remotePath: string,
    ): Promise<void> {
        const response =
            await this.sendRequest(
                "sftp.createDirectory",
                {
                    connectionId,
                    remotePath,
                },
            );

        if (
            response.type !==
            "sftp.createDirectoryCompleted"
        ) {
            throw new Error(
                `Expected sftp.createDirectoryCompleted but received ${response.type}.`,
            );
        }
    }

    async deleteRemoteDirectory(
        connectionId: string,
        remotePath: string,
    ): Promise<void> {
        const response =
            await this.sendRequest(
                "sftp.deleteDirectory",
                {
                    connectionId,
                    remotePath,
                },
            );

        if (
            response.type !==
            "sftp.deleteDirectoryCompleted"
        ) {
            throw new Error(
                `Expected sftp.deleteDirectoryCompleted but received ${response.type}.`,
            );
        }
    }

    async readRemoteTextFile(
        connectionId: string,
        remotePath: string,
    ): Promise<RemoteTextFileSnapshot> {
        const response =
            await this.sendRequest(
                "sftp.readTextFile",
                {
                    connectionId,
                    remotePath,
                },
                30_000,
            );

        if (
            response.type !==
            "sftp.textFile"
        ) {
            throw new Error(
                `Expected sftp.textFile but received ${response.type}.`,
            );
        }

        return response.payload as
            RemoteTextFileSnapshot;
    }

    async readRemoteImageFile(
        connectionId: string,
        remotePath: string,
    ): Promise<RemoteImageSnapshot> {
        const response =
            await this.sendRequest(
                "sftp.readImageFile",
                {
                    connectionId,
                    remotePath,
                },
                45_000,
            );

        if (
            response.type !==
            "sftp.imageFile"
        ) {
            throw new Error(
                `Expected sftp.imageFile but received ${response.type}.`,
            );
        }

        return response.payload as
            RemoteImageSnapshot;
    }

    async saveRemoteTextFile(
        options:
            SaveRemoteTextFileOptions,
    ): Promise<RemoteTextFileSnapshot> {
        const response =
            await this.sendRequest(
                "sftp.saveTextFile",
                {
                    connectionId:
                        options.connectionId,

                    remotePath:
                        options.remotePath,

                    contentBase64:
                        options.contentBase64,

                    expectedRevision:
                        options.expectedRevision,

                    force:
                        options.force ??
                        false,
                },
                45_000,
            );

        if (
            response.type !==
            "sftp.textFileSaved"
        ) {
            throw new Error(
                `Expected sftp.textFileSaved but received ${response.type}.`,
            );
        }

        return response.payload as
            RemoteTextFileSnapshot;
    }

    async connectSsh(
        config: SshConnectionConfig,
    ): Promise<string> {
        const connectionId = crypto.randomUUID();

        const response = await this.sendRequest(
            "connection.open",
            {
                connectionId,
                ...config,
            },
        );

        if (response.type !== "connection.opened") {
            throw new Error(
                `Expected connection.opened but received ${response.type}.`,
            );
        }

        return connectionId;
    }

    async uploadLocalFile(
        connectionId: string,
        localPath: string,
        remotePath: string,
        overwrite: boolean,
    ): Promise<string> {
        const transferId = crypto.randomUUID();

        const response = await this.sendRequest(
            "transfer.upload",
            {
                transferId,
                connectionId,
                localPath,
                remotePath,
                overwrite,
            },
        );

        if (
            response.type !== "transfer.accepted"
        ) {
            throw new Error(
                `Expected transfer.accepted but received ${response.type}.`,
            );
        }

        return transferId;
    }

    async downloadRemoteFile(
        connectionId: string,
        remotePath: string,
        localPath: string,
    ): Promise<string> {
        const transferId = crypto.randomUUID();

        const response = await this.sendRequest(
            "transfer.download",
            {
                transferId,
                connectionId,
                remotePath,
                localPath,
            },
        );

        if (
            response.type !== "transfer.accepted"
        ) {
            throw new Error(
                `Expected transfer.accepted but received ${response.type}.`,
            );
        }

        return transferId;
    }

    async cancelTransfer(
        transferId: string,
    ): Promise<void> {
        const response = await this.sendRequest(
            "transfer.cancel",
            {
                transferId,
            },
        );

        if (
            response.type !==
            "transfer.cancelAccepted"
        ) {
            throw new Error(
                `Unexpected response: ${response.type}`,
            );
        }
    }

    async decideHostKey(
        connectionId: string,
        accepted: boolean,
    ): Promise<void> {
        const response = await this.sendRequest(
            "connection.hostKeyDecision",
            {
                connectionId,
                accepted,
            },
        );

        if (
            response.type !==
            "connection.hostKeyDecisionRecorded"
        ) {
            throw new Error(
                `Unexpected response: ${response.type}`,
            );
        }
    }

    async disconnectSsh(
        connectionId: string,
    ): Promise<void> {
        const response = await this.sendRequest(
            "connection.close",
            {
                connectionId,
            },
        );

        if (
            response.type !== "connection.closeAccepted"
        ) {
            throw new Error(
                `Unexpected response: ${response.type}`,
            );
        }
    }

    private async sendNotification(
        type: string,
        payload?: unknown,
    ): Promise<void> {
        if (!this.child) {
            throw new Error("Backend is not running.");
        }

        const message: BackendMessage = {
            type,
            payload,
        };

        await this.child.write(
            `${JSON.stringify(message)}\n`,
        );
    }

    private async sendRequest(
        type: string,
        payload?: unknown,
        timeoutMs: number = 10_000,
    ): Promise<BackendMessage> {
        if (!this.child) {
            throw new Error("Backend is not running.");
        }

        const id = crypto.randomUUID();

        const request: BackendMessage = {
            id,
            type,
            payload,
        };

        return new Promise<BackendMessage>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Backend request timed out: ${type}`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve,
                reject,
                timeoutId,
            });

            this.child
                ?.write(`${JSON.stringify(request)}\n`)
                .catch((error: unknown) => {
                    clearTimeout(timeoutId);
                    this.pendingRequests.delete(id);

                    reject(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    );
                });
        });
    }

    private handleStdout(line: string): void {
        const trimmedLine = line.trim();

        if (!trimmedLine) {
            return;
        }

        let message: BackendMessage;

        try {
            message = JSON.parse(trimmedLine) as BackendMessage;
        } catch {
            this.emitLog(`Invalid backend JSON: ${trimmedLine}`);
            return;
        }

        if (message.type === "sidecar.ready") {
            this.updateState({
                status: "connected",
                message: "Backend connected.",
            });

            this.resolveReady();
        }

        if (message.id) {
            const pendingRequest = this.pendingRequests.get(message.id);

            if (pendingRequest) {
                clearTimeout(pendingRequest.timeoutId);
                this.pendingRequests.delete(message.id);

                if (message.type === "system.error") {
                    const payload =
                        message.payload as
                        | {
                            code?: string;
                            message?: string;
                            details?: unknown;
                        }
                        | undefined;

                    pendingRequest.reject(
                        new BackendRequestError(
                            payload?.code ??
                            "BACKEND_REQUEST_FAILED",

                            payload?.message ??
                            "Backend request failed.",

                            payload?.details,
                        ),
                    );
                } else {
                    pendingRequest.resolve(message);
                }
            }
        }

        for (const listener of this.eventListeners) {
            listener(message);
        }
    }

    private resolveReady(): void {
        if (this.readyTimeoutId) {
            clearTimeout(this.readyTimeoutId);
        }

        this.readyTimeoutId = null;
        this.readyReject = null;

        this.readyResolve?.();
        this.readyResolve = null;
    }

    private rejectReady(error: Error): void {
        if (this.readyTimeoutId) {
            clearTimeout(this.readyTimeoutId);
        }

        this.readyTimeoutId = null;
        this.readyResolve = null;

        this.readyReject?.(error);
        this.readyReject = null;
    }

    private rejectAllPending(error: Error): void {
        for (const pendingRequest of this.pendingRequests.values()) {
            clearTimeout(pendingRequest.timeoutId);
            pendingRequest.reject(error);
        }

        this.pendingRequests.clear();
    }

    private updateState(state: BackendState): void {
        this.currentState = state;

        for (const listener of this.stateListeners) {
            listener(state);
        }
    }

    private emitLog(message: string): void {
        for (const listener of this.logListeners) {
            listener(message);
        }
    }
}

export const backendClient = new BackendClient();
