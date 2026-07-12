import { createHash } from "node:crypto";
import {
    Client,
    utils,
    type ConnectConfig,
} from "ssh2";

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

export interface OpenConnectionOptions {
    host: string;
    port: number;
    username: string;
    authentication: SshAuthentication;
    knownHostFingerprint?: string;
}

export interface BackendEvent {
    type: string;
    payload?: unknown;
}

type SendEvent = (event: BackendEvent) => void;

interface ManagedConnection {
    client: Client;
    host: string;
    port: number;
    username: string;
    connected: boolean;
    intentionalClose: boolean;
}

interface PendingHostApproval {
    callback: (accepted: boolean) => void;
    timeoutId: ReturnType<typeof setTimeout>;
}

export class ConnectionManager {
    private readonly connections = new Map<
        string,
        ManagedConnection
    >();

    private readonly pendingHostApprovals = new Map<
        string,
        PendingHostApproval
    >();

    constructor(private readonly sendEvent: SendEvent) { }

    async open(
        connectionId: string,
        options: OpenConnectionOptions,
    ): Promise<void> {
        if (this.connections.has(connectionId)) {
            throw new Error(
                `Connection already exists: ${connectionId}`,
            );
        }

        const client = new Client();

        const managedConnection: ManagedConnection = {
            client,
            host: options.host,
            port: options.port,
            username: options.username,
            connected: false,
            intentionalClose: false,
        };

        this.connections.set(connectionId, managedConnection);

        await new Promise<void>((resolve, reject) => {
            let openingSettled = false;
            let failureEventSent = false;

            const rejectOpening = (error: Error): void => {
                if (openingSettled) {
                    return;
                }

                openingSettled = true;
                reject(error);
            };

            const emitOpeningFailure = (error: Error): void => {
                if (failureEventSent) {
                    return;
                }

                failureEventSent = true;

                this.sendEvent({
                    type: "connection.failed",
                    payload: {
                        connectionId,
                        host: options.host,
                        port: options.port,
                        message: error.message,
                    },
                });
            };

            client.on("banner", (message) => {
                this.sendEvent({
                    type: "connection.banner",
                    payload: {
                        connectionId,
                        message,
                    },
                });
            });

            client.on("ready", () => {
                managedConnection.connected = true;
                openingSettled = true;

                this.sendEvent({
                    type: "connection.connected",
                    payload: {
                        connectionId,
                        host: options.host,
                        port: options.port,
                        username: options.username,
                    },
                });

                resolve();
            });

            client.on("error", (error) => {
                if (!managedConnection.connected) {
                    emitOpeningFailure(error);
                    rejectOpening(error);
                    return;
                }

                this.sendEvent({
                    type: "connection.error",
                    payload: {
                        connectionId,
                        message: error.message,
                    },
                });
            });

            client.on("close", () => {
                this.cancelPendingHostApproval(connectionId);

                this.connections.delete(connectionId);

                if (!managedConnection.connected) {
                    const error = new Error(
                        "SSH connection closed before authentication completed.",
                    );

                    emitOpeningFailure(error);
                    rejectOpening(error);
                    return;
                }

                this.sendEvent({
                    type: "connection.disconnected",
                    payload: {
                        connectionId,
                        reason: managedConnection.intentionalClose
                            ? "user"
                            : "remote",
                    },
                });
            });

            const connectConfig: ConnectConfig = {
                host: options.host,
                port: options.port,
                username: options.username,

                readyTimeout: 20_000,

                keepaliveInterval: 10_000,
                keepaliveCountMax: 3,

                hostVerifier: (key: any, callback: any) => {
                    if (!callback) {
                        return false;
                    }

                    const rawKey = Buffer.isBuffer(key)
                        ? key
                        : Buffer.from(key, "hex");

                    const fingerprint =
                        this.createFingerprint(rawKey);

                    const keyType =
                        this.getKeyType(rawKey);

                    const expectedFingerprint =
                        options.knownHostFingerprint;

                    /*
                     * The host has previously been trusted.
                     * Only accept it when the new fingerprint
                     * exactly matches the stored fingerprint.
                     */
                    if (expectedFingerprint) {
                        if (
                            fingerprint ===
                            expectedFingerprint
                        ) {
                            this.sendEvent({
                                type: "connection.hostKeyVerified",
                                payload: {
                                    connectionId,

                                    host: options.host,
                                    port: options.port,

                                    keyType,
                                    fingerprint,
                                },
                            });

                            callback(true);
                            return;
                        }

                        this.sendEvent({
                            type: "connection.hostKeyMismatch",
                            payload: {
                                connectionId,

                                host: options.host,
                                port: options.port,

                                keyType,

                                expectedFingerprint,
                                receivedFingerprint:
                                    fingerprint,
                            },
                        });

                        callback(false);
                        return;
                    }

                    /*
                     * First connection to this host.
                     * Ask the user to approve the key.
                     */
                    this.requestHostApproval(
                        connectionId,
                        options,
                        rawKey,
                        callback,
                    );
                },
            };

            if (options.authentication.type === "password") {
                connectConfig.password =
                    options.authentication.password;
            } else {
                connectConfig.privateKey =
                    options.authentication.privateKey;

                if (options.authentication.passphrase) {
                    connectConfig.passphrase =
                        options.authentication.passphrase;
                }
            }

            try {
                client.connect(connectConfig);
            } catch (error) {
                this.connections.delete(connectionId);

                const connectionError =
                    error instanceof Error
                        ? error
                        : new Error(String(error));

                emitOpeningFailure(connectionError);
                rejectOpening(connectionError);
            }
        });
    }

