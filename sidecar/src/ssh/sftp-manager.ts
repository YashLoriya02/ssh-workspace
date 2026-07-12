import path from "node:path";

import {
    createHash,
    randomUUID,
} from "node:crypto";

import { TextDecoder } from "node:util";
import type { OpenMode, SFTPWrapper } from "ssh2";
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

export class SftpOperationError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly details?:
            Record<string, unknown>,
    ) {
        super(message);

        this.name =
            "SftpOperationError";
    }
}

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 15 * 1024 * 1024;

interface RemoteAttributes {
    mode?: number;
    size?: number;
    mtime?: number;
    uid?: number;
    gid?: number;
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

    async statPath(
        connectionId: string,
        requestedPath: string,
    ): Promise<RemoteFileEntry> {
        const sftp =
            await this.getSession(
                connectionId,
            );

        const remotePath =
            this.requireRemotePath(
                requestedPath,
                "remotePath",
            );

        const attributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const name =
            path.posix.basename(
                remotePath,
            ) || "/";

        const mode =
            typeof attributes.mode === "number"
                ? attributes.mode
                : undefined;

        return {
            name,
            path: remotePath,

            type:
                this.getFileType(
                    mode,
                ),

            size:
                typeof attributes.size === "number"
                    ? attributes.size
                    : 0,

            modifiedAt:
                typeof attributes.mtime === "number"
                    ? attributes.mtime
                    : null,

            permissions:
                this.formatPermissions(
                    mode,
                ),

            uid:
                typeof attributes.uid === "number"
                    ? attributes.uid
                    : null,

            gid:
                typeof attributes.gid === "number"
                    ? attributes.gid
                    : null,
        };
    }

    async renamePath(
        connectionId: string,
        sourcePathValue: string,
        destinationPathValue: string,
    ): Promise<void> {
        const sftp =
            await this.getSession(
                connectionId,
            );

        const sourcePath =
            this.requireMutableRemotePath(
                sourcePathValue,
                "sourcePath",
            );

        const destinationPath =
            this.requireMutableRemotePath(
                destinationPathValue,
                "destinationPath",
            );

        if (
            sourcePath === destinationPath
        ) {
            throw new Error(
                "The new remote path must be different from the current path.",
            );
        }

        await this.rename(
            sftp,
            sourcePath,
            destinationPath,
        );
    }

    async deleteFile(
        connectionId: string,
        requestedPath: string,
    ): Promise<void> {
        const remotePath =
            this.requireMutableRemotePath(
                requestedPath,
                "remotePath",
            );

        const details =
            await this.statPath(
                connectionId,
                remotePath,
            );

        if (
            details.type === "directory"
        ) {
            throw new Error(
                "The selected remote path is a directory. Use deleteDirectory instead.",
            );
        }

        const sftp =
            await this.getSession(
                connectionId,
            );

        await this.unlink(
            sftp,
            remotePath,
        );
    }

    async createDirectory(
        connectionId: string,
        requestedPath: string,
    ): Promise<void> {
        const remotePath =
            this.requireMutableRemotePath(
                requestedPath,
                "remotePath",
            );

        const sftp =
            await this.getSession(
                connectionId,
            );

        await this.mkdir(
            sftp,
            remotePath,
        );
    }

    async deleteDirectory(
        connectionId: string,
        requestedPath: string,
    ): Promise<void> {
        const remotePath =
            this.requireMutableRemotePath(
                requestedPath,
                "remotePath",
            );

        const details =
            await this.statPath(
                connectionId,
                remotePath,
            );

        if (
            details.type !== "directory"
        ) {
            throw new Error(
                "The selected remote path is not a directory.",
            );
        }

        const sftp =
            await this.getSession(
                connectionId,
            );

        /*
         * SFTP rmdir only removes an empty directory.
         * A non-empty folder should be rejected by the server.
         */
        await this.rmdir(
            sftp,
            remotePath,
        );
    }

