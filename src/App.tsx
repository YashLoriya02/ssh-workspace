import {
  useCallback,
  useEffect,
  useReducer,
  useState,
} from "react";

import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

import {
  Plus,
  Server,
  ServerOff,
  X,
} from "lucide-react";

import {
  backendClient,
  type BackendState,
} from "./backend/backend-client";

import {
  AppHeader,
  type AppArea,
} from "./components/AppHeader";

import {
  SshConnectionTest,
  type ConnectedWorkspaceDetails,
} from "./features/ssh/SshConnectionTest";

import {
  WorkspacePage,
} from "./features/ssh/WorkspacePage";

import "./App.css";

interface WorkspaceSession
  extends ConnectedWorkspaceDetails {}

interface WorkspaceState {
  sessions: WorkspaceSession[];
  activeConnectionId: string | null;
}

type WorkspaceAction =
  | {
      type: "add";
      session: WorkspaceSession;
    }
  | {
      type: "select";
      connectionId: string;
    }
  | {
      type: "remove";
      connectionId: string;
    };

const initialWorkspaceState:
  WorkspaceState = {
    sessions: [],
    activeConnectionId: null,
  };

function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "add": {
      const existingIndex =
        state.sessions.findIndex(
          (session) =>
            session.connectionId ===
            action.session.connectionId,
        );

      if (existingIndex >= 0) {
        const nextSessions = [
          ...state.sessions,
        ];

        nextSessions[existingIndex] =
          action.session;

        return {
          sessions: nextSessions,
          activeConnectionId:
            action.session.connectionId,
        };
      }

      return {
        sessions: [
          ...state.sessions,
          action.session,
        ],

        activeConnectionId:
          action.session.connectionId,
      };
    }

    case "select": {
      const exists =
        state.sessions.some(
          (session) =>
            session.connectionId ===
            action.connectionId,
        );

      if (!exists) {
        return state;
      }

      return {
        ...state,
        activeConnectionId:
          action.connectionId,
      };
    }

    case "remove": {
      const removalIndex =
        state.sessions.findIndex(
          (session) =>
            session.connectionId ===
            action.connectionId,
        );

      if (removalIndex < 0) {
        return state;
      }

      const nextSessions =
        state.sessions.filter(
          (session) =>
            session.connectionId !==
            action.connectionId,
        );

      if (
        state.activeConnectionId !==
        action.connectionId
      ) {
        return {
          sessions: nextSessions,
          activeConnectionId:
            state.activeConnectionId,
        };
      }

      /*
       * Prefer the tab immediately to the right.
       * If none exists, use the tab on the left.
       */
      const fallbackIndex =
        Math.min(
          removalIndex,
          nextSessions.length - 1,
        );

      const fallbackSession =
        fallbackIndex >= 0
          ? nextSessions[fallbackIndex]
          : undefined;

      return {
        sessions: nextSessions,

        activeConnectionId:
          fallbackSession?.connectionId ??
          null,
      };
    }

    default:
      return state;
  }
}

function isTerminalEventTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(
    target.closest(
      ".xterm, .terminal-container",
    ),
  );
}

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();

  const [
    workspaceState,
    dispatchWorkspace,
  ] = useReducer(
    workspaceReducer,
    initialWorkspaceState,
  );

  const {
    sessions,
    activeConnectionId,
  } = workspaceState;

  const [
    backendState,
    setBackendState,
  ] = useState<BackendState>({
    status: "stopped",
  });

  const [
    closingConnectionIds,
    setClosingConnectionIds,
  ] = useState<Set<string>>(
    () => new Set(),
  );

  const isMac =
    /Mac|iPhone|iPad|iPod/u.test(
      navigator.platform,
    );

  const shortcutModifierLabel =
    isMac
      ? "⌘"
      : "Ctrl";

  const isSessionsRoute =
    location.pathname ===
    "/workspace";

  const currentArea: AppArea =
    isSessionsRoute
      ? "sessions"
      : "connections";

  useEffect(() => {
    return backendClient.subscribeToState(
      setBackendState,
    );
  }, []);

  useEffect(() => {
    document.title =
      sessions.length > 0
        ? `SSH Workspace · ${sessions.length} active`
        : "SSH Workspace";
  }, [sessions.length]);

  const handleOpenConnections =
    useCallback((): void => {
      navigate("/");
    }, [navigate]);

  const handleOpenSessions =
    useCallback((): void => {
      navigate("/workspace");
    }, [navigate]);

  const handleConnected =
    useCallback(
      (
        workspace:
          ConnectedWorkspaceDetails,
      ): void => {
        dispatchWorkspace({
          type: "add",
          session: workspace,
        });

        navigate("/workspace");
      },
      [navigate],
    );

  const handleSelectSession =
    useCallback(
      (
        connectionId: string,
      ): void => {
        dispatchWorkspace({
          type: "select",
          connectionId,
        });

        navigate("/workspace");
      },
      [navigate],
    );

  const handleDisconnected =
    useCallback(
      (
        connectionId: string,
      ): void => {
        dispatchWorkspace({
          type: "remove",
          connectionId,
        });
      },
      [],
    );

  const handleCloseSession =
    useCallback(
      async (
        connectionId: string,
      ): Promise<void> => {
        if (
          closingConnectionIds.has(
            connectionId,
          )
        ) {
          return;
        }

        setClosingConnectionIds(
          (currentConnectionIds) => {
            const nextConnectionIds =
              new Set(
                currentConnectionIds,
              );

            nextConnectionIds.add(
              connectionId,
            );

            return nextConnectionIds;
          },
        );

        try {
          await backendClient.disconnectSsh(
            connectionId,
          );
        } catch (error) {
          console.error(
            `Failed to disconnect SSH connection ${connectionId}:`,
            error,
          );
        } finally {
          dispatchWorkspace({
            type: "remove",
            connectionId,
          });

          setClosingConnectionIds(
            (currentConnectionIds) => {
              const nextConnectionIds =
                new Set(
                  currentConnectionIds,
                );

              nextConnectionIds.delete(
                connectionId,
              );

              return nextConnectionIds;
            },
          );
        }
      },
      [closingConnectionIds],
    );

  /*
   * Global keyboard shortcuts.
   *
   * Ctrl+W is not captured while xterm has focus,
   * because shells commonly use Ctrl+W to delete
   * the previous word.
   */
  useEffect(() => {
    function handleGlobalKeyDown(
      event: KeyboardEvent,
    ): void {
      const key =
        event.key.toLowerCase();

      const primaryModifierPressed =
        isMac
          ? event.metaKey
          : event.ctrlKey;

      /*
       * Add Connection
       *
       * Windows/Linux: Ctrl+T
       * macOS: Cmd+T
       */
      if (
        primaryModifierPressed &&
        !event.altKey &&
        key === "t"
      ) {
        event.preventDefault();
        event.stopPropagation();

        handleOpenConnections();
        return;
      }

      /*
       * Switch to next or previous SSH session.
       *
       * Ctrl+Tab
       * Ctrl+Shift+Tab
       *
       * Ctrl is deliberately used on macOS because
       * Cmd+Tab is reserved by the operating system.
       */
      if (
        event.ctrlKey &&
        !event.altKey &&
        key === "tab" &&
        sessions.length > 0
      ) {
        event.preventDefault();
        event.stopPropagation();

        const currentIndex =
          sessions.findIndex(
            (session) =>
              session.connectionId ===
              activeConnectionId,
          );

        const startingIndex =
          currentIndex >= 0
            ? currentIndex
            : 0;

        const direction =
          event.shiftKey
            ? -1
            : 1;

        const nextIndex =
          (
            startingIndex +
            direction +
            sessions.length
          ) %
          sessions.length;

        const nextSession =
          sessions[nextIndex];

        if (!nextSession) {
          return;
        }

        dispatchWorkspace({
          type: "select",
          connectionId:
            nextSession.connectionId,
        });

        navigate("/workspace");
        return;
      }

      /*
       * Direct session selection.
       *
       * Windows/Linux: Ctrl+1 through Ctrl+9
       * macOS: Cmd+1 through Cmd+9
       */
      if (
        primaryModifierPressed &&
        !event.altKey &&
        !event.shiftKey &&
        /^[1-9]$/u.test(key)
      ) {
        const requestedIndex =
          Number(key) - 1;

        const requestedSession =
          sessions[requestedIndex];

        if (!requestedSession) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        dispatchWorkspace({
          type: "select",
          connectionId:
            requestedSession.connectionId,
        });

        navigate("/workspace");
        return;
      }

      if (
        key !== "w" ||
        !isSessionsRoute ||
        !activeConnectionId
      ) {
        return;
      }

      const terminalFocused =
        isTerminalEventTarget(
          event.target,
        );

      /*
       * macOS:
       * Cmd+W closes the active SSH session.
       *
       * Windows/Linux:
       * Ctrl+Shift+W always closes it.
       * Ctrl+W closes it only outside xterm.
       */
      const shouldCloseOnMac =
        isMac &&
        event.metaKey &&
        !event.altKey;

      const shouldCloseOnWindows =
        !isMac &&
        event.ctrlKey &&
        !event.altKey &&
        (
          event.shiftKey ||
          !terminalFocused
        );

      if (
        !shouldCloseOnMac &&
        !shouldCloseOnWindows
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void handleCloseSession(
        activeConnectionId,
      );
    }

    window.addEventListener(
      "keydown",
      handleGlobalKeyDown,
      true,
    );

    return () => {
      window.removeEventListener(
        "keydown",
        handleGlobalKeyDown,
        true,
      );
    };
  }, [
    activeConnectionId,
    handleCloseSession,
    handleOpenConnections,
    isMac,
    isSessionsRoute,
    navigate,
    sessions,
  ]);

  return (
    <div className="app-shell">
      <AppHeader
        currentArea={currentArea}
        activeSessionCount={
          sessions.length
        }
        backendStatus={
          backendState.status
        }
        shortcutModifierLabel={
          shortcutModifierLabel
        }
        onOpenConnections={
          handleOpenConnections
        }
        onOpenSessions={
          handleOpenSessions
        }
      />

      <div className="app-shell__content">
        <Routes>
          <Route
            path="/"
            element={
              <SshConnectionTest
                onConnected={
                  handleConnected
                }
              />
            }
          />

          <Route
            path="/workspace"
            element={<></>}
          />

          <Route
            path="*"
            element={
              <Navigate
                to="/"
                replace
              />
            }
          />
        </Routes>

        {isSessionsRoute &&
          sessions.length === 0 && (
            <main className="active-sessions-empty-page">
              <section className="active-sessions-empty">
                <div className="active-sessions-empty__icon">
                  <ServerOff
                    size={30}
                    aria-hidden="true"
                  />
                </div>

                <h1>
                  No active SSH sessions
                </h1>

                <p>
                  Connect to a server to open
                  a terminal and remote file
                  explorer.
                </p>

                <button
                  type="button"
                  className="active-sessions-empty__button"
                  onClick={
                    handleOpenConnections
                  }
                >
                  <Plus
                    size={16}
                    aria-hidden="true"
                  />

                  Add Connection
                </button>
              </section>
            </main>
          )}

        {sessions.length > 0 && (
          <div
            className={
              isSessionsRoute
                ? "workspace-tabs-shell"
                : "workspace-tabs-shell workspace-tabs-shell--hidden"
            }
            aria-hidden={
              !isSessionsRoute
            }
          >
            <header className="workspace-tabs-bar">
              <div
                className="workspace-tabs-list"
                role="tablist"
                aria-label="SSH sessions"
              >
                {sessions.map(
                  (
                    session,
                    sessionIndex,
                  ) => {
                    const isActive =
                      session.connectionId ===
                      activeConnectionId;

                    const isClosing =
                      closingConnectionIds.has(
                        session.connectionId,
                      );

                    return (
                      <div
                        key={
                          session.connectionId
                        }
                        className={
                          isActive
                            ? "workspace-tab workspace-tab--active"
                            : "workspace-tab"
                        }
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={
                            isActive
                          }
                          className="workspace-tab__select"
                          onClick={() =>
                            handleSelectSession(
                              session.connectionId,
                            )
                          }
                          title={[
                            session.title,
                            `${session.username}@${session.host}:${session.port}`,
                            `Shortcut: ${shortcutModifierLabel}+${sessionIndex + 1}`,
                          ].join("\n")}
                        >
                          <Server
                            size={14}
                            aria-hidden="true"
                          />

                          <span className="workspace-tab__text">
                            <strong>
                              {session.title}
                            </strong>
                          </span>

                          <span
                            className="workspace-tab__status"
                            title="Connected"
                          />
                        </button>

                        <button
                          type="button"
                          className="workspace-tab__close"
                          onClick={(
                            event,
                          ) => {
                            event.stopPropagation();

                            void handleCloseSession(
                              session.connectionId,
                            );
                          }}
                          disabled={
                            isClosing
                          }
                          title={
                            isClosing
                              ? "Disconnecting…"
                              : `Close ${session.title}`
                          }
                          aria-label={
                            isClosing
                              ? `Disconnecting ${session.title}`
                              : `Close ${session.title}`
                          }
                        >
                          <X
                            size={14}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                    );
                  },
                )}
              </div>
            </header>

            <div className="workspace-tabs-content">
              {sessions.map(
                (session) => {
                  const isActive =
                    session.connectionId ===
                    activeConnectionId;

                  return (
                    <div
                      key={
                        session.connectionId
                      }
                      className={
                        isActive
                          ? "workspace-tab-panel workspace-tab-panel--active"
                          : "workspace-tab-panel"
                      }
                      role="tabpanel"
                      aria-hidden={
                        !isActive
                      }
                    >
                      <WorkspacePage
                        connectionId={
                          session.connectionId
                        }
                        host={
                          session.host
                        }
                        port={
                          session.port
                        }
                        username={
                          session.username
                        }
                        isActive={
                          isSessionsRoute &&
                          isActive
                        }
                        onDisconnected={
                          handleDisconnected
                        }
                      />
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}

export default App;