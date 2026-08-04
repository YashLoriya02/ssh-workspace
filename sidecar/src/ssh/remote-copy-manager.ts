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

import type {
  SftpManager,
} from "./sftp-manager";

interface BackendEvent {
  type: string;
  payload: unknown;
}

interface RemoteCopyOptions {
  transferId: string;

  sourceConnectionId: string;
  destinationConnectionId: string;

  sourceRemotePath: string;
  destinationRemotePath: string;

  overwrite: boolean;
}

interface ActiveRemoteCopy {
  options: RemoteCopyOptions;
  cancelled: boolean;

  sourceStream: Readable | null;
  progressStream: Transform | null;
  destinationStream: Writable | null;
}

interface RemoteCopyEventPayload {
  transferId: string;

  /*
   * Keep connectionId/remotePath/localPath for compatibility with the
   * existing transfer queue. The SFTP workspace uses the more specific
   * source/destination fields below.
   */
  connectionId: string;
  direction: "remote-copy";

  name: string;
  remotePath: string;
  localPath: string;

  sourceConnectionId: string;
  destinationConnectionId: string;
  sourceRemotePath: string;
  destinationRemotePath: string;

  transferredBytes: number;
  totalBytes: number;

  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

  message?: string;
}

class RemoteCopyCancelledError extends Error {
  constructor(
    message: string = "The remote copy was cancelled.",
  ) {
    super(message);
    this.name = "RemoteCopyCancelledError";
  }
}

function getErrorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function isMissingPathError(
  error: unknown,
): boolean {
  if (
    typeof error !== "object" ||
    error === null
  ) {
    return false;
  }

  const candidate = error as {
    code?: string | number;
    errno?: string | number;
  };

  return (
    candidate.code === "ENOENT" ||
    candidate.errno === "ENOENT" ||
    candidate.code === 2 ||
    candidate.errno === 2
  );
}

function isDirectoryMode(
  mode: number | undefined,
): boolean {
  if (typeof mode !== "number") {
    return false;
  }

  return (mode & 0o170000) === 0o040000;
}

export class RemoteCopyManager {
  private readonly activeCopies = new Map<
    string,
    ActiveRemoteCopy
  >();

  constructor(
    private readonly sftpManager: SftpManager,
    private readonly sendEvent: (
      event: BackendEvent,
    ) => void,
  ) { }

  async startRemoteCopy(
    options: RemoteCopyOptions,
  ): Promise<void> {
    this.validateOptions(options);

    if (
      this.activeCopies.has(
        options.transferId,
      )
    ) {
      throw new Error(
        `A transfer already exists with ID ${options.transferId}.`,
      );
    }

    const activeCopy: ActiveRemoteCopy = {
      options,
      cancelled: false,
      sourceStream: null,
      progressStream: null,
      destinationStream: null,
    };

    this.activeCopies.set(
      options.transferId,
      activeCopy,
    );

    /*
     * Match the existing upload/download manager: accept the request
     * immediately and run the actual transfer asynchronously. Progress and
     * completion are delivered through transfer.* events.
     */
    void this.runRemoteCopy(
      activeCopy,
    );
  }

  cancel(
    transferId: string,
  ): boolean {
    const activeCopy =
      this.activeCopies.get(
        transferId,
      );

    if (!activeCopy) {
      return false;
    }

    activeCopy.cancelled = true;

    const cancellationError =
      new RemoteCopyCancelledError();

    activeCopy.sourceStream?.destroy(
      cancellationError,
    );

    activeCopy.progressStream?.destroy(
      cancellationError,
    );

    activeCopy.destinationStream?.destroy(
      cancellationError,
    );

    return true;
  }

  cancelForConnection(
    connectionId: string,
  ): void {
    for (
      const [
        transferId,
        activeCopy,
      ] of this.activeCopies.entries()
    ) {
      if (
        activeCopy.options.sourceConnectionId ===
          connectionId ||
        activeCopy.options.destinationConnectionId ===
          connectionId
      ) {
        this.cancel(transferId);
      }
    }
  }

  cancelAll(): void {
    for (
      const transferId of
      this.activeCopies.keys()
    ) {
      this.cancel(transferId);
    }
  }

