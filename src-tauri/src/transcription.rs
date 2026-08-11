use std::sync::OnceLock;
use std::time::Duration;

use crate::settings;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

#[derive(Deserialize)]
struct Response {
    text: String,
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

pub async fn check_server(server_url: &str) -> Result<(), String> {
    let url = settings::transcription_url(server_url)?;
    shared_client()
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.is_timeout() {
                "Сервер не ответил вовремя.".to_owned()
            } else {
                "Не удалось подключиться к серверу.".to_owned()
            }
        })
}

pub async fn transcribe(server_url: &str, wav: Vec<u8>) -> Result<String, String> {
    let url = settings::transcription_url(server_url)?;
    let audio = Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|error| error.to_string())?;
    let response = shared_client()
        .post(url)
        .multipart(Form::new().part("file", audio).text("model", "whisper-1"))
        .send()
        .await
        .map_err(|error| format!("transcription request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("transcription server returned {status}: {body}"));
    }
    response
        .json::<Response>()
        .await
        .map(|response| response.text)
        .map_err(|error| format!("invalid transcription response: {error}"))
}