    async saveTextFile(
        connectionId: string,
        requestedPath: string,
        contentBase64: string,
        expectedRevision: string,
        force: boolean,
    ): Promise<RemoteTextFileSnapshot> {
        const sftp =
            await this.getSession(
                connectionId,
            );

        const remotePath =
            this.requireMutableRemotePath(
                requestedPath,
                "remotePath",
            );

        if (
            !force &&
            expectedRevision.trim().length ===
            0
        ) {
            throw new SftpOperationError(
                "REMOTE_REVISION_REQUIRED",
                "A remote file revision is required before saving.",
                {
                    remotePath,
                },
            );
        }

        const content =
            this.decodeBase64Content(
                contentBase64,
            );

        this.assertEditableFileSize(
            content.length,
            remotePath,
        );

        this.assertEditableText(
            content,
            remotePath,
        );

        const currentSnapshot =
            await this.readTextFile(
                connectionId,
                remotePath,
            );

        this.assertExpectedRevision(
            currentSnapshot,
            expectedRevision,
            force,
        );

        const currentAttributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const originalMode =
            typeof currentAttributes.mode ===
                "number"
                ? currentAttributes.mode &
                0o7777
                : 0o600;

        const parentPath =
            path.posix.dirname(
                remotePath,
            );

        const fileName =
            path.posix.basename(
                remotePath,
            );

        const operationId =
            randomUUID();

        const temporaryPath =
            path.posix.join(
                parentPath,
                `.${fileName}.ssh-workspace-${operationId}.tmp`,
            );

        let temporaryFileExists =
            false;

        try {
            await this.writeFileBuffer(
                sftp,
                temporaryPath,
                content,
                originalMode,
            );

            temporaryFileExists =
                true;

            await this.chmod(
                sftp,
                temporaryPath,
                originalMode,
            );

            const temporaryAttributes =
                await this.lstat(
                    sftp,
                    temporaryPath,
                );

            if (
                temporaryAttributes.size !==
                content.length
            ) {
                throw new SftpOperationError(
                    "REMOTE_TEMP_FILE_INCOMPLETE",
                    "The temporary remote file was not written completely.",
                    {
                        remotePath,
                        temporaryPath,

                        expectedSize:
                            content.length,

                        actualSize:
                            temporaryAttributes.size ??
                            null,
                    },
                );
            }

            if (!force) {
                const latestSnapshot =
                    await this.readTextFile(
                        connectionId,
                        remotePath,
                    );

                this.assertExpectedRevision(
                    latestSnapshot,
                    expectedRevision,
                    false,
                );
            }

            await this.replaceRemoteFile(
                sftp,
                temporaryPath,
                remotePath,
            );

            temporaryFileExists =
                false;
        } catch (error) {
            if (temporaryFileExists) {
                await this.safeUnlink(
                    sftp,
                    temporaryPath,
                );
            }

            throw error;
        }

        return this.readTextFile(
            connectionId,
            remotePath,
        );
    }

    async readTextFile(
        connectionId: string,
        requestedPath: string,
    ): Promise<RemoteTextFileSnapshot> {
        const sftp =
            await this.getSession(
                connectionId,
            );

        const remotePath =
            this.requireRemotePath(
                requestedPath,
                "remotePath",
            );

        const initialAttributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const initialMode =
            typeof initialAttributes.mode ===
                "number"
                ? initialAttributes.mode
                : undefined;

        const type =
            this.getFileType(
                initialMode,
            );

        if (type !== "file") {
            throw new SftpOperationError(
                "REMOTE_FILE_NOT_EDITABLE",
                "Only regular remote files can be opened in the editor.",
                {
                    remotePath,
                    type,
                },
            );
        }

        this.assertEditableFileSize(
            initialAttributes.size,
            remotePath,
        );

        const content =
            await this.readFileBuffer(
                sftp,
                remotePath,
                MAX_EDITABLE_FILE_BYTES,
                "REMOTE_FILE_TOO_LARGE",
                "This remote file is too large to edit safely.",
            );

        this.assertEditableText(
            content,
            remotePath,
        );

        const latestAttributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const latestSize =
            typeof latestAttributes.size ===
                "number"
                ? latestAttributes.size
                : content.length;

        if (
            latestSize !==
            content.length
        ) {
            throw new SftpOperationError(
                "REMOTE_FILE_CHANGED_DURING_READ",
                "The remote file changed while it was being opened. Please try again.",
                {
                    remotePath,
                },
            );
        }

        return this.createTextSnapshot(
            remotePath,
            content,
            latestAttributes,
        );
    }

