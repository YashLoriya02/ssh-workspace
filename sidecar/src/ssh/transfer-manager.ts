import {
    createReadStream,
    createWriteStream,
} from "node:fs";

import {
    rename as renameLocal,
    rm,
    stat as statLocal,
} from "node:fs/promises";

import path from "node:path";

import {
    Transform,
    type Readable,
    type Writable,
} from "node:stream";

import { pipeline } from "node:stream/promises";

import type {
    SFTPWrapper,
    Stats,
} from "ssh2";

import type { SftpManager } from "./sftp-manager";

interface BackendEvent {
    type: string;
    payload?: unknown;
}

type SendEvent = (event: BackendEvent) => void;

export type TransferDirection =
    | "download"
    | "upload";

export type TransferStatus =
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

export interface TransferSnapshot {
    transferId: string;
    connectionId: string;

    direction: TransferDirection;

    name: string;
    remotePath: string;
    localPath: string;

    transferredBytes: number;
    totalBytes: number;

    status: TransferStatus;
}

export interface StartDownloadOptions {
    transferId: string;
    connectionId: string;
    remotePath: string;
    localPath: string;
}

export interface StartUploadOptions {
    transferId: string;
    connectionId: string;
    localPath: string;
    remotePath: string;
    overwrite: boolean;
}

interface ManagedTransfer {
    transferId: string;
    connectionId: string;

    direction: TransferDirection;

    name: string;
    remotePath: string;
    localPath: string;

    temporaryPath: string;

    transferredBytes: number;
    totalBytes: number;

    source: Readable;
    destination: Writable;

    cancelRequested: boolean;
    lastProgressEventAt: number;
}

export class TransferManager {
    private readonly transfers = new Map<
        string,
        ManagedTransfer
    >();

    constructor(
        private readonly sftpManager: SftpManager,
        private readonly sendEvent: SendEvent,
    ) { }

    async startDownload(
        options: StartDownloadOptions,
    ): Promise<TransferSnapshot> {
        this.ensureTransferDoesNotExist(
            options.transferId,
        );

        const sftp =
            await this.sftpManager.getSession(
                options.connectionId,
            );

        const remoteStats = await this.statRemote(
            sftp,
            options.remotePath,
        );

        if (this.isDirectory(remoteStats.mode)) {
            throw new Error(
                "Directory downloads are not supported yet.",
            );
        }

        const temporaryPath =
            `${options.localPath}.ssh-workspace-` +
            `${options.transferId}.part`;

        await rm(temporaryPath, {
            force: true,
        });

        const source = sftp.createReadStream(
            options.remotePath,
            {
                flags: "r",
                autoClose: true,
            },
        );

        const destination = createWriteStream(
            temporaryPath,
            {
                flags: "w",
            },
        );

        const transfer: ManagedTransfer = {
            transferId: options.transferId,
            connectionId: options.connectionId,

            direction: "download",

            name: path.posix.basename(
                options.remotePath,
            ),

            remotePath: options.remotePath,
            localPath: options.localPath,
            temporaryPath,

            transferredBytes: 0,
            totalBytes: remoteStats.size ?? 0,

            source,
            destination,

            cancelRequested: false,
            lastProgressEventAt: 0,
        };

        this.registerTransfer(transfer);

        void this.runTransfer(
            transfer,

            async () => {
                await rm(options.localPath, {
                    force: true,
                });

                await renameLocal(
                    temporaryPath,
                    options.localPath,
                );
            },

            async () => {
                await rm(temporaryPath, {
                    force: true,
                });
            },
        );

        return this.createSnapshot(
            transfer,
            "running",
        );
    }

