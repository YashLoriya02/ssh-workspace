export interface SftpServerOption {
    connectionId: string;

    title: string;
    host: string;
    port: number;
    username: string;
}

export type SftpPaneSource =
    | {
        type: "empty";
    }
    | {
        type: "local";
        rootPath: string | null;
        path: string | null;
    }
    | {
        type: "remote";
        connectionId: string;
        path: string | null;
    };

export type SftpPaneSide =
    | "left"
    | "right";