  private async runRemoteCopy(
    activeCopy: ActiveRemoteCopy,
  ): Promise<void> {
    const { options } = activeCopy;

    let sourceSftp: SFTPWrapper | null = null;
    let destinationSftp: SFTPWrapper | null = null;

    let transferredBytes = 0;
    let totalBytes = 0;

    let temporaryCreated = false;
    let destinationBackedUp = false;
    let committed = false;

    const temporaryPath =
      `${options.destinationRemotePath}.ssh-workspace-${options.transferId}.part`;

    const backupPath =
      `${options.destinationRemotePath}.ssh-workspace-${options.transferId}.backup`;

    try {
      this.throwIfCancelled(activeCopy);

      const [
        sourceSession,
        destinationSession,
      ] = await Promise.all([
        this.sftpManager.getSession(
          options.sourceConnectionId,
        ),
        this.sftpManager.getSession(
          options.destinationConnectionId,
        ),
      ]);

      sourceSftp = sourceSession;
      destinationSftp = destinationSession;

      this.throwIfCancelled(activeCopy);

      const sourceAttributes =
        await this.lstat(
          sourceSession,
          options.sourceRemotePath,
        );

      if (
        isDirectoryMode(
          sourceAttributes.mode,
        )
      ) {
        throw new Error(
          "RemoteCopyManager copies files only. Folder recursion is handled by the SFTP transfer orchestrator.",
        );
      }

      totalBytes = Math.max(
        0,
        typeof sourceAttributes.size ===
          "number"
          ? sourceAttributes.size
          : 0,
      );

      const destinationAttributes =
        await this.tryLstat(
          destinationSession,
          options.destinationRemotePath,
        );

      if (
        destinationAttributes &&
        isDirectoryMode(
          destinationAttributes.mode,
        )
      ) {
        throw new Error(
          "A remote folder exists at the destination path. The folder must be removed by the transfer orchestrator before copying the file.",
        );
      }

      if (
        destinationAttributes &&
        !options.overwrite
      ) {
        throw new Error(
          "A remote file already exists at the destination path.",
        );
      }

      await this.safeUnlink(
        destinationSession,
        temporaryPath,
      );

      await this.safeUnlink(
        destinationSession,
        backupPath,
      );

      this.emitTransferEvent(
        "transfer.started",
        options,
        transferredBytes,
        totalBytes,
        "running",
      );

      const sourceStream =
        sourceSession.createReadStream(
          options.sourceRemotePath,
        );

      const destinationStream =
        destinationSession.createWriteStream(
          temporaryPath,
          {
            flags: "w",
            mode:
              typeof sourceAttributes.mode ===
                "number"
                ? sourceAttributes.mode &
                  0o777
                : 0o644,
          },
        );

      let lastProgressAt = 0;

      const progressStream =
        new Transform({
          transform: (
            chunk,
            _encoding,
            callback,
          ) => {
            if (activeCopy.cancelled) {
              callback(
                new RemoteCopyCancelledError(),
              );
              return;
            }

            const chunkLength =
              Buffer.isBuffer(chunk)
                ? chunk.length
                : Buffer.byteLength(chunk);

            transferredBytes +=
              chunkLength;

            const now = Date.now();

            if (
              now - lastProgressAt >=
                100 ||
              transferredBytes >=
                totalBytes
            ) {
              lastProgressAt = now;

              this.emitTransferEvent(
                "transfer.progress",
                options,
                transferredBytes,
                totalBytes,
                "running",
              );
            }

            callback(null, chunk);
          },
        });

      activeCopy.sourceStream =
        sourceStream;

      activeCopy.progressStream =
        progressStream;

      activeCopy.destinationStream =
        destinationStream;

      temporaryCreated = true;

      await pipeline(
        sourceStream,
        progressStream,
        destinationStream,
      );

      this.throwIfCancelled(activeCopy);

      if (destinationAttributes) {
        await this.rename(
          destinationSession,
          options.destinationRemotePath,
          backupPath,
        );

        destinationBackedUp = true;
      }

      this.throwIfCancelled(activeCopy);

      await this.rename(
        destinationSession,
        temporaryPath,
        options.destinationRemotePath,
      );

      temporaryCreated = false;
      committed = true;

      if (destinationBackedUp) {
        try {
          await this.safeUnlink(
            destinationSession,
            backupPath,
          );

          destinationBackedUp = false;
        } catch {
          /*
           * The new destination is already valid. A stale backup is safer
           * than deleting the newly copied file.
           */
        }
      }

      transferredBytes =
        Math.max(
          transferredBytes,
          totalBytes,
        );

      this.emitTransferEvent(
        "transfer.completed",
        options,
        transferredBytes,
        totalBytes,
        "completed",
      );
    } catch (error) {
      const cancelled =
        activeCopy.cancelled ||
        error instanceof
          RemoteCopyCancelledError;

      this.emitTransferEvent(
        cancelled
          ? "transfer.cancelled"
          : "transfer.failed",
        options,
        transferredBytes,
        totalBytes,
        cancelled
          ? "cancelled"
          : "failed",
        cancelled
          ? "Remote copy cancelled. Any unfinished temporary file was removed."
          : getErrorMessage(error),
      );
    } finally {
      activeCopy.sourceStream = null;
      activeCopy.progressStream = null;
      activeCopy.destinationStream = null;

      if (
        destinationSftp &&
        temporaryCreated &&
        !committed
      ) {
        try {
          await this.safeUnlink(
            destinationSftp,
            temporaryPath,
          );
        } catch {
          // Preserve the primary transfer result.
        }
      }

      if (
        destinationSftp &&
        destinationBackedUp &&
        !committed
      ) {
        try {
          const currentDestination =
            await this.tryLstat(
              destinationSftp,
              options.destinationRemotePath,
            );

          if (!currentDestination) {
            await this.rename(
              destinationSftp,
              backupPath,
              options.destinationRemotePath,
            );

            destinationBackedUp = false;
          }
        } catch {
          // Preserve the primary transfer result.
        }
      }

      this.activeCopies.delete(
        options.transferId,
      );
    }
  }