    async startUpload(
        options: StartUploadOptions,
    ): Promise<TransferSnapshot> {
        this.ensureTransferDoesNotExist(
            options.transferId,
        );

        const localStats = await statLocal(
            options.localPath,
        );

        if (!localStats.isFile()) {
            throw new Error(
                "Only individual files can be uploaded currently.",
            );
        }

        const sftp =
            await this.sftpManager.getSession(
                options.connectionId,
            );

        const existingRemoteStats =
            await this.tryStatRemote(
                sftp,
                options.remotePath,
            );

        if (
            existingRemoteStats &&
            this.isDirectory(existingRemoteStats.mode)
        ) {
            throw new Error(
                "A directory already exists with the same name.",
            );
        }

        if (
            existingRemoteStats &&
            !options.overwrite
        ) {
            throw new Error(
                "A remote file already exists with the same name.",
            );
        }

        const remoteDirectory =
            path.posix.dirname(options.remotePath);

        const remoteFilename =
            path.posix.basename(options.remotePath);

        const temporaryPath = path.posix.join(
            remoteDirectory,
            `.${remoteFilename}.ssh-workspace-${options.transferId}.part`,
        );

        await this.unlinkRemoteIfExists(
            sftp,
            temporaryPath,
        );

        const source = createReadStream(
            options.localPath,
        );

        const destination = sftp.createWriteStream(
            temporaryPath,
            {
                flags: "w",
                mode: 0o644,
                autoClose: true,
            },
        );

        const transfer: ManagedTransfer = {
            transferId: options.transferId,
            connectionId: options.connectionId,

            direction: "upload",

            name: path.basename(options.localPath),

            remotePath: options.remotePath,
            localPath: options.localPath,
            temporaryPath,

            transferredBytes: 0,
            totalBytes: localStats.size,

            source,
            destination,

            cancelRequested: false,
            lastProgressEventAt: 0,
        };

        this.registerTransfer(transfer);

        void this.runTransfer(
            transfer,

            async () => {
                await this.commitUploadedFile(
                    sftp,
                    transfer,
                    options.overwrite,
                );
            },

            async () => {
                await this.unlinkRemoteIfExists(
                    sftp,
                    temporaryPath,
                );
            },
        );

        return this.createSnapshot(
            transfer,
            "running",
        );
    }

    cancel(transferId: string): boolean {
        const transfer =
            this.transfers.get(transferId);

        if (!transfer) {
            return false;
        }

        transfer.cancelRequested = true;

        const cancellationError = new Error(
            "Transfer cancelled by the user.",
        );

        transfer.source.destroy(
            cancellationError,
        );

        transfer.destination.destroy(
            cancellationError,
        );

        return true;
    }

    cancelForConnection(
        connectionId: string,
    ): void {
        for (
            const transfer of
            this.transfers.values()
        ) {
            if (
                transfer.connectionId === connectionId
            ) {
                this.cancel(transfer.transferId);
            }
        }
    }

    cancelAll(): void {
        for (
            const transfer of
            this.transfers.values()
        ) {
            this.cancel(transfer.transferId);
        }
    }

    private registerTransfer(
        transfer: ManagedTransfer,
    ): void {
        this.transfers.set(
            transfer.transferId,
            transfer,
        );

        this.sendEvent({
            type: "transfer.started",
            payload: this.createSnapshot(
                transfer,
                "running",
            ),
        });
    }

