import type {
    RemoteImageSnapshot,
    RemoteTextFileSnapshot,
} from "../../backend/backend-client";

import type {
    RemoteImageViewerTab,
    RemoteTextEditorTab,
} from "./editor-types";

const SUPPORTED_IMAGE_EXTENSIONS =
    new Set([
        "png",
        "jpg",
        "jpeg",
        "jfif",
        "gif",
        "webp",
        "bmp",
        "ico",
    ]);

export function isSupportedImageFileName(
    filename: string,
): boolean {
    const normalizedName =
        filename
            .trim()
            .toLowerCase();

    const finalSegment =
        normalizedName
            .split("/")
            .pop() ??
        normalizedName;

    const extension =
        finalSegment.includes(".")
            ? finalSegment
                .split(".")
                .pop() ?? ""
            : "";

    return SUPPORTED_IMAGE_EXTENSIONS.has(
        extension,
    );
}

export function decodeBase64Utf8(
    base64: string,
): string {
    if (!base64) {
        return "";
    }

    const binary =
        window.atob(base64);

    const bytes =
        new Uint8Array(
            binary.length,
        );

    for (
        let index = 0;
        index < binary.length;
        index += 1
    ) {
        bytes[index] =
            binary.charCodeAt(index);
    }

    return new TextDecoder(
        "utf-8",
        {
            fatal: true,
        },
    ).decode(bytes);
}

export function encodeUtf8Base64(
    value: string,
): string {
    const bytes =
        new TextEncoder().encode(
            value,
        );

    const chunkSize =
        32_768;

    let binary = "";

    for (
        let offset = 0;
        offset < bytes.length;
        offset += chunkSize
    ) {
        const chunk =
            bytes.subarray(
                offset,
                Math.min(
                    offset +
                    chunkSize,
                    bytes.length,
                ),
            );

        binary +=
            String.fromCharCode(
                ...chunk,
            );
    }

    return window.btoa(binary);
}

export function getRemoteEditorLanguage(
    filename: string,
): string {
    const normalized =
        filename.toLowerCase();

    const basename =
        normalized.split("/").pop() ??
        normalized;

    if (
        basename === "dockerfile" ||
        basename.startsWith(
            "dockerfile.",
        )
    ) {
        return "dockerfile";
    }

    if (
        basename === "makefile" ||
        basename === "gnumakefile"
    ) {
        return "makefile";
    }

    if (
        basename === ".gitignore" ||
        basename === ".dockerignore"
    ) {
        return "plaintext";
    }

    if (
        basename === ".env" ||
        basename.startsWith(".env.")
    ) {
        return "ini";
    }

    const extension =
        basename.includes(".")
            ? basename
                .split(".")
                .pop() ?? ""
            : "";

    const languages:
        Record<string, string> = {
        js: "javascript",
        jsx: "javascript",

        ts: "typescript",
        tsx: "typescript",

        json: "json",
        jsonc: "json",

        css: "css",
        scss: "scss",
        less: "less",

        html: "html",
        htm: "html",

        xml: "xml",
        svg: "xml",

        md: "markdown",
        markdown: "markdown",

        yaml: "yaml",
        yml: "yaml",

        sh: "shell",
        bash: "shell",
        zsh: "shell",

        py: "python",
        rb: "ruby",
        php: "php",

        java: "java",
        kt: "kotlin",
        kts: "kotlin",

        c: "c",
        h: "c",

        cc: "cpp",
        cpp: "cpp",
        cxx: "cpp",
        hpp: "cpp",

        cs: "csharp",

        go: "go",
        rs: "rust",

        sql: "sql",

        toml: "ini",
        ini: "ini",
        conf: "ini",
        cfg: "ini",

        properties: "ini",

        vue: "html",
    };

    return (
        languages[extension] ??
        "plaintext"
    );
}

export function getRemoteEditorModelPath(
    connectionId: string,
    remotePath: string,
): string {
    return [
        "inmemory://ssh-workspace",
        encodeURIComponent(
            connectionId,
        ),
        encodeURIComponent(
            remotePath,
        ),
    ].join("/");
}

export function createEditorTabFromSnapshot(
    connectionId: string,
    snapshot:
        RemoteTextFileSnapshot,
): RemoteTextEditorTab {
    const content =
        decodeBase64Utf8(
            snapshot.contentBase64,
        );

    return {
        path: snapshot.path,
        name: snapshot.name,
        kind: "text",

        modelPath:
            getRemoteEditorModelPath(
                connectionId,
                snapshot.path,
            ),

        language:
            getRemoteEditorLanguage(
                snapshot.name,
            ),

        content,
        savedContent: content,

        revision:
            snapshot.revision,

        encoding:
            snapshot.encoding,

        size:
            snapshot.size,

        modifiedAt:
            snapshot.modifiedAt,

        permissions:
            snapshot.permissions,

        readOnly:
            snapshot.readOnly,

        status: "ready",

        isSaving: false,
        isReloading: false,

        error: "",
    };
}

export function createImageTabFromSnapshot(
    snapshot:
        RemoteImageSnapshot,
): RemoteImageViewerTab {
    return {
        kind: "image",

        path: snapshot.path,
        name: snapshot.name,

        contentBase64:
            snapshot.contentBase64,

        mimeType:
            snapshot.mimeType,

        revision:
            snapshot.revision,

        size:
            snapshot.size,

        modifiedAt:
            snapshot.modifiedAt,

        permissions:
            snapshot.permissions,

        status: "ready",
        isReloading: false,

        error: "",
    };
}