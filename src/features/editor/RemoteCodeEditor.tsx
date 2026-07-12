import {
    useEffect,
    useRef,
} from "react";

import Editor, {
    type OnMount,
} from "@monaco-editor/react";

import type * as Monaco from
    "monaco-editor";

import "./monaco-setup";

import type {
    RemoteEditorTab,
} from "./editor-types";

interface RemoteCodeEditorProps {
    tab: RemoteEditorTab;

    isVisible: boolean;

    onChange: (
        value: string,
    ) => void;

    onSave: () => Promise<void>;

    onCursorChange: (
        line: number,
        column: number,
    ) => void;
}

export function RemoteCodeEditor({
    tab,
    isVisible,
    onChange,
    onSave,
    onCursorChange,
}: RemoteCodeEditorProps) {
    const editorRef =
        useRef<
            Monaco.editor.IStandaloneCodeEditor |
            null
        >(null);

    const saveHandlerRef =
        useRef(onSave);

    const cursorSubscriptionRef =
        useRef<
            Monaco.IDisposable |
            null
        >(null);

    useEffect(() => {
        saveHandlerRef.current =
            onSave;
    }, [onSave]);

    useEffect(() => {
        if (
            !isVisible ||
            !editorRef.current
        ) {
            return;
        }

        const timeoutId =
            window.setTimeout(() => {
                editorRef.current?.layout();
                editorRef.current?.focus();
            }, 0);

        return () => {
            window.clearTimeout(
                timeoutId,
            );
        };
    }, [
        isVisible,
        tab.path,
    ]);

    useEffect(() => {
        return () => {
            cursorSubscriptionRef
                .current
                ?.dispose();
        };
    }, []);

    const handleMount: OnMount = (
        editor,
        monaco,
    ) => {
        editorRef.current =
            editor;

        editor.addCommand(
            monaco.KeyMod.CtrlCmd |
            monaco.KeyCode.KeyS,
            () => {
                void saveHandlerRef
                    .current();
            },
        );

        cursorSubscriptionRef
            .current
            ?.dispose();

        cursorSubscriptionRef.current =
            editor.onDidChangeCursorPosition(
                (event) => {
                    onCursorChange(
                        event.position
                            .lineNumber,

                        event.position
                            .column,
                    );
                },
            );

        editor.focus();
    };

    return (
        <Editor
            path={tab.modelPath}
            language={tab.language}
            value={tab.content}
            theme="vs-dark"
            saveViewState
            keepCurrentModel
            onMount={handleMount}
            onChange={(value) =>
                onChange(
                    value ?? "",
                )
            }
            loading={
                <div className="remote-editor-loading">
                    Loading editor…
                </div>
            }
            options={{
                readOnly:
                    tab.readOnly ||
                    tab.isSaving,

                automaticLayout: true,

                fontFamily:
                    '"Cascadia Code", Consolas, "Courier New", monospace',

                fontSize: 13,
                lineHeight: 21,

                minimap: {
                    enabled: false,
                },

                scrollBeyondLastLine:
                    false,

                smoothScrolling: true,

                wordWrap: "off",

                tabSize: 4,
                insertSpaces: true,
                detectIndentation: true,

                renderWhitespace:
                    "selection",

                renderControlCharacters:
                    true,

                bracketPairColorization: {
                    enabled: true,
                },

                guides: {
                    bracketPairs: true,
                    indentation: true,
                },

                padding: {
                    top: 12,
                    bottom: 12,
                },

                cursorBlinking:
                    "smooth",

                cursorSmoothCaretAnimation:
                    "on",

                overviewRulerBorder:
                    false,

                fixedOverflowWidgets:
                    true,
            }}
        />
    );
}