    private async runTransfer(
        transfer: ManagedTransfer,
        commit: () => Promise<void>,
        cleanupPartialFile: () => Promise<void>,
    ): Promise<void> {
        const progressStream = new Transform({
            transform: (
                chunk: Buffer | Uint8Array | string,
                _encoding,
                callback,
            ) => {
                const chunkSize =
                    typeof chunk === "string"
                        ? Buffer.byteLength(chunk)
                        : chunk.length;

                transfer.transferredBytes += chunkSize;

                this.emitProgressWhenNeeded(
                    transfer,
                );

                callback(null, chunk);
            },
        });

        try {
            await pipeline(
                transfer.source,
                progressStream,
                transfer.destination,
            );

            if (transfer.cancelRequested) {
                throw new Error(
                    "Transfer cancelled by the user.",
                );
            }

            await commit();

            transfer.transferredBytes = Math.max(
                transfer.transferredBytes,
                transfer.totalBytes,
            );

            this.sendEvent({
                type: "transfer.completed",
                payload: this.createSnapshot(
                    transfer,
                    "completed",
                ),
            });
        } catch (error) {
            await cleanupPartialFile().catch(
                () => {
                    // Avoid hiding the original transfer error
                    // if temporary-file cleanup also fails.
                },
            );

            if (transfer.cancelRequested) {
                this.sendEvent({
                    type: "transfer.cancelled",
                    payload: this.createSnapshot(
                        transfer,
                        "cancelled",
                    ),
                });
            } else {
                this.sendEvent({
                    type: "transfer.failed",
                    payload: {
                        ...this.createSnapshot(
                            transfer,
                            "failed",
                        ),

                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
        } finally {
            this.transfers.delete(
                transfer.transferId,
            );
        }
    }

    private async commitUploadedFile(
        sftp: SFTPWrapper,
        transfer: ManagedTransfer,
        overwrite: boolean,
    ): Promise<void> {
        const existingStats =
            await this.tryStatRemote(
                sftp,
                transfer.remotePath,
            );

        if (!existingStats) {
            await this.renameRemote(
                sftp,
                transfer.temporaryPath,
                transfer.remotePath,
            );

            return;
        }

        if (this.isDirectory(existingStats.mode)) {
            throw new Error(
                "Cannot replace a remote directory with a file.",
            );
        }

        if (!overwrite) {
            throw new Error(
                "The remote file was created by another process while uploading.",
            );
        }

        const backupPath =
            `${transfer.remotePath}.ssh-workspace-` +
            `${transfer.transferId}.backup`;

        await this.unlinkRemoteIfExists(
            sftp,
            backupPath,
        );

        await this.renameRemote(
            sftp,
            transfer.remotePath,
            backupPath,
        );

        try {
            await this.renameRemote(
                sftp,
                transfer.temporaryPath,
                transfer.remotePath,
            );

            await this.unlinkRemoteIfExists(
                sftp,
                backupPath,
            );
        } catch (error) {
            await this.renameRemote(
                sftp,
                backupPath,
                transfer.remotePath,
            ).catch(() => {
                // Best-effort restoration.
            });

            throw error;
        }
    }

    private ensureTransferDoesNotExist(
        transferId: string,
    ): void {
        if (this.transfers.has(transferId)) {
            throw new Error(
                `Transfer already exists: ${transferId}`,
            );
        }
    }

    private emitProgressWhenNeeded(
        transfer: ManagedTransfer,
    ): void {
        const now = Date.now();

        const completed =
            transfer.totalBytes > 0 &&
            transfer.transferredBytes >=
            transfer.totalBytes;

        if (
            !completed &&
            now - transfer.lastProgressEventAt < 100
        ) {
            return;
        }

        transfer.lastProgressEventAt = now;

        this.sendEvent({
            type: "transfer.progress",
            payload: this.createSnapshot(
                transfer,
                "running",
            ),
        });
    }

    private createSnapshot(
        transfer: ManagedTransfer,
        status: TransferStatus,
    ): TransferSnapshot {
        return {
            transferId: transfer.transferId,
            connectionId: transfer.connectionId,

            direction: transfer.direction,

            name: transfer.name,
            remotePath: transfer.remotePath,
            localPath: transfer.localPath,

            transferredBytes:
                transfer.transferredBytes,

            totalBytes: transfer.totalBytes,

            status,
        };
    }

    private statRemote(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<Stats> {
        return new Promise((resolve, reject) => {
            sftp.stat(
                remotePath,
                (error, attributes) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(attributes);
                },
            );
        });
    }

    private async tryStatRemote(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<Stats | null> {
        try {
            return await this.statRemote(
                sftp,
                remotePath,
            );
        } catch (error) {
            const code = (
                error as {
                    code?: number | string;
                }
            ).code;

            if (
                code === 2 ||
                code === "ENOENT"
            ) {
                return null;
            }

            throw error;
        }
    }

    private renameRemote(
        sftp: SFTPWrapper,
        sourcePath: string,
        destinationPath: string,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            sftp.rename(
                sourcePath,
                destinationPath,
                (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                },
            );
        });
    }

    private unlinkRemoteIfExists(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            sftp.unlink(remotePath, (error) => {
                if (!error) {
                    resolve();
                    return;
                }

                const code = (
                    error as {
                        code?: number | string;
                    }
                ).code;

                if (
                    code === 2 ||
                    code === "ENOENT"
                ) {
                    resolve();
                    return;
                }

                reject(error);
            });
        });
    }

    private isDirectory(
        mode: number | undefined,
    ): boolean {
        if (mode === undefined) {
            return false;
        }

        return (
            (mode & 0o170000) === 0o040000
        );
    }
}