  private validateOptions(
    options: RemoteCopyOptions,
  ): void {
    const requiredValues = [
      options.transferId,
      options.sourceConnectionId,
      options.destinationConnectionId,
      options.sourceRemotePath,
      options.destinationRemotePath,
    ];

    if (
      requiredValues.some(
        (value) =>
          value.trim().length === 0,
      )
    ) {
      throw new Error(
        "Remote copy identifiers and paths must be non-empty strings.",
      );
    }

    if (
      options.sourceConnectionId ===
        options.destinationConnectionId &&
      options.sourceRemotePath ===
        options.destinationRemotePath
    ) {
      throw new Error(
        "The remote source and destination paths are identical.",
      );
    }
  }

  private throwIfCancelled(
    activeCopy: ActiveRemoteCopy,
  ): void {
    if (activeCopy.cancelled) {
      throw new RemoteCopyCancelledError();
    }
  }

  private emitTransferEvent(
    type: string,
    options: RemoteCopyOptions,
    transferredBytes: number,
    totalBytes: number,
    status:
      RemoteCopyEventPayload["status"],
    message?: string,
  ): void {
    const payload:
      RemoteCopyEventPayload = {
      transferId:
        options.transferId,

      connectionId:
        options.destinationConnectionId,

      direction:
        "remote-copy",

      name:
        path.posix.basename(
          options.sourceRemotePath,
        ) ||
        options.sourceRemotePath,

      remotePath:
        options.destinationRemotePath,

      localPath: "",

      sourceConnectionId:
        options.sourceConnectionId,

      destinationConnectionId:
        options.destinationConnectionId,

      sourceRemotePath:
        options.sourceRemotePath,

      destinationRemotePath:
        options.destinationRemotePath,

      transferredBytes:
        Math.max(
          0,
          transferredBytes,
        ),

      totalBytes:
        Math.max(
          0,
          totalBytes,
        ),

      status,

      ...(message
        ? {
          message,
        }
        : {}),
    };

    this.sendEvent({
      type,
      payload,
    });
  }

  private lstat(
    sftp: SFTPWrapper,
    remotePath: string,
  ): Promise<Stats> {
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

            resolve(attributes);
          },
        );
      },
    );
  }

  private async tryLstat(
    sftp: SFTPWrapper,
    remotePath: string,
  ): Promise<Stats | null> {
    try {
      return await this.lstat(
        sftp,
        remotePath,
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    }
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

  private async safeUnlink(
    sftp: SFTPWrapper,
    remotePath: string,
  ): Promise<void> {
    try {
      await this.unlink(
        sftp,
        remotePath,
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }
}
