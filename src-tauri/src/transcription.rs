use crate::settings;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

#[derive(Deserialize)]
struct Response {
    text: String,
}

pub async fn transcribe(server_url: &str, wav: Vec<u8>) -> Result<String, String> {
    let url = settings::transcription_url(server_url)?;
    let audio = Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|error| error.to_string())?;
    let response = reqwest::Client::new()
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