    approveHostKey(
        connectionId: string,
        accepted: boolean,
    ): void {
        const pendingApproval =
            this.pendingHostApprovals.get(connectionId);

        if (!pendingApproval) {
            throw new Error(
                "There is no pending host-key approval for this connection.",
            );
        }

        clearTimeout(pendingApproval.timeoutId);
        this.pendingHostApprovals.delete(connectionId);

        pendingApproval.callback(accepted);
    }

    getConnectedClient(connectionId: string): Client {
        const connection = this.connections.get(connectionId);

        if (!connection) {
            throw new Error(
                `SSH connection was not found: ${connectionId}`,
            );
        }

        if (!connection.connected) {
            throw new Error(
                `SSH connection is not ready: ${connectionId}`,
            );
        }

        return connection.client;
    }

    close(connectionId: string): boolean {
        const connection = this.connections.get(connectionId);

        if (!connection) {
            return false;
        }

        connection.intentionalClose = true;

        this.cancelPendingHostApproval(connectionId);
        connection.client.end();

        return true;
    }

    closeAll(): void {
        for (const [
            connectionId,
            connection,
        ] of this.connections.entries()) {
            connection.intentionalClose = true;

            this.cancelPendingHostApproval(connectionId);
            connection.client.end();
        }
    }

    private requestHostApproval(
        connectionId: string,
        options: OpenConnectionOptions,
        rawKey: Buffer,
        callback: (accepted: boolean) => void,
    ): void {
        this.cancelPendingHostApproval(connectionId);

        const fingerprint = this.createFingerprint(rawKey);
        const keyType = this.getKeyType(rawKey);

        const timeoutId = setTimeout(() => {
            this.pendingHostApprovals.delete(connectionId);

            callback(false);

            this.sendEvent({
                type: "connection.hostKeyApprovalExpired",
                payload: {
                    connectionId,
                },
            });
        }, 30_000);

        this.pendingHostApprovals.set(connectionId, {
            callback,
            timeoutId,
        });

        this.sendEvent({
            type: "connection.hostKeyApprovalRequired",
            payload: {
                connectionId,
                host: options.host,
                port: options.port,
                keyType,
                fingerprint,
            },
        });
    }

    private cancelPendingHostApproval(
        connectionId: string,
    ): void {
        const pendingApproval =
            this.pendingHostApprovals.get(connectionId);

        if (!pendingApproval) {
            return;
        }

        clearTimeout(pendingApproval.timeoutId);
        this.pendingHostApprovals.delete(connectionId);

        pendingApproval.callback(false);
    }

    private createFingerprint(rawKey: Buffer): string {
        const fingerprint = createHash("sha256")
            .update(rawKey)
            .digest("base64")
            .replace(/=+$/u, "");

        return `SHA256:${fingerprint}`;
    }

    private getKeyType(rawKey: Buffer): string {
        try {
            const parsedKey = utils.parseKey(rawKey);

            if (parsedKey instanceof Error) {
                return "unknown";
            }

            const firstKey = Array.isArray(parsedKey)
                ? parsedKey[0]
                : parsedKey;

            return firstKey?.type ?? "unknown";
        } catch {
            return "unknown";
        }
    }
}