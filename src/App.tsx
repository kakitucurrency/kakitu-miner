import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

interface SessionStats {
  workCompleted: number;
  kshsEarned: number;
}

interface NetworkStats {
  connectedWorkers: number;
  totalPaid: number;
  reward: number;
}

interface WorkStartedPayload {
  hash: string;
}

interface WorkCompletedPayload {
  hash: string;
  work: string;
}

interface PaidPayload {
  hash: string;
  amount: string;
  tx_hash: string;
}

interface ConnectionStatusPayload {
  connected: boolean;
  message: string;
}

interface WorkHistoryEntry {
  hash: string;
  work: string;
  time: string;
  paid: boolean;
}

type TabId = "session" | "worklog";

function App() {
  const [address, setAddress] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [isMining, setIsMining] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("session");
  const [workHistory, setWorkHistory] = useState<WorkHistoryEntry[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    workCompleted: 0,
    kshsEarned: 0,
  });
  const [networkStats, setNetworkStats] = useState<NetworkStats>({
    connectedWorkers: 0,
    totalPaid: 0,
    reward: 0.01,
  });

  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNetworkStats = async () => {
    try {
      const res = await fetch("https://work.kakitu.org/stats");
      if (res.ok) {
        const data = await res.json();
        setNetworkStats((prev) => ({
          connectedWorkers: data.connected_workers ?? prev.connectedWorkers,
          totalPaid: parseFloat(data.total_kshs_paid ?? prev.totalPaid.toString()),
          reward: parseFloat(data.work_reward_kshs ?? prev.reward.toString()),
        }));
      }
    } catch {
      // silently ignore — network may not be up yet
    }
  };

  useEffect(() => {
    const setupListeners = async () => {
      const unWork = await listen<WorkStartedPayload>("work_started", (event) => {
        setIsMining(true);
        setCurrentHash(event.payload.hash);
      });

      const unDone = await listen<WorkCompletedPayload>("work_completed", (event) => {
        setIsMining(false);
        setCurrentHash(event.payload.hash);
        setSessionStats((prev) => ({
          ...prev,
          workCompleted: prev.workCompleted + 1,
        }));

        // Push to work history (newest first, max 50)
        const entry: WorkHistoryEntry = {
          hash: event.payload.hash,
          work: event.payload.work,
          time: new Date().toLocaleTimeString(),
          paid: false,
        };
        setWorkHistory((prev) => [entry, ...prev].slice(0, 50));

        // clear hash display after short delay
        setTimeout(() => setCurrentHash(null), 2000);
      });

      const unPaid = await listen<PaidPayload>("paid", (event) => {
        const amount = parseFloat(event.payload.amount) || 0;
        setSessionStats((prev) => ({
          ...prev,
          kshsEarned: prev.kshsEarned + amount,
        }));

        // Mark the matching hash as paid in work history
        setWorkHistory((prev) =>
          prev.map((entry) =>
            entry.hash === event.payload.hash ? { ...entry, paid: true } : entry
          )
        );
      });

      const unStatus = await listen<ConnectionStatusPayload>(
        "connection_status",
        (event) => {
          setIsConnected(event.payload.connected);
          setConnectionMessage(event.payload.message);
          setIsConnecting(false);
          if (!event.payload.connected) {
            setIsMining(false);
            setCurrentHash(null);
          }
        }
      );

      unlistenRefs.current = [unWork, unDone, unPaid, unStatus];
    };

    setupListeners();

    // Poll network stats every 10 seconds
    fetchNetworkStats();
    statsIntervalRef.current = setInterval(fetchNetworkStats, 10000);

    return () => {
      unlistenRefs.current.forEach((fn) => fn());
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    };
  }, []);

  const handleConnect = async () => {
    if (!address.trim()) {
      setConnectionMessage("Please enter your KSHS address.");
      return;
    }
    setIsConnecting(true);
    setConnectionMessage("Connecting...");
    try {
      await invoke("connect_worker", { address: address.trim() });
    } catch (err) {
      setConnectionMessage(`Error: ${err}`);
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await invoke("disconnect_worker");
    } catch {
      // ignore
    }
    setIsConnected(false);
    setIsMining(false);
    setCurrentHash(null);
    setConnectionMessage("Disconnected.");
  };

  const dotClass = isMining ? "mining" : isConnected ? "connected" : "";

  const miningStatusText = isMining
    ? "hashing..."
    : isConnected
    ? "connected · waiting for work"
    : "idle";

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-title">
          <span className="pick">⛏</span>
          <span>kakitu <span>miner</span></span>
        </div>
        <div className={`status-dot ${dotClass}`} title={miningStatusText} />
      </header>

      {/* Body */}
      <div className="body">
        {/* Address field */}
        <div>
          <div className="field-label">Your KSHS Address</div>
          <input
            className="address-input"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="kshs_1..."
            disabled={isConnected || isConnecting}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Connect / Disconnect button */}
        {!isConnected ? (
          <button
            className="connect-btn connect"
            onClick={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </button>
        ) : (
          <button className="connect-btn disconnect" onClick={handleDisconnect}>
            Disconnect
          </button>
        )}

        {connectionMessage && (
          <div
            className={`connection-message ${
              connectionMessage.toLowerCase().startsWith("error") ? "error" : ""
            }`}
          >
            {connectionMessage}
          </div>
        )}

        {/* Mining visual */}
        <div className={`mining-panel ${isMining ? "active" : ""}`}>
          {isMining ? (
            <div className="hash-animation">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="hash-dot" />
              ))}
            </div>
          ) : isConnected ? (
            <div className="connected-icon">⚡</div>
          ) : (
            <div className="idle-icon">⛏</div>
          )}

          <div className={`mining-status-text ${isMining ? "active" : ""}`}>
            {miningStatusText}
          </div>

          {currentHash && (
            <div className="hash-scroll" title={currentHash}>
              {currentHash}
            </div>
          )}
        </div>

        {/* Tab switcher */}
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === "session" ? "active" : ""}`}
            onClick={() => setActiveTab("session")}
          >
            Session
          </button>
          <button
            className={`tab-btn ${activeTab === "worklog" ? "active" : ""}`}
            onClick={() => setActiveTab("worklog")}
          >
            Work Log
          </button>
        </div>

        {/* Session tab */}
        {activeTab === "session" && (
          <>
            <div className="stats-section">
              <div className="stats-divider">Session</div>
              <div className="stat-row">
                <span className="stat-label">Work completed</span>
                <span className="stat-value">{sessionStats.workCompleted}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">KSHS earned</span>
                <span className="stat-value amber">
                  {sessionStats.kshsEarned.toFixed(6)}
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Status</span>
                <span className={`stat-value ${isMining ? "mining" : isConnected ? "green" : ""}`}>
                  {isMining ? "Mining..." : isConnected ? "Connected" : "Idle"}
                </span>
              </div>
            </div>

            <div className="stats-section">
              <div className="stats-divider">Network</div>
              <div className="stat-row">
                <span className="stat-label">Connected workers</span>
                <span className="stat-value">{networkStats.connectedWorkers}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Total KSHS paid</span>
                <span className="stat-value">{networkStats.totalPaid.toFixed(6)}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Your reward</span>
                <span className="stat-value amber">
                  {networkStats.reward.toFixed(6)} KSHS
                </span>
              </div>
            </div>
          </>
        )}

        {/* Work Log tab */}
        {activeTab === "worklog" && (
          <div className="worklog-section">
            {workHistory.length === 0 ? (
              <div className="worklog-empty">No work completed yet this session.</div>
            ) : (
              <div className="worklog-list">
                {workHistory.map((entry, i) => (
                  <div key={i} className={`worklog-row ${entry.paid ? "paid" : ""}`}>
                    <span className="worklog-time">{entry.time}</span>
                    <span className="worklog-hash">{entry.hash.slice(0, 8)}…</span>
                    <span className="worklog-status">
                      {entry.paid ? "✓ paid" : "pending"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
