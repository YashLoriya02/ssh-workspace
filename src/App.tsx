import { useState } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";

import { backendClient } from "./backend/backend-client";
import { SshConnectionTest } from "./features/ssh/SshConnectionTest";
import { WorkspacePage } from "./features/ssh/WorkspacePage";

import "./App.css";

function AppRoutes() {
  const navigate = useNavigate();

  const [connectionId, setConnectionId] =
    useState<string | null>(null);

  function handleConnected(
    newConnectionId: string,
  ): void {
    setConnectionId(newConnectionId);
    navigate("/workspace");
  }

  async function handleBack(): Promise<void> {
    const activeConnectionId = connectionId;

    setConnectionId(null);

    if (activeConnectionId) {
      try {
        await backendClient.disconnectSsh(
          activeConnectionId,
        );
      } catch (error) {
        console.error(
          "Failed to disconnect SSH:",
          error,
        );
      }
    }

    navigate("/", {
      replace: true,
    });
  }

  function handleDisconnected(): void {
    setConnectionId(null);

    navigate("/", {
      replace: true,
    });
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <SshConnectionTest
            onConnected={handleConnected}
          />
        }
      />

      <Route
        path="/workspace"
        element={
          connectionId ? (
            <WorkspacePage
              connectionId={connectionId}
              onBack={handleBack}
              onDisconnected={
                handleDisconnected
              }
            />
          ) : (
            <Navigate
              to="/"
              replace
            />
          )
        }
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