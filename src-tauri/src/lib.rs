use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{connect_async, tungstenite::Message};

// Nano/Kakitu send threshold
const WORK_THRESHOLD: u64 = 0xfffffe0000000000;

// ── Shared state ──────────────────────────────────────────────────────────────

type WsSender = Arc<Mutex<Option<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>
    >,
    Message,
>>>>;

struct WorkerState {
    sender: WsSender,
}

// ── Incoming WS message types ─────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct WsIncoming {
    action: String,
    hash: Option<String>,
    difficulty: Option<String>,
    amount: Option<String>,
    tx_hash: Option<String>,
}

// ── Outgoing event payloads ───────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct WorkStartedPayload {
    hash: String,
}

#[derive(Serialize, Clone)]
struct WorkCompletedPayload {
    hash: String,
    work: String,
}

#[derive(Serialize, Clone)]
struct PaidPayload {
    hash: String,
    amount: String,
    tx_hash: String,
}

#[derive(Serialize, Clone)]
struct ConnectionStatusPayload {
    connected: bool,
    message: String,
}

// ── PoW computation (CPU, blocking) ──────────────────────────────────────────

fn compute_work(hash_hex: &str, threshold: u64) -> String {
    let hash_bytes = match hex::decode(hash_hex) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };

    let mut nonce: u64 = rand::random();
    loop {
        let mut input = nonce.to_le_bytes().to_vec();
        input.extend_from_slice(&hash_bytes);
        let result = blake2b_simd::Params::new()
            .hash_length(8)
            .hash(&input);
        let result_bytes: [u8; 8] = result.as_bytes().try_into().unwrap();
        let result_u64 = u64::from_le_bytes(result_bytes);
        if result_u64 >= threshold {
            return hex::encode(nonce.to_le_bytes());
        }
        nonce = nonce.wrapping_add(1);
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn connect_worker(
    app: AppHandle,
    address: String,
) -> Result<(), String> {
    let state = app.state::<WorkerState>();

    // Disconnect any existing connection first
    {
        let mut guard = state.sender.lock().await;
        if let Some(sender) = guard.take() {
            drop(sender);
        }
    }

    let url = "wss://work.kakitu.org/worker/ws";
    let (ws_stream, _) = connect_async(url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let (mut write, mut read) = ws_stream.split();

    // Send registration
    let reg = serde_json::json!({ "kshs_address": address }).to_string();
    write
        .send(Message::Text(reg.into()))
        .await
        .map_err(|e| format!("Registration send failed: {e}"))?;

    // Store sender for disconnect
    {
        let mut guard = state.sender.lock().await;
        *guard = Some(write);
    }

    // Notify frontend: connected
    let _ = app.emit(
        "connection_status",
        ConnectionStatusPayload {
            connected: true,
            message: "Connected to worker hub.".into(),
        },
    );

    // Clone what we need for the read loop
    let sender_clone = state.sender.clone();
    let app_clone = app.clone();

    // Spawn message-reading loop
    tauri::async_runtime::spawn(async move {
        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    handle_message(&app_clone, &sender_clone, text.as_str()).await;
                }
                Ok(Message::Close(_)) | Err(_) => {
                    break;
                }
                _ => {}
            }
        }

        // Connection dropped
        {
            let mut guard = sender_clone.lock().await;
            *guard = None;
        }
        let _ = app_clone.emit(
            "connection_status",
            ConnectionStatusPayload {
                connected: false,
                message: "Disconnected from worker hub.".into(),
            },
        );
    });

    Ok(())
}

#[tauri::command]
async fn disconnect_worker(app: AppHandle) -> Result<(), String> {
    let state = app.state::<WorkerState>();
    let mut guard = state.sender.lock().await;
    if let Some(mut sender) = guard.take() {
        let _ = sender.send(Message::Close(None)).await;
        drop(sender);
    }
    Ok(())
}

// ── Message handler ───────────────────────────────────────────────────────────

async fn handle_message(app: &AppHandle, sender_arc: &WsSender, text: &str) {
    let msg: WsIncoming = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(_) => return,
    };

    match msg.action.as_str() {
        "work" => {
            let hash = match msg.hash {
                Some(h) => h,
                None => return,
            };

            // Parse difficulty or use default threshold
            let threshold = msg
                .difficulty
                .as_deref()
                .and_then(|d| u64::from_str_radix(d.trim_start_matches("0x"), 16).ok())
                .unwrap_or(WORK_THRESHOLD);

            // Emit work_started
            let _ = app.emit("work_started", WorkStartedPayload { hash: hash.clone() });

            // Compute PoW in a blocking thread
            let hash_for_compute = hash.clone();
            let work = tauri::async_runtime::spawn_blocking(move || {
                compute_work(&hash_for_compute, threshold)
            })
            .await
            .unwrap_or_default();

            if work.is_empty() {
                return;
            }

            // Emit work_completed
            let _ = app.emit(
                "work_completed",
                WorkCompletedPayload {
                    hash: hash.clone(),
                    work: work.clone(),
                },
            );

            // Send result back over WebSocket
            let result_msg = serde_json::json!({
                "action": "work_result",
                "hash": hash,
                "work": work,
            })
            .to_string();

            let mut guard = sender_arc.lock().await;
            if let Some(sender) = guard.as_mut() {
                let _ = sender.send(Message::Text(result_msg.into())).await;
            }
        }

        "paid" => {
            let hash = msg.hash.unwrap_or_default();
            let amount = msg.amount.unwrap_or_else(|| "0.010000".into());
            let tx_hash = msg.tx_hash.unwrap_or_default();
            let _ = app.emit("paid", PaidPayload { hash, amount, tx_hash });
        }

        "ping" => {
            // respond with pong to keep connection alive
            let pong = serde_json::json!({ "action": "pong" }).to_string();
            let mut guard = sender_arc.lock().await;
            if let Some(sender) = guard.as_mut() {
                let _ = sender.send(Message::Text(pong.into())).await;
            }
        }

        _ => {}
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let worker_state = WorkerState {
        sender: Arc::new(Mutex::new(None)),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(worker_state)
        .invoke_handler(tauri::generate_handler![connect_worker, disconnect_worker])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