    async readImageFile(
        connectionId: string,
        requestedPath: string,
    ): Promise<RemoteImageSnapshot> {
        const sftp =
            await this.getSession(
                connectionId,
            );

        const remotePath =
            this.requireRemotePath(
                requestedPath,
                "remotePath",
            );

        const initialAttributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const initialMode =
            typeof initialAttributes.mode ===
                "number"
                ? initialAttributes.mode
                : undefined;

        const type =
            this.getFileType(
                initialMode,
            );

        if (type !== "file") {
            throw new SftpOperationError(
                "REMOTE_IMAGE_NOT_PREVIEWABLE",
                "Only regular remote image files can be previewed.",
                {
                    remotePath,
                    type,
                },
            );
        }

        this.assertFileSizeLimit(
            initialAttributes.size,
            remotePath,
            MAX_PREVIEW_IMAGE_BYTES,
            "REMOTE_IMAGE_TOO_LARGE",
            "This remote image is too large to preview safely.",
        );

        const content =
            await this.readFileBuffer(
                sftp,
                remotePath,
                MAX_PREVIEW_IMAGE_BYTES,
                "REMOTE_IMAGE_TOO_LARGE",
                "This remote image is too large to preview safely.",
            );

        const mimeType =
            this.detectImageMimeType(
                content,
            );

        if (!mimeType) {
            throw new SftpOperationError(
                "REMOTE_IMAGE_FORMAT_UNSUPPORTED",
                "This file is not a supported image format.",
                {
                    remotePath,

                    supportedFormats: [
                        "PNG",
                        "JPEG",
                        "GIF",
                        "WebP",
                        "BMP",
                        "ICO",
                    ],
                },
            );
        }

        const latestAttributes =
            await this.lstat(
                sftp,
                remotePath,
            );

        const latestSize =
            typeof latestAttributes.size ===
                "number"
                ? latestAttributes.size
                : content.length;

        if (
            latestSize !==
            content.length
        ) {
            throw new SftpOperationError(
                "REMOTE_IMAGE_CHANGED_DURING_READ",
                "The remote image changed while it was being opened. Please try again.",
                {
                    remotePath,
                },
            );
        }

        const latestMode =
            typeof latestAttributes.mode ===
                "number"
                ? latestAttributes.mode
                : undefined;

        return {
            path: remotePath,

            name:
                path.posix.basename(
                    remotePath,
                ),

            contentBase64:
                content.toString(
                    "base64",
                ),

            mimeType,

            size:
                content.length,

            modifiedAt:
                typeof latestAttributes.mtime ===
                    "number"
                    ? latestAttributes.mtime
                    : null,

            permissions:
                this.formatPermissions(
                    latestMode,
                ),

            revision:
                this.createRevision(
                    content,
                ),
        };
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

    private requireRemotePath(
        remotePathValue: string,
        fieldName: string,
    ): string {
        const remotePath =
            remotePathValue.trim();

        if (!remotePath) {
            throw new Error(
                `${fieldName} must be a non-empty remote path.`,
            );
        }

        return remotePath;
    }

    private requireMutableRemotePath(
        remotePathValue: string,
        fieldName: string,
    ): string {
        const remotePath =
            this.requireRemotePath(
                remotePathValue,
                fieldName,
            );

        const normalizedPath =
            path.posix.normalize(
                remotePath,
            );

        /*
         * Never allow mutation methods to target a root,
         * current-directory, or parent-directory reference.
         */
        if (
            normalizedPath === "/" ||
            normalizedPath === "." ||
            normalizedPath === ".."
        ) {
            throw new Error(
                `Refusing to modify protected remote path: ${remotePath}`,
            );
        }

        return remotePath;
    }

    private createTextSnapshot(
        remotePath: string,
        content: Buffer,
        attributes: RemoteAttributes,
    ): RemoteTextFileSnapshot {
        const mode =
            typeof attributes.mode ===
                "number"
                ? attributes.mode
                : undefined;

        return {
            path: remotePath,

            name:
                path.posix.basename(
                    remotePath,
                ),

            contentBase64:
                content.toString(
                    "base64",
                ),

            encoding: "utf-8",

            size: content.length,

            modifiedAt:
                typeof attributes.mtime ===
                    "number"
                    ? attributes.mtime
                    : null,

            permissions:
                this.formatPermissions(
                    mode,
                ),

            revision:
                this.createRevision(
                    content,
                ),

            /*
             * This is an advisory UI value. The server still
             * makes the final permission decision during save.
             */
            readOnly:
                mode !== undefined
                    ? (
                        mode &
                        0o222
                    ) === 0
                    : false,
        };
    }

    private createRevision(
        content: Buffer,
    ): string {
        return createHash(
            "sha256",
        )
            .update(content)
            .digest("hex");
    }

    private assertExpectedRevision(
        currentSnapshot:
            RemoteTextFileSnapshot,
        expectedRevision: string,
        force: boolean,
    ): void {
        if (
            force ||
            currentSnapshot.revision ===
            expectedRevision
        ) {
            return;
        }

        throw new SftpOperationError(
            "REMOTE_FILE_CHANGED",
            "The remote file changed after it was opened.",
            {
                remotePath:
                    currentSnapshot.path,

                expectedRevision,

                currentRevision:
                    currentSnapshot.revision,

                currentModifiedAt:
                    currentSnapshot.modifiedAt,

                currentSize:
                    currentSnapshot.size,
            },
        );
    }

    private assertFileSizeLimit(
        sizeValue: number | undefined,
        remotePath: string,
        maximumSize: number,
        errorCode: string,
        errorMessage: string,
    ): void {
        const size =
            typeof sizeValue === "number"
                ? sizeValue
                : 0;

        if (size <= maximumSize) {
            return;
        }

        throw new SftpOperationError(
            errorCode,
            errorMessage,
            {
                remotePath,
                size,
                maximumSize,
            },
        );
    }

    private assertEditableFileSize(
        sizeValue: number | undefined,
        remotePath: string,
    ): void {
        this.assertFileSizeLimit(
            sizeValue,
            remotePath,
            MAX_EDITABLE_FILE_BYTES,
            "REMOTE_FILE_TOO_LARGE",
            "This remote file is too large to edit safely.",
        );
    }

    private assertEditableText(
        content: Buffer,
        remotePath: string,
    ): void {
        if (
            content.includes(0)
        ) {
            throw new SftpOperationError(
                "REMOTE_FILE_BINARY",
                "This appears to be a binary file and cannot be opened in the text editor.",
                {
                    remotePath,
                },
            );
        }

        try {
            const decoder =
                new TextDecoder(
                    "utf-8",
                    {
                        fatal: true,
                    },
                );

            decoder.decode(
                content,
            );
        } catch {
            throw new SftpOperationError(
                "REMOTE_FILE_ENCODING_UNSUPPORTED",
                "This file is not valid UTF-8 text.",
                {
                    remotePath,
                    encoding: "unknown",
                },
            );
        }
    }

    private detectImageMimeType(
        content: Buffer,
    ): RemoteImageMimeType | null {
        if (
            content.length >= 8 &&
            content[0] === 0x89 &&
            content[1] === 0x50 &&
            content[2] === 0x4e &&
            content[3] === 0x47 &&
            content[4] === 0x0d &&
            content[5] === 0x0a &&
            content[6] === 0x1a &&
            content[7] === 0x0a
        ) {
            return "image/png";
        }

        if (
            content.length >= 3 &&
            content[0] === 0xff &&
            content[1] === 0xd8 &&
            content[2] === 0xff
        ) {
            return "image/jpeg";
        }

        if (content.length >= 6) {
            const gifSignature =
                content
                    .subarray(
                        0,
                        6,
                    )
                    .toString(
                        "ascii",
                    );

            if (
                gifSignature ===
                "GIF87a" ||
                gifSignature ===
                "GIF89a"
            ) {
                return "image/gif";
            }
        }

        if (
            content.length >= 12 &&
            content
                .subarray(
                    0,
                    4,
                )
                .toString(
                    "ascii",
                ) === "RIFF" &&
            content
                .subarray(
                    8,
                    12,
                )
                .toString(
                    "ascii",
                ) === "WEBP"
        ) {
            return "image/webp";
        }

        if (
            content.length >= 2 &&
            content[0] === 0x42 &&
            content[1] === 0x4d
        ) {
            return "image/bmp";
        }

        if (
            content.length >= 4 &&
            content[0] === 0x00 &&
            content[1] === 0x00 &&
            content[2] === 0x01 &&
            content[3] === 0x00
        ) {
            return "image/x-icon";
        }

        return null;
    }

    private decodeBase64Content(
        contentBase64: string,
    ): Buffer {
        const normalized =
            contentBase64.replace(
                /\s+/gu,
                "",
            );

        if (normalized.length === 0) {
            return Buffer.alloc(0);
        }

        const validBase64Pattern =
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

        if (
            !validBase64Pattern.test(
                normalized,
            )
        ) {
            throw new SftpOperationError(
                "INVALID_BASE64_CONTENT",
                "The editor content is not valid base64 data.",
            );
        }

        const content =
            Buffer.from(
                normalized,
                "base64",
            );

        const inputWithoutPadding =
            normalized.replace(
                /=+$/u,
                "",
            );

        const outputWithoutPadding =
            content
                .toString(
                    "base64",
                )
                .replace(
                    /=+$/u,
                    "",
                );

        if (
            inputWithoutPadding !==
            outputWithoutPadding
        ) {
            throw new SftpOperationError(
                "INVALID_BASE64_CONTENT",
                "The editor content could not be decoded safely.",
            );
        }

        return content;
    }

    private lstat(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<RemoteAttributes> {
        return new Promise(
            (resolve, reject) => {
                sftp.lstat(
                    remotePath,
                    (
                        error,
                        attributes,
                    ) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(
                            attributes,
                        );
                    },
                );
            },
        );
    }

    private async readFileBuffer(
        sftp: SFTPWrapper,
        remotePath: string,
        maximumSize: number,
        sizeErrorCode: string,
        sizeErrorMessage: string,
    ): Promise<Buffer> {
        const handle =
            await this.openFile(
                sftp,
                remotePath,
                "r",
            );

        try {
            const attributes =
                await this.fstat(
                    sftp,
                    handle,
                );

            this.assertFileSizeLimit(
                attributes.size,
                remotePath,
                maximumSize,
                sizeErrorCode,
                sizeErrorMessage,
            );

            const size =
                typeof attributes.size ===
                    "number"
                    ? attributes.size
                    : 0;

            if (size === 0) {
                return Buffer.alloc(0);
            }

            const buffer =
                Buffer.alloc(size);

            let offset = 0;

            while (offset < size) {
                const bytesRead =
                    await this.readChunk(
                        sftp,
                        handle,
                        buffer,
                        offset,
                        size - offset,
                        offset,
                    );

                if (bytesRead === 0) {
                    break;
                }

                offset += bytesRead;
            }

            return buffer.subarray(
                0,
                offset,
            );
        } finally {
            await this.closeHandle(
                sftp,
                handle,
            );
        }
    }

    private openFile(
        sftp: SFTPWrapper,
        remotePath: string,
        flags: OpenMode,
    ): Promise<Buffer> {
        return new Promise(
            (resolve, reject) => {
                sftp.open(
                    remotePath,
                    flags,
                    (
                        error,
                        handle,
                    ) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(handle);
                    },
                );
            },
        );
    }

