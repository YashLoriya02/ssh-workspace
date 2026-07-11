import path from "node:path";

import type { SFTPWrapper } from "ssh2";

import type { ConnectionManager } from "./connection-manager";

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

export class SftpManager {
    private readonly sessions = new Map<
        string,
        Promise<SFTPWrapper>
    >();

    constructor(
        private readonly connectionManager: ConnectionManager,
    ) { }

    async listDirectory(
        connectionId: string,
        requestedPath?: string,
    ): Promise<RemoteDirectoryListing> {
        try {
            const sftp = await this.getSession(connectionId);

            const remotePath =
                requestedPath?.trim().length
                    ? requestedPath.trim()
                    : ".";

            const resolvedPath = await this.realpath(
                sftp,
                remotePath,
            );

            const rawEntries = await this.readdir(
                sftp,
                resolvedPath,
            );

            const entries = rawEntries
                .filter(
                    (entry) =>
                        entry.filename !== "." &&
                        entry.filename !== "..",
                )
                .map((entry): RemoteFileEntry => {
                    const mode =
                        typeof entry.attrs.mode === "number"
                            ? entry.attrs.mode
                            : undefined;

                    return {
                        name: entry.filename,

                        path: path.posix.join(
                            resolvedPath,
                            entry.filename,
                        ),

                        type: this.getFileType(mode),

                        size:
                            typeof entry.attrs.size === "number"
                                ? entry.attrs.size
                                : 0,

                        modifiedAt:
                            typeof entry.attrs.mtime === "number"
                                ? entry.attrs.mtime
                                : null,

                        permissions:
                            this.formatPermissions(mode),

                        uid:
                            typeof entry.attrs.uid === "number"
                                ? entry.attrs.uid
                                : null,

                        gid:
                            typeof entry.attrs.gid === "number"
                                ? entry.attrs.gid
                                : null,
                    };
                })
                .sort((first, second) => {
                    if (
                        first.type === "directory" &&
                        second.type !== "directory"
                    ) {
                        return -1;
                    }

                    if (
                        first.type !== "directory" &&
                        second.type === "directory"
                    ) {
                        return 1;
                    }

                    return first.name.localeCompare(
                        second.name,
                        undefined,
                        {
                            numeric: true,
                            sensitivity: "base",
                        },
                    );
                });

            return {
                path: resolvedPath,

                parentPath:
                    resolvedPath === "/"
                        ? null
                        : path.posix.dirname(resolvedPath),

                entries,
            };
        } catch (error) {
            // Remove a potentially broken session so the next
            // request can create a fresh SFTP channel.
            this.closeForConnection(connectionId);

            throw error;
        }
    }

    closeForConnection(connectionId: string): void {
        const sessionPromise =
            this.sessions.get(connectionId);

        if (!sessionPromise) {
            return;
        }

        this.sessions.delete(connectionId);

        void sessionPromise
            .then((session) => {
                const closeableSession = session as SFTPWrapper & {
                    end?: () => void;
                    destroy?: () => void;
                };

                if (
                    typeof closeableSession.end === "function"
                ) {
                    closeableSession.end();
                    return;
                }

                closeableSession.destroy?.();
            })
            .catch(() => {
                // The session may have failed while opening.
            });
    }

    closeAll(): void {
        for (const connectionId of [
            ...this.sessions.keys(),
        ]) {
            this.closeForConnection(connectionId);
        }
    }

    async getSession(
        connectionId: string,
    ): Promise<SFTPWrapper> {
        const existingSession =
            this.sessions.get(connectionId);

        if (existingSession) {
            return existingSession;
        }

        const client =
            this.connectionManager.getConnectedClient(
                connectionId,
            );

        const sessionPromise =
            new Promise<SFTPWrapper>((resolve, reject) => {
                client.sftp((error, sftp) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(sftp);
                });
            });

        this.sessions.set(
            connectionId,
            sessionPromise,
        );

        try {
            return await sessionPromise;
        } catch (error) {
            this.sessions.delete(connectionId);
            throw error;
        }
    }

    private realpath(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            sftp.realpath(
                remotePath,
                (error, absolutePath) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve(absolutePath);
                },
            );
        });
    }

    private readdir(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<
        Array<{
            filename: string;
            longname: string;
            attrs: {
                mode?: number;
                size?: number;
                mtime?: number;
                uid?: number;
                gid?: number;
            };
        }>
    > {
        return new Promise((resolve, reject) => {
            sftp.readdir(remotePath, (error, list) => {
                if (error) {
                    reject(error);
                    return;
                }

                if (!Array.isArray(list)) {
                    resolve([]);
                    return;
                }

                resolve(list);
            });
        });
    }

    private getFileType(
        mode: number | undefined,
    ): RemoteFileType {
        if (mode === undefined) {
            return "other";
        }

        const typeBits = mode & 0o170000;

        switch (typeBits) {
            case 0o040000:
                return "directory";

            case 0o100000:
                return "file";

            case 0o120000:
                return "symlink";

            default:
                return "other";
        }
    }

    private formatPermissions(
        mode: number | undefined,
    ): string | null {
        if (mode === undefined) {
            return null;
        }

        return (mode & 0o7777)
            .toString(8)
            .padStart(3, "0");
    }
}
