import { useEffect, useState } from "react";
import LoginPage from "./LoginPage";
import ChatPage from "./ChatPage";
import { clearAuth, loadAuth, LoginResult, saveAuth } from "./api";

interface AuthState {
  token: string;
  userId: string;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  // Restore session on mount.
  useEffect(() => {
    const stored = loadAuth();
    if (stored) {
      setAuth({ token: stored.token, userId: stored.user_id });
    }
  }, []);

  function handleLoggedIn(result: LoginResult) {
    saveAuth(result);
    setAuth({ token: result.token, userId: result.user_id });
  }

  function handleLogout() {
    clearAuth();
    setAuth(null);
  }

  if (!auth) {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }
  return (
    <ChatPage
      token={auth.token}
      userId={auth.userId}
      onLogout={handleLogout}
    />
  );
}
