import process from "node:process";
import { createInterface } from "node:readline";
import {
  ConnectionManager,
  type OpenConnectionOptions,
  type SshAuthentication,
} from "./ssh/connection-manager.js";
import { TerminalManager } from "./ssh/terminal-manager";
import {
  SftpManager,
  SftpOperationError,
} from "./ssh/sftp-manager";
import { TransferManager } from "./ssh/transfer-manager";

interface BackendRequest {
  id: string;
  type: string;
  payload?: unknown;
}

interface BackendIncomingMessage {
  id?: string;
  type: string;
  payload?: unknown;
}

interface BackendResponse {
  id?: string;
  type: string;
  payload?: unknown;
}

function sendMessage(message: BackendResponse): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeLog(message: string): void {
  process.stderr.write(`[sidecar] ${message}\n`);
}

const connectionManager = new ConnectionManager(
  sendMessage,
);

const terminalManager = new TerminalManager(
  connectionManager,
  sendMessage,
);

const sftpManager = new SftpManager(
  connectionManager,
);

const transferManager = new TransferManager(
  sftpManager,
  sendMessage,
);

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireTerminalInput(
  object: Record<string, unknown>,
  fieldName: string,
): string {
  const value = object[fieldName];

  if (
    typeof value !== "string" ||
    value.length === 0
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string.`,
    );
  }

  // Do not trim terminal input.
  // Values such as "\r", "\n", "\x03", tabs and escape
  // sequences are valid terminal data.
  return value;
}

function requireRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  return value;
}

function requireStringIncludingEmpty(
  object: Record<string, unknown>,
  fieldName: string,
): string {
  const value = object[fieldName];

  if (typeof value !== "string") {
    throw new Error(
      `${fieldName} must be a string.`,
    );
  }

  return value;
}

function requireString(
  object: Record<string, unknown>,
  fieldName: string,
): string {
  const value = object[fieldName];

  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(
      `${fieldName} must be a non-empty string.`,
    );
  }

  return value;
}

function requireBoolean(
  object: Record<string, unknown>,
  fieldName: string,
): boolean {
  const value = object[fieldName];

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }

  return value;
}

function requireInteger(
  object: Record<string, unknown>,
  fieldName: string,
  minimum: number,
  maximum: number,
): number {
  const value = object[fieldName];

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${fieldName} must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

function optionalString(
  object: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = object[fieldName];

  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value;
}

function parsePort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new Error(
      "port must be an integer between 1 and 65535.",
    );
  }

  return value;
}

function parseAuthentication(
  value: unknown,
): SshAuthentication {
  const authentication = requireRecord(
    value,
    "authentication",
  );

  const type = requireString(authentication, "type");

  if (type === "password") {
    return {
      type: "password",
      password: requireString(
        authentication,
        "password",
      ),
    };
  }

  if (type === "privateKey") {
    const passphrase = optionalString(
      authentication,
      "passphrase",
    );

    return {
      type: "privateKey",
      privateKey: requireString(
        authentication,
        "privateKey",
      ),
      ...(passphrase ? { passphrase } : {}),
    };
  }

  throw new Error(
    "authentication.type must be password or privateKey.",
  );
}

function parseOpenConnectionOptions(
  payload: unknown,
): {
  connectionId: string;
  options: OpenConnectionOptions;
} {
  const value = requireRecord(
    payload,
    "connection.open payload",
  );

  const knownHostFingerprint =
    optionalString(
      value,
      "knownHostFingerprint",
    );

  return {
    connectionId: requireString(
      value,
      "connectionId",
    ),

    options: {
      host: requireString(
        value,
        "host",
      ),

      port: parsePort(
        value.port,
      ),

      username: requireString(
        value,
        "username",
      ),

      authentication:
        parseAuthentication(
          value.authentication,
        ),

      ...(knownHostFingerprint
        ? {
          knownHostFingerprint,
        }
        : {}),
    },
  };
}

async function handleRequest(
  request: BackendRequest,
): Promise<void> {
  switch (request.type) {
    case "system.ping": {
      const payload = isRecord(request.payload)
        ? request.payload
        : {};

      sendMessage({
        id: request.id,
        type: "system.pong",
        payload: {
          sentAt:
            typeof payload.sentAt === "number"
              ? payload.sentAt
              : undefined,
          receivedAt: Date.now(),
          processId: process.pid,
          platform: process.platform,
          architecture: process.arch,
        },
      });

      return;
    }

    case "connection.open": {
      const { connectionId, options } =
        parseOpenConnectionOptions(request.payload);

      await connectionManager.open(
        connectionId,
        options,
      );

      sendMessage({
        id: request.id,
        type: "connection.opened",
        payload: {
          connectionId,
        },
      });

      return;
    }

    case "connection.hostKeyDecision": {
      const payload = requireRecord(
        request.payload,
        "connection.hostKeyDecision payload",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      const accepted = requireBoolean(
        payload,
        "accepted",
      );

      connectionManager.approveHostKey(
        connectionId,
        accepted,
      );

      sendMessage({
        id: request.id,
        type: "connection.hostKeyDecisionRecorded",
        payload: {
          connectionId,
          accepted,
        },
      });

      return;
    }

    case "connection.close": {
      const payload = requireRecord(
        request.payload,
        "connection.close payload",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      transferManager.cancelForConnection(
        connectionId,
      );

      terminalManager.closeForConnection(
        connectionId,
      );

      sftpManager.closeForConnection(
        connectionId,
      );

      const existed =
        connectionManager.close(connectionId);

      sendMessage({
        id: request.id,
        type: "connection.closeAccepted",
        payload: {
          connectionId,
          existed,
        },
      });

      return;
    }

    case "terminal.open": {
      const payload = requireRecord(
        request.payload,
        "terminal.open payload",
      );

      const terminalId = requireString(
        payload,
        "terminalId",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      const cols = requireInteger(
        payload,
        "cols",
        1,
        1_000,
      );

      const rows = requireInteger(
        payload,
        "rows",
        1,
        1_000,
      );

      await terminalManager.open({
        terminalId,
        connectionId,
        cols,
        rows,
      });

      sendMessage({
        id: request.id,
        type: "terminal.opened",
        payload: {
          terminalId,
          connectionId,
        },
      });

      return;
    }

    case "terminal.close": {
      const payload = requireRecord(
        request.payload,
        "terminal.close payload",
      );

      const terminalId = requireString(
        payload,
        "terminalId",
      );

      const existed =
        terminalManager.close(terminalId);

      sendMessage({
        id: request.id,
        type: "terminal.closeAccepted",
        payload: {
          terminalId,
          existed,
        },
      });

      return;
    }

    case "sftp.list": {
      const payload = requireRecord(
        request.payload,
        "sftp.list payload",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      const remotePath = optionalString(
        payload,
        "path",
      );

      const listing =
        await sftpManager.listDirectory(
          connectionId,
          remotePath,
        );

      sendMessage({
        id: request.id,
        type: "sftp.directory",
        payload: listing,
      });

      return;
    }

    case "sftp.stat": {
      const payload = requireRecord(
        request.payload,
        "sftp.stat payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      const entry =
        await sftpManager.statPath(
          connectionId,
          remotePath,
        );

      sendMessage({
        id: request.id,
        type: "sftp.entry",
        payload: entry,
      });

      return;
    }

    case "sftp.rename": {
      const payload = requireRecord(
        request.payload,
        "sftp.rename payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const sourcePath =
        requireString(
          payload,
          "sourcePath",
        );

      const destinationPath =
        requireString(
          payload,
          "destinationPath",
        );

      await sftpManager.renamePath(
        connectionId,
        sourcePath,
        destinationPath,
      );

      sendMessage({
        id: request.id,
        type: "sftp.renameCompleted",
        payload: {
          connectionId,
          sourcePath,
          destinationPath,
        },
      });

      return;
    }

    case "sftp.deleteFile": {
      const payload = requireRecord(
        request.payload,
        "sftp.deleteFile payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      await sftpManager.deleteFile(
        connectionId,
        remotePath,
      );

      sendMessage({
        id: request.id,
        type: "sftp.deleteFileCompleted",
        payload: {
          connectionId,
          remotePath,
        },
      });

      return;
    }

    case "sftp.createDirectory": {
      const payload = requireRecord(
        request.payload,
        "sftp.createDirectory payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      await sftpManager.createDirectory(
        connectionId,
        remotePath,
      );

      sendMessage({
        id: request.id,
        type: "sftp.createDirectoryCompleted",
        payload: {
          connectionId,
          remotePath,
        },
      });

      return;
    }

    case "sftp.deleteDirectory": {
      const payload = requireRecord(
        request.payload,
        "sftp.deleteDirectory payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      await sftpManager.deleteDirectory(
        connectionId,
        remotePath,
      );

      sendMessage({
        id: request.id,
        type: "sftp.deleteDirectoryCompleted",
        payload: {
          connectionId,
          remotePath,
        },
      });

      return;
    }

    case "sftp.readTextFile": {
      const payload = requireRecord(
        request.payload,
        "sftp.readTextFile payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      const snapshot =
        await sftpManager.readTextFile(
          connectionId,
          remotePath,
        );

      sendMessage({
        id: request.id,
        type: "sftp.textFile",
        payload: snapshot,
      });

      return;
    }

    case "sftp.saveTextFile": {
      const payload = requireRecord(
        request.payload,
        "sftp.saveTextFile payload",
      );

      const connectionId =
        requireString(
          payload,
          "connectionId",
        );

      const remotePath =
        requireString(
          payload,
          "remotePath",
        );

      const contentBase64 =
        requireStringIncludingEmpty(
          payload,
          "contentBase64",
        );

      const expectedRevision =
        requireString(
          payload,
          "expectedRevision",
        );

      const force =
        payload.force === undefined
          ? false
          : requireBoolean(
            payload,
            "force",
          );

      const snapshot =
        await sftpManager.saveTextFile(
          connectionId,
          remotePath,
          contentBase64,
          expectedRevision,
          force,
        );

      sendMessage({
        id: request.id,
        type: "sftp.textFileSaved",
        payload: snapshot,
      });

      return;
    }

    case "transfer.download": {
      const payload = requireRecord(
        request.payload,
        "transfer.download payload",
      );

      const transferId = requireString(
        payload,
        "transferId",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      const remotePath = requireString(
        payload,
        "remotePath",
      );

      const localPath = requireString(
        payload,
        "localPath",
      );

      await transferManager.startDownload({
        transferId,
        connectionId,
        remotePath,
        localPath,
      });

      sendMessage({
        id: request.id,
        type: "transfer.accepted",
        payload: {
          transferId,
        },
      });

      return;
    }

    case "transfer.cancel": {
      const payload = requireRecord(
        request.payload,
        "transfer.cancel payload",
      );

      const transferId = requireString(
        payload,
        "transferId",
      );

      const existed =
        transferManager.cancel(transferId);

      sendMessage({
        id: request.id,
        type: "transfer.cancelAccepted",
        payload: {
          transferId,
          existed,
        },
      });

      return;
    }

    case "transfer.upload": {
      const payload = requireRecord(
        request.payload,
        "transfer.upload payload",
      );

      const transferId = requireString(
        payload,
        "transferId",
      );

      const connectionId = requireString(
        payload,
        "connectionId",
      );

      const localPath = requireString(
        payload,
        "localPath",
      );

      const remotePath = requireString(
        payload,
        "remotePath",
      );

      const overwrite = requireBoolean(
        payload,
        "overwrite",
      );

      await transferManager.startUpload({
        transferId,
        connectionId,
        localPath,
        remotePath,
        overwrite,
      });

      sendMessage({
        id: request.id,
        type: "transfer.accepted",
        payload: {
          transferId,
        },
      });

      return;
    }

    default:
      throw new Error(
        `Unknown request type: ${request.type}`,
      );
  }
}

function isBackendIncomingMessage(
  value: unknown,
): value is BackendIncomingMessage {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.type !== "string" ||
    value.type.length === 0
  ) {
    return false;
  }

  if (
    value.id !== undefined &&
    (
      typeof value.id !== "string" ||
      value.id.length === 0
    )
  ) {
    return false;
  }

  return true;
}

function handleNotification(
  message: BackendIncomingMessage,
): boolean {
  switch (message.type) {
    case "terminal.input": {
      const payload = requireRecord(
        message.payload,
        "terminal.input payload",
      );

      const terminalId = requireString(
        payload,
        "terminalId",
      );

      const data = requireTerminalInput(
        payload,
        "data",
      );

      terminalManager.write(
        terminalId,
        data,
      );

      return true;
    }

    case "terminal.resize": {
      const payload = requireRecord(
        message.payload,
        "terminal.resize payload",
      );

      const terminalId = requireString(
        payload,
        "terminalId",
      );

      const cols = requireInteger(
        payload,
        "cols",
        1,
        1_000,
      );

      const rows = requireInteger(
        payload,
        "rows",
        1,
        1_000,
      );

      terminalManager.resize(
        terminalId,
        cols,
        rows,
      );

      return true;
    }

    default:
      return false;
  }
}

async function handleInputLine(
  line: string,
): Promise<void> {
  const trimmedLine = line.trim();

  if (!trimmedLine) {
    return;
  }

  let parsedMessage: unknown;

  try {
    parsedMessage = JSON.parse(trimmedLine);
  } catch (error) {
    sendMessage({
      type: "system.error",
      payload: {
        code: "INVALID_JSON",
        message:
          error instanceof Error
            ? error.message
            : "Invalid JSON.",
      },
    });

    return;
  }

  if (
    !isBackendIncomingMessage(parsedMessage)
  ) {
    sendMessage({
      type: "system.error",
      payload: {
        code: "INVALID_MESSAGE",
        message:
          "Message must contain a non-empty type.",
      },
    });

    return;
  }

  try {
    if (handleNotification(parsedMessage)) {
      return;
    }

    if (!parsedMessage.id) {
      throw new Error(
        `Request ${parsedMessage.type} requires an id.`,
      );
    }

    await handleRequest({
      id: parsedMessage.id,
      type: parsedMessage.type,
      payload: parsedMessage.payload,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    const code =
      error instanceof
        SftpOperationError
        ? error.code
        : "MESSAGE_FAILED";

    const details =
      error instanceof
        SftpOperationError
        ? error.details
        : undefined;

    writeLog(
      `Message ${parsedMessage.type} failed: ${message}`,
    );

    sendMessage({
      ...(parsedMessage.id
        ? { id: parsedMessage.id }
        : {}),

      type: "system.error",

      payload: {
        code,
        message,

        ...(details
          ? {
            details,
          }
          : {}),
      },
    });
  }
}

const clearAll = () => {
  transferManager.cancelAll();
  terminalManager.closeAll();
  sftpManager.closeAll();
  connectionManager.closeAll();
}

function start(): void {
  const inputReader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  inputReader.on("line", (line) => {
    void handleInputLine(line);
  });

  inputReader.on("close", () => {
    clearAll()

    process.exit(0);
  });

  process.on("SIGINT", () => {
    clearAll()
    inputReader.close();
  });

  process.on("SIGTERM", () => {
    clearAll()

    inputReader.close();
  });

  process.on("uncaughtException", (error) => {
    writeLog(`Uncaught exception: ${error.message}`);
    clearAll()

    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    writeLog(`Unhandled rejection: ${String(reason)}`);
  });

  sendMessage({
    type: "sidecar.ready",
    payload: {
      processId: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      startedAt: new Date().toISOString(),
    },
  });

  writeLog("Backend sidecar started.");
}

start();