    private fstat(
        sftp: SFTPWrapper,
        handle: Buffer,
    ): Promise<RemoteAttributes> {
        return new Promise(
            (resolve, reject) => {
                sftp.fstat(
                    handle,
                    (
                        error,
                        attributes,
                    ) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(
                            attributes,
                        );
                    },
                );
            },
        );
    }

    private readChunk(
        sftp: SFTPWrapper,
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<number> {
        return new Promise(
            (resolve, reject) => {
                sftp.read(
                    handle,
                    buffer,
                    offset,
                    length,
                    position,
                    (
                        error,
                        bytesRead,
                    ) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(
                            bytesRead,
                        );
                    },
                );
            },
        );
    }

    private closeHandle(
        sftp: SFTPWrapper,
        handle: Buffer,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.close(
                    handle,
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
    }

    private writeFileBuffer(
        sftp: SFTPWrapper,
        remotePath: string,
        content: Buffer,
        mode: number,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.writeFile(
                    remotePath,
                    content,
                    {
                        flag: "w",
                        mode,
                    },
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
    }

    private chmod(
        sftp: SFTPWrapper,
        remotePath: string,
        mode: number,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.chmod(
                    remotePath,
                    mode,
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
    }

    private async replaceRemoteFile(
        sftp: SFTPWrapper,
        temporaryPath: string,
        destinationPath: string,
    ): Promise<void> {
        /*
         * OpenSSH's POSIX rename extension replaces the
         * destination atomically when the server supports it.
         */
        try {
            const replaced =
                await this.tryOpenSshRename(
                    sftp,
                    temporaryPath,
                    destinationPath,
                );

            if (replaced) {
                return;
            }
        } catch {
            /*
             * Fall through to the portable backup strategy.
             */
        }

        const backupPath =
            `${destinationPath}.ssh-workspace-${randomUUID()}.bak`;

        await this.rename(
            sftp,
            destinationPath,
            backupPath,
        );

        try {
            await this.rename(
                sftp,
                temporaryPath,
                destinationPath,
            );
        } catch (replacementError) {
            try {
                await this.rename(
                    sftp,
                    backupPath,
                    destinationPath,
                );
            } catch (rollbackError) {
                throw new SftpOperationError(
                    "REMOTE_SAVE_ROLLBACK_FAILED",
                    "The remote save failed and the original file could not be restored automatically.",
                    {
                        destinationPath,
                        backupPath,

                        replacementError:
                            replacementError instanceof
                                Error
                                ? replacementError.message
                                : String(
                                    replacementError,
                                ),

                        rollbackError:
                            rollbackError instanceof
                                Error
                                ? rollbackError.message
                                : String(
                                    rollbackError,
                                ),
                    },
                );
            }

            throw replacementError;
        }

        /*
         * The new file is already in place. Failure to remove
         * a backup should not mark the save itself as failed.
         */
        await this.safeUnlink(
            sftp,
            backupPath,
        );
    }

    private tryOpenSshRename(
        sftp: SFTPWrapper,
        sourcePath: string,
        destinationPath: string,
    ): Promise<boolean> {
        const extendedSftp =
            sftp as SFTPWrapper & {
                ext_openssh_rename?: (
                    sourcePath: string,
                    destinationPath: string,
                    callback: (
                        error?: Error | null,
                    ) => void,
                ) => void;
            };

        if (
            typeof extendedSftp
                .ext_openssh_rename !==
            "function"
        ) {
            return Promise.resolve(
                false,
            );
        }

        return new Promise(
            (resolve, reject) => {
                extendedSftp.ext_openssh_rename?.(
                    sourcePath,
                    destinationPath,
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve(true);
                    },
                );
            },
        );
    }

    private async safeUnlink(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<void> {
        try {
            await this.unlink(
                sftp,
                remotePath,
            );
        } catch { }
    }

    private rename(
        sftp: SFTPWrapper,
        sourcePath: string,
        destinationPath: string,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
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
            },
        );
    }

    private unlink(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.unlink(
                    remotePath,
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
    }

    private mkdir(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.mkdir(
                    remotePath,
                    {
                        mode: 0o755,
                    },
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
    }

    private rmdir(
        sftp: SFTPWrapper,
        remotePath: string,
    ): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                sftp.rmdir(
                    remotePath,
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    },
                );
            },
        );
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
