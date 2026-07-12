import {
    useEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react";

import {
    save as saveDialog,
} from "@tauri-apps/plugin-dialog";

import {
    Download,
    ImageIcon,
    Loader,
    Maximize2,
    RefreshCcw,
    ZoomIn,
    ZoomOut,
} from "lucide-react";

import {
    backendClient,
} from "../../backend/backend-client";

import type {
    RemoteImageViewerTab,
} from "./editor-types";

interface RemoteImageViewerProps {
    connectionId: string;

    tab:
    RemoteImageViewerTab |
    null;

    isVisible: boolean;
    isSessionActive: boolean;

    onReload:
    () => Promise<void>;

    onRetry:
    () => Promise<void>;
}

interface ImageDimensions {
    width: number;
    height: number;
}

function createImageBlob(
    contentBase64: string,
    mimeType: string,
): Blob {
    const binary =
        window.atob(
            contentBase64,
        );

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
            binary.charCodeAt(
                index,
            );
    }

    return new Blob(
        [bytes],
        {
            type: mimeType,
        },
    );
}

function formatImageSize(
    bytes: number,
): string {
    if (bytes < 1_024) {
        return `${bytes} B`;
    }

    if (
        bytes <
        1_024 * 1_024
    ) {
        return `${(
            bytes / 1_024
        ).toFixed(1)} KB`;
    }

    return `${(
        bytes /
        (
            1_024 *
            1_024
        )
    ).toFixed(1)} MB`;
}

function formatImageModifiedAt(
    timestamp: number | null,
): string {
    if (timestamp === null) {
        return "—";
    }

    return new Date(
        timestamp * 1000,
    ).toLocaleString();
}

function clampZoom(
    zoom: number,
): number {
    return Math.min(
        5,
        Math.max(
            0.1,
            zoom,
        ),
    );
}

export function RemoteImageViewer({
    connectionId,
    tab,
    isVisible,
    isSessionActive,
    onReload,
    onRetry,
}: RemoteImageViewerProps) {
    const [
        objectUrl,
        setObjectUrl,
    ] = useState<
        string | null
    >(null);

    const [
        dimensions,
        setDimensions,
    ] = useState<
        ImageDimensions |
        null
    >(null);

    const [
        viewMode,
        setViewMode,
    ] = useState<
        "fit" |
        "custom"
    >("fit");

    const [
        zoom,
        setZoom,
    ] = useState(1);

    const [
        isPanning,
        setIsPanning,
    ] = useState(false);

    const [
        isDownloading,
        setIsDownloading,
    ] = useState(false);

    const [
        downloadError,
        setDownloadError,
    ] = useState("");

    const stageRef =
        useRef<
            HTMLDivElement |
            null
        >(null);

    const panRef =
        useRef({
            startX: 0,
            startY: 0,

            scrollLeft: 0,
            scrollTop: 0,
        });

    useEffect(() => {
        setObjectUrl(null);

        if (
            !tab ||
            tab.status !==
            "ready" ||
            !tab.mimeType
        ) {
            return;
        }

        const blob =
            createImageBlob(
                tab.contentBase64,
                tab.mimeType,
            );

        const nextObjectUrl =
            URL.createObjectURL(
                blob,
            );

        setObjectUrl(
            nextObjectUrl,
        );

        return () => {
            URL.revokeObjectURL(
                nextObjectUrl,
            );
        };
    }, [
        tab?.path,
        tab?.revision,
        tab?.status,
        tab?.mimeType,
        tab?.contentBase64,
    ]);

    useEffect(() => {
        setDimensions(null);
        setViewMode("fit");
        setZoom(1);
        setDownloadError("");

        if (
            stageRef.current
        ) {
            stageRef.current.scrollLeft =
                0;

            stageRef.current.scrollTop =
                0;
        }
    }, [
        tab?.path,
        tab?.revision,
    ]);

    function changeZoom(
        difference: number,
    ): void {
        setViewMode(
            "custom",
        );

        setZoom(
            (current) =>
                clampZoom(
                    current +
                    difference,
                ),
        );
    }

    function handlePointerDown(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (
            viewMode !==
            "custom" ||
            event.button !== 0
        ) {
            return;
        }

        const stage =
            event.currentTarget;

        panRef.current = {
            startX:
                event.clientX,

            startY:
                event.clientY,

            scrollLeft:
                stage.scrollLeft,

            scrollTop:
                stage.scrollTop,
        };

        stage.setPointerCapture(
            event.pointerId,
        );

        setIsPanning(true);
    }

    function handlePointerMove(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (
            !isPanning
        ) {
            return;
        }

        const stage =
            event.currentTarget;

        stage.scrollLeft =
            panRef.current.scrollLeft -
            (
                event.clientX -
                panRef.current.startX
            );

        stage.scrollTop =
            panRef.current.scrollTop -
            (
                event.clientY -
                panRef.current.startY
            );
    }

    function finishPanning(
        event:
            ReactPointerEvent<HTMLDivElement>,
    ): void {
        if (
            event.currentTarget
                .hasPointerCapture(
                    event.pointerId,
                )
        ) {
            event.currentTarget
                .releasePointerCapture(
                    event.pointerId,
                );
        }

        setIsPanning(false);
    }

    async function handleDownload():
        Promise<void> {
        if (
            !tab ||
            isDownloading
        ) {
            return;
        }

        setDownloadError("");

        try {
            const localPath =
                await saveDialog({
                    title:
                        `Download ${tab.name}`,

                    defaultPath:
                        tab.name,
                });

            if (!localPath) {
                return;
            }

            setIsDownloading(true);

            await backendClient
                .downloadRemoteFile(
                    connectionId,
                    tab.path,
                    localPath,
                );
        } catch (error) {
            setDownloadError(
                error instanceof Error
                    ? error.message
                    : String(error),
            );
        } finally {
            setIsDownloading(false);
        }
    }

    const zoomPercentage =
        Math.round(
            zoom * 100,
        );

    return (
        <section
            className={
                isVisible
                    ? "remote-image-panel"
                    : "remote-image-panel remote-image-panel--hidden"
            }
        >
            {tab ? (
                <>
                    <header className="remote-image-toolbar">
                        <div className="remote-image-toolbar__file">
                            <strong>
                                <ImageIcon
                                    size={14}
                                />

                                {tab.name}
                            </strong>

                            <span title={tab.path}>
                                {tab.path}
                            </span>
                        </div>

                        <div className="remote-image-toolbar__actions">
                            <button
                                type="button"
                                className={
                                    viewMode ===
                                        "fit"
                                        ? "remote-image-tool remote-image-tool--active"
                                        : "remote-image-tool"
                                }
                                disabled={
                                    tab.status !==
                                    "ready"
                                }
                                onClick={() =>
                                    setViewMode(
                                        "fit",
                                    )
                                }
                                title="Fit image to window"
                            >
                                <Maximize2
                                    size={14}
                                />

                                Fit
                            </button>

                            <button
                                type="button"
                                className="remote-image-tool"
                                disabled={
                                    tab.status !==
                                    "ready"
                                }
                                onClick={() => {
                                    setViewMode(
                                        "custom",
                                    );

                                    setZoom(1);
                                }}
                                title="Show image at actual size"
                            >
                                100%
                            </button>

                            <button
                                type="button"
                                className="remote-image-tool remote-image-tool--icon"
                                disabled={
                                    tab.status !==
                                    "ready"
                                }
                                onClick={() =>
                                    changeZoom(
                                        -0.1,
                                    )
                                }
                                title="Zoom out"
                            >
                                <ZoomOut
                                    size={14}
                                />
                            </button>

                            <span className="remote-image-zoom">
                                {viewMode ===
                                    "fit"
                                    ? "Fit"
                                    : `${zoomPercentage}%`}
                            </span>

                            <button
                                type="button"
                                className="remote-image-tool remote-image-tool--icon"
                                disabled={
                                    tab.status !==
                                    "ready"
                                }
                                onClick={() =>
                                    changeZoom(
                                        0.1,
                                    )
                                }
                                title="Zoom in"
                            >
                                <ZoomIn
                                    size={14}
                                />
                            </button>

                            <button
                                type="button"
                                className="remote-image-tool"
                                disabled={
                                    !isSessionActive ||
                                    tab.isReloading
                                }
                                onClick={() =>
                                    void onReload()
                                }
                                title="Reload image from remote server"
                            >
                                {tab.isReloading ? (
                                    <Loader
                                        size={14}
                                        className="loader"
                                    />
                                ) : (
                                    <RefreshCcw
                                        size={14}
                                    />
                                )}

                                Reload
                            </button>

                            <button
                                type="button"
                                className="remote-image-download"
                                disabled={
                                    !isSessionActive ||
                                    isDownloading
                                }
                                onClick={() =>
                                    void handleDownload()
                                }
                            >
                                {isDownloading ? (
                                    <Loader
                                        size={14}
                                        className="loader"
                                    />
                                ) : (
                                    <Download
                                        size={14}
                                    />
                                )}

                                Download
                            </button>
                        </div>
                    </header>

                    {(tab.error ||
                        downloadError) && (
                            <div className="remote-image-error">
                                {tab.error ||
                                    downloadError}
                            </div>
                        )}

                    <div className="remote-image-body">
                        {tab.status ===
                            "loading" ? (
                            <div className="remote-image-state">
                                <Loader className="loader" />

                                <strong>
                                    Opening {tab.name}
                                </strong>

                                <span>
                                    Reading and validating the remote image…
                                </span>
                            </div>
                        ) : tab.status ===
                            "error" ? (
                            <div className="remote-image-state">
                                <ImageIcon
                                    size={32}
                                />

                                <strong>
                                    Unable to preview this image
                                </strong>

                                <span>
                                    {tab.error}
                                </span>

                                <button
                                    type="button"
                                    onClick={() =>
                                        void onRetry()
                                    }
                                >
                                    Try Again
                                </button>
                            </div>
                        ) : objectUrl ? (
                            <div
                                ref={
                                    stageRef
                                }
                                className={[
                                    "remote-image-stage",

                                    viewMode ===
                                        "fit"
                                        ? "remote-image-stage--fit"
                                        : "remote-image-stage--custom",

                                    isPanning
                                        ? "remote-image-stage--panning"
                                        : "",
                                ]
                                    .filter(
                                        Boolean,
                                    )
                                    .join(" ")}
                                onPointerDown={
                                    handlePointerDown
                                }
                                onPointerMove={
                                    handlePointerMove
                                }
                                onPointerUp={
                                    finishPanning
                                }
                                onPointerCancel={
                                    finishPanning
                                }
                            >
                                <img
                                    src={
                                        objectUrl
                                    }
                                    alt={
                                        tab.name
                                    }
                                    draggable={
                                        false
                                    }
                                    className={
                                        viewMode ===
                                            "fit"
                                            ? "remote-image-preview remote-image-preview--fit"
                                            : "remote-image-preview remote-image-preview--custom"
                                    }
                                    style={
                                        viewMode ===
                                            "custom" &&
                                            dimensions
                                            ? {
                                                width:
                                                    `${Math.max(
                                                        1,
                                                        dimensions.width *
                                                        zoom,
                                                    )}px`,
                                            }
                                            : undefined
                                    }
                                    onLoad={(
                                        event,
                                    ) => {
                                        setDimensions({
                                            width:
                                                event
                                                    .currentTarget
                                                    .naturalWidth,

                                            height:
                                                event
                                                    .currentTarget
                                                    .naturalHeight,
                                        });
                                    }}
                                />
                            </div>
                        ) : (
                            <div className="remote-image-state">
                                Preparing image…
                            </div>
                        )}
                    </div>

                    <footer className="remote-image-statusbar">
                        <span
                            className="remote-image-statusbar__path"
                            title={tab.path}
                        >
                            {tab.path}
                        </span>

                        <div className="remote-image-statusbar__details">
                            <span>
                                {tab.mimeType
                                    ?.replace(
                                        "image/",
                                        "",
                                    )
                                    .toUpperCase() ??
                                    "IMAGE"}
                            </span>

                            <span>
                                {dimensions
                                    ? `${dimensions.width} × ${dimensions.height}`
                                    : "—"}
                            </span>

                            <span>
                                {formatImageSize(
                                    tab.size,
                                )}
                            </span>

                            <span>
                                {tab.permissions ??
                                    "—"}
                            </span>

                            <span>
                                {formatImageModifiedAt(
                                    tab.modifiedAt,
                                )}
                            </span>
                        </div>
                    </footer>
                </>
            ) : (
                <div className="remote-image-state">
                    No image selected.
                </div>
            )}
        </section>
    );
}